/**
 * Primitiva LWC v5 (`ISeriesPrimitive<Time>`) para renderizar bandas horizontales
 * `HVN` y `LVN` en `PanoramicPriceChart` sin contribuir jamás al autoescalado
 * del eje derecho (`autoscaleInfo(): null`).
 */

import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { VolumeProfileNodeZoneDto } from '../../data/liveTypes.js';

export const HVN_BAND_FILL_COLOR = 'rgba(56, 189, 248, 0.09)';
export const HVN_BAND_BORDER_COLOR = 'rgba(56, 189, 248, 0.28)';
export const LVN_BAND_FILL_COLOR = 'rgba(245, 158, 11, 0.08)';
export const LVN_BAND_BORDER_COLOR = 'rgba(245, 158, 11, 0.26)';

export interface PanoramicBandsDrawState {
  readonly enabled: boolean;
  readonly tickSize: number | null;
  readonly hvnZones: readonly VolumeProfileNodeZoneDto[];
  readonly lvnZones: readonly VolumeProfileNodeZoneDto[];
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
  }) {
    this.state = initial;
  }

  public autoscaleInfo(): null {
    return null;
  }

  public setState(next: PanoramicBandsDrawState): void {
    if (
      this.state.enabled === next.enabled &&
      this.state.tickSize === next.tickSize &&
      this.state.hvnZones === next.hvnZones &&
      this.state.lvnZones === next.lvnZones
    ) {
      return;
    }
    this.state = next;
    this.cachedSignature = '';
    this.param?.requestUpdate();
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
    const { enabled, tickSize, hvnZones, lvnZones } = this.state;
    if (param === null || !enabled || (hvnZones.length === 0 && lvnZones.length === 0)) {
      if (this.cachedViews.length > 0) {
        this.cachedViews = [];
        this.cachedSignature = '';
      }
      return this.cachedViews;
    }

    const sig = `${String(tickSize)}|${String(hvnZones.length)}|${String(lvnZones.length)}`;
    if (this.cachedViews.length === 1 && this.cachedSignature === sig) {
      return this.cachedViews;
    }

    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        target.useMediaCoordinateSpace(({ context, mediaSize }) => {
          const { series } = param;
          const width = mediaSize.width;
          const height = mediaSize.height;
          if (width <= 0 || height <= 0) return;
          const halfTick = tickSize !== null && Number.isFinite(tickSize) && tickSize > 0 ? tickSize * 0.5 : 0;

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
        });
      },
    };

    this.cachedViews = [{ renderer: () => renderer }];
    this.cachedSignature = sig;
    return this.cachedViews;
  }
}
