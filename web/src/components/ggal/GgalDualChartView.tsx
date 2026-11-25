import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type LineWidth,
  type LogicalRange,
  type MouseEventParams,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { AlertTriangle, Layers, RefreshCw } from 'lucide-react';
import { classifySessionRegime } from '../../../../src/core/ggal/parityGap';
import { evaluateCclContemporaneity, MAX_PLAUSIBLE_EPOCH_SEC } from '../../../../src/core/temporalFeedIntegrity';
import { projectLiveEma } from '../../../../src/core/ema';
import {
  advanceSessionVwapCheckpoint,
  buildSessionVwapCheckpoint,
  projectLiveCandle,
  projectLiveSessionVwapFromCheckpoint,
  type LiveChartBar,
  type LiveSessionVwapCheckpoint,
} from '../../../../src/core/realtimePropagation';
import type {
  GgalAvwapAnchorMode,
  GgalDualChartCoordMode,
  GgalDualChartPayloadDto,
  GgalDualChartTimeframe,
  GgalGreekProfileMode,
  GgalL2LadderStateDto,
  GgalL2OrderLevelDto,
  GgalMicrostructureResponseDto,
  GgalSubPaneIndicatorMode,
} from '../../api/ggalSpecialistClient';
import {
  BYMA_MARKET_TZ,
  US_MARKET_TZ,
  computeSessionVwapSeries,
} from '../../../../src/core/ggal/technicalIndicators';
import {
  computeDualChartVisibleRange,
  filterOverlayLevelsForCoordMode,
} from '../../../../src/core/ggal/chartCoordGuard';
import {
  formatExtendedSessionBadge,
  getMarketStreamMetaClock,
  setVisibleMarketSymbols,
  subscribeAtomicQuoteValue,
  subscribeGgalBarTick,
  tickFlashClass,
  useAtomicMarketQuote,
  useAtomicOrderBook,
  useLivePriceFlash,
  useMarketStreamMeta,
  useMarketViewScope,
  type MarketLiveQuote,
  type GgalBarTickEventDto,
} from '../../api/useMarketLiveStream';

export interface GgalDualChartViewProps {
  readonly payload: GgalDualChartPayloadDto | null;
  readonly microstructure: GgalMicrostructureResponseDto | null;
  readonly microstructureError: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly coordMode: GgalDualChartCoordMode;
  readonly timeframe: GgalDualChartTimeframe;
  readonly avwapAnchor: GgalAvwapAnchorMode;
  readonly onChangeCoordMode: (next: GgalDualChartCoordMode) => void;
  readonly onChangeTimeframe: (next: GgalDualChartTimeframe) => void;
  readonly onChangeAvwapAnchor: (next: GgalAvwapAnchorMode) => void;
  readonly onSubPaneModeChange?: (next: GgalSubPaneIndicatorMode) => void;
  readonly onRefresh: () => void;
}

function findBarIndexByTime(bars: readonly LiveChartBar[], timeSec: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const t = bars[mid]!.timeSec;
    if (t === timeSec) return mid;
    if (t < timeSec) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

const BMB_OUT_OF_SESSION_MESSAGE = 'BYMA fuera de rueda (11:00–17:00 ART) — BMB Bridge armado';

const INDICATOR_COLORS = {
  ema9: '#F3F4F6',
  ema21: '#38BDF8',
  ema50: '#E5C76B',
  ema200: '#F97316',
  sessionVwap: '#F472B6',
  avwap: '#A78BFA',
  avwapBand: 'rgba(167, 139, 250, 0.35)',
  cone1: '#2DD4BF',
  cone2: '#64748B',
  poc: '#E5C76B',
} as const;

interface OverlayToggleState {
  readonly showEmas: boolean;
  readonly showSessionVwap: boolean;
  readonly showAvwap: boolean;
  readonly showVolumeProfile: boolean;
  readonly showZones: boolean;
  readonly showCone: boolean;
}

interface LevelVisibilityState {
  readonly callWall: boolean;
  readonly putWall: boolean;
  readonly zeroGamma: boolean;
  readonly maxPain: boolean;
}

type LevelId = keyof LevelVisibilityState;

const LEVEL_SPECS: readonly {
  readonly id: LevelId;
  readonly label: string;
  readonly short: string;
  readonly color: string;
}[] = [
  { id: 'callWall', label: 'Call Wall', short: 'CW', color: '#E5C76B' },
  { id: 'putWall', label: 'Put Wall', short: 'PW', color: '#A78BFA' },
  { id: 'zeroGamma', label: 'Zero-Gamma', short: 'ZG', color: '#E5E7EB' },
  { id: 'maxPain', label: 'Max Pain', short: 'MP', color: '#9CA3AF' },
];

const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat('es-AR', {
  notation: 'compact',
  maximumFractionDigits: 2,
});
const INTEGER_FORMAT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });

interface OverlayDrawState {
  readonly payload: GgalDualChartPayloadDto | null;
  readonly toggles: OverlayToggleState;
  readonly coneLabel: string;
}

class GgalChartOverlayPrimitive implements ISeriesPrimitive<Time> {
  private param: SeriesAttachedParameter<Time, SeriesType> | null = null;
  private state: OverlayDrawState;

  public constructor(initial: OverlayDrawState) {
    this.state = initial;
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

  public paneViews(): readonly IPrimitivePaneView[] {
    const param = this.param;
    const { payload, toggles, coneLabel } = this.state;
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
                const yNeighbor =
                  refNeighbor !== undefined ? series.priceToCoordinate(refNeighbor.priceMid) : null;
                const barH =
                  yNeighbor !== null ? Math.max(2, Math.abs(yNeighbor - y) * 0.82) : 6;
                const barW = (bin.volume / maxBinVol) * maxBarWidth;
                context.fillStyle = bin.isPoc
                  ? 'rgba(229, 199, 107, 0.28)'
                  : bin.isValToVah
                    ? 'rgba(229, 199, 107, 0.18)'
                    : 'rgba(148, 163, 184, 0.14)';
                context.fillRect(0, y - barH * 0.5, barW, barH);
              }
            }

            if (vp.poc !== null && Number.isFinite(vp.poc)) {
              const yPoc = series.priceToCoordinate(vp.poc);
              if (yPoc !== null) {
                context.save();
                context.strokeStyle = 'rgba(229, 199, 107, 0.85)';
                context.lineWidth = 1.25;
                context.setLineDash([4, 3]);
                context.beginPath();
                context.moveTo(0, yPoc);
                context.lineTo(width, yPoc);
                context.stroke();
                context.fillStyle = INDICATOR_COLORS.poc;
                context.font = "10px 'Geist Mono', ui-monospace, SFMono-Regular, monospace";
                context.fillText('POC', 6, Math.max(11, yPoc - 3));
                context.restore();
              }
            }

            if (
              vp.vah !== null &&
              Number.isFinite(vp.vah) &&
              vp.val !== null &&
              Number.isFinite(vp.val)
            ) {
              const yVah = series.priceToCoordinate(vp.vah);
              const yVal = series.priceToCoordinate(vp.val);
              context.save();
              context.strokeStyle = 'rgba(229, 199, 107, 0.45)';
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
              context.strokeStyle = 'rgba(167, 139, 250, 0.78)';
              context.lineWidth = 1.1;
              context.setLineDash([5, 3]);
              context.beginPath();
              context.moveTo(0, yNp);
              context.lineTo(width, yNp);
              context.stroke();
              context.fillStyle = '#A78BFA';
              context.font = "10px 'Geist Mono', ui-monospace, SFMono-Regular, monospace";
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
                  ? 'rgba(34, 197, 94, 0.18)'
                  : 'rgba(34, 197, 94, 0.10)'
                : isFob
                  ? 'rgba(239, 68, 68, 0.18)'
                  : 'rgba(239, 68, 68, 0.10)';
              context.fillRect(x0, top, Math.max(16, width - x0), boxH);
              context.strokeStyle = isBull
                ? 'rgba(34, 197, 94, 0.55)'
                : 'rgba(239, 68, 68, 0.55)';
              context.lineWidth = 0.8;
              context.strokeRect(x0, top, Math.max(16, width - x0), boxH);

              context.fillStyle = isBull ? '#22C55E' : '#EF4444';
              context.font = '9px ui-monospace, SFMono-Regular, monospace';
              context.fillText(
                `${z.kind} ${isBull ? '↑' : '↓'}`,
                x0 + 4,
                top + Math.min(11, boxH - 1),
              );
            }
          }

          // 3) Timeframe-adaptive expected move cone, bounded to the right edge.
          if (
            toggles.showCone &&
            payload.expectedCone !== undefined &&
            payload.expectedCone.length >= 2
          ) {
            const firstPt = payload.expectedCone[0];
            const lastBar = payload.bars?.[payload.bars.length - 1];
            const anchorX =
              firstPt !== undefined
                ? (timeScale.timeToCoordinate(firstPt.timeSec as UTCTimestamp) ??
                  (lastBar !== undefined
                    ? timeScale.timeToCoordinate(lastBar.timeSec as UTCTimestamp)
                    : null))
                : null;
            if (anchorX !== null && anchorX < width - 8) {
              const endX = Math.min(
                width - 62,
                anchorX + Math.max(56, (width - anchorX) * 0.82),
              );
              const steps = payload.expectedCone.length - 1;
              context.save();
              context.setLineDash([5, 4]);

              const drawEnvelope = (
                extractor: (
                  p: NonNullable<GgalDualChartPayloadDto['expectedCone']>[number],
                ) => number,
                strokeStyle: string,
                lineWidth: number,
              ) => {
                context.strokeStyle = strokeStyle;
                context.lineWidth = lineWidth;
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

              drawEnvelope((p) => p.upper1Sigma, INDICATOR_COLORS.cone1, 1.25);
              drawEnvelope((p) => p.lower1Sigma, INDICATOR_COLORS.cone1, 1.25);
              drawEnvelope((p) => p.upper2Sigma, INDICATOR_COLORS.cone2, 1);
              drawEnvelope((p) => p.lower2Sigma, INDICATOR_COLORS.cone2, 1);

              const tailPt = payload.expectedCone[steps];
              if (tailPt !== undefined) {
                const yU1 = series.priceToCoordinate(tailPt.upper1Sigma);
                const yL1 = series.priceToCoordinate(tailPt.lower1Sigma);
                const yU2 = series.priceToCoordinate(tailPt.upper2Sigma);
                const yL2 = series.priceToCoordinate(tailPt.lower2Sigma);
                context.font = "9px 'Geist Mono', ui-monospace, SFMono-Regular, monospace";
                if (yU1 !== null) {
                  context.fillStyle = INDICATOR_COLORS.cone1;
                  context.fillText('+1σ', endX + 4, yU1 + 3);
                }
                if (yL1 !== null) {
                  context.fillStyle = INDICATOR_COLORS.cone1;
                  context.fillText('-1σ', endX + 4, yL1 + 3);
                }
                if (yU2 !== null) {
                  context.fillStyle = INDICATOR_COLORS.cone2;
                  context.fillText('+2σ', endX + 4, yU2 + 3);
                }
                if (yL2 !== null) {
                  context.fillStyle = INDICATOR_COLORS.cone2;
                  context.fillText('-2σ', endX + 4, yL2 + 3);
                }
              }

              context.fillStyle = INDICATOR_COLORS.cone1;
              context.font = "bold 10px 'Geist Mono', ui-monospace, SFMono-Regular, monospace";
              context.fillText(
                coneLabel,
                Math.max(8, Math.min(anchorX + 6, width - 190)),
                14,
              );
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

function asLineWidth(width: number): LineWidth {
  // Lightweight Charts uses the numeric width directly on its canvas context; its
  // public type only advertises 1..4, so this cast keeps the requested 1.25/1.5/1.75 px.
  return width as unknown as LineWidth;
}

function formatCoordPrice(
  val: number | null | undefined,
  mode: GgalDualChartCoordMode,
): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return '—';
  }
  if (mode === 'USD_ADR_NASDAQ') {
    return `$${val.toFixed(2)}`;
  }
  return val.toFixed(2);
}

function formatCompactNumber(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return '—';
  }
  return COMPACT_NUMBER_FORMAT.format(val);
}

function formatSize(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return '—';
  }
  return INTEGER_FORMAT.format(val);
}

