/**
 * Motor puro de Subasta de Apertura, Liquidez Pre-Market, Taxonomía de Apertura
 * e Initial Balance (`04:00 – 10:30 ET`, Bloque B / Pieza 9).
 *
 * Garantías de diseño:
 *  - Funciones puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Timestamps en **segundos UTC enteros**, mapeados a `America/New_York` (EST/EDT)
 *    mediante `getMarketParts` de `src/core/sessions.ts`.
 *  - Cero Look-Ahead Bias: solo entran barras cerradas (`bar.time + barSeconds <= asOfUtcSec`)
 *    y la línea base `08:30 ET` se calcula estrictamente con barras anteriores a `08:30 ET`.
 *  - Cero fallbacks silenciosos: cualquier dato ausente o inválido produce `Number.NaN`
 *    y estado explícito (`'PENDING_OPEN'`, `'PENDING_IB'`, `'INSUFFICIENT_DATA'`).
 */

import { getMarketParts, MAX_TIME_SECONDS, RTH_START_MINUTES, type MarketParts } from '../sessions.js';
import { computeSessionVwap } from '../sessionVwap.js';
import type { Bar } from '../types.js';
import type {
  BalanceType,
  InitialBalanceClassification,
  InventoryRiskType,
  Macro0830SpikeOptions,
  Macro0830SpikeResult,
  MicrostructureBar,
  OpeningAuctionOptions,
  OpeningAuctionResult,
  OpeningDirection,
  OpeningType,
  OvernightVolumeBin,
  OvernightVolumeProfileOptions,
  OvernightVolumeProfileResult,
} from './types.js';

const PRE_MARKET_START_MINUTES = 4 * 60; // 04:00 ET
const MACRO_0830_START_MINUTES = 8 * 60 + 30; // 08:30 ET
const MACRO_0830_WINDOW_END_MINUTES = 8 * 60 + 35; // 08:35 ET
const IB_END_MINUTES = 10 * 60 + 30; // 10:30 ET
const RTH_END_MINUTES = 16 * 60; // 16:00 ET

const DEFAULT_TICK_SIZE = 0.05;
const DEFAULT_VALUE_AREA_PCT = 0.70;
const DEFAULT_MACRO_RANGE_MULTIPLIER = 3.0;
const DEFAULT_MACRO_VOLUME_MULTIPLIER = 5.0;
const DEFAULT_INVENTORY_IMBALANCE_THRESHOLD = 0.85;
const DEFAULT_OPEN_CROSS_TOLERANCE_ATR = 0.05;
const DEFAULT_OPEN_DRIVE_MIN_RVOL = 2.5;
const DEFAULT_BOUNDARY_PROXIMITY_ATR = 0.25;
const DEFAULT_TEST_DRIVE_SWEEP_WINDOW_MINUTES = 15;
const DEFAULT_REJECTION_TOUCH_ATR = 0.08;
const DEFAULT_OPEN_AUCTION_MIN_CROSSES = 2;

const IB_NARROW_THRESHOLD_ATR = 0.35;
const IB_WIDE_THRESHOLD_ATR = 0.80;
const RVOL_LOW_REVERSAL_THRESHOLD = 2.0;

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BIN_EPS = 1e-12;

interface IndexedSessionBar {
  readonly bar: MicrostructureBar;
  readonly parts: MarketParts;
}

function assertValidUtcSeconds(time: number, label: string): void {
  if (!Number.isFinite(time) || !Number.isInteger(time) || Math.abs(time) > MAX_TIME_SECONDS) {
    throw new Error(`${label} must be finite integer UTC seconds (got ${String(time)})`);
  }
}

function assertValidBarSeconds(barSeconds: number): void {
  if (!Number.isInteger(barSeconds) || barSeconds <= 0 || 1800 % barSeconds !== 0) {
    throw new Error(
      `barSeconds must be a positive integer dividing 1800 (got ${String(barSeconds)})`,
    );
  }
}

