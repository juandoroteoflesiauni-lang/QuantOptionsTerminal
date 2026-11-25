/**
 * Motor puro de Perfil de Volumen Multihorizonte (`1D`, `5D`, `20D`, `252R`)
 * y detector topológico determinista de nodos `HVN` / `LVN` (Sub-fase 2 · Pieza 5: S2-1 + S2-2).
 *
 * Garantías de diseño:
 *  - Funciones 100 % puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Timestamps en segundos UTC enteros; sesiones reales `America/New_York` (ET)
 *    vía `sessions.ts` y calendario NYSE 2020–2028 de `usHistorical.ts`.
 *  - Conservación exacta de volumen: `|Σ binVol - totalVolume| <= 1e-9 * max(1, totalVolume)`.
 *  - Zero Silent Fallbacks: cobertura insuficiente o entradas inválidas producen
 *    `NaN` (y `null` en el DTO serializado) y `coverageStatus: 'UNAVAILABLE'`.
 */

import { etWallTimeToUtc } from '../../data/alignment.js';
import { getSessionDateKey } from '../ggal/technicalIndicators.js';
import { getMarketParts, MAX_TIME_SECONDS, sessionKey } from '../sessions.js';
import type { Bar } from '../types.js';
import { usHistoricalSession, type UsSession } from '../usHistorical.js';
import {
  DEFAULT_VALUE_AREA_PCT,
  DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
  priceToBinIndex,
  type VolumeProfileAmtResult,
} from './volumeProfileAmt.js';

export const MAX_PROFILE_BINS = 4_000;
export const VP_HORIZONS = ['1D', '5D', '20D', '252R'] as const;
export const DEFAULT_MAX_HVN_ZONES = 3;
export const DEFAULT_MAX_LVN_ZONES = 3;

const BIN_EPS = 1e-12;
const PLATEAU_REL_EPS = 1e-9;
const SECONDS_PER_DAY = 86_400;

export type VolumeProfileHorizon = (typeof VP_HORIZONS)[number];
export type VolumeProfileCoverageStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
export type VolumeProfileMethodology = 'OHLCV_UNIFORM_BIN';
export type VolumeProfileNodesMethodology = 'OHLCV_UNIFORM_SMOOTHED_PROMINENCE';
export type VolumeProfileSourceTimeframe = '1m' | '5m' | '1D';

export interface VolumeProfileNodeZone {
  readonly kind: 'HVN' | 'LVN';
  readonly startBinIndex: number;
  readonly endBinIndex: number;
  readonly lowPrice: number;
  readonly highPrice: number;
  readonly centerPrice: number;
  readonly volume: number;
  readonly volumeSharePct: number;
  readonly prominence: number;
  readonly prominenceRatio: number;
  readonly isPriceGap: boolean;
}

export interface DetectVolumeProfileNodesOptions {
  readonly minBinIndex: number;
  readonly tickSize: number;
  readonly referencePrice?: number;
  readonly maxHvnZones?: number;
  readonly maxLvnZones?: number;
}

export interface VolumeProfileNodesResult {
  readonly activeStartIndex: number;
  readonly activeEndIndex: number;
  readonly activeBinCount: number;
  readonly neighborhoodRadius: number;
  readonly smoothedPocVolume: number;
  readonly totalVolume: number;
  readonly hvnZones: readonly VolumeProfileNodeZone[];
  readonly lvnZones: readonly VolumeProfileNodeZone[];
  readonly methodology: VolumeProfileNodesMethodology;
}

export interface SessionVolumeHistogram {
  readonly sessionDate: string;
  readonly sourceBarSeconds: number;
  readonly tickSize: number;
  readonly minBinIndex: number;
  readonly maxBinIndex: number;
  readonly binVolumes: readonly number[];
  readonly totalVolume: number;
  readonly pvSum: number;
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly closedBarCount: number;
  readonly firstBarTime: number;
  readonly lastBarTime: number;
  readonly isClosedSession: boolean;
}

export interface HorizonVolumeProfile {
  readonly horizon: VolumeProfileHorizon;
  readonly coverageStatus: VolumeProfileCoverageStatus;
  readonly methodology: VolumeProfileMethodology;
  readonly nodesMethodology: VolumeProfileNodesMethodology;
  readonly sourceTimeframe: VolumeProfileSourceTimeframe;
  readonly sessionsTarget: number;
  readonly sessionsCovered: number;
  readonly tickSize: number;
  readonly closedBarCount: number;
  readonly minBinIndex: number;
  readonly maxBinIndex: number;
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly poc: number;
  readonly vah: number;
  readonly val: number;
  readonly profileVwap: number;
  readonly totalVolume: number;
  readonly valueAreaVolume: number;
  readonly valueAreaCoverage: number;
  readonly hvnZones: readonly VolumeProfileNodeZone[];
  readonly lvnZones: readonly VolumeProfileNodeZone[];
}

export interface MultiHorizonVolumeProfileInput {
  readonly market: 'US' | 'AR';
  readonly symbol: string;
  readonly asOfUtcSec: number;
  readonly rthOnly: boolean;
  readonly tickSize?: number | undefined;
  readonly referencePrice?: number | undefined;
  readonly valueAreaPct?: number | undefined;
  readonly maxHvnZones?: number | undefined;
  readonly maxLvnZones?: number | undefined;
  readonly bars1m?: readonly Bar[] | undefined;
  readonly coveredFrom1m?: number | null | undefined;
  readonly bars5m?: readonly Bar[] | undefined;
  readonly coveredFrom5m?: number | null | undefined;
  readonly bars1d?: readonly Bar[] | undefined;
  readonly existingProfile252R?: VolumeProfileAmtResult | null | undefined;
  readonly cache?: DailySessionHistogramCache | undefined;
  readonly adjustmentRevision?: number | undefined;
}

export interface MultiHorizonVpLiveSeed {
  readonly symbol: string;
  readonly rthOnly: boolean;
  readonly tickSize: number;
  readonly valueAreaPct: number;
  readonly maxHvnZones: number;
  readonly maxLvnZones: number;
  readonly activeSessionDate: string;
  readonly activeSessionOpen: number;
  readonly activeSessionClose: number;
  readonly watermark1mSec: number;
  readonly current1dHistogram: SessionVolumeHistogram | null;
  readonly prior4Closed1d: SessionVolumeHistogram | null;
  readonly current5mSessionHistogram: SessionVolumeHistogram | null;
  readonly prior19Closed5m: SessionVolumeHistogram | null;
  readonly sessions5dCovered: number;
  readonly sessions20dCovered: number;
}

export interface MultiHorizonVolumeProfileResult {
  readonly symbol: string;
  readonly market: 'US' | 'AR';
  readonly asOfUtcSec: number;
  readonly rthOnly: boolean;
  readonly tickSize: number;
  readonly methodology: VolumeProfileMethodology;
  readonly horizons: Readonly<Record<VolumeProfileHorizon, HorizonVolumeProfile>>;
  readonly liveSeed: MultiHorizonVpLiveSeed | null;
}

export interface VolumeProfileNodeZoneDto {
  readonly kind: 'HVN' | 'LVN';
  readonly startBinIndex: number;
  readonly endBinIndex: number;
  readonly lowPrice: number | null;
  readonly highPrice: number | null;
  readonly centerPrice: number | null;
  readonly volume: number | null;
  readonly volumeSharePct: number | null;
  readonly prominence: number | null;
  readonly prominenceRatio: number | null;
  readonly isPriceGap: boolean;
}

export interface HorizonVolumeProfileDto {
  readonly horizon: VolumeProfileHorizon;
  readonly coverageStatus: VolumeProfileCoverageStatus;
  readonly methodology: VolumeProfileMethodology;
  readonly nodesMethodology: VolumeProfileNodesMethodology;
  readonly sourceTimeframe: VolumeProfileSourceTimeframe;
  readonly sessionsTarget: number;
  readonly sessionsCovered: number;
  readonly tickSize: number | null;
  readonly closedBarCount: number;
  readonly minPrice: number | null;
  readonly maxPrice: number | null;
  readonly poc: number | null;
  readonly vah: number | null;
  readonly val: number | null;
  readonly profileVwap: number | null;
  readonly totalVolume: number | null;
  readonly valueAreaVolume: number | null;
  readonly valueAreaCoverage: number | null;
  readonly hvnZones: readonly VolumeProfileNodeZoneDto[];
  readonly lvnZones: readonly VolumeProfileNodeZoneDto[];
}

export type VolumeProfilesByHorizonDto = Readonly<Record<VolumeProfileHorizon, HorizonVolumeProfileDto>>;

export interface VolumeProfilesByHorizonPayloadDto {
  readonly asOfUtcSec: number;
  readonly rthOnly: boolean;
  readonly tickSize: number | null;
  readonly methodology: VolumeProfileMethodology;
  readonly horizons: VolumeProfilesByHorizonDto;
  readonly acquisitionAttempted?: boolean;
}

function isUsableVpBar(bar: Bar): boolean {
  return (
    Number.isSafeInteger(bar.time) &&
    Math.abs(bar.time) <= MAX_TIME_SECONDS &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    Number.isFinite(bar.volume) &&
    bar.open > 0 &&
    bar.high > 0 &&
    bar.low > 0 &&
    bar.close > 0 &&
    bar.high >= bar.low &&
    bar.volume > 0
  );
}

function barTypicalPrice(bar: Bar): number {
  return bar.vw !== undefined && Number.isFinite(bar.vw) && bar.vw > 0
    ? bar.vw
    : (bar.high + bar.low + bar.close) / 3;
}

/**
 * Resuelve un `tickSize` canónico estable por banda de precio para evitar invalidaciones
 * espurias de la caché de histogramas diarios ante oscilaciones menores del spot.
 */
export function resolveCanonicalVpTickSize(referencePrice: number): number {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return Number.NaN;
  }
  if (referencePrice < 5) return 0.01;
  if (referencePrice < 25) return 0.02;
  if (referencePrice < 100) return 0.05;
  if (referencePrice < 250) return 0.10;
  if (referencePrice < 600) return 0.25;
  if (referencePrice < 1_500) return 0.50;
  if (referencePrice < 4_000) return 1.00;
  if (referencePrice < 10_000) return 2.00;
  if (referencePrice < 25_000) return 5.00;
  if (referencePrice < 60_000) return 10.00;
  if (referencePrice < 150_000) return 25.00;
  return 50.00;
}