function formatDistancePct(
  level: number | null | undefined,
  spot: number | null | undefined,
): string {
  if (
    level === null ||
    level === undefined ||
    spot === null ||
    spot === undefined ||
    !Number.isFinite(level) ||
    !Number.isFinite(spot) ||
    spot <= 0
  ) {
    return '—';
  }
  const pct = ((level - spot) / spot) * 100;
  if (!Number.isFinite(pct)) {
    return '—';
  }
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function formatTimestamp(utcSec: number | null | undefined): string {
  if (utcSec === null || utcSec === undefined || !Number.isFinite(utcSec) || utcSec <= 0) {
    return '—';
  }
  return new Date(utcSec * 1_000).toLocaleTimeString('es-AR', {
    timeZone: BYMA_MARKET_TZ,
    hour12: false,
  });
}

function resolveBarSeconds(timeframe: GgalDualChartTimeframe): number {
  switch (timeframe) {
    case '1m':
      return 60;
    case '5m':
      return 300;
    case '15m':
      return 900;
    case '1H':
      return 3_600;
    case '4H':
      return 14_400;
    case '1D':
      return 86_400;
    default:
      return 60;
  }
}

function resolveConeLabel(
  timeframe: GgalDualChartTimeframe,
  payload: GgalDualChartPayloadDto | null,
): string {
  const hasCone = (payload?.expectedCone?.length ?? 0) >= 2;
  if (timeframe === '1m' || timeframe === '5m') {
    return hasCone ? 'Cono Sesión ±1σ/±2σ' : 'Cono Sesión sin datos';
  }
  if (timeframe === '15m' || timeframe === '1H') {
    return hasCone ? 'Cono 5R ±1σ/±2σ' : 'Cono 5R sin datos';
  }
  if (!hasCone || payload === null) {
    return 'Cono Vto sin datos';
  }
  const cone = payload.expectedCone;
  const tail = cone !== undefined && cone.length > 0 ? cone[cone.length - 1] : undefined;
  if (tail !== undefined) {
    const dte = Math.max(
      0,
      Math.round((tail.timeSec - payload.asOfUtcSec) / 86_400),
    );
    return `Cono Vto (${String(dte)}d) ±1σ/±2σ`;
  }
  return 'Cono Vto sin datos';
}

type GreekProfileRow = NonNullable<GgalDualChartPayloadDto['greekProfile']>[number];

function readGreekValues(
  row: GreekProfileRow,
  mode: GgalGreekProfileMode,
): { readonly uncovered: number; readonly covered: number } {
  if (mode === 'SIGNED_GEX') {
    return { uncovered: row.signedGexUncovered, covered: row.signedGexCovered };
  }
  if (mode === 'VANNA') {
    return { uncovered: row.vannaUncovered, covered: row.vannaCovered };
  }
  return { uncovered: row.charmUncovered, covered: row.charmCovered };
}

function resolveCoordFactor(
  coordMode: GgalDualChartCoordMode,
  chartLadder: GgalL2LadderStateDto | null,
  arsLadder: GgalL2LadderStateDto | null,
): number {
  if (coordMode === 'ARS_BYMA') {
    return 1;
  }
  if (chartLadder === null || arsLadder === null) {
    return Number.NaN;
  }
  if (!chartLadder.available || !arsLadder.available) {
    return Number.NaN;
  }
  const chartBid = chartLadder.bids[0]?.price;
  const arsBid = arsLadder.bids[0]?.price;
  if (
    chartBid === undefined ||
    arsBid === undefined ||
    !Number.isFinite(chartBid) ||
    !Number.isFinite(arsBid) ||
    arsBid <= 0
  ) {
    return Number.NaN;
  }
  return chartBid / arsBid;
}

function applyFactor(value: number, factor: number): number {
  return Number.isFinite(value) && Number.isFinite(factor) ? value * factor : Number.NaN;
}

function GreekProfilePanel({
  rows,
  mode,
  coordMode,
  onChangeMode,
}: {
  readonly rows: readonly GreekProfileRow[];
  readonly mode: GgalGreekProfileMode;
  readonly coordMode: GgalDualChartCoordMode;
  readonly onChangeMode: (next: GgalGreekProfileMode) => void;
}) {
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.strike - a.strike),
    [rows],
  );
  const maxAbs = useMemo(() => {
    let max = 0;
    for (const row of sortedRows) {
      const values = readGreekValues(row, mode);
      const total = Math.abs(values.uncovered) + Math.abs(values.covered);
      if (total > max) {
        max = total;
      }
    }
    return max;
  }, [sortedRows, mode]);

  const totals = useMemo(() => {
    let uncovered = 0;
    let covered = 0;
    for (const row of sortedRows) {
      const values = readGreekValues(row, mode);
      uncovered += values.uncovered;
      covered += values.covered;
    }
    const totalAbs = Math.abs(uncovered) + Math.abs(covered);
    return {
      uncovered,
      covered,
      uncoveredShare: totalAbs > 0 ? Math.abs(uncovered) / totalAbs : Number.NaN,
      coveredShare: totalAbs > 0 ? Math.abs(covered) / totalAbs : Number.NaN,
    };
  }, [sortedRows, mode]);

  return (
    <div className="flex h-[420px] flex-col overflow-hidden rounded-lg border border-[#1C1C24] bg-[#0A0A0D]">
      <div className="border-b border-[#1C1C24] px-2.5 py-2">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div>
            <div className="text-[11px] font-semibold text-[#E5E7EB]">
              Perfil Griego &amp; Anexo B Fijo
            </div>
            <div className="font-mono text-[9px] text-[#6B7280]">
              Eje propio por strike · independiente del zoom
            </div>
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
                onClick={() => onChangeMode(gm)}
                className={`rounded border px-1.5 py-0.5 text-[10px] font-medium transition ${
                  mode === gm
                    ? 'border-[#E5C76B]/60 bg-[#E5C76B]/15 text-[#E5C76B]'
                    : 'border-[#1C1C24] bg-[#111116] text-[#9CA3AF] hover:text-[#E5E7EB]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {sortedRows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center font-mono text-[10px] text-[#6B7280]">
            Sin filas Anexo B / strike profile.
          </div>
        ) : (
          <div className="space-y-0.5">
            <div className="grid grid-cols-[58px_1fr] items-center gap-1.5 pb-0.5 font-mono text-[9px] text-[#6B7280]">
              <span className="text-right">Strike</span>
              <span className="flex justify-between px-0.5">
                <span>Put / Neg ←</span>
                <span>→ Call / Pos</span>
              </span>
            </div>
            {sortedRows.map((row) => {
              const values = readGreekValues(row, mode);
              const total = values.uncovered + values.covered;
              const positive = total >= 0;
              const uncovPct =
                maxAbs > 0 ? (Math.abs(values.uncovered) / maxAbs) * 50 : 0;
              const covPct = maxAbs > 0 ? (Math.abs(values.covered) / maxAbs) * 50 : 0;
              const uncovLeft = positive ? 50 : 50 - uncovPct;
              const covLeft = positive ? 50 + uncovPct : 50 - uncovPct - covPct;
              return (
                <div
                  key={String(row.strike)}
                  className="grid grid-cols-[58px_1fr] items-center gap-1.5"
                >
                  <span className="text-right font-mono text-[10px] text-[#9CA3AF]">
                    {formatCoordPrice(row.strike, coordMode)}
                  </span>
                  <div
                    className="relative h-[15px] overflow-hidden rounded-sm bg-[#111116]"
                    title={`Descubiertas ${formatCompactNumber(values.uncovered)} · Cubiertas ${formatCompactNumber(values.covered)}`}
                  >
                    <div className="absolute inset-y-0 left-1/2 w-px bg-[#2C2C38]" />
                    <div
                      className="absolute inset-y-[2px] rounded-sm"
                      style={{
                        left: `${String(uncovLeft)}%`,
                        width: `${String(uncovPct)}%`,
                        backgroundColor: positive
                          ? 'rgba(229, 199, 107, 0.88)'
                          : 'rgba(167, 139, 250, 0.88)',
                      }}
                    />
                    <div
                      className="absolute inset-y-[2px] rounded-sm"
                      style={{
                        left: `${String(covLeft)}%`,
                        width: `${String(covPct)}%`,
                        backgroundColor: positive
                          ? 'rgba(229, 199, 107, 0.30)'
                          : 'rgba(167, 139, 250, 0.30)',
                        backgroundImage: positive
                          ? 'repeating-linear-gradient(135deg, rgba(229,199,107,0.30) 0 2px, transparent 2px 4px)'
                          : 'repeating-linear-gradient(135deg, rgba(167,139,250,0.30) 0 2px, transparent 2px 4px)',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-[#1C1C24] px-2.5 py-1.5">
        <div className="flex flex-wrap items-center justify-between gap-1 font-mono text-[9px]">
          <span className="inline-flex items-center gap-1 text-[#E5C76B]">
            <span className="inline-block h-2 w-2 rounded-sm bg-[#E5C76B]" />
            Desc. {formatCompactNumber(totals.uncovered)}
          </span>
          <span className="inline-flex items-center gap-1 text-[#A78BFA]">
            <span className="inline-block h-2 w-2 rounded-sm bg-[#A78BFA]/40" />
            Cub. {formatCompactNumber(totals.covered)}
          </span>
          <span className="text-[#9CA3AF]">
            {Number.isFinite(totals.uncoveredShare)
              ? `${(totals.uncoveredShare * 100).toFixed(1)}% / ${(totals.coveredShare * 100).toFixed(1)}%`
              : '—'}
          </span>
        </div>
        {sortedRows.length > 0 && maxAbs === 0 && (
          <div className="mt-1 font-mono text-[9px] text-[#E5C76B]">
            Anexo B sin nominales para el modo seleccionado.
          </div>
        )}
      </div>
    </div>
  );
}

function L2LevelRow({
  level,
  side,
  coordMode,
  maxSize,
}: {
  readonly level: GgalL2OrderLevelDto;
  readonly side: 'BID' | 'ASK';
  readonly coordMode: GgalDualChartCoordMode;
  readonly maxSize: number;
}) {
  const pct = maxSize > 0 ? Math.min(100, (level.size / maxSize) * 100) : 0;
  const color = side === 'BID' ? '#22C55E' : '#EF4444';
  return (
    <div className="relative grid grid-cols-[30px_1fr_62px_38px] items-center gap-1 overflow-hidden rounded-sm px-1 py-[2px] font-mono text-[10px]">
      <div
        className="absolute inset-y-0 right-0"
        style={{
          width: `${String(pct)}%`,
          backgroundColor: side === 'BID' ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
        }}
      />
      <span className="relative" style={{ color }}>
        {side === 'BID' ? 'BI' : 'OF'}
        {String(level.level)}
      </span>
      <span className="relative text-right text-[#E5E7EB]">
        {formatCoordPrice(level.price, coordMode)}
      </span>
      <span className="relative text-right text-[#9CA3AF]">{formatSize(level.size)}</span>
      <span className="relative text-right text-[#6B7280]">
        {level.orderCount === null ? '—' : INTEGER_FORMAT.format(level.orderCount)}
      </span>
    </div>
  );
}

function L2LadderPanel({
  ladder,
  microstructure,
  microstructureError,
  coordMode,
}: {
  readonly ladder: GgalL2LadderStateDto | null;
  readonly microstructure: GgalMicrostructureResponseDto | null;
  readonly microstructureError: string | null;
  readonly coordMode: GgalDualChartCoordMode;
}) {
  const liveBook = useAtomicOrderBook('GGAL', 100);
  const micro =
    microstructure !== null && microstructure.microstructure.status === 'OPERATIONAL'
      ? microstructure.microstructure
      : null;
  const factor = resolveCoordFactor(
    coordMode,
    ladder,
    microstructure?.l2Ladder ?? null,
  );
  const microprice = micro !== null ? applyFactor(micro.micropriceMultiLevel, factor) : Number.NaN;
  const micropriceL1 = micro !== null ? applyFactor(micro.micropriceL1, factor) : Number.NaN;
  const midPrice = micro !== null ? applyFactor(micro.midPrice, factor) : Number.NaN;

  const effectiveLadder: GgalL2LadderStateDto | null = useMemo(() => {
    if (
      liveBook !== null &&
      liveBook.symbol === 'GGAL' &&
      (liveBook.bids.length > 0 || liveBook.asks.length > 0)
    ) {
      const arsScale = coordMode === 'ARS_BYMA' ? 1 : factor;
      if (Number.isFinite(arsScale) && arsScale > 0) {
        const resolvedProvider = ((): Extract<
          GgalL2LadderStateDto,
          { readonly available: true }
        >['activeProvider'] => {
          const src = liveBook.source;
          if (
            src === 'PRIMARY_MATRIZ_WS' ||
            src === 'PPI_REST' ||
            src === 'IOL_REST' ||
            src === 'BMB_HOMEBROKER_BRIDGE' ||
            src === 'MAE_MARKETDATA_V1'
          ) {
            return src;
          }
          if (src.includes('BMB')) return 'BMB_HOMEBROKER_BRIDGE';
          if (src.includes('PRIMARY')) return 'PRIMARY_MATRIZ_WS';
          return ladder?.activeProvider ?? 'PRIMARY_MATRIZ_WS';
        })();
        return {
          symbol: ladder?.symbol ?? 'GGAL',
          available: true,
          qualityTier: 'REALTIME_L2_TICK',
          activeProvider: resolvedProvider,
          asOfUtcSec: liveBook.asOfUtcSec ?? ladder?.asOfUtcSec ?? Math.floor(Date.now() / 1_000),
          bids: liveBook.bids.slice(0, 5).map((lvl, idx) => ({
            level: (idx + 1) as 1 | 2 | 3 | 4 | 5,
            price: lvl.price * arsScale,
            size: lvl.size,
            orderCount: lvl.orderCount,
          })),
          asks: liveBook.asks.slice(0, 5).map((lvl, idx) => ({
            level: (idx + 1) as 1 | 2 | 3 | 4 | 5,
            price: lvl.price * arsScale,
            size: lvl.size,
            orderCount: lvl.orderCount,
          })),
          bookStatus: 'LIVE',
          isEodCached: false,
        };
      }
    }
    return ladder;
  }, [coordMode, factor, ladder, liveBook]);

  const sortedBids =
    effectiveLadder !== null && effectiveLadder.available
      ? [...effectiveLadder.bids].sort((a, b) => b.price - a.price)
      : [];
  const sortedAsks =
    effectiveLadder !== null && effectiveLadder.available
      ? [...effectiveLadder.asks].sort((a, b) => b.price - a.price)
      : [];
  const maxSize = Math.max(
    1,
    ...sortedBids.map((level) => level.size),
    ...sortedAsks.map((level) => level.size),
  );
  const bestBid = sortedBids[0]?.price;
  const bestAsk = sortedAsks[sortedAsks.length - 1]?.price;
  const spread =
    bestBid !== undefined && bestAsk !== undefined && Number.isFinite(bestBid) && Number.isFinite(bestAsk)
      ? bestAsk - bestBid
      : Number.NaN;
  const spreadBps =
    Number.isFinite(spread) && bestBid !== undefined && bestBid > 0
      ? (spread / bestBid) * 10_000
      : Number.NaN;

  return (
    <div className="flex h-[420px] flex-col overflow-hidden rounded-lg border border-[#1C1C24] bg-[#0A0A0D]">
      <div className="border-b border-[#1C1C24] px-2.5 py-2">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div>
            <div className="text-[11px] font-semibold text-[#E5E7EB]">
              Escalera L2 en Vivo (5 Puntas BI/OF)
            </div>
            <div className="font-mono text-[9px] text-[#6B7280]">
              BMB / Primary · {effectiveLadder?.activeProvider ?? 'SIN FEED'} · {effectiveLadder?.qualityTier ?? '—'}
            </div>
          </div>
          <span className="rounded border border-[#1C1C24] bg-[#111116] px-1.5 py-0.5 font-mono text-[9px] text-[#9CA3AF]">
            {effectiveLadder?.asOfUtcSec !== undefined ? formatTimestamp(effectiveLadder.asOfUtcSec) : '—'}
          </span>
        </div>
      </div>

      <div className="perf-table-viewport flex-1 overflow-y-auto px-2 py-1.5 tabular-nums">
        {effectiveLadder === null ? (
          <div className="flex h-full items-center justify-center px-4 text-center font-mono text-[10px] text-[#6B7280]">
            Sin payload de libro L2.
          </div>
        ) : !effectiveLadder.available ? (
          <div className="rounded border border-[#1C1C24] bg-[#111116] p-2.5">
            <div className="font-mono text-[10px] font-semibold text-[#E5E7EB]">
              {effectiveLadder.reason === 'OUT_OF_SESSION' ? 'BMB BRIDGE ARMADO' : 'L2 NO DISPONIBLE'}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-[#9CA3AF]">
              {effectiveLadder.reason === 'OUT_OF_SESSION'
                ? BMB_OUT_OF_SESSION_MESSAGE
                : `Motivo: ${effectiveLadder.reason}`}
            </p>
            <p className="mt-1 font-mono text-[9px] text-[#6B7280]">
              Feed: {effectiveLadder.activeProvider ?? 'NINGUNO'} · Tier: {effectiveLadder.qualityTier}
            </p>
          </div>
        ) : (
          <>
            {(effectiveLadder.bookStatus === 'EOD_CIERRE' || effectiveLadder.isEodCached === true) && (
              <div className="mb-1 flex items-center justify-between rounded border border-[#F59E0B]/30 bg-[#35280F]/40 px-1.5 py-0.5 font-mono text-[9px] text-[#F5B544]">
                <span>EOD / CIERRE</span>
                <span>Último snapshot L2</span>
              </div>
            )}
            <div className="grid grid-cols-[30px_1fr_62px_38px] gap-1 px-1 pb-0.5 font-mono text-[9px] text-[#6B7280]">
              <span>Lado</span>
              <span className="text-right">Precio</span>
              <span className="text-right">Tamaño</span>
              <span className="text-right">Órdenes</span>
            </div>
            {sortedAsks.map((level) => (
              <L2LevelRow
                key={`ASK-${String(level.level)}`}
                level={level}
                side="ASK"
                coordMode={coordMode}
                maxSize={maxSize}
              />
            ))}
            <div className="my-1 grid grid-cols-2 gap-1 rounded border border-[#1C1C24] bg-[#111116] px-1.5 py-1 font-mono text-[9px]">
              <span className="text-[#9CA3AF]">
                Spread <strong className="text-[#E5E7EB]">{formatCoordPrice(spread, coordMode)}</strong>
              </span>
              <span className="text-right text-[#9CA3AF]">
                {Number.isFinite(spreadBps) ? `${spreadBps.toFixed(1)} bps` : '—'}
              </span>
            </div>
            {sortedBids.map((level) => (
              <L2LevelRow
                key={`BID-${String(level.level)}`}
                level={level}
                side="BID"
                coordMode={coordMode}
                maxSize={maxSize}
              />
            ))}
            <div className="mt-1 px-1 font-mono text-[9px] text-[#6B7280]">
              {String(sortedBids.length)} BI / {String(sortedAsks.length)} OF · libro de 5 puntas
            </div>
          </>
        )}
      </div>

      <div className="border-t border-[#1C1C24] px-2.5 py-1.5">
        <div className="rounded border border-[#1C1C24] bg-[#111116] p-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[9px] uppercase tracking-wide text-[#9CA3AF]">
              Microprice Motor 8
            </span>
            <span className="font-mono text-[13px] font-semibold text-[#2DD4BF]">
              {formatCoordPrice(microprice, coordMode)}
            </span>
          </div>
          {micro !== null ? (
            <div className="mt-1 grid grid-cols-3 gap-x-2 gap-y-0.5 font-mono text-[9px] text-[#9CA3AF]">
              <span>L1 {formatCoordPrice(micropriceL1, coordMode)}</span>
              <span>Mid {formatCoordPrice(midPrice, coordMode)}</span>
              <span>Spread {micro.spreadBps.toFixed(1)} bps</span>
              <span>OBI {micro.obiMultiLevel.toFixed(3)}</span>
              <span>VPIN {micro.vpin.vpin === null ? '—' : micro.vpin.vpin.toFixed(3)}</span>
              <span>
                VPIN pct{' '}
                {micro.vpin.percentileRank === null
                  ? '—'
                  : `${micro.vpin.percentileRank.toFixed(1)}%`}
              </span>
            </div>
          ) : microstructure !== null &&
            microstructure.microstructure.status === 'UNAVAILABLE' ? (
            <div className="mt-1 font-mono text-[9px] text-[#9CA3AF]">
              Motor 8 {microstructure.microstructure.reason}:{' '}
              {microstructure.microstructure.detail}
            </div>
          ) : (
            <div className="mt-1 font-mono text-[9px] text-[#9CA3AF]">
              {microstructureError === null
                ? 'Motor 8 sin datos.'
                : `Motor 8 sin datos: ${microstructureError}`}
            </div>
          )}
          {micro !== null && !Number.isFinite(factor) && coordMode !== 'ARS_BYMA' && (
            <div className="mt-1 font-mono text-[9px] text-[#E5C76B]">
              Microprice ARS sin referencia L2 para convertir a {coordMode}.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KeyLevelsPanel({
  payload,
  coordMode,
  visibility,
  onToggle,
}: {
  readonly payload: GgalDualChartPayloadDto | null;
  readonly coordMode: GgalDualChartCoordMode;
  readonly visibility: LevelVisibilityState;
  readonly onToggle: (id: LevelId) => void;
}) {
  const spot = payload?.spotPrice;
  const levelValues: Record<LevelId, number | null | undefined> = {
    callWall: payload?.callWall,
    putWall: payload?.putWall,
    zeroGamma: payload?.zeroGamma,
    maxPain: payload?.maxPain,
  };

  return (
    <div className="flex h-[420px] flex-col overflow-hidden rounded-lg border border-[#1C1C24] bg-[#0A0A0D]">
      <div className="border-b border-[#1C1C24] px-2.5 py-2">
        <div className="text-[11px] font-semibold text-[#E5E7EB]">
          Niveles Clave de Opciones
        </div>
        <div className="font-mono text-[9px] text-[#6B7280]">
          Distancia al spot · líneas ocultas por defecto
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 py-2">
        {payload === null ? (
          <div className="flex h-full items-center justify-center px-4 text-center font-mono text-[10px] text-[#6B7280]">
            Sin payload dual-chart.
          </div>
        ) : (
          <div className="space-y-1.5">
            {LEVEL_SPECS.map((spec) => {
              const value = levelValues[spec.id];
              const valid =
                value !== null &&
                value !== undefined &&
                Number.isFinite(value) &&
                value > 0;
              return (
                <label
                  key={spec.id}
                  className={`flex items-center justify-between gap-2 rounded border px-2 py-1.5 transition ${
                    visibility[spec.id]
                      ? 'border-[#2C2C38] bg-[#111116]'
                      : 'border-[#1C1C24] bg-[#0A0A0D]'
                  } ${valid ? 'cursor-pointer hover:border-[#2C2C38]' : 'opacity-60'}`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={visibility[spec.id]}
                      disabled={!valid}
                      onChange={() => onToggle(spec.id)}
                      className="h-3 w-3 shrink-0 accent-[#E5C76B]"
                    />
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: spec.color }}
                    />
                    <span className="truncate text-[11px] text-[#E5E7EB]">{spec.label}</span>
                    <span className="font-mono text-[9px] text-[#6B7280]">{spec.short}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 font-mono text-[10px]">
                    <strong className="text-[#E5E7EB]">
                      {formatCoordPrice(value, coordMode)}
                    </strong>
                    <span className="w-12 text-right text-[#9CA3AF]">
                      {formatDistancePct(value, spot)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-[#1C1C24] px-2.5 py-1.5 font-mono text-[9px] text-[#6B7280]">
        {payload?.status === 'UNAVAILABLE'
          ? `Payload no operativo: ${payload.reason}`
          : 'Spot de referencia: '}
        {payload?.status === 'UNAVAILABLE' ? null : (
          <strong className="text-[#E5E7EB]">{formatCoordPrice(spot, coordMode)}</strong>
        )}
      </div>
    </div>
  );
}

const GgalToolbarSpotBadge = memo(function GgalToolbarSpotBadge({
  coordMode,
  fallbackSpot,
}: {
  readonly coordMode: GgalDualChartCoordMode;
  readonly fallbackSpot: number | null | undefined;
}) {
  const liveArGgal = useAtomicMarketQuote('AR', 'GGAL', 250);
  const liveUsGgal = useAtomicMarketQuote('US', 'GGAL', 250);
  const streamMeta = useMarketStreamMeta(500);
  const adrExtBadge = formatExtendedSessionBadge(liveUsGgal?.sessionPhase);
  const adrExtChangePct = liveUsGgal?.extendedChangePct ?? null;
  const liveDisplaySpot =
    coordMode === 'ARS_BYMA'
      ? liveArGgal?.price ?? null
      : coordMode === 'USD_ADR_NASDAQ'
        ? liveUsGgal?.price ?? null
        : liveArGgal !== null && liveUsGgal !== null && liveUsGgal.price > 0
          ? (liveArGgal.price * 10) / liveUsGgal.price
          : null;
  const liveClock = streamMeta.isFresh ? getMarketStreamMetaClock(streamMeta) : null;
  const liveSpotFlash = useLivePriceFlash(liveDisplaySpot);

  return (
    <>
      <span>
        Spot:{' '}
        <strong className={`rounded px-1 tabular-nums ${tickFlashClass(liveSpotFlash)}`}>
          {formatCoordPrice(liveDisplaySpot ?? fallbackSpot, coordMode)}
        </strong>
      </span>
      {liveDisplaySpot !== null && liveClock !== null && (
        <span
          className={`rounded-full border px-1.5 py-0.5 tabular-nums ${
            (coordMode === 'USD_ADR_NASDAQ' || coordMode === 'RATIO_CCL') && adrExtBadge !== null
              ? 'border-[#F5B544]/40 bg-[#F5B544]/10 text-[#F5B544]'
              : 'border-[#22C55E]/35 bg-[#22C55E]/10 text-[#22C55E]'
          }`}
        >
          {(coordMode === 'USD_ADR_NASDAQ' || coordMode === 'RATIO_CCL') && adrExtBadge !== null
            ? `● ${adrExtBadge}${adrExtChangePct !== null ? ` (${adrExtChangePct >= 0 ? '+' : ''}${adrExtChangePct.toFixed(2).replace('.', ',')}%)` : ''} · ${liveClock}`
            : `● Tiempo real ${liveClock}`}
        </span>
      )}
    </>
  );
});

export function GgalDualChartView({
  payload,
  microstructure,
  microstructureError,
  loading,
  error,
  coordMode,
  timeframe,
  avwapAnchor,
  onChangeCoordMode,
  onChangeTimeframe,
  onChangeAvwapAnchor,
  onSubPaneModeChange,
  onRefresh,
}: GgalDualChartViewProps) {
  const streamMode = coordMode === 'USD_ADR_NASDAQ' ? 'ADR' : coordMode === 'ARS_BYMA' ? 'ARS' : 'CCL';
  const streamTimeframeForScope = timeframe === '1H' ? '1h' : timeframe === '4H' ? '4h' : timeframe;
  useMarketViewScope('ggal_specialist', 'GGAL', 'AR', streamMode, streamTimeframeForScope);

  useEffect(() => {
    setVisibleMarketSymbols(['AR:GGAL', 'US:GGAL'], 'ggal-dual');
    return () => {
      setVisibleMarketSymbols([], 'ggal-dual');
    };
  }, []);

  const lastBarRef = useRef<LiveChartBar | null>(null);
  const closedBarsRef = useRef<readonly LiveChartBar[]>([]);
  const appliedBucketRevisionRef = useRef(new Map<number, number>());
  const emaBaselinesRef = useRef<{ 9: number; 21: number; 50: number; 200: number } | null>(null);
  const emaEndRef = useRef<{ 9: number; 21: number; 50: number; 200: number } | null>(null);
  const emaSeriesRefs = useRef<Partial<Record<9 | 21 | 50 | 200, ISeriesApi<'Line'>>>>({});
  const vwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const cvdSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const cclBrechaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rsBmaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rsBbarSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rsSupvSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  // Pieza 39: volumen + AVWAP con refs nombradas para updates tick-a-tick.
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const avwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const avwapPlus1SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const avwapMinus1SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const avwapPlus2SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const avwapMinus2SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLineSlotsRef = useRef<Record<LevelId, IPriceLine> | null>(null);
  const lastPriceLineOptsRef = useRef<
    Partial<Record<LevelId, { readonly show: boolean; readonly price: number; readonly title: string }>>
  >({});
  // Leyenda OHLCV: DOM directo (sin setState por pixel de mouse).
  const crosshairLegendRef = useRef<HTMLDivElement | null>(null);
  const lastCvdRef = useRef<number | null>(null);
  const liveBarCvdDeltaRef = useRef<number>(0);
  const sessionVwapCheckpointRef = useRef<LiveSessionVwapCheckpoint | null>(null);
  const lastDatasetSigRef = useRef<string | null>(null);
  const lastSubPaneSigRef = useRef<string | null>(null);
  const lastRightPadRef = useRef<number | null>(null);
  const tickRafIdRef = useRef<number | null>(null);
  const [subPaneMode, setSubPaneMode] = useState<GgalSubPaneIndicatorMode>('CVD_LEE_READY');
  const [greekMode, setGreekMode] = useState<GgalGreekProfileMode>('SIGNED_GEX');
  const [toggles, setToggles] = useState<OverlayToggleState>({
    showEmas: true,
    showSessionVwap: true,
    showAvwap: true,
    showVolumeProfile: true,
    showZones: true,
    showCone: true,
  });
  const [levelVisibility, setLevelVisibility] = useState<LevelVisibilityState>({
    callWall: false,
    putWall: false,
    zeroGamma: false,
    maxPain: false,
  });

  const mainContainerRef = useRef<HTMLDivElement | null>(null);
  const subContainerRef = useRef<HTMLDivElement | null>(null);
  const mainChartRef = useRef<IChartApi | null>(null);
  const subChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const primitiveRef = useRef<GgalChartOverlayPrimitive | null>(null);
  const isSyncingRef = useRef(false);
  const lastFitKeyRef = useRef<string | null>(null);
  const prevScaleModeRef = useRef<string | null>(null);
  const latestBarCountRef = useRef<number>(0);

  // Pieza 44: bloquea cualquier desajuste o fuga de niveles ARS <-> USD antes de renderizar o escalar.
  const safePayload = useMemo((): GgalDualChartPayloadDto | null => {
    if (payload === null) return null;
    if (payload.status !== 'OPERATIONAL') {
      return payload.coordMode === coordMode ? payload : null;
    }
    const bars = payload.bars ?? [];
    const guarded = filterOverlayLevelsForCoordMode({
      activeCoordMode: coordMode,
      payloadCoordMode: payload.coordMode,
      bars,
      levels: {
        callWall: payload.callWall ?? Number.NaN,
        putWall: payload.putWall ?? Number.NaN,
        zeroGamma: payload.zeroGamma ?? Number.NaN,
        maxPain: payload.maxPain ?? Number.NaN,
      },
      zones: payload.zones ?? [],
      expectedCone: payload.expectedCone ?? [],
      volumeProfile: payload.volumeProfile ?? null,
    });
    if (!guarded.coordMatched) {
      return null;
    }
    return {
      ...payload,
      callWall: guarded.levels.callWall,
      putWall: guarded.levels.putWall,
      zeroGamma: guarded.levels.zeroGamma,
      maxPain: guarded.levels.maxPain,
      zones: guarded.zones,
      expectedCone: guarded.expectedCone,
      ...(guarded.volumeProfile !== null ? { volumeProfile: guarded.volumeProfile } : { volumeProfile: undefined }),
    };
  }, [payload, coordMode]);

  const latestPayloadRef = useRef(safePayload);
  latestPayloadRef.current = safePayload;
  const togglesRef = useRef(toggles);
  togglesRef.current = toggles;
  const subPaneModeRef = useRef(subPaneMode);
  subPaneModeRef.current = subPaneMode;

  const coneLabel = useMemo(() => resolveConeLabel(timeframe, safePayload), [timeframe, safePayload]);
  const hasCone = (safePayload?.expectedCone?.length ?? 0) >= 2;
  const latestConeLabelRef = useRef(coneLabel);
  latestConeLabelRef.current = coneLabel;

  const toggleLevel = useCallback((id: LevelId) => {
    setLevelVisibility((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // Initialize charts once. Main pane is full width and 640 px high; CVD is full width and 180 px high.
  useEffect(() => {
    const mainEl = mainContainerRef.current;
    const subEl = subContainerRef.current;
    if (mainEl === null || subEl === null) {
      return;
    }

    const commonLayout = {
      background: { type: ColorType.Solid, color: '#0A0A0D' },
      textColor: '#9CA3AF',
      fontFamily:
        "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    };
    const commonGrid = {
      vertLines: { color: '#1C1C24' },
      horzLines: { color: '#1C1C24' },
    };

    const mainChart = createChart(mainEl, {
      autoSize: false,
      width: Math.max(1, Math.floor(mainEl.clientWidth)),
      height: Math.max(1, Math.floor(mainEl.clientHeight)),
      layout: commonLayout,
      grid: commonGrid,
      rightPriceScale: {
        borderColor: '#1C1C24',
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: '#1C1C24',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        enableConflation: true,
        conflationThresholdFactor: 1.0,
        precomputeConflationOnInit: false,
      },
    });

    const subChart = createChart(subEl, {
      autoSize: false,
      width: Math.max(1, Math.floor(subEl.clientWidth)),
      height: Math.max(1, Math.floor(subEl.clientHeight)),
      layout: commonLayout,
      grid: commonGrid,
      rightPriceScale: {
        borderColor: '#1C1C24',
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: '#1C1C24',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        enableConflation: true,
        conflationThresholdFactor: 1.0,
        precomputeConflationOnInit: false,
      },
    });

    const candleSeries = mainChart.addSeries(CandlestickSeries, {
      upColor: '#22C55E',
      downColor: '#EF4444',
      borderVisible: false,
      wickUpColor: '#22C55E',
      wickDownColor: '#EF4444',
      autoscaleInfoProvider: (
        original: () => AutoscaleInfo | null,
      ): AutoscaleInfo | null => {
        const result = original();
        if (result === null || result.priceRange === null) {
          return result;
        }
        const { minValue, maxValue } = result.priceRange;
        if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || maxValue <= minValue) {
          return result;
        }
        const pad = (maxValue - minValue) * 0.05;
        return {
          priceRange: {
            minValue: minValue - pad,
            maxValue: maxValue + pad,
          },
          margins: result.margins,
        };
      },
    });

    // Pieza 39: volumen OHLCV como overlay inferior (leyenda + update por tick).
    const volumeSeries = mainChart.addSeries(HistogramSeries, {
      priceScaleId: 'ggal-volume-scale',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    mainChart.priceScale('ggal-volume-scale').applyOptions({
      scaleMargins: { top: 0.86, bottom: 0 },
    });
    volumeSeriesRef.current = volumeSeries;

    const initialToggles = togglesRef.current;
    const initialSubPaneMode = subPaneModeRef.current;

    const addPersistentOverlay = (
      color: string,
      width: number,
      lineStyle: LineStyle,
      visible: boolean,
    ): ISeriesApi<'Line'> =>
      mainChart.addSeries(LineSeries, {
        color,
        lineWidth: asLineWidth(width),
        lineStyle,
        lastValueVisible: false,
        priceLineVisible: false,
        visible,
        autoscaleInfoProvider: () => null,
      });

    emaSeriesRefs.current = {
      9: addPersistentOverlay(INDICATOR_COLORS.ema9, 1.25, LineStyle.Solid, initialToggles.showEmas),
      21: addPersistentOverlay(INDICATOR_COLORS.ema21, 1.25, LineStyle.Solid, initialToggles.showEmas),
      50: addPersistentOverlay(INDICATOR_COLORS.ema50, 1.5, LineStyle.Solid, initialToggles.showEmas),
      200: addPersistentOverlay(INDICATOR_COLORS.ema200, 2, LineStyle.Solid, initialToggles.showEmas),
    };
    vwapSeriesRef.current = addPersistentOverlay(
      INDICATOR_COLORS.sessionVwap,
      1.5,
      LineStyle.Solid,
      initialToggles.showSessionVwap,
    );
    avwapSeriesRef.current = addPersistentOverlay(
      INDICATOR_COLORS.avwap,
      1.75,
      LineStyle.Solid,
      initialToggles.showAvwap,
    );
    avwapPlus1SeriesRef.current = addPersistentOverlay(
      INDICATOR_COLORS.avwapBand,
      1,
      LineStyle.Dashed,
      initialToggles.showAvwap,
    );
    avwapMinus1SeriesRef.current = addPersistentOverlay(
      INDICATOR_COLORS.avwapBand,
      1,
      LineStyle.Dashed,
      initialToggles.showAvwap,
    );
    avwapPlus2SeriesRef.current = addPersistentOverlay(
      INDICATOR_COLORS.avwapBand,
      1,
      LineStyle.Dotted,
      initialToggles.showAvwap,
    );
    avwapMinus2SeriesRef.current = addPersistentOverlay(
      INDICATOR_COLORS.avwapBand,
      1,
      LineStyle.Dotted,
      initialToggles.showAvwap,
    );

    const createHiddenWall = (color: string, title: string): IPriceLine =>
      candleSeries.createPriceLine({
        price: 0,
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lineVisible: false,
        axisLabelVisible: false,
        title,
      });

    priceLineSlotsRef.current = {
      callWall: createHiddenWall('#E5C76B', 'Call Wall'),
      putWall: createHiddenWall('#A78BFA', 'Put Wall'),
      zeroGamma: createHiddenWall('#E5E7EB', 'Zero-Gamma'),
      maxPain: createHiddenWall('#9CA3AF', 'Max Pain'),
    };

    cvdSeriesRef.current = subChart.addSeries(LineSeries, {
      color: '#E5C76B',
      lineWidth: 2,
      visible: initialSubPaneMode === 'CVD_LEE_READY',
    });
    cclBrechaSeriesRef.current = subChart.addSeries(LineSeries, {
      color: '#38BDF8',
      lineWidth: 2,
      visible: initialSubPaneMode === 'CCL_BRECHA_PCT',
    });
    rsBmaSeriesRef.current = subChart.addSeries(LineSeries, {
      color: '#F3F4F6',
      lineWidth: 1,
      title: 'vs BMA',
      visible: initialSubPaneMode === 'REL_STRENGTH_BANKS',
    });
    rsBbarSeriesRef.current = subChart.addSeries(LineSeries, {
      color: '#38BDF8',
      lineWidth: 1,
      title: 'vs BBAR',
      visible: initialSubPaneMode === 'REL_STRENGTH_BANKS',
    });
    rsSupvSeriesRef.current = subChart.addSeries(LineSeries, {
      color: '#F472B6',
      lineWidth: 1,
      title: 'vs SUPV',
      visible: initialSubPaneMode === 'REL_STRENGTH_BANKS',
    });

    const primitive = new GgalChartOverlayPrimitive({
      payload: latestPayloadRef.current,
      toggles: togglesRef.current,
      coneLabel: latestConeLabelRef.current,
    });
    candleSeries.attachPrimitive(primitive);

    mainChartRef.current = mainChart;
    subChartRef.current = subChart;
    candleSeriesRef.current = candleSeries;
    primitiveRef.current = primitive;

    const handleMainRange = (range: LogicalRange | null) => {
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
      } finally {
        isSyncingRef.current = false;
      }
    };

    mainChart.timeScale().subscribeVisibleLogicalRangeChange(handleMainRange);
    subChart.timeScale().subscribeVisibleLogicalRangeChange(handleSubRange);

    let lastContainerWidth = Math.floor(mainEl.clientWidth);
    let resizeRafId: number | null = null;
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver((entries) => {
            let mainW = Math.floor(mainEl.clientWidth);
            let mainH = Math.floor(mainEl.clientHeight);
            let subW = Math.floor(subEl.clientWidth);
            let subH = Math.floor(subEl.clientHeight);
            for (const entry of entries) {
              const box = entry.contentBoxSize?.[0];
              const iw = box?.inlineSize ?? entry.contentRect.width;
              const ih = box?.blockSize ?? entry.contentRect.height;
              if (entry.target === mainEl) {
                mainW = Math.floor(iw);
                mainH = Math.floor(ih);
              } else if (entry.target === subEl) {
                subW = Math.floor(iw);
                subH = Math.floor(ih);
              }
            }
            if (mainW <= 0 && subW <= 0) return;
            if (resizeRafId !== null) window.cancelAnimationFrame(resizeRafId);
            resizeRafId = window.requestAnimationFrame(() => {
              resizeRafId = null;
              if (mainW > 0 && mainH > 0) mainChart.resize(mainW, mainH);
              if (subW > 0 && subH > 0) subChart.resize(subW, subH);
              if (lastContainerWidth <= 40 && mainW > 40 && latestBarCountRef.current > 0) {
                isSyncingRef.current = true;
                try {
                  const count = latestBarCountRef.current;
                  const vr = computeDualChartVisibleRange({
                    totalBars: count,
                    maxVisibleBars: 220,
                    rightPaddingBars: (latestPayloadRef.current?.expectedCone?.length ?? 0) >= 2 ? 5 : 2,
                  });
                  mainChart.priceScale('right').applyOptions({ autoScale: true });
                  subChart.priceScale('right').applyOptions({ autoScale: true });
                  if (count <= 220) {
                    mainChart.timeScale().fitContent();
                    subChart.timeScale().fitContent();
                  } else if (vr !== null) {
                    mainChart.timeScale().setVisibleLogicalRange(vr);
                    subChart.timeScale().setVisibleLogicalRange(vr);
                  }
                } finally {
                  isSyncingRef.current = false;
                }
              }
              if (mainW > 0) lastContainerWidth = mainW;
            });
          })
        : null;
    resizeObserver?.observe(mainEl);
    resizeObserver?.observe(subEl);

    return () => {
      if (resizeRafId !== null) window.cancelAnimationFrame(resizeRafId);
      if (tickRafIdRef.current !== null) {
        window.cancelAnimationFrame(tickRafIdRef.current);
        tickRafIdRef.current = null;
      }
      resizeObserver?.disconnect();
      mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handleMainRange);
      subChart.timeScale().unsubscribeVisibleLogicalRangeChange(handleSubRange);
      candleSeries.detachPrimitive(primitive);
      mainChart.remove();
      subChart.remove();
      mainChartRef.current = null;
      subChartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      emaSeriesRefs.current = {};
      vwapSeriesRef.current = null;
      avwapSeriesRef.current = null;
      avwapPlus1SeriesRef.current = null;
      avwapMinus1SeriesRef.current = null;
      avwapPlus2SeriesRef.current = null;
      avwapMinus2SeriesRef.current = null;
      cvdSeriesRef.current = null;
      cclBrechaSeriesRef.current = null;
      rsBmaSeriesRef.current = null;
      rsBbarSeriesRef.current = null;
      rsSupvSeriesRef.current = null;
      priceLineSlotsRef.current = null;
      lastPriceLineOptsRef.current = {};
      lastDatasetSigRef.current = null;
      lastSubPaneSigRef.current = null;
      lastRightPadRef.current = null;
      sessionVwapCheckpointRef.current = null;
      primitiveRef.current = null;
    };
  }, []);

  // 1) Dataset histórico: setData() únicamente cuando cambia símbolo/coordMode/timeframe/avwap o las velas cerradas.
  useEffect(() => {
    const mainChart = mainChartRef.current;
    const subChart = subChartRef.current;
    const candleSeries = candleSeriesRef.current;
    if (mainChart === null || subChart === null || candleSeries === null) {
      return;
    }

    const scaleModeKey = `${coordMode}|${timeframe}`;
    const scaleModeChanged = prevScaleModeRef.current !== scaleModeKey;
    prevScaleModeRef.current = scaleModeKey;

    const bars = safePayload?.status === 'OPERATIONAL' ? (safePayload.bars ?? []) : [];
    latestBarCountRef.current = bars.length;

    const closedCount = Math.max(0, bars.length - 1);
    const lastClosedBar = closedCount > 0 ? bars[closedCount - 1] : undefined;
    const datasetSig =
      safePayload === null || safePayload.status !== 'OPERATIONAL' || bars.length === 0
        ? `EMPTY|${scaleModeKey}`
        : `${safePayload.timeframe}|${safePayload.coordMode}|${safePayload.avwapAnchor}|${String(bars.length)}|${String(bars[0]?.timeSec ?? 0)}|${String(lastClosedBar?.timeSec ?? 0)}|${String(lastClosedBar?.close ?? 0)}`;

    const subPaneSeries = safePayload?.status === 'OPERATIONAL' ? (safePayload.subPaneSeries ?? []) : [];
    const lastSubPoint = subPaneSeries[subPaneSeries.length - 1];
    const subPaneSig =
      subPaneSeries.length === 0
        ? 'EMPTY'
        : `${String(subPaneSeries.length)}|${String(lastSubPoint?.timeSec ?? 0)}|${String(lastSubPoint?.cvdLeeReady ?? 'na')}|${String(lastSubPoint?.cclBrechaPct ?? 'na')}|${String(lastSubPoint?.relStrengthBma ?? 'na')}`;

    if (lastDatasetSigRef.current === datasetSig) {
      if (safePayload !== null && safePayload.status === 'OPERATIONAL' && bars.length > 0) {
        if (lastSubPaneSigRef.current !== subPaneSig) {
          lastSubPaneSigRef.current = subPaneSig;
          cvdSeriesRef.current?.setData(
            subPaneSeries.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.cvdLeeReady })),
          );
          cclBrechaSeriesRef.current?.setData(
            subPaneSeries.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.cclBrechaPct })),
          );
          rsBmaSeriesRef.current?.setData(
            subPaneSeries.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.relStrengthBma })),
          );
          rsBbarSeriesRef.current?.setData(
            subPaneSeries.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.relStrengthBbar })),
          );
          rsSupvSeriesRef.current?.setData(
            subPaneSeries.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.relStrengthSupv })),
          );
          lastCvdRef.current =
            lastSubPoint !== undefined && Number.isFinite(lastSubPoint.cvdLeeReady)
              ? lastSubPoint.cvdLeeReady
              : null;
          liveBarCvdDeltaRef.current = 0;
        }
        const rightPad = (safePayload.expectedCone?.length ?? 0) >= 2 ? 5 : 2;
        if (lastRightPadRef.current !== rightPad) {
          lastRightPadRef.current = rightPad;
          mainChart.timeScale().applyOptions({ rightOffset: rightPad });
          subChart.timeScale().applyOptions({ rightOffset: rightPad });
        }
        const incomingLast = bars[bars.length - 1];
        if (
          incomingLast !== undefined &&
          lastBarRef.current !== null &&
          incomingLast.timeSec === lastBarRef.current.timeSec &&
          !appliedBucketRevisionRef.current.has(incomingLast.timeSec)
        ) {
          lastBarRef.current = incomingLast;
          candleSeries.update({
            time: incomingLast.timeSec as UTCTimestamp,
            open: incomingLast.open,
            high: incomingLast.high,
            low: incomingLast.low,
            close: incomingLast.close,
          });
          volumeSeriesRef.current?.update({
            time: incomingLast.timeSec as UTCTimestamp,
            value: incomingLast.volume,
            color: incomingLast.close >= incomingLast.open ? 'rgba(34,197,94,0.38)' : 'rgba(239,68,68,0.38)',
          });
        }
      }
      return;
    }
    lastDatasetSigRef.current = datasetSig;

    if (safePayload === null || safePayload.status !== 'OPERATIONAL' || bars.length === 0) {
      isSyncingRef.current = true;
      try {
        candleSeries.setData([]);
        volumeSeriesRef.current?.setData([]);
        emaSeriesRefs.current[9]?.setData([]);
        emaSeriesRefs.current[21]?.setData([]);
        emaSeriesRefs.current[50]?.setData([]);
        emaSeriesRefs.current[200]?.setData([]);
        vwapSeriesRef.current?.setData([]);
        avwapSeriesRef.current?.setData([]);
        avwapPlus1SeriesRef.current?.setData([]);
        avwapMinus1SeriesRef.current?.setData([]);
        avwapPlus2SeriesRef.current?.setData([]);
        avwapMinus2SeriesRef.current?.setData([]);
        cvdSeriesRef.current?.setData([]);
        cclBrechaSeriesRef.current?.setData([]);
        rsBmaSeriesRef.current?.setData([]);
        rsBbarSeriesRef.current?.setData([]);
        rsSupvSeriesRef.current?.setData([]);
        mainChart.priceScale('right').applyOptions({ autoScale: true });
        subChart.priceScale('right').applyOptions({ autoScale: true });
      } finally {
        isSyncingRef.current = false;
      }
      lastFitKeyRef.current = null;
      lastSubPaneSigRef.current = 'EMPTY';
      lastRightPadRef.current = null;
      lastBarRef.current = null;
      appliedBucketRevisionRef.current.clear();
      closedBarsRef.current = [];
      sessionVwapCheckpointRef.current = null;
      emaBaselinesRef.current = null;
      emaEndRef.current = null;
      lastCvdRef.current = null;
      liveBarCvdDeltaRef.current = 0;
      return;
    }

    if (scaleModeChanged) {
      isSyncingRef.current = true;
      try {
        mainChart.priceScale('right').applyOptions({ autoScale: true });
        subChart.priceScale('right').applyOptions({ autoScale: true });
      } finally {
        isSyncingRef.current = false;
      }
    }

    candleSeries.setData(
      bars.map((bar) => ({
        time: bar.timeSec as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    );
    volumeSeriesRef.current?.setData(
      bars.map((bar) => ({
        time: bar.timeSec as UTCTimestamp,
        value: bar.volume,
        color: bar.close >= bar.open ? 'rgba(34,197,94,0.38)' : 'rgba(239,68,68,0.38)',
      })),
    );

    const lastBar = bars[bars.length - 1];
    lastBarRef.current = lastBar ?? null;
    appliedBucketRevisionRef.current.clear();
    closedBarsRef.current = bars.slice(0, Math.max(0, bars.length - 1));
    const marketTz = safePayload.coordMode === 'USD_ADR_NASDAQ' ? US_MARKET_TZ : BYMA_MARKET_TZ;
    sessionVwapCheckpointRef.current = buildSessionVwapCheckpoint(closedBarsRef.current, marketTz);
    emaBaselinesRef.current = {
      9: safePayload.ema9 !== undefined && safePayload.ema9.length > 1 ? (safePayload.ema9[safePayload.ema9.length - 2]?.value ?? Number.NaN) : Number.NaN,
      21: safePayload.ema21 !== undefined && safePayload.ema21.length > 1 ? (safePayload.ema21[safePayload.ema21.length - 2]?.value ?? Number.NaN) : Number.NaN,
      50: safePayload.ema50 !== undefined && safePayload.ema50.length > 1 ? (safePayload.ema50[safePayload.ema50.length - 2]?.value ?? Number.NaN) : Number.NaN,
      200: safePayload.ema200 !== undefined && safePayload.ema200.length > 1 ? (safePayload.ema200[safePayload.ema200.length - 2]?.value ?? Number.NaN) : Number.NaN,
    };
    emaEndRef.current = {
      9: safePayload.ema9 !== undefined && safePayload.ema9.length > 0 ? (safePayload.ema9[safePayload.ema9.length - 1]?.value ?? Number.NaN) : Number.NaN,
      21: safePayload.ema21 !== undefined && safePayload.ema21.length > 0 ? (safePayload.ema21[safePayload.ema21.length - 1]?.value ?? Number.NaN) : Number.NaN,
      50: safePayload.ema50 !== undefined && safePayload.ema50.length > 0 ? (safePayload.ema50[safePayload.ema50.length - 1]?.value ?? Number.NaN) : Number.NaN,
      200: safePayload.ema200 !== undefined && safePayload.ema200.length > 0 ? (safePayload.ema200[safePayload.ema200.length - 1]?.value ?? Number.NaN) : Number.NaN,
    };

    const setLinePts = (
      series: ISeriesApi<'Line'> | undefined | null,
      pts: readonly { readonly timeSec: number; readonly value: number }[] | undefined,
    ): void => {
      if (!series) return;
      series.setData(
        pts !== undefined && pts.length > 0
          ? pts.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.value }))
          : [],
      );
    };

    setLinePts(emaSeriesRefs.current[9], safePayload.ema9);
    setLinePts(emaSeriesRefs.current[21], safePayload.ema21);
    setLinePts(emaSeriesRefs.current[50], safePayload.ema50);
    setLinePts(emaSeriesRefs.current[200], safePayload.ema200);

    const avwapBands = safePayload.avwapBands ?? [];
    avwapSeriesRef.current?.setData(avwapBands.map((band) => ({ time: band.timeSec as UTCTimestamp, value: band.avwap })));
    avwapPlus1SeriesRef.current?.setData(avwapBands.map((band) => ({ time: band.timeSec as UTCTimestamp, value: band.plus1Sigma })));
    avwapMinus1SeriesRef.current?.setData(avwapBands.map((band) => ({ time: band.timeSec as UTCTimestamp, value: band.minus1Sigma })));
    avwapPlus2SeriesRef.current?.setData(avwapBands.map((band) => ({ time: band.timeSec as UTCTimestamp, value: band.plus2Sigma })));
    avwapMinus2SeriesRef.current?.setData(avwapBands.map((band) => ({ time: band.timeSec as UTCTimestamp, value: band.minus2Sigma })));

    const vwapSeriesPts = computeSessionVwapSeries(bars, marketTz);
    setLinePts(vwapSeriesRef.current, vwapSeriesPts);

    lastSubPaneSigRef.current = subPaneSig;
    cvdSeriesRef.current?.setData(
      subPaneSeries.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.cvdLeeReady })),
    );
    cclBrechaSeriesRef.current?.setData(
      subPaneSeries.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.cclBrechaPct })),
    );
    rsBmaSeriesRef.current?.setData(
      subPaneSeries.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.relStrengthBma })),
    );
    rsBbarSeriesRef.current?.setData(
      subPaneSeries.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.relStrengthBbar })),
    );
    rsSupvSeriesRef.current?.setData(
      subPaneSeries.map((pt) => ({ time: pt.timeSec as UTCTimestamp, value: pt.relStrengthSupv })),
    );
    lastCvdRef.current =
      lastSubPoint !== undefined && Number.isFinite(lastSubPoint.cvdLeeReady)
        ? lastSubPoint.cvdLeeReady
        : null;
    liveBarCvdDeltaRef.current = 0;

    const fitKey = `${safePayload.timeframe}|${safePayload.coordMode}`;
    if (lastFitKeyRef.current !== fitKey || scaleModeChanged) {
      lastFitKeyRef.current = fitKey;
      isSyncingRef.current = true;
      try {
        const rightPad = (safePayload.expectedCone?.length ?? 0) >= 2 ? 5 : 2;
        lastRightPadRef.current = rightPad;
        mainChart.timeScale().applyOptions({ rightOffset: rightPad });
        subChart.timeScale().applyOptions({ rightOffset: rightPad });
        mainChart.priceScale('right').applyOptions({ autoScale: true });
        subChart.priceScale('right').applyOptions({ autoScale: true });
        const visibleRange = computeDualChartVisibleRange({
          totalBars: bars.length,
          maxVisibleBars: 220,
          rightPaddingBars: rightPad,
        });
        if (bars.length <= 220) {
          mainChart.timeScale().fitContent();
          subChart.timeScale().fitContent();
        } else if (visibleRange !== null) {
          mainChart.timeScale().setVisibleLogicalRange(visibleRange);
          subChart.timeScale().setVisibleLogicalRange(visibleRange);
        }
      } finally {
        isSyncingRef.current = false;
      }
    }
  }, [safePayload, coordMode, timeframe]);

  // 2) Visibilidad de overlays y primitiva custom sin setData().
  useEffect(() => {
    primitiveRef.current?.setState({ payload: safePayload, toggles, coneLabel });
    emaSeriesRefs.current[9]?.applyOptions({ visible: toggles.showEmas });
    emaSeriesRefs.current[21]?.applyOptions({ visible: toggles.showEmas });
    emaSeriesRefs.current[50]?.applyOptions({ visible: toggles.showEmas });
    emaSeriesRefs.current[200]?.applyOptions({ visible: toggles.showEmas });
    vwapSeriesRef.current?.applyOptions({ visible: toggles.showSessionVwap });
    avwapSeriesRef.current?.applyOptions({ visible: toggles.showAvwap });
    avwapPlus1SeriesRef.current?.applyOptions({ visible: toggles.showAvwap });
    avwapMinus1SeriesRef.current?.applyOptions({ visible: toggles.showAvwap });
    avwapPlus2SeriesRef.current?.applyOptions({ visible: toggles.showAvwap });
    avwapMinus2SeriesRef.current?.applyOptions({ visible: toggles.showAvwap });
  }, [safePayload, toggles, coneLabel]);

  // 3) Cambio de sub-panel sin destruir/recrear series.
  useEffect(() => {
    cvdSeriesRef.current?.applyOptions({ visible: subPaneMode === 'CVD_LEE_READY' });
    cclBrechaSeriesRef.current?.applyOptions({ visible: subPaneMode === 'CCL_BRECHA_PCT' });
    rsBmaSeriesRef.current?.applyOptions({ visible: subPaneMode === 'REL_STRENGTH_BANKS' });
    rsBbarSeriesRef.current?.applyOptions({ visible: subPaneMode === 'REL_STRENGTH_BANKS' });
    rsSupvSeriesRef.current?.applyOptions({ visible: subPaneMode === 'REL_STRENGTH_BANKS' });
    subChartRef.current?.priceScale('right').applyOptions({ autoScale: true });
  }, [subPaneMode]);

  // 4) IPriceLine persistentes actualizadas in-place con applyOptions.
  useEffect(() => {
    const slots = priceLineSlotsRef.current;
    if (slots === null) return;
    const isOperational = safePayload?.status === 'OPERATIONAL';
    const levelValues: Record<LevelId, number | null | undefined> = {
      callWall: safePayload?.callWall,
      putWall: safePayload?.putWall,
      zeroGamma: safePayload?.zeroGamma,
      maxPain: safePayload?.maxPain,
    };
    for (const spec of LEVEL_SPECS) {
      const price = levelValues[spec.id];
      const show =
        isOperational &&
        levelVisibility[spec.id] &&
        price !== null &&
        price !== undefined &&
        Number.isFinite(price);
      const nextPrice = show && price !== null && price !== undefined ? price : 0;
      const nextTitle = show ? spec.label : '';
      const prevOpts = lastPriceLineOptsRef.current[spec.id];
      if (
        prevOpts !== undefined &&
        prevOpts.show === show &&
        prevOpts.price === nextPrice &&
        prevOpts.title === nextTitle
      ) {
        continue;
      }
      lastPriceLineOptsRef.current[spec.id] = { show, price: nextPrice, title: nextTitle };
      slots[spec.id].applyOptions({
        price: nextPrice,
        lineVisible: show,
        axisLabelVisible: show,
        title: nextTitle,
      });
    }
  }, [safePayload, levelVisibility]);

  // 5) Bus imperativo en rAF. Las revisiones se aplican al historial con el rango visible guardado.
  useEffect(() => {
    const mode = coordMode === 'USD_ADR_NASDAQ' ? 'ADR' : coordMode === 'ARS_BYMA' ? 'ARS' : 'CCL';
    let latestArQuote: MarketLiveQuote | null = null;
    let latestUsQuote: MarketLiveQuote | null = null;
    let prevActiveQuote: MarketLiveQuote | null = null;
    let pendingQuoteDirty = false;
    const pendingTicksByTime = new Map<number, GgalBarTickEventDto>();
    const streamTimeframe = timeframe === '1H' ? '1h' : timeframe === '4H' ? '4h' : timeframe;

    const updateLine = (series: ISeriesApi<'Line'> | null | undefined, value: number | null, timeSec: number): void => {
      if (series === null || series === undefined || value === null || !Number.isFinite(value)) return;
      series.update({ time: timeSec as UTCTimestamp, value });
    };

    const marketTz = coordMode === 'USD_ADR_NASDAQ' ? US_MARKET_TZ : BYMA_MARKET_TZ;

    const flushFrame = (): void => {
      tickRafIdRef.current = null;
      const barTicks = [...pendingTicksByTime.values()].sort((a, b) => a.bar.timeSec - b.bar.timeSec);
      pendingTicksByTime.clear();
      let historicalBarsChanged = false;
      for (const barTick of barTicks) {
        const b = barTick.bar;
        if (!Number.isInteger(b.timeSec) || b.timeSec <= 0 ||
            ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite)) continue;
        const revisions = appliedBucketRevisionRef.current;
        const revision = barTick.bucketRevision;
        if (revision !== undefined && revision <= (revisions.get(b.timeSec) ?? 0)) continue;
        const currentLast = lastBarRef.current;
        if (currentLast !== null && b.timeSec < currentLast.timeSec) {
          if (barTick.isRevision !== true && barTick.updateKind !== 'HISTORICAL_REVISION') continue;
          if (revision !== undefined) revisions.set(b.timeSec, revision);
          const existingIdx = findBarIndexByTime(closedBarsRef.current, b.timeSec);
          if (existingIdx >= 0) {
            const nextClosed = closedBarsRef.current.slice();
            nextClosed[existingIdx] = b;
            closedBarsRef.current = nextClosed;
            sessionVwapCheckpointRef.current = buildSessionVwapCheckpoint(closedBarsRef.current, marketTz);
            candleSeriesRef.current?.update(
              {
                time: b.timeSec as UTCTimestamp,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
              },
              true,
            );
            volumeSeriesRef.current?.update(
              {
                time: b.timeSec as UTCTimestamp,
                value: b.volume,
                color: b.close >= b.open ? 'rgba(34,197,94,0.38)' : 'rgba(239,68,68,0.38)',
              },
              true,
            );
          } else {
            closedBarsRef.current = [...closedBarsRef.current, b].sort((a, c) => a.timeSec - c.timeSec);
            sessionVwapCheckpointRef.current = buildSessionVwapCheckpoint(closedBarsRef.current, marketTz);
            historicalBarsChanged = true;
          }
          continue;
        }
        if (revision !== undefined) revisions.set(b.timeSec, revision);
        if (currentLast !== null && b.timeSec > currentLast.timeSec) {
          closedBarsRef.current = [...closedBarsRef.current, currentLast];
          if (sessionVwapCheckpointRef.current !== null) {
            sessionVwapCheckpointRef.current = advanceSessionVwapCheckpoint(
              sessionVwapCheckpointRef.current,
              currentLast,
              marketTz,
            );
          } else {
            sessionVwapCheckpointRef.current = buildSessionVwapCheckpoint(closedBarsRef.current, marketTz);
          }
          if (lastCvdRef.current !== null) {
            lastCvdRef.current += liveBarCvdDeltaRef.current;
          }
          liveBarCvdDeltaRef.current = 0;
          if (emaEndRef.current !== null) {
            emaBaselinesRef.current = { ...emaEndRef.current };
          }
        }
        lastBarRef.current = {
          timeSec: b.timeSec,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        };
        candleSeriesRef.current?.update({
          time: b.timeSec as UTCTimestamp,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        });
        volumeSeriesRef.current?.update({
          time: b.timeSec as UTCTimestamp,
          value: b.volume,
          color: b.close >= b.open ? 'rgba(34,197,94,0.38)' : 'rgba(239,68,68,0.38)',
        });
        const pt = barTick.indicatorsPoint;
        updateLine(emaSeriesRefs.current[9], pt.ema9, pt.timeSec);
        updateLine(emaSeriesRefs.current[21], pt.ema21, pt.timeSec);
        updateLine(emaSeriesRefs.current[50], pt.ema50, pt.timeSec);
        updateLine(emaSeriesRefs.current[200], pt.ema200, pt.timeSec);
        updateLine(vwapSeriesRef.current, pt.sessionVwap, pt.timeSec);
        updateLine(avwapSeriesRef.current, pt.avwap, pt.timeSec);
        updateLine(avwapPlus1SeriesRef.current, pt.avwapPlus1Sigma, pt.timeSec);
        updateLine(avwapMinus1SeriesRef.current, pt.avwapMinus1Sigma, pt.timeSec);
        if (emaEndRef.current !== null) {
          emaEndRef.current = {
            9: pt.ema9 ?? emaEndRef.current[9],
            21: pt.ema21 ?? emaEndRef.current[21],
            50: pt.ema50 ?? emaEndRef.current[50],
            200: pt.ema200 ?? emaEndRef.current[200],
          };
        }
      }
      if (historicalBarsChanged) {
        const chart = mainChartRef.current;
        const currentLast = lastBarRef.current;
        if (chart !== null && currentLast !== null) {
          const scale = chart.timeScale();
          const visibleRange = scale.getVisibleLogicalRange();
          const subScale = subChartRef.current?.timeScale();
          const subVisibleRange = subScale?.getVisibleLogicalRange();
          const bars = [...closedBarsRef.current, currentLast];
          isSyncingRef.current = true;
          try {
            candleSeriesRef.current?.setData(bars.map((bar) => ({
              time: bar.timeSec as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
            })));
            volumeSeriesRef.current?.setData(bars.map((bar) => ({
              time: bar.timeSec as UTCTimestamp, value: bar.volume,
              color: bar.close >= bar.open ? 'rgba(34,197,94,0.38)' : 'rgba(239,68,68,0.38)',
            })));
            if (visibleRange !== null) scale.setVisibleLogicalRange(visibleRange);
            if (subVisibleRange != null) subScale?.setVisibleLogicalRange(subVisibleRange);
          } finally {
            isSyncingRef.current = false;
          }
        }
      }

      if (!pendingQuoteDirty) return;
      pendingQuoteDirty = false;
      const activeQuote = coordMode === 'USD_ADR_NASDAQ' ? latestUsQuote : latestArQuote;
      const previousQuote = prevActiveQuote;
      prevActiveQuote = activeQuote;
      let activePrice = activeQuote?.price ?? null;
      let activeTimeSec = activeQuote?.asOfUtcSec ?? null;
      if (coordMode === 'RATIO_CCL') {
        const arTime = latestArQuote?.asOfUtcSec;
        const usTime = latestUsQuote?.asOfUtcSec;
        if (typeof arTime !== 'number' || typeof usTime !== 'number' || !Number.isInteger(arTime) ||
            !Number.isInteger(usTime) || arTime <= 0 || usTime <= 0 ||
            arTime > MAX_PLAUSIBLE_EPOCH_SEC || usTime > MAX_PLAUSIBLE_EPOCH_SEC) return;
        const evaluationNowSec = Math.floor(Date.now() / 1_000);
        const valuation = evaluateCclContemporaneity({
          byma: { price: latestArQuote?.price ?? Number.NaN, timeSec: arTime },
          adr: { price: latestUsQuote?.price ?? Number.NaN, timeSec: usTime },
          evaluationNowSec,
          marketRegime: classifySessionRegime(evaluationNowSec).sessionRegime,
        });
        if (!valuation.livePublishable) return;
        activePrice = valuation.value;
        activeTimeSec = valuation.valuationTimestamp;
      }
      const bar = lastBarRef.current;
      if (
        activePrice === null ||
        activeTimeSec === null ||
        !Number.isFinite(activePrice) ||
        !Number.isInteger(activeTimeSec) ||
        bar === null
      ) {
        return;
      }
      const volumeDelta =
        coordMode !== 'RATIO_CCL' && activeQuote !== null &&
        previousQuote !== null &&
        activeQuote.volume !== null &&
        previousQuote.volume !== null
          ? Math.max(0, activeQuote.volume - previousQuote.volume)
          : 0;
      const projectedBar = projectLiveCandle(
        bar,
        { price: activePrice, timeSec: activeTimeSec, volumeDelta },
        resolveBarSeconds(timeframe),
      );
      if (projectedBar === null || projectedBar.timeSec < bar.timeSec ||
          appliedBucketRevisionRef.current.has(projectedBar.timeSec)) {
        return;
      }
      if (projectedBar.timeSec > bar.timeSec) {
        closedBarsRef.current = [...closedBarsRef.current, bar];
        if (sessionVwapCheckpointRef.current !== null) {
          sessionVwapCheckpointRef.current = advanceSessionVwapCheckpoint(
            sessionVwapCheckpointRef.current,
            bar,
            marketTz,
          );
        } else {
          sessionVwapCheckpointRef.current = buildSessionVwapCheckpoint(closedBarsRef.current, marketTz);
        }
        if (lastCvdRef.current !== null) {
          lastCvdRef.current += liveBarCvdDeltaRef.current;
        }
        liveBarCvdDeltaRef.current = 0;
        if (emaEndRef.current !== null) {
          emaBaselinesRef.current = { ...emaEndRef.current };
        }
      }
      lastBarRef.current = projectedBar;
      candleSeriesRef.current?.update({
        time: projectedBar.timeSec as UTCTimestamp,
        open: projectedBar.open,
        high: projectedBar.high,
        low: projectedBar.low,
        close: projectedBar.close,
      });

      const baselines = emaBaselinesRef.current;
      if (baselines !== null) {
        const nextEma9 = projectLiveEma(baselines[9], activePrice, 9);
        if (Number.isFinite(nextEma9)) {
          emaSeriesRefs.current[9]?.update({ time: projectedBar.timeSec as UTCTimestamp, value: nextEma9 });
        }
        const nextEma21 = projectLiveEma(baselines[21], activePrice, 21);
        if (Number.isFinite(nextEma21)) {
          emaSeriesRefs.current[21]?.update({ time: projectedBar.timeSec as UTCTimestamp, value: nextEma21 });
        }
        const nextEma50 = projectLiveEma(baselines[50], activePrice, 50);
        if (Number.isFinite(nextEma50)) {
          emaSeriesRefs.current[50]?.update({ time: projectedBar.timeSec as UTCTimestamp, value: nextEma50 });
        }
        const nextEma200 = projectLiveEma(baselines[200], activePrice, 200);
        if (Number.isFinite(nextEma200)) {
          emaSeriesRefs.current[200]?.update({ time: projectedBar.timeSec as UTCTimestamp, value: nextEma200 });
        }
        emaEndRef.current = {
          9: Number.isFinite(nextEma9) ? nextEma9 : baselines[9],
          21: Number.isFinite(nextEma21) ? nextEma21 : baselines[21],
          50: Number.isFinite(nextEma50) ? nextEma50 : baselines[50],
          200: Number.isFinite(nextEma200) ? nextEma200 : baselines[200],
        };
      }

      if (vwapSeriesRef.current !== null) {
        let cp = sessionVwapCheckpointRef.current;
        if (cp === null) {
          cp = buildSessionVwapCheckpoint(closedBarsRef.current, marketTz);
          sessionVwapCheckpointRef.current = cp;
        }
        const vwapPoint = projectLiveSessionVwapFromCheckpoint(cp, projectedBar, marketTz);
        if (vwapPoint !== null) {
          vwapSeriesRef.current.update({ time: vwapPoint.timeSec as UTCTimestamp, value: vwapPoint.value });
        }
      }

      if (volumeDelta > 0 && activeQuote !== null) {
        liveBarCvdDeltaRef.current += activeQuote.direction === 'down' ? -volumeDelta : volumeDelta;
      }

      if (subPaneMode === 'CVD_LEE_READY' && cvdSeriesRef.current !== null && lastCvdRef.current !== null) {
        const projectedCvd = lastCvdRef.current + liveBarCvdDeltaRef.current;
        if (Number.isFinite(projectedCvd)) {
          cvdSeriesRef.current.update({ time: projectedBar.timeSec as UTCTimestamp, value: projectedCvd });
        }
      }
    };

    const scheduleFlush = (): void => {
      if (tickRafIdRef.current !== null) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      tickRafIdRef.current = window.requestAnimationFrame(flushFrame);
    };

    const handleVisibilityChange = (): void => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        (pendingQuoteDirty || pendingTicksByTime.size > 0)
      ) {
        scheduleFlush();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    const unsubBar = subscribeGgalBarTick((event) => {
      if (event.mode !== mode || event.timeframe !== streamTimeframe) return;
      const existing = pendingTicksByTime.get(event.bar.timeSec);
      if ((existing?.bucketRevision ?? 0) > (event.bucketRevision ?? 0)) return;
      pendingTicksByTime.set(event.bar.timeSec, event);
      scheduleFlush();
    });

    const unsubAr = subscribeAtomicQuoteValue('AR', 'GGAL', (quote) => {
      latestArQuote = quote;
      if (coordMode === 'USD_ADR_NASDAQ') return;
      pendingQuoteDirty = true;
      scheduleFlush();
    });

    const unsubUs = subscribeAtomicQuoteValue('US', 'GGAL', (quote) => {
      latestUsQuote = quote;
      if (coordMode === 'ARS_BYMA') return;
      pendingQuoteDirty = true;
      scheduleFlush();
    });

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      unsubBar();
      unsubAr();
      unsubUs();
      if (tickRafIdRef.current !== null) {
        window.cancelAnimationFrame(tickRafIdRef.current);
        tickRafIdRef.current = null;
      }
    };
  }, [coordMode, timeframe, subPaneMode]);

  // Pieza 39: crosshair desacoplado de React — la leyenda OHLCV se actualiza
  // escribiendo textContent directo del DOM (prohibido setState por pixel).
  useEffect(() => {
    const mainChart = mainChartRef.current;
    const legend = crosshairLegendRef.current;
    if (mainChart === null || legend === null) return;
    const formatNumber = (value: number): string =>
      Number.isFinite(value) ? value.toLocaleString('es-AR', { maximumFractionDigits: 2 }) : '—';
    const renderLegend = (bar: { open: number; high: number; low: number; close: number; volume: number } | null): void => {
      if (bar === null) {
        legend.textContent = '';
        return;
      }
      legend.textContent =
        `O ${formatNumber(bar.open)} · H ${formatNumber(bar.high)} · L ${formatNumber(bar.low)} · ` +
        `C ${formatNumber(bar.close)} · V ${bar.volume > 0 ? formatNumber(bar.volume) : '—'}`;
    };
    const handler = (param: MouseEventParams): void => {
      if (param.time === undefined) {
        renderLegend(null);
        return;
      }
      const data = param.seriesData.get(candleSeriesRef.current as ISeriesApi<'Candlestick'>);
      if (data === undefined || data === null) {
        renderLegend(null);
        return;
      }
      const candidate = data as { open?: number; high?: number; low?: number; close?: number };
      if (
        typeof candidate.open !== 'number' ||
        typeof candidate.high !== 'number' ||
        typeof candidate.low !== 'number' ||
        typeof candidate.close !== 'number'
      ) {
        renderLegend(null);
        return;
      }
      const volumePoint =
        volumeSeriesRef.current === null ? undefined : param.seriesData.get(volumeSeriesRef.current);
      const volumeValue =
        volumePoint !== undefined
          ? (volumePoint as unknown as { value?: number }).value
          : undefined;
      const volume = typeof volumeValue === 'number' && Number.isFinite(volumeValue) ? volumeValue : 0;
      renderLegend({ open: candidate.open, high: candidate.high, low: candidate.low, close: candidate.close, volume });
    };
    mainChart.subscribeCrosshairMove(handler);
    return () => {
      mainChart.unsubscribeCrosshairMove(handler);
    };
  }, []);

  const confluenceAlerts = useMemo(
    () => (payload?.status === 'OPERATIONAL' ? (payload.confluenceAlerts ?? []) : []),
    [payload],
  );

  const greekRows = useMemo(
    () => (payload?.status === 'OPERATIONAL' ? (payload.greekProfile ?? []) : []),
    [payload],
  );

  const chartStats = useMemo(() => {
    const bars = payload?.status === 'OPERATIONAL' ? (payload.bars ?? []) : [];
    const barCount = bars.length;
    const ema200Pts = payload?.ema200?.length ?? 0;
    const ema200Ready = barCount >= 200 && ema200Pts > 0;
    const firstBar = bars[0];
    const lastBar = bars[bars.length - 1];
    const fmtDate = (sec: number | undefined): string =>
      sec !== undefined && Number.isFinite(sec)
        ? new Date(sec * 1_000).toISOString().slice(0, 10)
        : '—';
    return {
      barCount,
      ema200Ready,
      startDate: fmtDate(firstBar?.timeSec),
      endDate: fmtDate(lastBar?.timeSec),
      avwapDate: fmtDate(payload?.avwapAnchorUtcSec),
    };
  }, [payload]);

  return (
    <section className="w-full rounded-xl border border-[#1C1C24] bg-[#0A0A0D] p-3">
      {/* Global Coordinate, Timeframe & Anchor Controls */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#1C1C24] pb-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 inline-flex items-center gap-1 text-xs font-semibold text-[#E5E7EB]">
            <Layers className="h-3.5 w-3.5 text-[#E5C76B]" />
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
              className={`rounded border px-2.5 py-1 text-xs font-medium transition ${
                coordMode === id
                  ? 'border-[#E5C76B]/60 bg-[#E5C76B]/15 text-[#E5C76B]'
                  : 'border-[#1C1C24] bg-[#111116] text-[#9CA3AF] hover:border-[#2C2C38] hover:text-[#E5E7EB]'
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
              className={`rounded border px-2 py-0.5 font-mono text-xs transition ${
                timeframe === tf
                  ? 'border-[#E5C76B]/60 bg-[#E5C76B]/15 text-[#E5C76B]'
                  : 'border-[#1C1C24] bg-[#111116] text-[#9CA3AF] hover:border-[#2C2C38] hover:text-[#E5E7EB]'
              }`}
            >
              {tf}
            </button>
          ))}

          <select
            aria-label="AVWAP Anchor"
            value={avwapAnchor}
            onChange={(event) =>
              onChangeAvwapAnchor(event.target.value as GgalAvwapAnchorMode)
            }
            className="ml-1 rounded border border-[#1C1C24] bg-[#111116] px-2 py-1 text-xs text-[#E5E7EB] focus:border-[#E5C76B]/60 focus:outline-none"
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
            className="inline-flex items-center gap-1 rounded border border-[#1C1C24] bg-[#111116] px-2 py-1 text-xs text-[#E5E7EB] hover:border-[#E5C76B]/50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Sync
          </button>
        </div>
      </div>

      {/* Overlay Toggles, Bar Telemetry & Levels */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-3 text-[#9CA3AF]">
          {(
            [
              ['showEmas', 'EMAs 9/21/50/200'],
              ['showSessionVwap', 'VWAP Sesión'],
              ['showAvwap', 'AVWAP ±1σ/±2σ'],
              ['showVolumeProfile', 'Vol Profile & Naked POC'],
              ['showZones', 'FVG / FOB'],
              ['showCone', 'Cono Esperado'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="inline-flex cursor-pointer items-center gap-1 hover:text-[#E5E7EB]">
              <input
                type="checkbox"
                checked={toggles[key]}
                onChange={(event) =>
                  setToggles((prev) => ({
                    ...prev,
                    [key]: event.target.checked,
                  }))
                }
                className="accent-[#E5C76B]"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[#9CA3AF]">
          <span
            title={`Rango: ${chartStats.startDate} → ${chartStats.endDate}`}
            className={`rounded border px-1.5 py-0.5 ${
              chartStats.ema200Ready
                ? 'border-[#22C55E]/35 bg-[#22C55E]/10 text-[#22C55E]'
                : 'border-[#E5C76B]/35 bg-[#E5C76B]/10 text-[#E5C76B]'
            }`}
          >
            {chartStats.barCount.toLocaleString('es-AR')} velas ·{' '}
            {chartStats.ema200Ready ? 'EMA200 OK' : 'EMA200 <200'}
          </span>
          <span className="rounded border border-[#1C1C24] bg-[#111116] px-1.5 py-0.5 text-[#E5C76B]">
            AVWAP desde {chartStats.avwapDate}
          </span>
          <GgalToolbarSpotBadge coordMode={coordMode} fallbackSpot={payload?.spotPrice} />
          <span
            className={`rounded border px-1.5 py-0.5 ${
              hasCone
                ? 'border-[#2DD4BF]/35 bg-[#2DD4BF]/10 text-[#2DD4BF]'
                : 'border-[#64748B]/45 bg-[#64748B]/10 text-[#94A3B8]'
            }`}
          >
            {coneLabel}
          </span>
        </div>
      </div>

      {/* Indicator palette legend */}
      <div className="mb-2 flex flex-wrap items-center gap-3 font-mono text-[9px] text-[#9CA3AF]">
        {(
          [
            ['EMA 9', INDICATOR_COLORS.ema9],
            ['EMA 21', INDICATOR_COLORS.ema21],
            ['EMA 50', INDICATOR_COLORS.ema50],
            ['EMA 200', INDICATOR_COLORS.ema200],
            ['VWAP', INDICATOR_COLORS.sessionVwap],
            ['AVWAP', INDICATOR_COLORS.avwap],
            ['±1σ', INDICATOR_COLORS.cone1],
            ['±2σ', INDICATOR_COLORS.cone2],
            ['POC', INDICATOR_COLORS.poc],
          ] as const
        ).map(([label, color]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span
              className="inline-block h-[2px] w-4 rounded-full"
              style={{ backgroundColor: color }}
            />
            {label}
          </span>
        ))}
      </div>

      {payload?.status === 'OPERATIONAL' && !hasCone && (
        <div className="mb-2 flex items-start gap-1.5 rounded border border-[#64748B]/40 bg-[#111116] px-2.5 py-1.5 font-mono text-[10px] text-[#9CA3AF]">
          <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0 text-[#64748B]" />
          <span>
            Cono no dibujado para {timeframe}: faltan IV ATM o vencimiento activo reales. No se usa
            una proyección sintética.
          </span>
        </div>
      )}

      {confluenceAlerts.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-[#E5C76B]/45 bg-[#111116] px-3 py-1.5 text-xs text-[#E5C76B]">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[#E5C76B]" />
          <span className="font-semibold">Confluencia L2 &lt; ±0.5%:</span>
          {confluenceAlerts.slice(0, 4).map((alert, idx) => (
            <span
              key={`${alert.side}-${String(alert.l2Price)}-${String(idx)}`}
              className="rounded border border-[#E5C76B]/30 bg-[#0A0A0D] px-1.5 py-0.5 font-mono text-[11px] text-[#E5E7EB]"
            >
              {alert.side} {formatCoordPrice(alert.l2Price, coordMode)} (
              {Math.round(alert.l2Size)}) ≈ {alert.targetLabel} (Δ{' '}
              {alert.distancePct.toFixed(2)}%)
            </span>
          ))}
        </div>
      )}

      {error !== null && (
        <div className="mb-2 rounded border border-[#EF4444]/40 bg-[#111116] px-3 py-2 text-xs text-[#EF4444]">
          {error}
        </div>
      )}

      {/* Full-width main chart */}
      <div className="relative w-full overflow-hidden rounded-lg border border-[#1C1C24] bg-[#0A0A0D]">
        <div
          ref={crosshairLegendRef}
          className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-[#0A0A0D]/85 px-2 py-1 font-mono text-[10px] tabular-nums text-[#E5E7EB]"
        />
        <div ref={mainContainerRef} className="h-[640px] w-full" />
      </div>

      {/* Full-width synchronized CVD sub-panel */}
      <div className="mt-2 w-full rounded-lg border border-[#1C1C24] bg-[#0A0A0D] p-1.5">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-1 px-1">
          <span className="text-[11px] font-medium text-[#9CA3AF]">
            Sub-panel CVD (eje X acoplado)
            {subPaneMode === 'CVD_LEE_READY' && (
              <span
                title="Estimado por barra OHLCV (volumen × CLV). No es cinta tick a tick: el modo cambia a TICK_TAPE solo cuando haya cinta real activa."
                className="ml-2 rounded border border-[#1C1C24] bg-[#111116] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[#9CA3AF]"
              >
                CLV · Barras
              </span>
            )}
          </span>
          <div className="flex flex-wrap gap-1">
            {(
              [
                ['CVD_LEE_READY', 'CVD aprox. (CLV)'],
                ['CCL_BRECHA_PCT', 'Brecha CCL (%)'],
                ['REL_STRENGTH_BANKS', 'Fuerza Rel. vs BMA/BBAR/SUPV'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setSubPaneMode(mode);
                  onSubPaneModeChange?.(mode);
                }}
                className={`rounded border px-2 py-0.5 text-[11px] transition ${
                  subPaneMode === mode
                    ? 'border-[#E5C76B]/60 bg-[#E5C76B]/15 text-[#E5C76B]'
                    : 'border-[#1C1C24] bg-[#111116] text-[#9CA3AF] hover:text-[#E5E7EB]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div ref={subContainerRef} className="h-[180px] w-full" />
      </div>

      {/* Fixed bottom block: independent of chart zoom/scroll */}
      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
        <GreekProfilePanel
          rows={greekRows}
          mode={greekMode}
          coordMode={coordMode}
          onChangeMode={setGreekMode}
        />
        <L2LadderPanel
          ladder={payload?.l2Ladder ?? null}
          microstructure={microstructure}
          microstructureError={microstructureError}
          coordMode={coordMode}
        />
        <KeyLevelsPanel
          payload={safePayload}
          coordMode={coordMode}
          visibility={levelVisibility}
          onToggle={toggleLevel}
        />
      </div>
    </section>
  );
}