function resolvePositiveConfig(
  value: number | undefined,
  defaultValue: number,
  label: string,
): number {
  const resolved = value === undefined ? defaultValue : value;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${label} must be finite > 0 (got ${String(resolved)})`);
  }
  return resolved;
}

function resolveNonNegativeConfig(
  value: number | undefined,
  defaultValue: number,
  label: string,
): number {
  const resolved = value === undefined ? defaultValue : value;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`${label} must be finite >= 0 (got ${String(resolved)})`);
  }
  return resolved;
}

function isUsableOhlcv(bar: Bar): boolean {
  if (
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    bar.high < bar.low
  ) {
    throw new Error(
      `Bar high (${String(bar.high)}) cannot be lower than low (${String(bar.low)}) at time=${String(bar.time)}`,
    );
  }
  if (Number.isFinite(bar.volume) && bar.volume < 0) {
    throw new Error(`Bar volume must be >= 0 (got ${String(bar.volume)}) at time=${String(bar.time)}`);
  }
  return (
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    Number.isFinite(bar.volume)
  );
}

function priceToBinIndex(price: number, tickSize: number): number {
  return Math.floor(price / tickSize + 0.5 + BIN_EPS);
}

function computePreMarketVwap(bars: readonly Bar[]): number {
  let pvSum = 0;
  let volSum = 0;
  for (const bar of bars) {
    if (!isUsableOhlcv(bar) || bar.volume <= 0) {
      continue;
    }
    const barPrice =
      bar.vw !== undefined && Number.isFinite(bar.vw) && bar.vw > 0
        ? bar.vw
        : (bar.high + bar.low + bar.close) / 3;
    pvSum += barPrice * bar.volume;
    volSum += bar.volume;
  }
  return volSum > 0 ? pvSum / volSum : Number.NaN;
}

function selectPocIndex(
  binVolumes: readonly number[],
  minBinIndex: number,
  tickSize: number,
  preMarketVwap: number,
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
    const dist = Number.isFinite(preMarketVwap)
      ? Math.abs(price - preMarketVwap)
      : Number.POSITIVE_INFINITY;

    if (bestPrice === Number.POSITIVE_INFINITY) {
      bestArrayIdx = i;
      bestDistToVwap = dist;
      bestPrice = price;
      continue;
    }

    if (Number.isFinite(preMarketVwap)) {
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

function expandValueAreaIndices(
  binVolumes: readonly number[],
  pocArrayIdx: number,
  totalVolume: number,
  valueAreaPct: number,
): { readonly lowIdx: number; readonly highIdx: number; readonly coveredVolume: number } {
  let lowIdx = pocArrayIdx;
  let highIdx = pocArrayIdx;
  let coveredVolume = binVolumes[pocArrayIdx] ?? 0;
  const targetVolume = valueAreaPct * totalVolume;
  const eps = BIN_EPS * Math.max(1, totalVolume);

  while (
    coveredVolume < targetVolume - eps &&
    (lowIdx > 0 || highIdx < binVolumes.length - 1)
  ) {
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

/**
 * Construye el perfil de volumen overnight discreto sobre las barras pre-market (`[pml, pmh]`),
 * distribuyendo el volumen de cada barra uniformemente entre sus bins cubiertos (o en `close`
 * si `high === low`), determinando `onPoc`, `onVah` y `onVal` por expansión simétrica/greedy.
 */
export function computeOvernightVolumeProfile(
  preMarketBars: readonly Bar[],
  options: OvernightVolumeProfileOptions,
): OvernightVolumeProfileResult {
  const tickSize = resolvePositiveConfig(options.tickSize, DEFAULT_TICK_SIZE, 'tickSize');
  const valueAreaPct =
    options.valueAreaPct === undefined ? DEFAULT_VALUE_AREA_PCT : options.valueAreaPct;
  if (!Number.isFinite(valueAreaPct) || valueAreaPct <= 0 || valueAreaPct > 1) {
    throw new Error(`valueAreaPct must be in (0, 1] (got ${String(valueAreaPct)})`);
  }

  let pmh = Number.NEGATIVE_INFINITY;
  let pml = Number.POSITIVE_INFINITY;
  let minBinIndex = Number.POSITIVE_INFINITY;
  let maxBinIndex = Number.NEGATIVE_INFINITY;
  let validOhlcCount = 0;
  let positiveVolBarCount = 0;

  for (const bar of preMarketBars) {
    assertValidUtcSeconds(bar.time, 'bar.time');
    if (!isUsableOhlcv(bar)) {
      continue;
    }
    validOhlcCount += 1;
    if (bar.high > pmh) {
      pmh = bar.high;
    }
    if (bar.low < pml) {
      pml = bar.low;
    }
    if (bar.volume > 0) {
      positiveVolBarCount += 1;
      const barLowIdx =
        bar.high === bar.low
          ? priceToBinIndex(bar.close, tickSize)
          : priceToBinIndex(bar.low, tickSize);
      const barHighIdx =
        bar.high === bar.low
          ? barLowIdx
          : priceToBinIndex(bar.high, tickSize);
      if (barLowIdx < minBinIndex) {
        minBinIndex = barLowIdx;
      }
      if (barHighIdx > maxBinIndex) {
        maxBinIndex = barHighIdx;
      }
    }
  }

  if (validOhlcCount === 0) {
    return {
      pmh: Number.NaN,
      pml: Number.NaN,
      onPoc: Number.NaN,
      onVah: Number.NaN,
      onVal: Number.NaN,
      preMarketVwap: Number.NaN,
      totalVolume: 0,
      valueAreaVolume: 0,
      valueAreaCoverage: Number.NaN,
      bins: [],
    };
  }

  if (positiveVolBarCount === 0) {
    return {
      pmh,
      pml,
      onPoc: Number.NaN,
      onVah: Number.NaN,
      onVal: Number.NaN,
      preMarketVwap: Number.NaN,
      totalVolume: 0,
      valueAreaVolume: 0,
      valueAreaCoverage: Number.NaN,
      bins: [],
    };
  }

  const binCount = maxBinIndex - minBinIndex + 1;
  const binVolumes = new Array<number>(binCount).fill(0);
  let totalVolume = 0;

  for (const bar of preMarketBars) {
    if (!isUsableOhlcv(bar) || bar.volume <= 0) {
      continue;
    }
    const lowIdx =
      bar.high === bar.low
        ? priceToBinIndex(bar.close, tickSize)
        : priceToBinIndex(bar.low, tickSize);
    const highIdx =
      bar.high === bar.low
        ? lowIdx
        : priceToBinIndex(bar.high, tickSize);

    const coveredBins = highIdx - lowIdx + 1;
    const volumePerBin = bar.volume / coveredBins;
    for (let idx = lowIdx; idx <= highIdx; idx += 1) {
      const arrayIdx = idx - minBinIndex;
      binVolumes[arrayIdx] = (binVolumes[arrayIdx] ?? 0) + volumePerBin;
    }
    totalVolume += bar.volume;
  }

  if (totalVolume <= 0) {
    return {
      pmh,
      pml,
      onPoc: Number.NaN,
      onVah: Number.NaN,
      onVal: Number.NaN,
      preMarketVwap: Number.NaN,
      totalVolume: 0,
      valueAreaVolume: 0,
      valueAreaCoverage: Number.NaN,
      bins: [],
    };
  }

  const preMarketVwap = computePreMarketVwap(preMarketBars);
  const pocArrayIdx = selectPocIndex(binVolumes, minBinIndex, tickSize, preMarketVwap);
  const area = expandValueAreaIndices(binVolumes, pocArrayIdx, totalVolume, valueAreaPct);

  const bins: OvernightVolumeBin[] = [];
  for (let i = 0; i < binVolumes.length; i += 1) {
    const vol = binVolumes[i] ?? 0;
    if (vol > 0) {
      bins.push({
        price: (minBinIndex + i) * tickSize,
        volume: vol,
      });
    }
  }

  return {
    pmh,
    pml,
    onPoc: (minBinIndex + pocArrayIdx) * tickSize,
    onVah: (minBinIndex + area.highIdx) * tickSize,
    onVal: (minBinIndex + area.lowIdx) * tickSize,
    preMarketVwap,
    totalVolume,
    valueAreaVolume: area.coveredVolume,
    valueAreaCoverage: area.coveredVolume / totalVolume,
    bins,
  };
}

function computeMedian(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? Number.NaN;
  }
  const left = sorted[mid - 1];
  const right = sorted[mid];
  return left !== undefined && right !== undefined ? (left + right) / 2 : Number.NaN;
}

/**
 * Detecta el nodo de volatilidad/volumen de noticias macro de las `08:30 ET`
 * comparando cada barra cerrada en `[08:30, 08:35) ET` contra las medianas de rango
 * y volumen calculadas estrictamente con barras previas a `08:30 ET` (sin look-ahead).
 */
export function detectMacro0830Spike(
  preMarketBars: readonly Bar[],
  barSeconds: number,
  options: Macro0830SpikeOptions = {},
): Macro0830SpikeResult {
  assertValidBarSeconds(barSeconds);
  const rangeMultiplier = resolvePositiveConfig(
    options.rangeMultiplier,
    DEFAULT_MACRO_RANGE_MULTIPLIER,
    'rangeMultiplier',
  );
  const volumeMultiplier = resolvePositiveConfig(
    options.volumeMultiplier,
    DEFAULT_MACRO_VOLUME_MULTIPLIER,
    'volumeMultiplier',
  );

  const baselineRanges: number[] = [];
  const baselineVolumes: number[] = [];
  const targetWindowBars: Bar[] = [];
  let expectedDateKey: string | null = null;

  for (const bar of preMarketBars) {
    assertValidUtcSeconds(bar.time, 'bar.time');
    if (!isUsableOhlcv(bar)) {
      continue;
    }
    const parts = getMarketParts(bar.time, 'EQUITY');
    if (expectedDateKey === null) {
      expectedDateKey = parts.dateKey;
    } else if (parts.dateKey !== expectedDateKey) {
      throw new Error(
        `detectMacro0830Spike expects single-session bars (mixed ${expectedDateKey} and ${parts.dateKey})`,
      );
    }
    if (parts.minutesOfDay >= PRE_MARKET_START_MINUTES && parts.minutesOfDay < MACRO_0830_START_MINUTES) {
      baselineRanges.push(bar.high - bar.low);
      baselineVolumes.push(bar.volume);
    } else if (
      parts.minutesOfDay >= MACRO_0830_START_MINUTES &&
      parts.minutesOfDay < MACRO_0830_WINDOW_END_MINUTES
    ) {
      targetWindowBars.push(bar);
    }
  }

  const medianPreMarketRange = computeMedian(baselineRanges);
  const medianPreMarketVolume = computeMedian(baselineVolumes);

  if (
    !Number.isFinite(medianPreMarketRange) ||
    medianPreMarketRange <= 0 ||
    !Number.isFinite(medianPreMarketVolume) ||
    medianPreMarketVolume <= 0 ||
    targetWindowBars.length === 0
  ) {
    return {
      detected: false,
      high: Number.NaN,
      low: Number.NaN,
      medianPreMarketRange,
      medianPreMarketVolume,
    };
  }

  const minRange = rangeMultiplier * medianPreMarketRange;
  const minVolume = volumeMultiplier * medianPreMarketVolume;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let detected = false;

  for (const bar of targetWindowBars) {
    const barRange = bar.high - bar.low;
    if (barRange >= minRange && bar.volume >= minVolume) {
      detected = true;
      if (bar.high > high) {
        high = bar.high;
      }
      if (bar.low < low) {
        low = bar.low;
      }
    }
  }

  return {
    detected,
    high: detected ? high : Number.NaN,
    low: detected ? low : Number.NaN,
    medianPreMarketRange,
    medianPreMarketVolume,
  };
}

function computeBarDelta(bar: MicrostructureBar): number {
  if (bar.delta !== undefined) {
    return Number.isFinite(bar.delta) ? bar.delta : Number.NaN;
  }
  const range = bar.high - bar.low;
  if (bar.volume <= 0 || range === 0) {
    return 0;
  }
  // Proxy CLV de delta intrabar: ((close - low) - (high - close)) / (high - low) * volume
  return (bar.volume * (2 * bar.close - bar.high - bar.low)) / range;
}

function computePreMarketInventorySplit(
  preMarketBars: readonly MicrostructureBar[],
  prevRthClose: number,
): { readonly pctAbove: number; readonly pctBelow: number } {
  if (!Number.isFinite(prevRthClose) || prevRthClose <= 0) {
    return { pctAbove: Number.NaN, pctBelow: Number.NaN };
  }

  let volAbove = 0;
  let volBelow = 0;
  let totalVol = 0;

  for (const bar of preMarketBars) {
    if (!isUsableOhlcv(bar) || bar.volume <= 0) {
      continue;
    }
    totalVol += bar.volume;
    const range = bar.high - bar.low;
    if (range === 0) {
      if (bar.close > prevRthClose) {
        volAbove += bar.volume;
      } else if (bar.close < prevRthClose) {
        volBelow += bar.volume;
      }
    } else if (bar.low >= prevRthClose) {
      volAbove += bar.volume;
    } else if (bar.high <= prevRthClose) {
      volBelow += bar.volume;
    } else {
      volAbove += bar.volume * ((bar.high - prevRthClose) / range);
      volBelow += bar.volume * ((prevRthClose - bar.low) / range);
    }
  }

  if (totalVol <= 0) {
    return { pctAbove: Number.NaN, pctBelow: Number.NaN };
  }

  return {
    pctAbove: volAbove / totalVol,
    pctBelow: volBelow / totalVol,
  };
}

function buildSortedStatisticalTargets(
  currentClose: number,
  prevRthClose: number,
  onPoc: number,
): readonly number[] {
  const candidates: number[] = [];
  if (Number.isFinite(prevRthClose)) {
    candidates.push(prevRthClose);
  }
  if (Number.isFinite(onPoc)) {
    const duplicate = candidates.some((c) => Math.abs(c - onPoc) <= BIN_EPS * Math.max(1, Math.abs(c)));
    if (!duplicate) {
      candidates.push(onPoc);
    }
  }
  if (!Number.isFinite(currentClose)) {
    return candidates;
  }
  return candidates.sort((a, b) => {
    const da = Math.abs(a - currentClose);
    const db = Math.abs(b - currentClose);
    if (Math.abs(da - db) > BIN_EPS) {
      return da - db;
    }
    return a - b;
  });
}

function classifyInventoryRisk(params: {
  readonly hasRthBars: boolean;
  readonly pctAbove: number;
  readonly pctBelow: number;
  readonly cumulativeRthDelta: number;
  readonly open0930: number;
  readonly currentClose: number;
  readonly prevRthClose: number;
  readonly onPoc: number;
  readonly imbalanceThreshold: number;
}): { readonly inventoryRisk: InventoryRiskType; readonly statisticalTargets: readonly number[] } {
  if (!params.hasRthBars) {
    return { inventoryRisk: 'NEUTRAL', statisticalTargets: [] };
  }

  const bearishFail =
    (Number.isFinite(params.cumulativeRthDelta) && params.cumulativeRthDelta < 0) ||
    params.currentClose < params.open0930;
  if (
    Number.isFinite(params.pctAbove) &&
    params.pctAbove >= params.imbalanceThreshold &&
    bearishFail
  ) {
    return {
      inventoryRisk: 'LONG_LIQUIDATION_RISK',
      statisticalTargets: buildSortedStatisticalTargets(
        params.currentClose,
        params.prevRthClose,
        params.onPoc,
      ),
    };
  }

  const bullishAbsorption =
    (Number.isFinite(params.cumulativeRthDelta) && params.cumulativeRthDelta > 0) ||
    params.currentClose > params.open0930;
  if (
    Number.isFinite(params.pctBelow) &&
    params.pctBelow >= params.imbalanceThreshold &&
    bullishAbsorption
  ) {
    return {
      inventoryRisk: 'SHORT_COVERING_RISK',
      statisticalTargets: buildSortedStatisticalTargets(
        params.currentClose,
        params.prevRthClose,
        params.onPoc,
      ),
    };
  }

  return { inventoryRisk: 'NEUTRAL', statisticalTargets: [] };
}

function resolveBalanceType(
  referencePrice: number,
  pml: number,
  pmh: number,
  prevRthLow: number,
  prevRthHigh: number,
): BalanceType {
  if (
    !Number.isFinite(referencePrice) ||
    !Number.isFinite(pml) ||
    !Number.isFinite(pmh) ||
    !Number.isFinite(prevRthLow) ||
    !Number.isFinite(prevRthHigh) ||
    prevRthHigh < prevRthLow ||
    pmh < pml
  ) {
    return 'INSUFFICIENT_DATA';
  }
  const insidePreMarket = referencePrice >= pml && referencePrice <= pmh;
  const insidePrevRth = referencePrice >= prevRthLow && referencePrice <= prevRthHigh;
  return insidePreMarket && insidePrevRth ? 'IN_BALANCE' : 'OUT_OF_BALANCE';
}

function countLevelCrosses(
  bars: readonly MicrostructureBar[],
  levels: readonly number[],
): number {
  let crosses = 0;
  let prevSide = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const level = levels[i];
    if (bar === undefined || level === undefined || !Number.isFinite(level)) {
      continue;
    }
    const diff = bar.close - level;
    const side = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (side === 0) {
      continue;
    }
    if (prevSide !== 0 && side !== prevSide) {
      crosses += 1;
    }
    prevSide = side;
  }
  return crosses;
}

function checkTestDriveCandidate(params: {
  readonly openBars: readonly IndexedSessionBar[];
  readonly open0930: number;
  readonly lastClose: number;
  readonly lastVwap: number;
  readonly boundaries: readonly number[];
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly proximityLimit: number;
  readonly sweepEndMinutes: number;
}): boolean {
  const { openBars, open0930, lastClose, lastVwap, boundaries, direction, proximityLimit, sweepEndMinutes } =
    params;

  if (!Number.isFinite(lastVwap)) {
    return false;
  }

  for (const level of boundaries) {
    if (!Number.isFinite(level) || Math.abs(open0930 - level) > proximityLimit) {
      continue;
    }
    let sweepIdx = -1;
    for (let i = 0; i < openBars.length; i += 1) {
      const entry = openBars[i];
      if (entry === undefined || entry.parts.minutesOfDay >= sweepEndMinutes) {
        break;
      }
      const swept = direction === 'BULLISH' ? entry.bar.low < level : entry.bar.high > level;
      if (swept) {
        sweepIdx = i;
        break;
      }
    }
    if (sweepIdx < 0) {
      continue;
    }

    const recovered =
      direction === 'BULLISH'
        ? lastClose > level && lastClose > open0930 && lastClose > lastVwap
        : lastClose < level && lastClose < open0930 && lastClose < lastVwap;
    if (recovered) {
      return true;
    }
  }
  return false;
}

function checkRejectionReverse(params: {
  readonly openBars: readonly IndexedSessionBar[];
  readonly deltas: readonly number[];
  readonly open0930: number;
  readonly lastClose: number;
  readonly lastVwap: number;
  readonly extremeLevel: number;
  readonly touchTol: number;
  readonly onPoc: number;
  readonly prevRthClose: number;
  readonly direction: 'BEARISH' | 'BULLISH';
}): boolean {
  const {
    openBars,
    deltas,
    open0930,
    lastClose,
    lastVwap,
    extremeLevel,
    touchTol,
    onPoc,
    prevRthClose,
    direction,
  } = params;

  if (!Number.isFinite(extremeLevel)) {
    return false;
  }

  const targetCandidates: number[] = [];
  for (const candidate of [onPoc, prevRthClose]) {
    if (!Number.isFinite(candidate)) {
      continue;
    }
    const validSide =
      direction === 'BEARISH' ? candidate < extremeLevel : candidate > extremeLevel;
    if (validSide) {
      targetCandidates.push(candidate);
    }
  }
  if (targetCandidates.length === 0) {
    return false;
  }

  let testIndex = -1;
  let testPeak = Number.NaN;
  for (let i = 0; i < openBars.length; i += 1) {
    const entry = openBars[i];
    const barDelta = deltas[i];
    if (entry === undefined || barDelta === undefined || !Number.isFinite(barDelta)) {
      continue;
    }
    const testedAndAbsorbed =
      direction === 'BEARISH'
        ? entry.bar.high >= extremeLevel - touchTol && barDelta < 0
        : entry.bar.low <= extremeLevel + touchTol && barDelta > 0;
    if (testedAndAbsorbed) {
      testIndex = i;
      testPeak = direction === 'BEARISH' ? entry.bar.high : entry.bar.low;
      break;
    }
  }
  if (testIndex < 0 || !Number.isFinite(testPeak)) {
    return false;
  }

  const reversedPastOpenAndVwap =
    direction === 'BEARISH'
      ? lastClose < extremeLevel &&
        lastClose < open0930 &&
        (!Number.isFinite(lastVwap) || lastClose < lastVwap)
      : lastClose > extremeLevel &&
        lastClose > open0930 &&
        (!Number.isFinite(lastVwap) || lastClose > lastVwap);
  if (!reversedPastOpenAndVwap) {
    return false;
  }

  for (const target of targetCandidates) {
    if (direction === 'BEARISH') {
      const distToTarget = testPeak - target;
      const moveAchieved = testPeak - lastClose;
      if (lastClose <= target || (distToTarget > 0 && moveAchieved >= 0.5 * distToTarget)) {
        return true;
      }
    } else {
      const distToTarget = target - testPeak;
      const moveAchieved = lastClose - testPeak;
      if (lastClose >= target || (distToTarget > 0 && moveAchieved >= 0.5 * distToTarget)) {
        return true;
      }
    }
  }

  return false;
}

function classifyOpeningType(params: {
  readonly openBars: readonly IndexedSessionBar[];
  readonly vwaps: readonly number[];
  readonly deltas: readonly number[];
  readonly open0930: number;
  readonly lastClose: number;
  readonly atr14d: number;
  readonly openingRvol: number;
  readonly pmh: number;
  readonly pml: number;
  readonly onPoc: number;
  readonly prevRthClose: number;
  readonly prevRthHigh: number;
  readonly prevRthLow: number;
  readonly inventoryRisk: InventoryRiskType;
  readonly openCrossToleranceAtr: number;
  readonly openDriveMinRvol: number;
  readonly boundaryProximityAtr: number;
  readonly testDriveSweepWindowMinutes: number;
  readonly rejectionTouchAtr: number;
}): {
  readonly openingType: OpeningType;
  readonly openingDirection: OpeningDirection;
  readonly openCrossCount: number;
  readonly vwapCrossCount: number;
} {
  const { openBars, vwaps, deltas, open0930, lastClose, atr14d } = params;
  if (openBars.length === 0) {
    return {
      openingType: 'PENDING_OPEN',
      openingDirection: 'NEUTRAL',
      openCrossCount: 0,
      vwapCrossCount: 0,
    };
  }

  const rawBars = openBars.map((entry) => entry.bar);
  const openCrossCount = countLevelCrosses(
    rawBars,
    new Array<number>(rawBars.length).fill(open0930),
  );
  const vwapCrossCount = countLevelCrosses(rawBars, vwaps);
  const lastVwap = vwaps[vwaps.length - 1] ?? Number.NaN;

  const atrValid = Number.isFinite(atr14d) && atr14d > 0;
  if (!atrValid) {
    return {
      openingType: 'OPEN_AUCTION',
      openingDirection: 'NEUTRAL',
      openCrossCount,
      vwapCrossCount,
    };
  }

  const driveTol = params.openCrossToleranceAtr * atr14d;
  const proximityLimit = params.boundaryProximityAtr * atr14d;
  const rejectionTol = params.rejectionTouchAtr * atr14d;
  const sweepEndMinutes = RTH_START_MINUTES + params.testDriveSweepWindowMinutes;

  const lowBoundaries: number[] = [];
  if (Number.isFinite(params.pml)) {
    lowBoundaries.push(params.pml);
  }
  if (Number.isFinite(params.prevRthLow)) {
    lowBoundaries.push(params.prevRthLow);
  }

  const highBoundaries: number[] = [];
  if (Number.isFinite(params.pmh)) {
    highBoundaries.push(params.pmh);
  }
  if (Number.isFinite(params.prevRthHigh)) {
    highBoundaries.push(params.prevRthHigh);
  }

  const bullishTestDrive = checkTestDriveCandidate({
    openBars,
    open0930,
    lastClose,
    lastVwap,
    boundaries: lowBoundaries,
    direction: 'BULLISH',
    proximityLimit,
    sweepEndMinutes,
  });

  const bearishTestDrive = checkTestDriveCandidate({
    openBars,
    open0930,
    lastClose,
    lastVwap,
    boundaries: highBoundaries,
    direction: 'BEARISH',
    proximityLimit,
    sweepEndMinutes,
  });

  const rvolDriveValid =
    Number.isFinite(params.openingRvol) && params.openingRvol > params.openDriveMinRvol;
  if (rvolDriveValid) {
    const bullishDrive =
      !bullishTestDrive &&
      lastClose > open0930 + driveTol &&
      (!Number.isFinite(lastVwap) || lastClose > lastVwap) &&
      rawBars.every((b) => b.low >= open0930 - driveTol && b.close >= open0930 - driveTol);
    if (bullishDrive) {
      return {
        openingType: 'OPEN_DRIVE',
        openingDirection: 'BULLISH',
        openCrossCount,
        vwapCrossCount,
      };
    }

    const bearishDrive =
      !bearishTestDrive &&
      lastClose < open0930 - driveTol &&
      (!Number.isFinite(lastVwap) || lastClose < lastVwap) &&
      rawBars.every((b) => b.high <= open0930 + driveTol && b.close <= open0930 + driveTol);
    if (bearishDrive) {
      return {
        openingType: 'OPEN_DRIVE',
        openingDirection: 'BEARISH',
        openCrossCount,
        vwapCrossCount,
      };
    }
  }

  const ceilingRejection = checkRejectionReverse({
    openBars,
    deltas,
    open0930,
    lastClose,
    lastVwap,
    extremeLevel: params.pmh,
    touchTol: rejectionTol,
    onPoc: params.onPoc,
    prevRthClose: params.prevRthClose,
    direction: 'BEARISH',
  });

  const floorRejection = checkRejectionReverse({
    openBars,
    deltas,
    open0930,
    lastClose,
    lastVwap,
    extremeLevel: params.pml,
    touchTol: rejectionTol,
    onPoc: params.onPoc,
    prevRthClose: params.prevRthClose,
    direction: 'BULLISH',
  });

  if (ceilingRejection && (!bearishTestDrive || params.inventoryRisk === 'LONG_LIQUIDATION_RISK')) {
    return {
      openingType: 'OPEN_REJECTION_REVERSE',
      openingDirection: 'BEARISH',
      openCrossCount,
      vwapCrossCount,
    };
  }
  if (floorRejection && (!bullishTestDrive || params.inventoryRisk === 'SHORT_COVERING_RISK')) {
    return {
      openingType: 'OPEN_REJECTION_REVERSE',
      openingDirection: 'BULLISH',
      openCrossCount,
      vwapCrossCount,
    };
  }

  if (bullishTestDrive) {
    return {
      openingType: 'OPEN_TEST_DRIVE',
      openingDirection: 'BULLISH',
      openCrossCount,
      vwapCrossCount,
    };
  }
  if (bearishTestDrive) {
    return {
      openingType: 'OPEN_TEST_DRIVE',
      openingDirection: 'BEARISH',
      openCrossCount,
      vwapCrossCount,
    };
  }

  if (ceilingRejection) {
    return {
      openingType: 'OPEN_REJECTION_REVERSE',
      openingDirection: 'BEARISH',
      openCrossCount,
      vwapCrossCount,
    };
  }
  if (floorRejection) {
    return {
      openingType: 'OPEN_REJECTION_REVERSE',
      openingDirection: 'BULLISH',
      openCrossCount,
      vwapCrossCount,
    };
  }

  // En subasta rotacional sin drive/sweep/reversión, la direccionalidad es neutral.
  return {
    openingType: 'OPEN_AUCTION',
    openingDirection: 'NEUTRAL',
    openCrossCount,
    vwapCrossCount,
  };
}

function computeInitialBalance(params: {
  readonly asOfParts: MarketParts;
  readonly sessionDate: string;
  readonly ibBars: readonly MicrostructureBar[];
  readonly atr14d: number;
}): {
  readonly ibh: number;
  readonly ibl: number;
  readonly ibWidth: number;
  readonly ibWidthAtr: number;
  readonly ibClassification: InitialBalanceClassification;
} {
  const isIbReady =
    params.asOfParts.dateKey > params.sessionDate ||
    (params.asOfParts.dateKey === params.sessionDate &&
      params.asOfParts.minutesOfDay >= IB_END_MINUTES);

  if (!isIbReady) {
    return {
      ibh: Number.NaN,
      ibl: Number.NaN,
      ibWidth: Number.NaN,
      ibWidthAtr: Number.NaN,
      ibClassification: 'PENDING_IB',
    };
  }

  let ibh = Number.NEGATIVE_INFINITY;
  let ibl = Number.POSITIVE_INFINITY;
  let validCount = 0;

  for (const bar of params.ibBars) {
    if (!isUsableOhlcv(bar)) {
      continue;
    }
    validCount += 1;
    if (bar.high > ibh) {
      ibh = bar.high;
    }
    if (bar.low < ibl) {
      ibl = bar.low;
    }
  }

  if (validCount === 0) {
    return {
      ibh: Number.NaN,
      ibl: Number.NaN,
      ibWidth: Number.NaN,
      ibWidthAtr: Number.NaN,
      ibClassification: 'INSUFFICIENT_DATA',
    };
  }

  const ibWidth = ibh - ibl;
  if (!Number.isFinite(params.atr14d) || params.atr14d <= 0) {
    return {
      ibh,
      ibl,
      ibWidth,
      ibWidthAtr: Number.NaN,
      ibClassification: 'INSUFFICIENT_DATA',
    };
  }

  const ibWidthAtr = ibWidth / params.atr14d;
  let ibClassification: InitialBalanceClassification;
  if (ibWidthAtr < IB_NARROW_THRESHOLD_ATR) {
    ibClassification = 'NARROW_IB_EXPANSION_ALERT';
  } else if (ibWidthAtr > IB_WIDE_THRESHOLD_ATR) {
    ibClassification = 'WIDE_IB_CONSOLIDATION_BIAS';
  } else {
    ibClassification = 'NORMAL_IB';
  }

  return {
    ibh,
    ibl,
    ibWidth,
    ibWidthAtr,
    ibClassification,
  };
}

/**
 * Evalúa de forma pura y sin look-ahead la subasta de apertura completa (`04:00 – 10:30 ET`)
 * a fecha/hora `asOfUtcSec`: perfil overnight, referencias previas, nodo macro `08:30 ET`,
 * balance e inventario overnight, taxonomía de apertura e Initial Balance.
 */
export function evaluateOpeningAuction(
  bars: readonly MicrostructureBar[],
  options: OpeningAuctionOptions,
): OpeningAuctionResult {
  assertValidUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');
  assertValidBarSeconds(options.barSeconds);

  const asOfParts = getMarketParts(options.asOfUtcSec, 'EQUITY');
  const sessionDate =
    options.sessionDate === undefined ? asOfParts.dateKey : options.sessionDate.trim();
  if (!CALENDAR_DATE_RE.test(sessionDate)) {
    throw new Error(`sessionDate must follow YYYY-MM-DD (got ${sessionDate})`);
  }

  const tickSize = resolvePositiveConfig(options.tickSize, DEFAULT_TICK_SIZE, 'tickSize');
  const valueAreaPct =
    options.valueAreaPct === undefined ? DEFAULT_VALUE_AREA_PCT : options.valueAreaPct;
  const macroRangeMultiplier = resolvePositiveConfig(
    options.macroRangeMultiplier,
    DEFAULT_MACRO_RANGE_MULTIPLIER,
    'macroRangeMultiplier',
  );
  const macroVolumeMultiplier = resolvePositiveConfig(
    options.macroVolumeMultiplier,
    DEFAULT_MACRO_VOLUME_MULTIPLIER,
    'macroVolumeMultiplier',
  );
  const inventoryImbalanceThreshold = resolvePositiveConfig(
    options.inventoryImbalanceThreshold,
    DEFAULT_INVENTORY_IMBALANCE_THRESHOLD,
    'inventoryImbalanceThreshold',
  );
  if (inventoryImbalanceThreshold > 1) {
    throw new Error(
      `inventoryImbalanceThreshold must be <= 1 (got ${String(inventoryImbalanceThreshold)})`,
    );
  }

  const openCrossToleranceAtr = resolveNonNegativeConfig(
    options.openCrossToleranceAtr,
    DEFAULT_OPEN_CROSS_TOLERANCE_ATR,
    'openCrossToleranceAtr',
  );
  const openDriveMinRvol = resolvePositiveConfig(
    options.openDriveMinRvol,
    DEFAULT_OPEN_DRIVE_MIN_RVOL,
    'openDriveMinRvol',
  );
  const boundaryProximityAtr = resolvePositiveConfig(
    options.boundaryProximityAtr,
    DEFAULT_BOUNDARY_PROXIMITY_ATR,
    'boundaryProximityAtr',
  );
  const testDriveSweepWindowMinutes = resolvePositiveConfig(
    options.testDriveSweepWindowMinutes,
    DEFAULT_TEST_DRIVE_SWEEP_WINDOW_MINUTES,
    'testDriveSweepWindowMinutes',
  );
  const rejectionTouchAtr = resolveNonNegativeConfig(
    options.rejectionTouchAtr,
    DEFAULT_REJECTION_TOUCH_ATR,
    'rejectionTouchAtr',
  );
  resolvePositiveConfig(
    options.openAuctionMinCrosses,
    DEFAULT_OPEN_AUCTION_MIN_CROSSES,
    'openAuctionMinCrosses',
  );

  // Filtrado estricto anti look-ahead antes de ordenar o inspeccionar precios/volúmenes futuros.
  let excludedFutureBarCount = 0;
  const closedSessionBars: IndexedSessionBar[] = [];
  for (const bar of bars) {
    assertValidUtcSeconds(bar.time, 'bar.time');
    if (bar.time + options.barSeconds > options.asOfUtcSec) {
      excludedFutureBarCount += 1;
      continue;
    }
    const parts = getMarketParts(bar.time, 'EQUITY');
    if (parts.dateKey !== sessionDate) {
      continue;
    }
    if (parts.minutesOfDay >= PRE_MARKET_START_MINUTES && parts.minutesOfDay < RTH_END_MINUTES) {
      isUsableOhlcv(bar);
      closedSessionBars.push({ bar, parts });
    }
  }

  closedSessionBars.sort((a, b) => a.bar.time - b.bar.time);
  for (let i = 1; i < closedSessionBars.length; i += 1) {
    const prev = closedSessionBars[i - 1];
    const curr = closedSessionBars[i];
    if (prev !== undefined && curr !== undefined && curr.bar.time <= prev.bar.time) {
      throw new Error(`Duplicate closed bar timestamp at time=${String(curr.bar.time)}`);
    }
  }

  const preMarketIndexed: IndexedSessionBar[] = [];
  const rthIndexed: IndexedSessionBar[] = [];
  for (const entry of closedSessionBars) {
    if (entry.parts.minutesOfDay < RTH_START_MINUTES) {
      preMarketIndexed.push(entry);
    } else {
      rthIndexed.push(entry);
    }
  }

  const preMarketBars = preMarketIndexed.map((entry) => entry.bar);
  const overnightVolumeProfile = computeOvernightVolumeProfile(preMarketBars, {
    tickSize,
    valueAreaPct,
  });

  const macro0830 = detectMacro0830Spike(preMarketBars, options.barSeconds, {
    rangeMultiplier: macroRangeMultiplier,
    volumeMultiplier: macroVolumeMultiplier,
  });

  const prevRthClose =
    options.prevRthClose !== undefined && Number.isFinite(options.prevRthClose)
      ? options.prevRthClose
      : Number.NaN;
  const prevRthHigh =
    options.prevRthHigh !== undefined && Number.isFinite(options.prevRthHigh)
      ? options.prevRthHigh
      : Number.NaN;
  const prevRthLow =
    options.prevRthLow !== undefined && Number.isFinite(options.prevRthLow)
      ? options.prevRthLow
      : Number.NaN;
  const atr14d =
    options.atr14d !== undefined && Number.isFinite(options.atr14d) && options.atr14d > 0
      ? options.atr14d
      : Number.NaN;
  const expectedWindowVolume =
    options.expectedWindowVolume !== undefined &&
    Number.isFinite(options.expectedWindowVolume) &&
    options.expectedWindowVolume > 0
      ? options.expectedWindowVolume
      : Number.NaN;

  const usableRthIndexed = rthIndexed.filter((entry) => isUsableOhlcv(entry.bar));
  const usablePreMarketBars = preMarketBars.filter((bar) => isUsableOhlcv(bar));

  const firstRth = usableRthIndexed[0]?.bar;
  const lastRth = usableRthIndexed[usableRthIndexed.length - 1]?.bar;
  const lastPreMarket = usablePreMarketBars[usablePreMarketBars.length - 1];

  const open0930 = firstRth !== undefined ? firstRth.open : Number.NaN;
  const currentClose = lastRth !== undefined ? lastRth.close : Number.NaN;
  const referencePrice =
    firstRth !== undefined
      ? firstRth.open
      : lastPreMarket !== undefined
        ? lastPreMarket.close
        : Number.NaN;

  const trueGap =
    Number.isFinite(referencePrice) && Number.isFinite(prevRthClose)
      ? referencePrice - prevRthClose
      : Number.NaN;
  const trueGapAtr =
    Number.isFinite(trueGap) && Number.isFinite(atr14d) && atr14d > 0
      ? trueGap / atr14d
      : Number.NaN;

  const balanceType = resolveBalanceType(
    referencePrice,
    overnightVolumeProfile.pml,
    overnightVolumeProfile.pmh,
    prevRthLow,
    prevRthHigh,
  );

  let rthCumVolume = usableRthIndexed.length === 0 ? Number.NaN : 0;
  let cumulativeRthDelta = usableRthIndexed.length === 0 ? Number.NaN : 0;
  if (usableRthIndexed.length > 0) {
    for (const entry of usableRthIndexed) {
      rthCumVolume += entry.bar.volume;
      const barDelta = computeBarDelta(entry.bar);
      cumulativeRthDelta =
        Number.isFinite(cumulativeRthDelta) && Number.isFinite(barDelta)
          ? cumulativeRthDelta + barDelta
          : Number.NaN;
    }
  }

  const openingRvol =
    usableRthIndexed.length > 0 &&
    Number.isFinite(rthCumVolume) &&
    Number.isFinite(expectedWindowVolume) &&
    expectedWindowVolume > 0
      ? rthCumVolume / expectedWindowVolume
      : Number.NaN;
  const lowImmediateReversalProb =
    Number.isFinite(openingRvol) && openingRvol > RVOL_LOW_REVERSAL_THRESHOLD;

  const inventorySplit = computePreMarketInventorySplit(usablePreMarketBars, prevRthClose);
  const { inventoryRisk, statisticalTargets } = classifyInventoryRisk({
    hasRthBars: usableRthIndexed.length > 0,
    pctAbove: inventorySplit.pctAbove,
    pctBelow: inventorySplit.pctBelow,
    cumulativeRthDelta,
    open0930,
    currentClose,
    prevRthClose,
    onPoc: overnightVolumeProfile.onPoc,
    imbalanceThreshold: inventoryImbalanceThreshold,
  });

  // VWAP de sesión RTH oficial usando src/core/sessionVwap.ts sobre las barras utilizables de la sesión.
  const vwapMap = new Map<number, number>();
  if (usableRthIndexed.length > 0) {
    const usableSessionBars = closedSessionBars
      .filter((entry) => isUsableOhlcv(entry.bar))
      .map((entry) => entry.bar);
    const vwapSeries = computeSessionVwap(usableSessionBars, {
      market: 'EQUITY',
      barSeconds: options.barSeconds,
    });
    for (const point of vwapSeries.points) {
      vwapMap.set(point.time, point.vwap);
    }
  }

  const sessionVwap =
    lastRth !== undefined ? (vwapMap.get(lastRth.time) ?? Number.NaN) : Number.NaN;

  const openingWindowIndexed = usableRthIndexed.filter(
    (entry) => entry.parts.minutesOfDay < IB_END_MINUTES,
  );
  const openingWindowVwaps = openingWindowIndexed.map(
    (entry) => vwapMap.get(entry.bar.time) ?? Number.NaN,
  );
  const openingWindowDeltas = openingWindowIndexed.map((entry) => computeBarDelta(entry.bar));

  const taxonomy = classifyOpeningType({
    openBars: openingWindowIndexed,
    vwaps: openingWindowVwaps,
    deltas: openingWindowDeltas,
    open0930,
    lastClose:
      openingWindowIndexed[openingWindowIndexed.length - 1]?.bar.close ?? Number.NaN,
    atr14d,
    openingRvol,
    pmh: overnightVolumeProfile.pmh,
    pml: overnightVolumeProfile.pml,
    onPoc: overnightVolumeProfile.onPoc,
    prevRthClose,
    prevRthHigh,
    prevRthLow,
    inventoryRisk,
    openCrossToleranceAtr,
    openDriveMinRvol,
    boundaryProximityAtr,
    testDriveSweepWindowMinutes,
    rejectionTouchAtr,
  });

  const ibBars = openingWindowIndexed.map((entry) => entry.bar);
  const ib = computeInitialBalance({
    asOfParts,
    sessionDate,
    ibBars,
    atr14d,
  });

  return {
    sessionDate,
    asOfUtcSec: options.asOfUtcSec,
    preMarketBarCount: preMarketBars.length,
    rthBarCount: rthIndexed.length,
    excludedFutureBarCount,
    pmh: overnightVolumeProfile.pmh,
    pml: overnightVolumeProfile.pml,
    onPoc: overnightVolumeProfile.onPoc,
    onVah: overnightVolumeProfile.onVah,
    onVal: overnightVolumeProfile.onVal,
    preMarketVwap: overnightVolumeProfile.preMarketVwap,
    overnightVolumeProfile,
    referencePrice,
    open0930,
    currentClose,
    sessionVwap,
    trueGap,
    trueGapAtr,
    macro0830Detected: macro0830.detected,
    macro0830High: macro0830.high,
    macro0830Low: macro0830.low,
    medianPreMarketRange: macro0830.medianPreMarketRange,
    medianPreMarketVolume: macro0830.medianPreMarketVolume,
    balanceType,
    rthCumVolume,
    openingRvol,
    lowImmediateReversalProb,
    pctVolumeAbovePrevClose: inventorySplit.pctAbove,
    pctVolumeBelowPrevClose: inventorySplit.pctBelow,
    cumulativeRthDelta,
    inventoryRisk,
    statisticalTargets,
    openingType: taxonomy.openingType,
    openingDirection: taxonomy.openingDirection,
    openCrossCount: taxonomy.openCrossCount,
    vwapCrossCount: taxonomy.vwapCrossCount,
    ibh: ib.ibh,
    ibl: ib.ibl,
    ibWidth: ib.ibWidth,
    ibWidthAtr: ib.ibWidthAtr,
    ibClassification: ib.ibClassification,
  };
}