/**
 * Escala `baseTickSize` por un multiplicador entero positivo cuando el rango `[minPrice, maxPrice]`
 * supera `maxBins` (`MAX_PROFILE_BINS = 4_000`), preservando la rejilla compartida `k * tickSize`.
 */
export function resolveScaledTickSize(
  minPrice: number,
  maxPrice: number,
  baseTickSize: number,
  maxBins: number = MAX_PROFILE_BINS,
): number {
  if (
    !Number.isFinite(minPrice) ||
    !Number.isFinite(maxPrice) ||
    !Number.isFinite(baseTickSize) ||
    baseTickSize <= 0 ||
    maxPrice < minPrice ||
    !Number.isInteger(maxBins) ||
    maxBins < 2
  ) {
    return Number.NaN;
  }
  const initialBins = priceToBinIndex(maxPrice, baseTickSize) - priceToBinIndex(minPrice, baseTickSize) + 1;
  if (initialBins <= maxBins) {
    return baseTickSize;
  }
  let multiplier = Math.max(2, Math.ceil((maxPrice - minPrice) / ((maxBins - 1) * baseTickSize)));
  while (
    priceToBinIndex(maxPrice, baseTickSize * multiplier) -
      priceToBinIndex(minPrice, baseTickSize * multiplier) +
      1 >
    maxBins
  ) {
    multiplier += 1;
  }
  return baseTickSize * multiplier;
}

/** Selección determinista del índice POC (misma regla que `volumeProfileAmt.ts`). */
export function selectPocIndex(
  binVolumes: readonly number[],
  minBinIndex: number,
  tickSize: number,
  profileVwap: number,
): number {
  let maxVol = -1;
  for (const vol of binVolumes) {
    if (vol > maxVol) {
      maxVol = vol;
    }
  }
  const tieEps = BIN_EPS * Math.max(1, maxVol);

  let bestArrayIdx = 0;
  let bestDistToVwap = Number.POSITIVE_INFINITY;
  let bestPrice = Number.POSITIVE_INFINITY;

  for (let i = 0; i < binVolumes.length; i += 1) {
    const vol = binVolumes[i] ?? 0;
    if (vol < maxVol - tieEps) {
      continue;
    }
    const price = (minBinIndex + i) * tickSize;
    const dist = Number.isFinite(profileVwap) ? Math.abs(price - profileVwap) : Number.POSITIVE_INFINITY;

    if (bestPrice === Number.POSITIVE_INFINITY) {
      bestArrayIdx = i;
      bestDistToVwap = dist;
      bestPrice = price;
      continue;
    }

    if (Number.isFinite(profileVwap)) {
      if (dist < bestDistToVwap - tieEps) {
        bestArrayIdx = i;
        bestDistToVwap = dist;
        bestPrice = price;
        continue;
      }
      if (Math.abs(dist - bestDistToVwap) <= tieEps && price < bestPrice) {
        bestArrayIdx = i;
        bestDistToVwap = dist;
        bestPrice = price;
      }
    } else if (price < bestPrice) {
      bestArrayIdx = i;
      bestPrice = price;
    }
  }

  return bestArrayIdx;
}

/** Expansión bilateral del 70 % Value Area (misma regla que `volumeProfileAmt.ts`). */
export function expandValueAreaIndices(
  binVolumes: readonly number[],
  pocArrayIdx: number,
  totalVolume: number,
  valueAreaPct: number = DEFAULT_VALUE_AREA_PCT,
): { readonly lowIdx: number; readonly highIdx: number; readonly coveredVolume: number } {
  let lowIdx = pocArrayIdx;
  let highIdx = pocArrayIdx;
  let coveredVolume = binVolumes[pocArrayIdx] ?? 0;
  const targetVolume = valueAreaPct * totalVolume;
  const eps = BIN_EPS * Math.max(1, totalVolume);

  while (coveredVolume < targetVolume - eps && (lowIdx > 0 || highIdx < binVolumes.length - 1)) {
    const leftVol = lowIdx > 0 ? (binVolumes[lowIdx - 1] ?? 0) : -1;
    const rightVol = highIdx < binVolumes.length - 1 ? (binVolumes[highIdx + 1] ?? 0) : -1;

    if (leftVol < 0) {
      highIdx += 1;
      coveredVolume += rightVol;
    } else if (rightVol < 0) {
      lowIdx -= 1;
      coveredVolume += leftVol;
    } else if (leftVol > rightVol + eps) {
      lowIdx -= 1;
      coveredVolume += leftVol;
    } else if (rightVol > leftVol + eps) {
      highIdx += 1;
      coveredVolume += rightVol;
    } else {
      lowIdx -= 1;
      highIdx += 1;
      coveredVolume += leftVol + rightVol;
    }
  }

  return { lowIdx, highIdx, coveredVolume };
}

function emptyNodesResult(): VolumeProfileNodesResult {
  return {
    activeStartIndex: -1,
    activeEndIndex: -1,
    activeBinCount: 0,
    neighborhoodRadius: 0,
    smoothedPocVolume: Number.NaN,
    totalVolume: 0,
    hvnZones: [],
    lvnZones: [],
    methodology: 'OHLCV_UNIFORM_SMOOTHED_PROMINENCE',
  };
}

function reflectIndex(idx: number, length: number): number {
  if (length <= 1) return 0;
  let k = idx;
  while (k < 0 || k >= length) {
    if (k < 0) {
      k = -k - 1;
    } else {
      k = 2 * length - k - 1;
    }
  }
  return k;
}

interface RawBandCandidate {
  readonly kind: 'HVN' | 'LVN';
  readonly bL: number;
  readonly bR: number;
  readonly centerOffset: number;
  readonly prominence: number;
  readonly isPriceGap: boolean;
}

function plateauTolerance(reference: number): number {
  return PLATEAU_REL_EPS * Math.max(1, reference);
}

/**
 * S2-2: Detector topológico determinista de nodos `HVN` y `LVN` sobre un histograma de volumen.
 *
 * 1. Recorta al soporte activo `[i_min, i_max]` con `V_i > 0` (ningún bin exterior vacío se clasifica).
 * 2. Suaviza únicamente la topología con kernel simétrico `[1,2,3,2,1]/9` y bordes reflejados.
 * 3. Detecta `HVN` por máximos locales en vecindad `w ∈ [2, 12]` con `S_i/S_poc >= 0.35` y prominencia `>= 0.15 * S_poc`.
 * 4. Detecta `LVN` interiores flanqueados por dos clusters activos `>= 0.30 * S_poc` (`S_i/min(peakL,peakR) <= 0.35`)
 *    y consolida gaps internos (`V = 0`) en una sola banda con `isPriceGap: true`.
 * 5. Aplica separación mínima `>= w`, ranking por prominencia + cercanía al spot y tope configurable `3 + 3`.
 */
