/**
 * Primitiva LWC v5 (`ISeriesPrimitive<Time>`) para renderizar bandas horizontales
 * `HVN` / `LVN` y gatillos opcionales OHLCV (`FVG`/`IFVG` + `Liquidity Sweeps`)
 * en `PanoramicPriceChart` sin contribuir jamás al autoescalado del eje derecho
 * (`autoscaleInfo(): null`).
 */

import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type {
  IntradayTriggerZoneDto,
  LiquiditySweepEventDto,
  VolumeProfileNodeZoneDto,
} from '../../data/liveTypes.js';

export const HVN_BAND_FILL_COLOR = 'rgba(56, 189, 248, 0.09)';
export const HVN_BAND_BORDER_COLOR = 'rgba(56, 189, 248, 0.28)';
export const LVN_BAND_FILL_COLOR = 'rgba(245, 158, 11, 0.08)';
export const LVN_BAND_BORDER_COLOR = 'rgba(245, 158, 11, 0.26)';

export const FVG_BULLISH_FILL_COLOR = 'rgba(16, 185, 129, 0.11)';
export const FVG_BULLISH_BORDER_COLOR = 'rgba(16, 185, 129, 0.48)';
export const FVG_BEARISH_FILL_COLOR = 'rgba(244, 63, 94, 0.11)';
export const FVG_BEARISH_BORDER_COLOR = 'rgba(244, 63, 94, 0.48)';
export const IFVG_FILL_COLOR = 'rgba(168, 85, 247, 0.13)';
export const IFVG_BORDER_COLOR = 'rgba(168, 85, 247, 0.58)';

export interface PanoramicBandsDrawState {
  readonly enabled: boolean;
  readonly tickSize: number | null;
  readonly hvnZones: readonly VolumeProfileNodeZoneDto[];
  readonly lvnZones: readonly VolumeProfileNodeZoneDto[];
  readonly triggersEnabled?: boolean;
  readonly triggerZones?: readonly IntradayTriggerZoneDto[];
  readonly sweepMarkers?: readonly LiquiditySweepEventDto[];
}

export class PanoramicBandsPrimitive implements ISeriesPrimitive<Time> {
  private param: SeriesAttachedParameter<Time, SeriesType> | null = null;
  private state: PanoramicBandsDrawState;
  private cachedViews: readonly IPrimitivePaneView[] = [];
  private cachedSignature = '';

  public constructor(initial: PanoramicBandsDrawState = {
    enabled: false,
    tickSize: null,
    hvnZones: [],
    lvnZones: [],
    triggersEnabled: false,
    triggerZones: [],
    sweepMarkers: [],
  }) {
    this.state = initial;
  }

  public autoscaleInfo(): null {
    return null;
  }

  public setState(next: PanoramicBandsDrawState): void {
    const nextTriggerZones = next.triggerZones ?? this.state.triggerZones ?? [];
    const nextSweeps = next.sweepMarkers ?? this.state.sweepMarkers ?? [];
    const nextTriggersEnabled = next.triggersEnabled ?? this.state.triggersEnabled ?? false;
    if (
      this.state.enabled === next.enabled &&
      this.state.tickSize === next.tickSize &&
      this.state.hvnZones === next.hvnZones &&
      this.state.lvnZones === next.lvnZones &&
      (this.state.triggersEnabled ?? false) === nextTriggersEnabled &&
      (this.state.triggerZones ?? []) === nextTriggerZones &&
      (this.state.sweepMarkers ?? []) === nextSweeps
    ) {
      return;
    }
    this.state = {
      ...next,
      triggersEnabled: nextTriggersEnabled,
      triggerZones: nextTriggerZones,
      sweepMarkers: nextSweeps,
    };
    this.cachedSignature = '';
    this.param?.requestUpdate();
  }

  public patchState(partial: Partial<PanoramicBandsDrawState>): void {
    this.setState({
      enabled: partial.enabled ?? this.state.enabled,
      tickSize: partial.tickSize !== undefined ? partial.tickSize : this.state.tickSize,
      hvnZones: partial.hvnZones ?? this.state.hvnZones,
      lvnZones: partial.lvnZones ?? this.state.lvnZones,
      triggersEnabled:
        partial.triggersEnabled !== undefined
          ? partial.triggersEnabled
          : (this.state.triggersEnabled ?? false),
      triggerZones: partial.triggerZones ?? this.state.triggerZones ?? [],
      sweepMarkers: partial.sweepMarkers ?? this.state.sweepMarkers ?? [],
    });
  }

