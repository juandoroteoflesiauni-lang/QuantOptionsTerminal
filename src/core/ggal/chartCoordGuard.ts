/**
 * Pieza 44 — Guardias puros de coherencia de moneda (`ARS` vs `USD`) y encuadre visible para `GgalDualChartView`.
 *
 * Impide que niveles en ARS (p.ej. $7.500) contaminen el eje Y de la vista ADR USD ($50) o viceversa,
 * y calcula el rango lógico visible sin espacio vacío excesivo a la derecha.
 */

import type {
  GgalChartBarPoint,
  GgalChartStructureZone,
  GgalDualChartCoordMode,
  GgalExpectedConePoint,
  GgalVolumeProfileBin,
  GgalVolumeProfileSummary,
} from './institutionalContracts.js';

export interface OverlayLevelsInput {
  readonly callWall: number;
  readonly putWall: number;
  readonly zeroGamma: number;
  readonly maxPain: number;
}

export interface GuardVolumeProfileInput {
  readonly poc: number | null;
  readonly vah: number | null;
  readonly val: number | null;
  readonly nakedPocs: readonly number[];
  readonly bins: readonly GgalVolumeProfileBin[];
}

export interface FilterOverlayLevelsInput {
  readonly activeCoordMode: GgalDualChartCoordMode;
  readonly payloadCoordMode: GgalDualChartCoordMode;
  readonly bars: readonly GgalChartBarPoint[];
  readonly levels: OverlayLevelsInput;
  readonly zones?: readonly GgalChartStructureZone[];
  readonly expectedCone?: readonly GgalExpectedConePoint[];
  readonly volumeProfile?: GuardVolumeProfileInput | GgalVolumeProfileSummary | null;
}

export interface FilteredOverlayLevelsResult {
  readonly coordMatched: boolean;
  readonly levels: OverlayLevelsInput;
  readonly zones: readonly GgalChartStructureZone[];
  readonly expectedCone: readonly GgalExpectedConePoint[];
  readonly volumeProfile: GgalVolumeProfileSummary | null;
}

export interface VisibleRangeInput {
  readonly totalBars: number;
  readonly maxVisibleBars: number;
  readonly rightPaddingBars?: number;
}

export interface VisibleLogicalRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Valida que un nivel de precio positivo sea coherente con el rango observado de las velas en la moneda activa.
 * Al tener ARS/USD una razón ~100x-150x (`CCL/10`), una banda `[0.2x, 5.0x]` bloquea el 100 % de fugas ARS↔USD.
 */
export function isLevelCoherentWithBars(
  price: number,
  coordMode: GgalDualChartCoordMode,
  barMin: number,
  barMax: number,
): boolean {
  if (coordMode === 'RATIO_CCL') {
    return false;
  }
  if (!Number.isFinite(price) || price <= 0) {
    return false;
  }
  if (!Number.isFinite(barMin) || !Number.isFinite(barMax) || barMin <= 0 || barMax <= 0) {
    return false;
  }
  return price >= barMin * 0.2 && price <= barMax * 5.0;
}

function sanitizeLevel(
  price: number,
  coordMode: GgalDualChartCoordMode,
  barMin: number,
  barMax: number,
): number {
  return isLevelCoherentWithBars(price, coordMode, barMin, barMax) ? price : Number.NaN;
}

/**
 * Filtra y sanea todos los overlays (`callWall`, `putWall`, `zeroGamma`, `maxPain`, zonas, cono y VP)
 * para garantizar coincidencia estricta con la moneda activa del gráfico.
 */