export function detectVolumeProfileNodes(
  binVolumes: readonly number[],
  options: DetectVolumeProfileNodesOptions,
): VolumeProfileNodesResult {
  if (
    !Number.isInteger(options.minBinIndex) ||
    !Number.isFinite(options.tickSize) ||
    options.tickSize <= 0 ||
    binVolumes.length === 0
  ) {
    return emptyNodesResult();
  }

  const maxHvnZones =
    options.maxHvnZones !== undefined && Number.isInteger(options.maxHvnZones) && options.maxHvnZones >= 0
      ? options.maxHvnZones
      : DEFAULT_MAX_HVN_ZONES;
  const maxLvnZones =
    options.maxLvnZones !== undefined && Number.isInteger(options.maxLvnZones) && options.maxLvnZones >= 0
      ? options.maxLvnZones
      : DEFAULT_MAX_LVN_ZONES;

  let iMin = -1;
  let iMax = -1;
  for (let i = 0; i < binVolumes.length; i += 1) {
    const v = binVolumes[i];
    if (v === undefined || !Number.isFinite(v) || v < 0) {
      return emptyNodesResult();
    }
    if (v > 0) {
      if (iMin === -1) iMin = i;
      iMax = i;
    }
  }
  if (iMin === -1 || iMax === -1) {
    return emptyNodesResult();
  }

  const active = binVolumes.slice(iMin, iMax + 1);
  const n = active.length;
  let totalVolume = 0;
  for (const v of active) {
    totalVolume += v;
  }
  if (totalVolume <= 0) {
    return emptyNodesResult();
  }

  // Suavizado triangular simétrico sin desfase (solo topología).
  const smoothed = new Array<number>(n);
  let smoothedPoc = 0;
  let smoothedMin = Number.POSITIVE_INFINITY;
  for (let u = 0; u < n; u += 1) {
    const s =
      ((active[reflectIndex(u - 2, n)] ?? 0) +
        2 * (active[reflectIndex(u - 1, n)] ?? 0) +
        3 * (active[u] ?? 0) +
        2 * (active[reflectIndex(u + 1, n)] ?? 0) +
        (active[reflectIndex(u + 2, n)] ?? 0)) /
      9;
    smoothed[u] = s;
    if (s > smoothedPoc) smoothedPoc = s;
    if (s < smoothedMin) smoothedMin = s;
  }
  if (smoothedPoc <= 0) {
    return emptyNodesResult();
  }

  const w = Math.min(12, Math.max(2, Math.floor(0.015 * n)));

  // Particionar S en mesetas contiguas maximales (diferencia <= 1e-9 * max(1, ref)).
  const plateaus: Array<{ readonly left: number; readonly right: number; readonly maxVal: number; readonly minVal: number }> = [];
  let cursor = 0;
  while (cursor < n) {
    const anchorVal = smoothed[cursor] ?? 0;
    const tol = plateauTolerance(anchorVal);
    let right = cursor;
    let maxVal = anchorVal;
    let minVal = anchorVal;
    while (right + 1 < n && Math.abs((smoothed[right + 1] ?? 0) - anchorVal) <= tol) {
      right += 1;
      const val = smoothed[right] ?? 0;
      if (val > maxVal) maxVal = val;
      if (val < minVal) minVal = val;
    }
    plateaus.push({ left: cursor, right, maxVal, minVal });
    cursor = right + 1;
  }

  // 1) HVN: máximos locales prominentes.
  const rawHvnBands: Array<{ bL: number; bR: number; prominence: number }> = [];
  const pocEps = plateauTolerance(smoothedPoc);

  for (const p of plateaus) {
    const h = p.maxVal;
    const hEps = plateauTolerance(h);
    if (h / smoothedPoc < 0.35 - BIN_EPS) {
      continue;
    }

    const winStart = Math.max(0, p.left - w);
    const winEnd = Math.min(n - 1, p.right + w);
    let isLocalMax = true;
    for (let j = winStart; j <= winEnd; j += 1) {
      if ((smoothed[j] ?? 0) > h + hEps) {
        isLocalMax = false;
        break;
      }
    }
    if (!isLocalMax) {
      continue;
    }

    // Prominencia topográfica exacta con desempate canónico por menor índice.
    let leftHigher = -1;
    let leftCol = h;
    for (let j = p.left - 1; j >= 0; j -= 1) {
      const sj = smoothed[j] ?? 0;
      if (sj < leftCol) leftCol = sj;
      if (sj > h + hEps || Math.abs(sj - h) <= hEps) {
        leftHigher = j;
        break;
      }
    }

    let rightHigher = -1;
    let rightCol = h;
    for (let j = p.right + 1; j < n; j += 1) {
      const sj = smoothed[j] ?? 0;
      if (sj < rightCol) rightCol = sj;
      if (sj > h + hEps) {
        rightHigher = j;
        break;
      }
    }

    let base: number;
    if (leftHigher !== -1 && rightHigher !== -1) {
      base = Math.max(leftCol, rightCol);
    } else if (leftHigher !== -1) {
      base = leftCol;
    } else if (rightHigher !== -1) {
      base = rightCol;
    } else {
      base = smoothedMin;
    }

    const prominence = Math.max(0, h - base);
    if (prominence < 0.15 * smoothedPoc - pocEps) {
      continue;
    }

    // Expansión de banda: S_j >= 0.75 * h.
    const expandFloor = 0.75 * h - hEps;
    let bL = p.left;
    while (bL > 0 && (smoothed[bL - 1] ?? 0) >= expandFloor) {
      bL -= 1;
    }
    let bR = p.right;
    while (bR + 1 < n && (smoothed[bR + 1] ?? 0) >= expandFloor) {
      bR += 1;
    }
    rawHvnBands.push({ bL, bR, prominence });
  }

  // Fusión de bandas HVN separadas por <= 1 bin.
  rawHvnBands.sort((a, b) => a.bL - b.bL || a.bR - b.bR);
  const mergedHvnBands: Array<{ bL: number; bR: number; prominence: number }> = [];
  for (const band of rawHvnBands) {
    const prev = mergedHvnBands[mergedHvnBands.length - 1];
    if (prev !== undefined && band.bL <= prev.bR + 2) {
      prev.bR = Math.max(prev.bR, band.bR);
      prev.prominence = Math.max(prev.prominence, band.prominence);
    } else {
      mergedHvnBands.push({ ...band });
    }
  }

  const hvnOccupied = new Uint8Array(n);
  for (const band of mergedHvnBands) {
    for (let u = band.bL; u <= band.bR; u += 1) {
      hvnOccupied[u] = 1;
    }
  }

  const hvnCandidates: RawBandCandidate[] = mergedHvnBands.map((band) => {
    let rawVol = 0;
    let weightedOffset = 0;
    for (let u = band.bL; u <= band.bR; u += 1) {
      const vol = active[u] ?? 0;
      rawVol += vol;
      weightedOffset += u * vol;
    }
    const centerOffset = rawVol > 0 ? weightedOffset / rawVol : (band.bL + band.bR) / 2;
    return {
      kind: 'HVN',
      bL: band.bL,
      bR: band.bR,
      centerOffset,
      prominence: band.prominence,
      isPriceGap: false,
    };
  });

  // 2) LVN: valles estructurales interiores + gaps internos consolidados.
  const rawLvnBands: Array<{ bL: number; bR: number; prominence: number; isPriceGap: boolean }> = [];
  if (n >= 3) {
    // Prefix max / suffix max sobre S para consultar picos flanqueantes en O(1).
    const prefixMaxVal = new Array<number>(n);
    const prefixMaxIdx = new Array<number>(n);
    let curMax = -1;
    let curIdx = 0;
    for (let u = 0; u < n; u += 1) {
      const su = smoothed[u] ?? 0;
      if (su > curMax) {
        curMax = su;
        curIdx = u;
      }
      prefixMaxVal[u] = curMax;
      prefixMaxIdx[u] = curIdx;
    }

    const suffixMaxVal = new Array<number>(n);
    const suffixMaxIdx = new Array<number>(n);
    curMax = -1;
    curIdx = n - 1;
    for (let u = n - 1; u >= 0; u -= 1) {
      const su = smoothed[u] ?? 0;
      if (su > curMax) {
        curMax = su;
        curIdx = u;
      }
      suffixMaxVal[u] = curMax;
      suffixMaxIdx[u] = curIdx;
    }

    const minFlankPeak = 0.30 * smoothedPoc - pocEps;

    // 2a. Mínimos locales suavizados estrictamente interiores.
    for (const p of plateaus) {
      if (p.left === 0 || p.right === n - 1) {
        continue;
      }
      const v = p.minVal;
      const winStart = Math.max(0, p.left - w);
      const winEnd = Math.min(n - 1, p.right + w);
      let isLocalMin = true;
      for (let j = winStart; j <= winEnd; j += 1) {
        if ((smoothed[j] ?? 0) < v - pocEps) {
          isLocalMin = false;
          break;
        }
      }
      if (!isLocalMin) {
        continue;
      }

      const sPeakL = prefixMaxVal[p.left - 1] ?? 0;
      const idxPeakL = prefixMaxIdx[p.left - 1] ?? 0;
      const sPeakR = suffixMaxVal[p.right + 1] ?? 0;
      const idxPeakR = suffixMaxIdx[p.right + 1] ?? n - 1;
      if (sPeakL < minFlankPeak || sPeakR < minFlankPeak) {
        continue;
      }
      const flankRef = Math.min(sPeakL, sPeakR);
      if (flankRef <= 0 || v / flankRef > 0.35 + BIN_EPS) {
        continue;
      }

      const prominence = Math.max(0, flankRef - v);
      let hasZeroInPlateau = false;
      for (let u = p.left; u <= p.right; u += 1) {
        if ((active[u] ?? 0) === 0) {
          hasZeroInPlateau = true;
          break;
        }
      }

      let bL = p.left;
      let bR = p.right;
      if (!hasZeroInPlateau) {
        const cap = Math.min(0.35 * flankRef, v + 0.25 * (flankRef - v)) + pocEps;
        while (
          bL - 1 > idxPeakL &&
          bL - 1 > 0 &&
          hvnOccupied[bL - 1] === 0 &&
          (active[bL - 1] ?? 0) > 0 &&
          (smoothed[bL - 1] ?? Number.POSITIVE_INFINITY) <= cap
        ) {
          bL -= 1;
        }
        while (
          bR + 1 < idxPeakR &&
          bR + 1 < n - 1 &&
          hvnOccupied[bR + 1] === 0 &&
          (active[bR + 1] ?? 0) > 0 &&
          (smoothed[bR + 1] ?? Number.POSITIVE_INFINITY) <= cap
        ) {
          bR += 1;
        }
        rawLvnBands.push({ bL, bR, prominence, isPriceGap: false });
      } else {
        // Si la meseta contiene bins con volumen 0, restringir el candidato de gap puro
        // a los bins exactos con volumen 0; la etapa 2b los consolidará limpiamente.
        let gapMinS = Number.POSITIVE_INFINITY;
        for (let u = p.left; u <= p.right; u += 1) {
          if ((active[u] ?? 0) === 0) {
            const su = smoothed[u] ?? 0;
            if (su < gapMinS) gapMinS = su;
          }
        }
        const firstZero = active.findIndex((val, idx) => idx >= p.left && idx <= p.right && val === 0);
        let lastZero = firstZero;
        for (let u = p.right; u >= p.left; u -= 1) {
          if ((active[u] ?? 0) === 0) {
            lastZero = u;
            break;
          }
        }
        if (firstZero > 0 && lastZero < n - 1) {
          rawLvnBands.push({
            bL: firstZero,
            bR: lastZero,
            prominence: Math.max(0, flankRef - gapMinS),
            isPriceGap: true,
          });
        }
      }
    }

    // 2b. Gaps internos explícitos (V = 0) entre dos distribuciones negociadas.
    let gCursor = 1;
    while (gCursor < n - 1) {
      if ((active[gCursor] ?? 0) !== 0) {
        gCursor += 1;
        continue;
      }
      const gL = gCursor;
      let gR = gCursor;
      while (gR + 1 < n - 1 && (active[gR + 1] ?? 0) === 0) {
        gR += 1;
      }
      const sPeakL = prefixMaxVal[gL - 1] ?? 0;
      const sPeakR = suffixMaxVal[gR + 1] ?? 0;
      if (sPeakL >= minFlankPeak && sPeakR >= minFlankPeak) {
        const flankRef = Math.min(sPeakL, sPeakR);
        let minS = Number.POSITIVE_INFINITY;
        for (let u = gL; u <= gR; u += 1) {
          const su = smoothed[u] ?? 0;
          if (su < minS) minS = su;
        }
        rawLvnBands.push({
          bL: gL,
          bR: gR,
          prominence: Math.max(0, flankRef - minS),
          isPriceGap: true,
        });
      }
      gCursor = gR + 1;
    }
  }

  // Fusión de bandas LVN / gaps internos separadas por <= 1 bin en una banda consolidada.
  rawLvnBands.sort((a, b) => a.bL - b.bL || a.bR - b.bR);
  const mergedLvnBands: Array<{ bL: number; bR: number; prominence: number; isPriceGap: boolean }> = [];
  for (const band of rawLvnBands) {
    const prev = mergedLvnBands[mergedLvnBands.length - 1];
    if (prev !== undefined && band.bL <= prev.bR + 2) {
      prev.bR = Math.max(prev.bR, band.bR);
      prev.prominence = Math.max(prev.prominence, band.prominence);
      prev.isPriceGap = prev.isPriceGap || band.isPriceGap;
    } else {
      mergedLvnBands.push({ ...band });
    }
  }

  const lvnCandidates: RawBandCandidate[] = mergedLvnBands.map((band) => {
    let hasZero = band.isPriceGap;
    if (!hasZero) {
      for (let u = band.bL; u <= band.bR; u += 1) {
        if ((active[u] ?? 0) === 0) {
          hasZero = true;
          break;
        }
      }
    }
    return {
      kind: 'LVN',
      bL: band.bL,
      bR: band.bR,
      centerOffset: (band.bL + band.bR) / 2,
      prominence: band.prominence,
      isPriceGap: hasZero,
    };
  });

  // Ranking por prominencia + cercanía al precio de referencia + separación mínima >= w bins + tope.
  const priceSpan = Math.max(options.tickSize, (n - 1) * options.tickSize);
  const refPrice =
    options.referencePrice !== undefined && Number.isFinite(options.referencePrice) && options.referencePrice > 0
      ? options.referencePrice
      : Number.NaN;

  const finalizeAndSelect = (
    candidates: readonly RawBandCandidate[],
    limit: number,
  ): VolumeProfileNodeZone[] => {
    if (limit <= 0 || candidates.length === 0) return [];
    const scored = candidates.map((cand) => {
      const startBinIndex = options.minBinIndex + iMin + cand.bL;
      const endBinIndex = options.minBinIndex + iMin + cand.bR;
      const lowPrice = startBinIndex * options.tickSize;
      const highPrice = endBinIndex * options.tickSize;
      const centerPrice = (options.minBinIndex + iMin + cand.centerOffset) * options.tickSize;
      let rawVolume = 0;
      for (let u = cand.bL; u <= cand.bR; u += 1) {
        rawVolume += active[u] ?? 0;
      }
      const volumeSharePct = (100 * rawVolume) / totalVolume;
      const prominenceRatio = cand.prominence / smoothedPoc;
      const distNorm = Number.isFinite(refPrice) ? Math.abs(centerPrice - refPrice) / priceSpan : 0;
      const proximityFactor = 1 / (1 + distNorm);
      const rankScore = Number.isFinite(refPrice)
        ? prominenceRatio * (0.70 + 0.30 * proximityFactor)
        : prominenceRatio;
      return {
        zone: {
          kind: cand.kind,
          startBinIndex,
          endBinIndex,
          lowPrice,
          highPrice,
          centerPrice,
          volume: rawVolume,
          volumeSharePct,
          prominence: cand.prominence,
          prominenceRatio,
          isPriceGap: cand.isPriceGap,
        } satisfies VolumeProfileNodeZone,
        centerOffset: cand.centerOffset,
        rankScore,
        distAbs: Number.isFinite(refPrice) ? Math.abs(centerPrice - refPrice) : centerPrice,
      };
    });

    scored.sort((a, b) => {
      if (Math.abs(b.rankScore - a.rankScore) > 1e-12) return b.rankScore - a.rankScore;
      if (Math.abs(b.zone.prominence - a.zone.prominence) > 1e-12) {
        return b.zone.prominence - a.zone.prominence;
      }
      if (Math.abs(a.distAbs - b.distAbs) > 1e-12) return a.distAbs - b.distAbs;
      return a.zone.centerPrice - b.zone.centerPrice;
    });

    const selected: Array<(typeof scored)[number]> = [];
    for (const item of scored) {
      if (selected.length >= limit) break;
      const tooClose = selected.some((kept) => Math.abs(item.centerOffset - kept.centerOffset) < w - 1e-9);
      if (!tooClose) {
        selected.push(item);
      }
    }
    return selected.map((item) => item.zone);
  };

  return {
    activeStartIndex: iMin,
    activeEndIndex: iMax,
    activeBinCount: n,
    neighborhoodRadius: w,
    smoothedPocVolume: smoothedPoc,
    totalVolume,
    hvnZones: finalizeAndSelect(hvnCandidates, maxHvnZones),
    lvnZones: finalizeAndSelect(lvnCandidates, maxLvnZones),
    methodology: 'OHLCV_UNIFORM_SMOOTHED_PROMINENCE',
  };
}