  public getState(): PanoramicBandsDrawState {
    return this.state;
  }

  public attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.param = param;
    this.cachedSignature = '';
  }

  public detached(): void {
    this.param = null;
    this.cachedViews = [];
    this.cachedSignature = '';
  }

  public paneViews(): readonly IPrimitivePaneView[] {
    const param = this.param;
    const {
      enabled,
      tickSize,
      hvnZones,
      lvnZones,
      triggersEnabled = false,
      triggerZones = [],
      sweepMarkers = [],
    } = this.state;
    const hasBands = enabled && (hvnZones.length > 0 || lvnZones.length > 0);
    const hasTriggers = triggersEnabled && (triggerZones.length > 0 || sweepMarkers.length > 0);
    if (param === null || (!hasBands && !hasTriggers)) {
      if (this.cachedViews.length > 0) {
        this.cachedViews = [];
        this.cachedSignature = '';
      }
      return this.cachedViews;
    }

    const sig = `${String(hasBands)}|${String(tickSize)}|${String(hvnZones.length)}|${String(lvnZones.length)}|${String(hasTriggers)}|${String(triggerZones.length)}|${String(sweepMarkers.length)}`;
    if (this.cachedViews.length === 1 && this.cachedSignature === sig) {
      return this.cachedViews;
    }

    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          const { series, chart } = param;
          const width = mediaSize.width;
          const height = mediaSize.height;
          if (width <= 0 || height <= 0) return;

          if (this.state.enabled) {
            const halfTick =
              this.state.tickSize !== null &&
              Number.isFinite(this.state.tickSize) &&
              this.state.tickSize > 0
                ? this.state.tickSize * 0.5
                : 0;

            const drawBand = (zone: VolumeProfileNodeZoneDto): void => {
              if (
                zone.lowPrice === null ||
                zone.highPrice === null ||
                !Number.isFinite(zone.lowPrice) ||
                !Number.isFinite(zone.highPrice)
              ) {
                return;
              }
              const yHigh = series.priceToCoordinate(zone.highPrice + halfTick);
              const yLow = series.priceToCoordinate(zone.lowPrice - halfTick);
              if (yHigh === null || yLow === null) return;
              const rawTop = Math.min(yHigh, yLow);
              const rawHeight = Math.abs(yLow - yHigh);
              const boxH = Math.max(3, rawHeight);
              const top = rawHeight < 3 ? rawTop - (3 - rawHeight) * 0.5 : rawTop;
              if (top > height || top + boxH < 0) return;

              const isHvn = zone.kind === 'HVN';
              context.save();
              context.fillStyle = isHvn ? HVN_BAND_FILL_COLOR : LVN_BAND_FILL_COLOR;
              context.fillRect(0, top, width, boxH);

              context.strokeStyle = isHvn ? HVN_BAND_BORDER_COLOR : LVN_BAND_BORDER_COLOR;
              context.lineWidth = 1;
              if (!isHvn && zone.isPriceGap) {
                context.setLineDash([3, 3]);
              }
              context.beginPath();
              context.moveTo(0, top);
              context.lineTo(width, top);
              context.moveTo(0, top + boxH);
              context.lineTo(width, top + boxH);
              context.stroke();

              if (boxH >= 10) {
                context.fillStyle = isHvn ? 'rgba(56, 189, 248, 0.78)' : 'rgba(245, 158, 11, 0.82)';
                context.font = "9px 'Geist Mono', ui-monospace, SFMono-Regular, monospace";
                const label = isHvn ? 'HVN' : zone.isPriceGap ? 'LVN · GAP' : 'LVN';
                context.fillText(label, 6, Math.min(top + boxH - 2, top + 10));
              }
              context.restore();
            };

            for (const zone of this.state.hvnZones) {
              drawBand(zone);
            }
            for (const zone of this.state.lvnZones) {
              drawBand(zone);
            }
          }

          if (this.state.triggersEnabled === true) {
            const timeScale =
              typeof (chart as { timeScale?: unknown }).timeScale === 'function'
                ? chart.timeScale()
                : null;
            const visibleTriggers = (this.state.triggerZones ?? []).slice(0, 3);
            for (const zone of visibleTriggers) {
              if (!Number.isFinite(zone.gapLow) || !Number.isFinite(zone.gapHigh)) continue;
              const yHigh = series.priceToCoordinate(zone.gapHigh);
              const yLow = series.priceToCoordinate(zone.gapLow);
              if (yHigh === null || yLow === null) continue;
              const rawTop = Math.min(yHigh, yLow);
              const rawHeight = Math.abs(yLow - yHigh);
              const boxH = Math.max(4, rawHeight);
              const top = rawHeight < 4 ? rawTop - (4 - rawHeight) * 0.5 : rawTop;
              if (top > height || top + boxH < 0) continue;

              const rawX =
                timeScale !== null
                  ? timeScale.timeToCoordinate(zone.anchorStartTime as UTCTimestamp) ??
                    timeScale.timeToCoordinate(zone.formedAtTime as UTCTimestamp)
                  : null;
              const startX =
                rawX === null || !Number.isFinite(rawX)
                  ? 0
                  : Math.max(0, Math.min(width - 24, rawX));
              const boxW = Math.max(24, width - startX);

              const fillColor = zone.isInverted
                ? IFVG_FILL_COLOR
                : zone.activeDirection === 'BULLISH'
                  ? FVG_BULLISH_FILL_COLOR
                  : FVG_BEARISH_FILL_COLOR;
              const borderColor = zone.isInverted
                ? IFVG_BORDER_COLOR
                : zone.activeDirection === 'BULLISH'
                  ? FVG_BULLISH_BORDER_COLOR
                  : FVG_BEARISH_BORDER_COLOR;

              context.save();
              context.fillStyle = fillColor;
              context.fillRect(startX, top, boxW, boxH);

              context.strokeStyle = borderColor;
              context.lineWidth = 1;
              if (zone.isInverted || zone.state === 'ACTIVE_PARTIALLY_MITIGATED') {
                context.setLineDash([4, 3]);
              }
              context.strokeRect(startX + 0.5, top + 0.5, Math.max(1, boxW - 1), Math.max(1, boxH - 1));

              if (boxH >= 10) {
                const arrow = zone.activeDirection === 'BULLISH' ? '↑' : '↓';
                const kindTag = zone.isInverted ? 'IFVG' : 'FVG';
                context.fillStyle = zone.isInverted
                  ? 'rgba(216, 180, 254, 0.92)'
                  : zone.activeDirection === 'BULLISH'
                    ? 'rgba(110, 231, 183, 0.90)'
                    : 'rgba(253, 164, 175, 0.90)';
                context.font = "9px 'Geist Mono', ui-monospace, SFMono-Regular, monospace";
                context.fillText(
                  `${kindTag} ${arrow} · OHLCV`,
                  startX + 6,
                  Math.min(top + boxH - 2, top + 10),
                );
              }
              context.restore();
            }

            const sweeps = this.state.sweepMarkers ?? [];
            for (const sweep of sweeps) {
              if (!Number.isFinite(sweep.wickExtreme) || !Number.isFinite(sweep.levelPrice)) continue;
              const xCoord =
                timeScale !== null
                  ? timeScale.timeToCoordinate(sweep.barTime as UTCTimestamp)
                  : null;
              const yCoord = series.priceToCoordinate(sweep.wickExtreme);
              if (xCoord === null || yCoord === null) continue;
              if (xCoord < -8 || xCoord > width + 8 || yCoord < -8 || yCoord > height + 8) continue;

              const isBull = sweep.direction === 'BULLISH';
              const yOffset = isBull ? 7 : -7;
              const yMarker = Math.max(8, Math.min(height - 8, yCoord + yOffset));
              const accent = isBull ? '#34D399' : '#FB7185';
              const shortLevel =
                sweep.levelId === 'CALL_WALL'
                  ? 'CW'
                  : sweep.levelId === 'PUT_WALL'
                    ? 'PW'
                    : sweep.levelId;

              context.save();
              context.fillStyle = accent;
              context.strokeStyle = '#08080D';
              context.lineWidth = 1;
              context.beginPath();
              context.moveTo(xCoord, yMarker - 4);
              context.lineTo(xCoord + 4, yMarker);
              context.lineTo(xCoord, yMarker + 4);
              context.lineTo(xCoord - 4, yMarker);
              context.closePath();
              context.fill();
              context.stroke();

              context.font = "9px 'Geist Mono', ui-monospace, SFMono-Regular, monospace";
              const tag = `SWP ${shortLevel}`;
              const textX = Math.max(4, Math.min(width - 54, xCoord + 6));
              const textY = isBull
                ? Math.min(height - 4, yMarker + 4)
                : Math.max(10, yMarker + 3);
              context.fillText(tag, textX, textY);
              context.restore();
            }
          }
        });
      },
    };

    this.cachedViews = [{ renderer: () => renderer }];
    this.cachedSignature = sig;
    return this.cachedViews;
  }
}