export function filterOverlayLevelsForCoordMode(
  input: FilterOverlayLevelsInput,
): FilteredOverlayLevelsResult {
  const nanLevels: OverlayLevelsInput = {
    callWall: Number.NaN,
    putWall: Number.NaN,
    zeroGamma: Number.NaN,
    maxPain: Number.NaN,
  };

  if (input.payloadCoordMode !== input.activeCoordMode || input.bars.length === 0) {
    return {
      coordMatched: false,
      levels: nanLevels,
      zones: [],
      expectedCone: [],
      volumeProfile: null,
    };
  }

  let barMin = Number.POSITIVE_INFINITY;
  let barMax = Number.NEGATIVE_INFINITY;
  for (const b of input.bars) {
    if (Number.isFinite(b.low) && b.low > 0 && b.low < barMin) barMin = b.low;
    if (Number.isFinite(b.high) && b.high > 0 && b.high > barMax) barMax = b.high;
  }

  if (!Number.isFinite(barMin) || !Number.isFinite(barMax) || barMin <= 0 || barMax <= 0) {
    return {
      coordMatched: false,
      levels: nanLevels,
      zones: [],
      expectedCone: [],
      volumeProfile: null,
    };
  }

  const levels: OverlayLevelsInput = {
    callWall: sanitizeLevel(input.levels.callWall, input.activeCoordMode, barMin, barMax),
    putWall: sanitizeLevel(input.levels.putWall, input.activeCoordMode, barMin, barMax),
    zeroGamma: sanitizeLevel(input.levels.zeroGamma, input.activeCoordMode, barMin, barMax),
    maxPain: sanitizeLevel(input.levels.maxPain, input.activeCoordMode, barMin, barMax),
  };

  const zones = (input.zones ?? []).filter(
    (z) =>
      Number.isFinite(z.low) &&
      Number.isFinite(z.high) &&
      z.low >= barMin * 0.2 &&
      z.high <= barMax * 5.0 &&
      z.high >= z.low,
  );

  const expectedCone = (input.expectedCone ?? []).filter(
    (pt) =>
      Number.isFinite(pt.center) &&
      pt.center >= barMin * 0.2 &&
      pt.center <= barMax * 5.0 &&
      Number.isFinite(pt.upper2Sigma) &&
      pt.upper2Sigma <= barMax * 5.0 &&
      Number.isFinite(pt.lower2Sigma) &&
      pt.lower2Sigma >= barMin * 0.2,
  );

  let volumeProfile: GgalVolumeProfileSummary | null = null;
  if (input.volumeProfile !== undefined && input.volumeProfile !== null) {
    const vp = input.volumeProfile;
    const pocNum = vp.poc ?? Number.NaN;
    const vahNum = vp.vah ?? Number.NaN;
    const valNum = vp.val ?? Number.NaN;
    const validPoc = Number.isFinite(pocNum) && pocNum >= barMin * 0.2 && pocNum <= barMax * 5.0;
    if (validPoc) {
      volumeProfile = {
        poc: pocNum,
        vah: Number.isFinite(vahNum) && vahNum >= barMin * 0.2 && vahNum <= barMax * 5.0 ? vahNum : Number.NaN,
        val: Number.isFinite(valNum) && valNum >= barMin * 0.2 && valNum <= barMax * 5.0 ? valNum : Number.NaN,
        bins: vp.bins.filter(
          (bin: GgalVolumeProfileBin) =>
            Number.isFinite(bin.priceMid) &&
            bin.priceMid >= barMin * 0.2 &&
            bin.priceMid <= barMax * 5.0,
        ),
        nakedPocs: vp.nakedPocs.filter(
          (np: number) => Number.isFinite(np) && np >= barMin * 0.2 && np <= barMax * 5.0,
        ),
      };
    }
  }

  return {
    coordMatched: true,
    levels,
    zones,
    expectedCone,
    volumeProfile,
  };
}

/**
 * Calcula un rango lógico visible sin espacio muerto a la derecha en la apertura o cambio de vista.
 */
export function computeDualChartVisibleRange(
  input: VisibleRangeInput,
): VisibleLogicalRange | null {
  const totalBars = Math.trunc(input.totalBars);
  if (!Number.isFinite(totalBars) || totalBars <= 0) {
    return null;
  }
  const maxVisibleBars = Math.max(10, Math.trunc(input.maxVisibleBars));
  const rightPadding = Math.max(0, Math.trunc(input.rightPaddingBars ?? 2));
  const lastIdx = totalBars - 1;
  const from = totalBars <= maxVisibleBars ? 0 : totalBars - maxVisibleBars;
  const to = lastIdx + rightPadding;
  return { from, to };
}