/**
 * Enumera las `count` ruedas NYSE efectivas más recientes cerradas o abiertas hasta `asOfUtcSec`,
 * respetando calendario 2020–2028, feriados, cierres anticipados 13:00 ET y DST.
 */
export function enumerateRecentUsSessions(
  asOfUtcSec: number,
  count: number,
  rthOnly: boolean,
  barSeconds: number,
): readonly UsSession[] {
  if (
    !Number.isSafeInteger(asOfUtcSec) ||
    Math.abs(asOfUtcSec) > MAX_TIME_SECONDS ||
    !Number.isInteger(count) ||
    count <= 0 ||
    !Number.isInteger(barSeconds) ||
    barSeconds <= 0
  ) {
    return [];
  }
  const p = getMarketParts(asOfUtcSec, 'EQUITY');
  if (p.year < 2020 || p.year > 2028) {
    return [];
  }

  const sessions: UsSession[] = [];
  const noonUtcBase = Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0) / 1_000;
  for (let offsetDays = 0; offsetDays < 3650 && sessions.length < count; offsetDays += 1) {
    const probeDate = new Date((noonUtcBase - offsetDays * SECONDS_PER_DAY) * 1_000);
    const probeTime = etWallTimeToUtc(
      probeDate.getUTCFullYear(),
      probeDate.getUTCMonth() + 1,
      probeDate.getUTCDate(),
      720,
    );
    let session: UsSession | null;
    try {
      session = usHistoricalSession(probeTime);
    } catch {
      return [];
    }
    if (session === null) continue;
    const sessionStart = rthOnly ? session.open : session.extendedOpen;
    if (asOfUtcSec >= sessionStart + barSeconds) {
      sessions.push(session);
    }
  }
  return sessions.reverse();
}

/** Construye el histograma de una sesión individual a partir de sus barras cerradas. */
export function buildSessionVolumeHistogram(
  sessionDate: string,
  bars: readonly Bar[],
  sourceBarSeconds: number,
  tickSize: number,
  isClosedSession: boolean,
): SessionVolumeHistogram | null {
  if (!Number.isFinite(tickSize) || tickSize <= 0 || !Number.isInteger(sourceBarSeconds) || sourceBarSeconds <= 0) {
    return null;
  }
  let minBinIndex = Number.POSITIVE_INFINITY;
  let maxBinIndex = Number.NEGATIVE_INFINITY;
  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;
  let usableCount = 0;

  for (const bar of bars) {
    if (!isUsableVpBar(bar)) continue;
    usableCount += 1;
    if (bar.low < minPrice) minPrice = bar.low;
    if (bar.high > maxPrice) maxPrice = bar.high;
    const lowIdx = bar.high === bar.low ? priceToBinIndex(bar.close, tickSize) : priceToBinIndex(bar.low, tickSize);
    const highIdx = bar.high === bar.low ? lowIdx : priceToBinIndex(bar.high, tickSize);
    if (lowIdx < minBinIndex) minBinIndex = lowIdx;
    if (highIdx > maxBinIndex) maxBinIndex = highIdx;
  }
  if (usableCount === 0) return null;

  const span = maxBinIndex - minBinIndex + 1;
  if (span > MAX_PROFILE_BINS) {
    return null;
  }

  const binVolumes = new Array<number>(span).fill(0);
  let totalVolume = 0;
  let pvSum = 0;
  let firstBarTime = Number.POSITIVE_INFINITY;
  let lastBarTime = Number.NEGATIVE_INFINITY;

  for (const bar of bars) {
    if (!isUsableVpBar(bar)) continue;
    const lowIdx = bar.high === bar.low ? priceToBinIndex(bar.close, tickSize) : priceToBinIndex(bar.low, tickSize);
    const highIdx = bar.high === bar.low ? lowIdx : priceToBinIndex(bar.high, tickSize);
    const countBins = highIdx - lowIdx + 1;
    const perBin = bar.volume / countBins;
    for (let idx = lowIdx; idx <= highIdx; idx += 1) {
      const offset = idx - minBinIndex;
      binVolumes[offset] = (binVolumes[offset] ?? 0) + perBin;
    }
    totalVolume += bar.volume;
    pvSum += barTypicalPrice(bar) * bar.volume;
    if (bar.time < firstBarTime) firstBarTime = bar.time;
    if (bar.time > lastBarTime) lastBarTime = bar.time;
  }

  if (totalVolume <= 0) return null;

  return Object.freeze({
    sessionDate,
    sourceBarSeconds,
    tickSize,
    minBinIndex,
    maxBinIndex,
    binVolumes: Object.freeze(binVolumes),
    totalVolume,
    pvSum,
    minPrice,
    maxPrice,
    closedBarCount: usableCount,
    firstBarTime,
    lastBarTime,
    isClosedSession,
  });
}

/**
 * Actualización incremental O(B_bar) al cerrar una barra `1m` o `5m` sin mutar el histograma previo.
 */
export function appendClosedBarToSessionHistogram(
  prev: SessionVolumeHistogram | null,
  bar: Bar,
  sessionDate: string,
  sourceBarSeconds: number,
  tickSize: number,
  isClosedSession = false,
): SessionVolumeHistogram | null {
  if (!isUsableVpBar(bar)) {
    return prev;
  }
  if (prev === null) {
    return buildSessionVolumeHistogram(sessionDate, [bar], sourceBarSeconds, tickSize, isClosedSession);
  }
  if (prev.tickSize !== tickSize || prev.sessionDate !== sessionDate) {
    return prev;
  }
  if (bar.time <= prev.lastBarTime) {
    return prev;
  }

  const lowIdx = bar.high === bar.low ? priceToBinIndex(bar.close, tickSize) : priceToBinIndex(bar.low, tickSize);
  const highIdx = bar.high === bar.low ? lowIdx : priceToBinIndex(bar.high, tickSize);
  const nextMinBin = Math.min(prev.minBinIndex, lowIdx);
  const nextMaxBin = Math.max(prev.maxBinIndex, highIdx);
  const nextSpan = nextMaxBin - nextMinBin + 1;
  if (nextSpan > MAX_PROFILE_BINS) {
    return prev;
  }

  const nextBins = new Array<number>(nextSpan).fill(0);
  const prevShift = prev.minBinIndex - nextMinBin;
  for (let i = 0; i < prev.binVolumes.length; i += 1) {
    nextBins[prevShift + i] = prev.binVolumes[i] ?? 0;
  }

  const countBins = highIdx - lowIdx + 1;
  const perBin = bar.volume / countBins;
  for (let idx = lowIdx; idx <= highIdx; idx += 1) {
    const offset = idx - nextMinBin;
    nextBins[offset] = (nextBins[offset] ?? 0) + perBin;
  }

  return Object.freeze({
    sessionDate,
    sourceBarSeconds: prev.sourceBarSeconds,
    tickSize,
    minBinIndex: nextMinBin,
    maxBinIndex: nextMaxBin,
    binVolumes: Object.freeze(nextBins),
    totalVolume: prev.totalVolume + bar.volume,
    pvSum: prev.pvSum + barTypicalPrice(bar) * bar.volume,
    minPrice: Math.min(prev.minPrice, bar.low),
    maxPrice: Math.max(prev.maxPrice, bar.high),
    closedBarCount: prev.closedBarCount + 1,
    firstBarTime: Math.min(prev.firstBarTime, bar.time),
    lastBarTime: Math.max(prev.lastBarTime, bar.time),
    isClosedSession,
  });
}

function emptyHorizonProfile(
  horizon: VolumeProfileHorizon,
  sourceTimeframe: VolumeProfileSourceTimeframe,
  sessionsTarget: number,
  tickSize: number,
): HorizonVolumeProfile {
  return {
    horizon,
    coverageStatus: 'UNAVAILABLE',
    methodology: 'OHLCV_UNIFORM_BIN',
    nodesMethodology: 'OHLCV_UNIFORM_SMOOTHED_PROMINENCE',
    sourceTimeframe,
    sessionsTarget,
    sessionsCovered: 0,
    tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : Number.NaN,
    closedBarCount: 0,
    minBinIndex: 0,
    maxBinIndex: -1,
    minPrice: Number.NaN,
    maxPrice: Number.NaN,
    poc: Number.NaN,
    vah: Number.NaN,
    val: Number.NaN,
    profileVwap: Number.NaN,
    totalVolume: 0,
    valueAreaVolume: 0,
    valueAreaCoverage: Number.NaN,
    hvnZones: [],
    lvnZones: [],
  };
}

/**
 * Suma una lista de histogramas diarios sobre su rejilla compartida `k * tickSize`,
 * re-escalando si el rango excede `MAX_PROFILE_BINS` y conservando exactamente el volumen total.
 */
export function mergeSessionVolumeHistograms(
  histograms: readonly SessionVolumeHistogram[],
  options: {
    readonly horizon: VolumeProfileHorizon;
    readonly sourceTimeframe: VolumeProfileSourceTimeframe;
    readonly sessionsTarget: number;
    readonly sessionsCovered: number;
    readonly coverageStatus: VolumeProfileCoverageStatus;
    readonly valueAreaPct?: number;
    readonly referencePrice?: number;
    readonly maxHvnZones?: number;
    readonly maxLvnZones?: number;
  },
): HorizonVolumeProfile {
  const valid = histograms.filter((h) => h.totalVolume > 0 && h.binVolumes.length > 0);
  const firstTick = valid[0]?.tickSize ?? Number.NaN;
  if (valid.length === 0 || !Number.isFinite(firstTick) || firstTick <= 0) {
    return emptyHorizonProfile(options.horizon, options.sourceTimeframe, options.sessionsTarget, firstTick);
  }

  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;
  let minBinIndex = Number.POSITIVE_INFINITY;
  let maxBinIndex = Number.NEGATIVE_INFINITY;
  let totalVolume = 0;
  let pvSum = 0;
  let closedBarCount = 0;

  for (const h of valid) {
    if (h.tickSize !== firstTick) {
      return emptyHorizonProfile(options.horizon, options.sourceTimeframe, options.sessionsTarget, firstTick);
    }
    if (h.minPrice < minPrice) minPrice = h.minPrice;
    if (h.maxPrice > maxPrice) maxPrice = h.maxPrice;
    if (h.minBinIndex < minBinIndex) minBinIndex = h.minBinIndex;
    if (h.maxBinIndex > maxBinIndex) maxBinIndex = h.maxBinIndex;
    totalVolume += h.totalVolume;
    pvSum += h.pvSum;
    closedBarCount += h.closedBarCount;
  }

  if (totalVolume <= 0) {
    return emptyHorizonProfile(options.horizon, options.sourceTimeframe, options.sessionsTarget, firstTick);
  }

  let effectiveTickSize = firstTick;
  let mergedMinBin = minBinIndex;
  let mergedMaxBin = maxBinIndex;
  let binVolumes: number[];

  if (maxBinIndex - minBinIndex + 1 <= MAX_PROFILE_BINS) {
    binVolumes = new Array<number>(maxBinIndex - minBinIndex + 1).fill(0);
    for (const h of valid) {
      const shift = h.minBinIndex - minBinIndex;
      for (let i = 0; i < h.binVolumes.length; i += 1) {
        binVolumes[shift + i] = (binVolumes[shift + i] ?? 0) + (h.binVolumes[i] ?? 0);
      }
    }
  } else {
    effectiveTickSize = resolveScaledTickSize(
      minBinIndex * firstTick,
      maxBinIndex * firstTick,
      firstTick,
      MAX_PROFILE_BINS,
    );
    mergedMinBin = priceToBinIndex(minBinIndex * firstTick, effectiveTickSize);
    mergedMaxBin = priceToBinIndex(maxBinIndex * firstTick, effectiveTickSize);
    binVolumes = new Array<number>(mergedMaxBin - mergedMinBin + 1).fill(0);
    for (const h of valid) {
      for (let i = 0; i < h.binVolumes.length; i += 1) {
        const vol = h.binVolumes[i] ?? 0;
        if (vol <= 0) continue;
        const binPrice = (h.minBinIndex + i) * firstTick;
        const coarseIdx = priceToBinIndex(binPrice, effectiveTickSize) - mergedMinBin;
        binVolumes[coarseIdx] = (binVolumes[coarseIdx] ?? 0) + vol;
      }
    }
  }

  const profileVwap = pvSum / totalVolume;
  const valueAreaPct = options.valueAreaPct ?? DEFAULT_VALUE_AREA_PCT;
  const pocArrayIdx = selectPocIndex(binVolumes, mergedMinBin, effectiveTickSize, profileVwap);
  const va = expandValueAreaIndices(binVolumes, pocArrayIdx, totalVolume, valueAreaPct);
  const nodes = detectVolumeProfileNodes(binVolumes, {
    minBinIndex: mergedMinBin,
    tickSize: effectiveTickSize,
    ...(options.referencePrice !== undefined ? { referencePrice: options.referencePrice } : {}),
    ...(options.maxHvnZones !== undefined ? { maxHvnZones: options.maxHvnZones } : {}),
    ...(options.maxLvnZones !== undefined ? { maxLvnZones: options.maxLvnZones } : {}),
  });

  return {
    horizon: options.horizon,
    coverageStatus: options.coverageStatus,
    methodology: 'OHLCV_UNIFORM_BIN',
    nodesMethodology: nodes.methodology,
    sourceTimeframe: options.sourceTimeframe,
    sessionsTarget: options.sessionsTarget,
    sessionsCovered: options.sessionsCovered,
    tickSize: effectiveTickSize,
    closedBarCount,
    minBinIndex: mergedMinBin,
    maxBinIndex: mergedMaxBin,
    minPrice,
    maxPrice,
    poc: (mergedMinBin + pocArrayIdx) * effectiveTickSize,
    val: (mergedMinBin + va.lowIdx) * effectiveTickSize,
    vah: (mergedMinBin + va.highIdx) * effectiveTickSize,
    profileVwap,
    totalVolume,
    valueAreaVolume: va.coveredVolume,
    valueAreaCoverage: va.coveredVolume / totalVolume,
    hvnZones: nodes.hvnZones,
    lvnZones: nodes.lvnZones,
  };
}

interface DailyFingerprint {
  readonly closedBarCount: number;
  readonly totalVolume: number;
  readonly firstBarTime: number;
  readonly lastBarTime: number;
  readonly minPrice: number;
  readonly maxPrice: number;
}

export interface DailyHistogramCacheStats {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly invalidations: number;
}

/**
 * Caché LRU acotada de histogramas diarios cerrados inmutables por rueda efectiva.
 * Invalida automáticamente las entradas de un símbolo ante un cambio de `adjustmentRevision`
 * o una revisión OHLCV observada en la sesión cerrada.
 */
export class DailySessionHistogramCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, { readonly symbol: string; readonly histogram: SessionVolumeHistogram; readonly fingerprint: DailyFingerprint }>();
  private readonly revisionBySymbol = new Map<string, number>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private invalidations = 0;

  public constructor(options: { readonly maxEntries?: number } = {}) {
    this.maxEntries =
      options.maxEntries !== undefined && Number.isInteger(options.maxEntries) && options.maxEntries > 0
        ? options.maxEntries
        : 512;
  }

  public ensureSymbolRevision(symbol: string, revision: number): void {
    const prev = this.revisionBySymbol.get(symbol);
    if (prev !== undefined && prev !== revision) {
      this.invalidateSymbol(symbol);
    }
    this.revisionBySymbol.set(symbol, revision);
  }

  public invalidateSymbol(symbol: string): void {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.symbol === symbol) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.invalidations += removed;
    }
  }

  public clear(): void {
    this.entries.clear();
    this.revisionBySymbol.clear();
  }

  private buildKey(
    symbol: string,
    sourceBarSeconds: number,
    rthOnly: boolean,
    tickSize: number,
    sessionDate: string,
  ): string {
    return `${symbol}|${String(sourceBarSeconds)}|${rthOnly ? 'RTH' : 'EXT'}|${String(tickSize)}|${sessionDate}`;
  }

  public get(
    symbol: string,
    sourceBarSeconds: number,
    rthOnly: boolean,
    tickSize: number,
    sessionDate: string,
  ): SessionVolumeHistogram | null {
    const key = this.buildKey(symbol, sourceBarSeconds, rthOnly, tickSize, sessionDate);
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.misses += 1;
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, existing);
    this.hits += 1;
    return existing.histogram;
  }

  public getOrComputeClosedSession(
    symbol: string,
    sourceBarSeconds: number,
    rthOnly: boolean,
    tickSize: number,
    sessionDate: string,
    sessionBars: readonly Bar[],
  ): SessionVolumeHistogram | null {
    const key = this.buildKey(symbol, sourceBarSeconds, rthOnly, tickSize, sessionDate);
    const fingerprint = computeFingerprint(sessionBars);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (fingerprint === null || fingerprintsEqual(existing.fingerprint, fingerprint)) {
        this.entries.delete(key);
        this.entries.set(key, existing);
        this.hits += 1;
        return existing.histogram;
      }
      // Revisión OHLC / split detectada en sesión previamente cerrada -> invalidar símbolo completo.
      this.invalidateSymbol(symbol);
    }

    this.misses += 1;
    const computed = buildSessionVolumeHistogram(sessionDate, sessionBars, sourceBarSeconds, tickSize, true);
    if (computed === null || fingerprint === null) {
      return computed;
    }

    this.entries.set(key, { symbol, histogram: computed, fingerprint });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
    return computed;
  }

  public stats(): DailyHistogramCacheStats {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      invalidations: this.invalidations,
    };
  }
}

function computeFingerprint(bars: readonly Bar[]): DailyFingerprint | null {
  let closedBarCount = 0;
  let totalVolume = 0;
  let firstBarTime = Number.POSITIVE_INFINITY;
  let lastBarTime = Number.NEGATIVE_INFINITY;
  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;
  for (const b of bars) {
    if (!isUsableVpBar(b)) continue;
    closedBarCount += 1;
    totalVolume += b.volume;
    if (b.time < firstBarTime) firstBarTime = b.time;
    if (b.time > lastBarTime) lastBarTime = b.time;
    if (b.low < minPrice) minPrice = b.low;
    if (b.high > maxPrice) maxPrice = b.high;
  }
  if (closedBarCount === 0) return null;
  return { closedBarCount, totalVolume, firstBarTime, lastBarTime, minPrice, maxPrice };
}

function fingerprintsEqual(a: DailyFingerprint, b: DailyFingerprint): boolean {
  return (
    a.closedBarCount === b.closedBarCount &&
    a.firstBarTime === b.firstBarTime &&
    a.lastBarTime === b.lastBarTime &&
    Object.is(a.totalVolume, b.totalVolume) &&
    Object.is(a.minPrice, b.minPrice) &&
    Object.is(a.maxPrice, b.maxPrice)
  );
}

function partitionBarsByUsSessions(
  bars: readonly Bar[],
  barSeconds: number,
  asOfUtcSec: number,
  sessions: readonly UsSession[],
  rthOnly: boolean,
): Map<string, Bar[]> {
  const byDate = new Map<string, Bar[]>();
  if (sessions.length === 0 || bars.length === 0) return byDate;
  const sessionByDate = new Map(sessions.map((s) => [s.dateKey, s] as const));
  const minWindowStart = (() => {
    const first = sessions[0];
    return first === undefined ? Number.POSITIVE_INFINITY : rthOnly ? first.open : first.extendedOpen;
  })();

  for (const bar of bars) {
    if (!isUsableVpBar(bar)) continue;
    if (bar.time < minWindowStart || bar.time + barSeconds > asOfUtcSec) continue;
    const dateKey = getMarketParts(bar.time, 'EQUITY').dateKey;
    const session = sessionByDate.get(dateKey);
    if (session === undefined) continue;
    const open = rthOnly ? session.open : session.extendedOpen;
    const close = rthOnly ? session.close : session.extendedClose;
    if (bar.time < open || bar.time + barSeconds > close) continue;
    const bucket = byDate.get(dateKey);
    if (bucket === undefined) {
      byDate.set(dateKey, [bar]);
    } else {
      bucket.push(bar);
    }
  }
  return byDate;
}

function resolveWindowTickSize(
  barsByDate: ReadonlyMap<string, readonly Bar[]>,
  baseTickSize: number,
): number {
  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;
  for (const bars of barsByDate.values()) {
    for (const b of bars) {
      if (b.low < minPrice) minPrice = b.low;
      if (b.high > maxPrice) maxPrice = b.high;
    }
  }
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) return baseTickSize;
  return resolveScaledTickSize(minPrice, maxPrice, baseTickSize, MAX_PROFILE_BINS);
}

function compute252RFromLegacyResult(
  legacy: VolumeProfileAmtResult,
  referencePrice: number | undefined,
  maxHvnZones: number,
  maxLvnZones: number,
): HorizonVolumeProfile {
  const tickSize = legacy.tickSize;
  const firstBin = legacy.bins[0];
  const lastBin = legacy.bins[legacy.bins.length - 1];
  if (
    legacy.status !== 'OK' ||
    firstBin === undefined ||
    lastBin === undefined ||
    !Number.isFinite(tickSize) ||
    tickSize <= 0
  ) {
    return emptyHorizonProfile('252R', '1D', DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS, tickSize);
  }
  const minBinIndex = priceToBinIndex(firstBin.price, tickSize);
  const maxBinIndex = priceToBinIndex(lastBin.price, tickSize);
  const binVolumes = legacy.bins.map((b) => b.volume);
  const nodes = detectVolumeProfileNodes(binVolumes, {
    minBinIndex,
    tickSize,
    ...(referencePrice !== undefined ? { referencePrice } : {}),
    maxHvnZones,
    maxLvnZones,
  });
  const sessionsCovered = legacy.windowBars;
  const coverageStatus: VolumeProfileCoverageStatus =
    sessionsCovered >= DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS
      ? 'COMPLETE'
      : sessionsCovered >= 2
        ? 'PARTIAL'
        : 'UNAVAILABLE';
  return {
    horizon: '252R',
    coverageStatus,
    methodology: 'OHLCV_UNIFORM_BIN',
    nodesMethodology: nodes.methodology,
    sourceTimeframe: '1D',
    sessionsTarget: DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
    sessionsCovered,
    tickSize,
    closedBarCount: legacy.closedBarCount,
    minBinIndex,
    maxBinIndex,
    minPrice: legacy.minPrice,
    maxPrice: legacy.maxPrice,
    poc: legacy.poc,
    vah: legacy.vah,
    val: legacy.val,
    profileVwap: legacy.profileVwap,
    totalVolume: legacy.totalVolume,
    valueAreaVolume: legacy.valueAreaVolume,
    valueAreaCoverage: legacy.valueAreaCoverage,
    hvnZones: nodes.hvnZones,
    lvnZones: nodes.lvnZones,
  };
}

function compute252RFromDailyBars(
  bars1d: readonly Bar[],
  asOfUtcSec: number,
  baseTickSize: number,
  valueAreaPct: number,
  referencePrice: number | undefined,
  maxHvnZones: number,
  maxLvnZones: number,
): HorizonVolumeProfile {
  const closed = bars1d.filter((b) => isUsableVpBar(b) && b.time + SECONDS_PER_DAY <= asOfUtcSec);
  const windowed = closed.slice(-DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS);
  if (windowed.length < 2) {
    return emptyHorizonProfile('252R', '1D', DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS, baseTickSize);
  }
  let minP = Number.POSITIVE_INFINITY;
  let maxP = Number.NEGATIVE_INFINITY;
  for (const b of windowed) {
    if (b.low < minP) minP = b.low;
    if (b.high > maxP) maxP = b.high;
  }
  const scaledTick = resolveScaledTickSize(minP, maxP, baseTickSize, MAX_PROFILE_BINS);
  const hist = buildSessionVolumeHistogram('252R', windowed, SECONDS_PER_DAY, scaledTick, true);
  if (hist === null) {
    return emptyHorizonProfile('252R', '1D', DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS, scaledTick);
  }
  return mergeSessionVolumeHistograms([hist], {
    horizon: '252R',
    sourceTimeframe: '1D',
    sessionsTarget: DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
    sessionsCovered: windowed.length,
    coverageStatus: windowed.length >= DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS ? 'COMPLETE' : 'PARTIAL',
    valueAreaPct,
    ...(referencePrice !== undefined ? { referencePrice } : {}),
    maxHvnZones,
    maxLvnZones,
  });
}

function inferReferencePrice(input: MultiHorizonVolumeProfileInput): number {
  if (input.referencePrice !== undefined && Number.isFinite(input.referencePrice) && input.referencePrice > 0) {
    return input.referencePrice;
  }
  const last1m = input.bars1m?.[input.bars1m.length - 1];
  if (last1m !== undefined && Number.isFinite(last1m.close) && last1m.close > 0) return last1m.close;
  const last5m = input.bars5m?.[input.bars5m.length - 1];
  if (last5m !== undefined && Number.isFinite(last5m.close) && last5m.close > 0) return last5m.close;
  const last1d = input.bars1d?.[input.bars1d.length - 1];
  if (last1d !== undefined && Number.isFinite(last1d.close) && last1d.close > 0) return last1d.close;
  if (input.existingProfile252R !== undefined && input.existingProfile252R !== null && Number.isFinite(input.existingProfile252R.poc)) {
    return input.existingProfile252R.poc;
  }
  return Number.NaN;
}

/**
 * S2-1: Calcula el conjunto unificado de perfiles multihorizonte (`1D`, `5D`, `20D`, `252R`)
 * sobre una rejilla compartida `k * tickSize` con caché de histogramas diarios cerrados.
 */
export function computeMultiHorizonVolumeProfile(
  input: MultiHorizonVolumeProfileInput,
): MultiHorizonVolumeProfileResult {
  const maxHvnZones = input.maxHvnZones ?? DEFAULT_MAX_HVN_ZONES;
  const maxLvnZones = input.maxLvnZones ?? DEFAULT_MAX_LVN_ZONES;
  const valueAreaPct = input.valueAreaPct ?? DEFAULT_VALUE_AREA_PCT;
  const refPrice = inferReferencePrice(input);
  const explicitTick = input.tickSize;
  const baseTickSize =
    explicitTick !== undefined && Number.isFinite(explicitTick) && explicitTick > 0
      ? explicitTick
      : input.existingProfile252R !== undefined &&
          input.existingProfile252R !== null &&
          input.existingProfile252R.status === 'OK' &&
          Number.isFinite(input.existingProfile252R.tickSize) &&
          input.existingProfile252R.tickSize > 0
        ? input.existingProfile252R.tickSize
        : resolveCanonicalVpTickSize(refPrice);

  if (input.cache !== undefined && input.adjustmentRevision !== undefined) {
    input.cache.ensureSymbolRevision(input.symbol, input.adjustmentRevision);
  }

  const refOpt = Number.isFinite(refPrice) ? refPrice : undefined;
  const profile252R =
    input.existingProfile252R !== undefined &&
    input.existingProfile252R !== null &&
    input.existingProfile252R.status === 'OK'
      ? compute252RFromLegacyResult(input.existingProfile252R, refOpt, maxHvnZones, maxLvnZones)
      : input.bars1d !== undefined && input.bars1d.length >= 2 && Number.isFinite(baseTickSize)
        ? compute252RFromDailyBars(
            input.bars1d,
            input.asOfUtcSec,
            baseTickSize,
            valueAreaPct,
            refOpt,
            maxHvnZones,
            maxLvnZones,
          )
        : emptyHorizonProfile('252R', '1D', DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS, baseTickSize);

  let profile1d = emptyHorizonProfile('1D', '1m', 1, baseTickSize);
  let profile5d = emptyHorizonProfile('5D', '1m', 5, baseTickSize);
  let profile20d = emptyHorizonProfile('20D', '5m', 20, baseTickSize);
  let liveSeed: MultiHorizonVpLiveSeed | null = null;

  if (
    input.market === 'US' &&
    Number.isFinite(baseTickSize) &&
    baseTickSize > 0 &&
    Number.isSafeInteger(input.asOfUtcSec) &&
    Math.abs(input.asOfUtcSec) <= MAX_TIME_SECONDS
  ) {
    const sessions5d = enumerateRecentUsSessions(input.asOfUtcSec, 5, input.rthOnly, 60);
    const sessions20d = enumerateRecentUsSessions(input.asOfUtcSec, 20, input.rthOnly, 300);
    const active1mSession = sessions5d[sessions5d.length - 1];
    const active5mSession = sessions20d[sessions20d.length - 1];

    // 1D y 5D desde barras 1m cerradas.
    let current1dHist: SessionVolumeHistogram | null = null;
    let prior4Closed1dHist: SessionVolumeHistogram | null = null;
    let watermark1mSec = 0;
    let sessions5dCovered = 0;

    if (input.bars1m !== undefined && input.bars1m.length > 0 && sessions5d.length > 0) {
      const byDate1m = partitionBarsByUsSessions(input.bars1m, 60, input.asOfUtcSec, sessions5d, input.rthOnly);
      const tick1m = resolveWindowTickSize(byDate1m, baseTickSize);
      const sessionHistograms1m: SessionVolumeHistogram[] = [];
      let last1mTime = 0;
      for (const s of sessions5d) {
        const sBars = byDate1m.get(s.dateKey) ?? [];
        if (sBars.length === 0) continue;
        const sClose = input.rthOnly ? s.close : s.extendedClose;
        const isClosed = input.asOfUtcSec >= sClose;
        const hist =
          isClosed && input.cache !== undefined
            ? input.cache.getOrComputeClosedSession(input.symbol, 60, input.rthOnly, tick1m, s.dateKey, sBars)
            : buildSessionVolumeHistogram(s.dateKey, sBars, 60, tick1m, isClosed);
        if (hist !== null) {
          sessionHistograms1m.push(hist);
          if (hist.lastBarTime > last1mTime) last1mTime = hist.lastBarTime;
        }
      }
      watermark1mSec = last1mTime;

      if (active1mSession !== undefined) {
        const activeBars1m = byDate1m.get(active1mSession.dateKey) ?? [];
        const active1mOpen = input.rthOnly ? active1mSession.open : active1mSession.extendedOpen;
        const covered1mOk = input.coveredFrom1m === undefined || input.coveredFrom1m === null || input.coveredFrom1m <= active1mOpen;
        if (activeBars1m.length > 0 && covered1mOk) {
          const hist1d = sessionHistograms1m.find((h) => h.sessionDate === active1mSession.dateKey) ?? null;
          if (hist1d !== null) {
            current1dHist = hist1d;
            profile1d = mergeSessionVolumeHistograms([hist1d], {
              horizon: '1D',
              sourceTimeframe: '1m',
              sessionsTarget: 1,
              sessionsCovered: 1,
              coverageStatus: 'COMPLETE',
              valueAreaPct,
              ...(refOpt !== undefined ? { referencePrice: refOpt } : {}),
              maxHvnZones,
              maxLvnZones,
            });
          }
        }
      }

      const first5d = sessions5d[0];
      const first5dOpen = first5d === undefined ? Number.POSITIVE_INFINITY : input.rthOnly ? first5d.open : first5d.extendedOpen;
      const covered5dOk = input.coveredFrom1m === undefined || input.coveredFrom1m === null || input.coveredFrom1m <= first5dOpen;
      sessions5dCovered = sessionHistograms1m.length;
      if (sessions5d.length === 5 && sessionHistograms1m.length === 5 && covered5dOk) {
        const prior4 = sessionHistograms1m.slice(0, 4);
        const prior4Merged = mergeHistogramsOnly(prior4);
        prior4Closed1dHist = prior4Merged;
        profile5d = mergeSessionVolumeHistograms(sessionHistograms1m, {
          horizon: '5D',
          sourceTimeframe: '1m',
          sessionsTarget: 5,
          sessionsCovered: 5,
          coverageStatus: 'COMPLETE',
          valueAreaPct,
          ...(refOpt !== undefined ? { referencePrice: refOpt } : {}),
          maxHvnZones,
          maxLvnZones,
        });
      }
    }

    // 20D desde barras 5m cerradas.
    let current5mSessionHist: SessionVolumeHistogram | null = null;
    let prior19Closed5mHist: SessionVolumeHistogram | null = null;
    let sessions20dCovered = 0;

    if (input.bars5m !== undefined && input.bars5m.length > 0 && sessions20d.length > 0) {
      const byDate5m = partitionBarsByUsSessions(input.bars5m, 300, input.asOfUtcSec, sessions20d, input.rthOnly);
      const tick5m = resolveWindowTickSize(byDate5m, baseTickSize);
      const sessionHistograms5m: SessionVolumeHistogram[] = [];
      for (const s of sessions20d) {
        const sBars = byDate5m.get(s.dateKey) ?? [];
        if (sBars.length === 0) continue;
        const sClose = input.rthOnly ? s.close : s.extendedClose;
        const isClosed = input.asOfUtcSec >= sClose;
        const hist =
          isClosed && input.cache !== undefined
            ? input.cache.getOrComputeClosedSession(input.symbol, 300, input.rthOnly, tick5m, s.dateKey, sBars)
            : buildSessionVolumeHistogram(s.dateKey, sBars, 300, tick5m, isClosed);
        if (hist !== null) {
          sessionHistograms5m.push(hist);
        }
      }

      const first20d = sessions20d[0];
      const first20dOpen = first20d === undefined ? Number.POSITIVE_INFINITY : input.rthOnly ? first20d.open : first20d.extendedOpen;
      const covered20dOk = input.coveredFrom5m === undefined || input.coveredFrom5m === null || input.coveredFrom5m <= first20dOpen;
      sessions20dCovered = sessionHistograms5m.length;
      if (sessions20d.length === 20 && sessionHistograms5m.length === 20 && covered20dOk) {
        const prior19 = sessionHistograms5m.slice(0, 19);
        prior19Closed5mHist = mergeHistogramsOnly(prior19);
        current5mSessionHist = sessionHistograms5m[19] ?? null;
        profile20d = mergeSessionVolumeHistograms(sessionHistograms5m, {
          horizon: '20D',
          sourceTimeframe: '5m',
          sessionsTarget: 20,
          sessionsCovered: 20,
          coverageStatus: 'COMPLETE',
          valueAreaPct,
          ...(refOpt !== undefined ? { referencePrice: refOpt } : {}),
          maxHvnZones,
          maxLvnZones,
        });
      }
    }

    if (active1mSession !== undefined && (current1dHist !== null || current5mSessionHist !== null)) {
      const refSession = active5mSession ?? active1mSession;
      liveSeed = {
        symbol: input.symbol,
        rthOnly: input.rthOnly,
        tickSize: baseTickSize,
        valueAreaPct,
        maxHvnZones,
        maxLvnZones,
        activeSessionDate: refSession.dateKey,
        activeSessionOpen: input.rthOnly ? refSession.open : refSession.extendedOpen,
        activeSessionClose: input.rthOnly ? refSession.close : refSession.extendedClose,
        watermark1mSec,
        current1dHistogram: current1dHist,
        prior4Closed1d: prior4Closed1dHist,
        current5mSessionHistogram: current5mSessionHist,
        prior19Closed5m: prior19Closed5mHist,
        sessions5dCovered,
        sessions20dCovered,
      };
    }
  }

  return {
    symbol: input.symbol,
    market: input.market,
    asOfUtcSec: input.asOfUtcSec,
    rthOnly: input.rthOnly,
    tickSize: baseTickSize,
    methodology: 'OHLCV_UNIFORM_BIN',
    horizons: {
      '1D': profile1d,
      '5D': profile5d,
      '20D': profile20d,
      '252R': profile252R,
    },
    liveSeed,
  };
}

function mergeHistogramsOnly(histograms: readonly SessionVolumeHistogram[]): SessionVolumeHistogram | null {
  const valid = histograms.filter((h) => h.totalVolume > 0 && h.binVolumes.length > 0);
  const first = valid[0];
  if (first === undefined) return null;
  let minBinIndex = Number.POSITIVE_INFINITY;
  let maxBinIndex = Number.NEGATIVE_INFINITY;
  let totalVolume = 0;
  let pvSum = 0;
  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;
  let closedBarCount = 0;
  let firstBarTime = Number.POSITIVE_INFINITY;
  let lastBarTime = Number.NEGATIVE_INFINITY;

  for (const h of valid) {
    if (h.tickSize !== first.tickSize) return null;
    if (h.minBinIndex < minBinIndex) minBinIndex = h.minBinIndex;
    if (h.maxBinIndex > maxBinIndex) maxBinIndex = h.maxBinIndex;
    totalVolume += h.totalVolume;
    pvSum += h.pvSum;
    if (h.minPrice < minPrice) minPrice = h.minPrice;
    if (h.maxPrice > maxPrice) maxPrice = h.maxPrice;
    closedBarCount += h.closedBarCount;
    if (h.firstBarTime < firstBarTime) firstBarTime = h.firstBarTime;
    if (h.lastBarTime > lastBarTime) lastBarTime = h.lastBarTime;
  }

  const span = maxBinIndex - minBinIndex + 1;
  if (span > MAX_PROFILE_BINS) return null;
  const binVolumes = new Array<number>(span).fill(0);
  for (const h of valid) {
    const shift = h.minBinIndex - minBinIndex;
    for (let i = 0; i < h.binVolumes.length; i += 1) {
      binVolumes[shift + i] = (binVolumes[shift + i] ?? 0) + (h.binVolumes[i] ?? 0);
    }
  }
  return Object.freeze({
    sessionDate: `${first.sessionDate}..${valid[valid.length - 1]?.sessionDate ?? first.sessionDate}`,
    sourceBarSeconds: first.sourceBarSeconds,
    tickSize: first.tickSize,
    minBinIndex,
    maxBinIndex,
    binVolumes: Object.freeze(binVolumes),
    totalVolume,
    pvSum,
    minPrice,
    maxPrice,
    closedBarCount,
    firstBarTime,
    lastBarTime,
    isClosedSession: true,
  });
}

export interface MultiHorizonVpLiveState {
  readonly seed: MultiHorizonVpLiveSeed;
  readonly pending5mBucketStart: number | null;
  readonly pending5mBars: readonly Bar[];
  readonly profile1d: HorizonVolumeProfile | null;
  readonly profile5d: HorizonVolumeProfile | null;
  readonly profile20d: HorizonVolumeProfile | null;
}

export function createMultiHorizonVpLiveState(seed: MultiHorizonVpLiveSeed): MultiHorizonVpLiveState {
  return {
    seed,
    pending5mBucketStart: null,
    pending5mBars: [],
    profile1d: null,
    profile5d: null,
    profile20d: null,
  };
}

/**
 * Actualización incremental pura al cerrar una barra `1m` confirmada (`closedBar.time + 60 <= evalTimeSec`):
 *  - `1D` y `5D`: actualizan en O(B_bar) al cerrar cada barra `1m`.
 *  - `20D`: únicamente al cerrarse un bucket `5m` completo de la sesión actual.
 */
export function advanceMultiHorizonVpLiveOnClosed1m(
  state: MultiHorizonVpLiveState,
  closedBar1m: Bar,
  evalTimeSec: number,
  referencePrice?: number,
): MultiHorizonVpLiveState {
  const { seed } = state;
  if (
    !isUsableVpBar(closedBar1m) ||
    closedBar1m.time <= seed.watermark1mSec ||
    closedBar1m.time + 60 > evalTimeSec ||
    closedBar1m.time < seed.activeSessionOpen ||
    closedBar1m.time + 60 > seed.activeSessionClose
  ) {
    return state;
  }
  const barSessionDate = getMarketParts(closedBar1m.time, 'EQUITY').dateKey;
  if (barSessionDate !== seed.activeSessionDate) {
    return state;
  }

  const tick1m = seed.current1dHistogram?.tickSize ?? seed.tickSize;
  const next1dHist = appendClosedBarToSessionHistogram(
    seed.current1dHistogram,
    closedBar1m,
    seed.activeSessionDate,
    60,
    tick1m,
    evalTimeSec >= seed.activeSessionClose,
  );

  const refOpt =
    referencePrice !== undefined && Number.isFinite(referencePrice) && referencePrice > 0
      ? referencePrice
      : closedBar1m.close;

  const nextProfile1d =
    next1dHist !== null
      ? mergeSessionVolumeHistograms([next1dHist], {
          horizon: '1D',
          sourceTimeframe: '1m',
          sessionsTarget: 1,
          sessionsCovered: 1,
          coverageStatus: 'COMPLETE',
          valueAreaPct: seed.valueAreaPct,
          referencePrice: refOpt,
          maxHvnZones: seed.maxHvnZones,
          maxLvnZones: seed.maxLvnZones,
        })
      : state.profile1d;

  const nextProfile5d =
    seed.prior4Closed1d !== null && next1dHist !== null && seed.prior4Closed1d.tickSize === next1dHist.tickSize
      ? mergeSessionVolumeHistograms([seed.prior4Closed1d, next1dHist], {
          horizon: '5D',
          sourceTimeframe: '1m',
          sessionsTarget: 5,
          sessionsCovered: 5,
          coverageStatus: 'COMPLETE',
          valueAreaPct: seed.valueAreaPct,
          referencePrice: refOpt,
          maxHvnZones: seed.maxHvnZones,
          maxLvnZones: seed.maxLvnZones,
        })
      : state.profile5d;

  // Acumulación de bucket 5m alineado a `activeSessionOpen`: actualiza 20D solo al cierre 5m.
  const bucketStart =
    seed.activeSessionOpen + Math.floor((closedBar1m.time - seed.activeSessionOpen) / 300) * 300;
  const bucketEnd = Math.min(bucketStart + 300, seed.activeSessionClose);

  let nextPendingStart = state.pending5mBucketStart;
  let nextPendingBars: Bar[] = [];
  let closed5mBar: Bar | null = null;

  if (state.pending5mBucketStart === null) {
    nextPendingStart = bucketStart;
    nextPendingBars = [closedBar1m];
  } else if (bucketStart === state.pending5mBucketStart) {
    nextPendingStart = state.pending5mBucketStart;
    nextPendingBars = [...state.pending5mBars, closedBar1m];
  } else {
    // El bucket anterior cerró implícitamente al abrir un bucket posterior.
    closed5mBar = rollupClosed5mBucket(state.pending5mBucketStart, state.pending5mBars);
    nextPendingStart = bucketStart;
    nextPendingBars = [closedBar1m];
  }

  let next5mHist = seed.current5mSessionHistogram;
  let nextProfile20d = state.profile20d;

  const apply5mClose = (bar5m: Bar): void => {
    const tick5m = next5mHist?.tickSize ?? seed.tickSize;
    next5mHist = appendClosedBarToSessionHistogram(
      next5mHist,
      bar5m,
      seed.activeSessionDate,
      300,
      tick5m,
      evalTimeSec >= seed.activeSessionClose,
    );
    if (seed.prior19Closed5m !== null && next5mHist !== null && seed.prior19Closed5m.tickSize === next5mHist.tickSize) {
      nextProfile20d = mergeSessionVolumeHistograms([seed.prior19Closed5m, next5mHist], {
        horizon: '20D',
        sourceTimeframe: '5m',
        sessionsTarget: 20,
        sessionsCovered: 20,
        coverageStatus: 'COMPLETE',
        valueAreaPct: seed.valueAreaPct,
        referencePrice: refOpt,
        maxHvnZones: seed.maxHvnZones,
        maxLvnZones: seed.maxLvnZones,
      });
    }
  };

  if (closed5mBar !== null) {
    apply5mClose(closed5mBar);
  }
  if (closedBar1m.time + 60 >= bucketEnd) {
    const completed = rollupClosed5mBucket(nextPendingStart, nextPendingBars);
    if (completed !== null) {
      apply5mClose(completed);
    }
    nextPendingStart = null;
    nextPendingBars = [];
  }

  return {
    seed: {
      ...seed,
      watermark1mSec: closedBar1m.time,
      current1dHistogram: next1dHist,
      current5mSessionHistogram: next5mHist,
    },
    pending5mBucketStart: nextPendingStart,
    pending5mBars: nextPendingBars,
    profile1d: nextProfile1d,
    profile5d: nextProfile5d,
    profile20d: nextProfile20d,
  };
}

function rollupClosed5mBucket(bucketTime: number, bars: readonly Bar[]): Bar | null {
  if (bars.length === 0) return null;
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (first === undefined || last === undefined) return null;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let volume = 0;
  let vwPv = 0;
  let allVw = true;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
    if (b.vw !== undefined && Number.isFinite(b.vw) && b.vw > 0) {
      vwPv += b.vw * b.volume;
    } else {
      allVw = false;
    }
  }
  if (volume <= 0) return null;
  return {
    time: bucketTime,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    ...(allVw ? { vw: vwPv / volume } : {}),
  };
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function serializeHorizonVolumeProfile(profile: HorizonVolumeProfile): HorizonVolumeProfileDto {
  return {
    horizon: profile.horizon,
    coverageStatus: profile.coverageStatus,
    methodology: profile.methodology,
    nodesMethodology: profile.nodesMethodology,
    sourceTimeframe: profile.sourceTimeframe,
    sessionsTarget: profile.sessionsTarget,
    sessionsCovered: profile.sessionsCovered,
    tickSize: finiteOrNull(profile.tickSize),
    closedBarCount: profile.closedBarCount,
    minPrice: finiteOrNull(profile.minPrice),
    maxPrice: finiteOrNull(profile.maxPrice),
    poc: finiteOrNull(profile.poc),
    vah: finiteOrNull(profile.vah),
    val: finiteOrNull(profile.val),
    profileVwap: finiteOrNull(profile.profileVwap),
    totalVolume: finiteOrNull(profile.totalVolume),
    valueAreaVolume: finiteOrNull(profile.valueAreaVolume),
    valueAreaCoverage: finiteOrNull(profile.valueAreaCoverage),
    hvnZones: profile.hvnZones.map((z) => ({
      kind: z.kind,
      startBinIndex: z.startBinIndex,
      endBinIndex: z.endBinIndex,
      lowPrice: finiteOrNull(z.lowPrice),
      highPrice: finiteOrNull(z.highPrice),
      centerPrice: finiteOrNull(z.centerPrice),
      volume: finiteOrNull(z.volume),
      volumeSharePct: finiteOrNull(z.volumeSharePct),
      prominence: finiteOrNull(z.prominence),
      prominenceRatio: finiteOrNull(z.prominenceRatio),
      isPriceGap: z.isPriceGap,
    })),
    lvnZones: profile.lvnZones.map((z) => ({
      kind: z.kind,
      startBinIndex: z.startBinIndex,
      endBinIndex: z.endBinIndex,
      lowPrice: finiteOrNull(z.lowPrice),
      highPrice: finiteOrNull(z.highPrice),
      centerPrice: finiteOrNull(z.centerPrice),
      volume: finiteOrNull(z.volume),
      volumeSharePct: finiteOrNull(z.volumeSharePct),
      prominence: finiteOrNull(z.prominence),
      prominenceRatio: finiteOrNull(z.prominenceRatio),
      isPriceGap: z.isPriceGap,
    })),
  };
}

export function serializeMultiHorizonVolumeProfile(
  result: MultiHorizonVolumeProfileResult,
  options?: { readonly acquisitionAttempted?: boolean },
): VolumeProfilesByHorizonPayloadDto {
  return {
    asOfUtcSec: result.asOfUtcSec,
    rthOnly: result.rthOnly,
    tickSize: finiteOrNull(result.tickSize),
    methodology: result.methodology,
    horizons: {
      '1D': serializeHorizonVolumeProfile(result.horizons['1D']),
      '5D': serializeHorizonVolumeProfile(result.horizons['5D']),
      '20D': serializeHorizonVolumeProfile(result.horizons['20D']),
      '252R': serializeHorizonVolumeProfile(result.horizons['252R']),
    },
    ...(options?.acquisitionAttempted === undefined ? {} : { acquisitionAttempted: options.acquisitionAttempted }),
  };
}

/**
 * Helper puro para comprobar qué clave de sesión civil corresponde a una barra según mercado.
 */
export function resolveVpSessionDateKey(timeSec: number, market: 'US' | 'AR'): string {
  return market === 'US'
    ? sessionKey(timeSec, 'EQUITY')
    : getSessionDateKey(timeSec, 'America/Argentina/Buenos_Aires');
}
