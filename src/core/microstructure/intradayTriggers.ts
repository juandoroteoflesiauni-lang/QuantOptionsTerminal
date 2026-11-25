/**
 * S2-3 — Capa opcional de gatillos OHLCV causales (1m y 5m):
 *  1) Máquina de estados FVG / IFVG (6 estados exactos) con confirmación causal
 *     al cierre de la 3.ª vela y tope determinista de hasta 3 zonas activas.
 *  2) Detector causal de Liquidity Sweeps (barrida de mecha + recuperación de cierre)
 *     sobre niveles existentes (`PDH/PDL`, `PMH/PML`, `ORH/ORL`, `CALL_WALL/PUT_WALL`).
 *
 * Funciones 100% puras sobre barras cerradas (`bar.time + barSeconds <= asOfUtcSec`),
 * sin red, sin UI, sin mutación de argumentos y con degradación honesta ante
 * niveles ausentes (`NaN` / `null` / `UNAVAILABLE`).
 */

import type { SessionLevel } from '../sessionKeyLevels.js';

export interface IntradayTriggerBarInput {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vw?: number | null | undefined;
}

export type IntradayTriggerTimeframe = '1m' | '5m';
export type FvgDirection = 'BULLISH' | 'BEARISH';

export type FvgLifecycleState =
  | 'ACTIVE_UNMITIGATED'
  | 'ACTIVE_PARTIALLY_MITIGATED'
  | 'MITIGATED_FILLED'
  | 'INVERTED_IFVG_ACTIVE'
  | 'IFVG_MITIGATED'
  | 'EXPIRED';

export type SweepTargetLevelId =
  | 'PDH'
  | 'PDL'
  | 'PMH'
  | 'PML'
  | 'ORH'
  | 'ORL'
  | 'CALL_WALL'
  | 'PUT_WALL';

export type SweepLevelSide = 'HIGH' | 'LOW';

export interface SweepReferenceLevelInput {
  readonly id: SweepTargetLevelId;
  readonly side: SweepLevelSide;
  readonly price: number | null | undefined;
  readonly status?: 'UNAVAILABLE' | 'PROVISIONAL' | 'DEFINITIVE';
  readonly activeFromUtcSec?: number | null;
}

export interface NormalizedSweepReferenceLevel {
  readonly id: SweepTargetLevelId;
  readonly side: SweepLevelSide;
  readonly price: number;
  readonly activeFromUtcSec: number;
}

export interface IntradayTriggerZone {
  readonly id: string;
  readonly timeframe: IntradayTriggerTimeframe;
  readonly methodology: 'OHLCV';
  readonly state: FvgLifecycleState;
  readonly initialDirection: FvgDirection;
  readonly activeDirection: FvgDirection;
  readonly isInverted: boolean;
  readonly anchorStartTime: number;
  readonly formedAtTime: number;
  readonly formedAtBarIndex: number;
  readonly gapLow: number;
  readonly gapHigh: number;
  readonly gapWidth: number;
  readonly midpoint: number;
  readonly mitigationRatio: number;
  readonly ifvgMitigationRatio: number;
  readonly mitigatedAtTime: number | null;
  readonly invertedAtTime: number | null;
  readonly invertedAtBarIndex: number | null;
  readonly ifvgMitigatedAtTime: number | null;
  readonly expiredAtTime: number | null;
  readonly distanceToPrice: number;
}

export interface LiquiditySweepEvent {
  readonly id: string;
  readonly timeframe: IntradayTriggerTimeframe;
  readonly methodology: 'OHLCV';
  readonly provenanceLabel: 'OHLCV_WICK_CLOSE_RECOVERY';
  readonly levelId: SweepTargetLevelId;
  readonly levelSide: SweepLevelSide;
  readonly direction: FvgDirection;
  readonly levelPrice: number;
  readonly barTime: number;
  readonly barIndex: number;
  readonly wickExtreme: number;
  readonly closePrice: number;
  readonly wickExcursion: number;
  readonly closeRecovery: number;
}

export interface IntradayTriggersOptions {
  readonly timeframe: string;
  readonly asOfUtcSec: number;
  readonly referenceLevels?: readonly SweepReferenceLevelInput[];
  readonly referencePrice?: number | null;
  readonly minAbsGap?: number;
  readonly minGapRatio?: number;
  readonly minDisplacementBodyRatio?: number;
  readonly maxTripletSpanSec?: number;
  readonly maxZoneAgeBars?: number;
  readonly maxActiveZones?: number;
  readonly minAbsSweepExcursion?: number;
  readonly minSweepExcursionRatio?: number;
  readonly minAbsSweepRecovery?: number;
  readonly minSweepRecoveryRatio?: number;
  readonly sweepCooldownBars?: number;
  readonly maxVisibleSweeps?: number;
}

export interface IntradayTriggersResult {
  readonly status: 'OK' | 'UNSUPPORTED_TIMEFRAME' | 'NO_CLOSED_BARS';
  readonly methodology: 'OHLCV';
  readonly timeframe: IntradayTriggerTimeframe | null;
  readonly barSeconds: number;
  readonly asOfUtcSec: number;
  readonly closedBarCount: number;
  readonly excludedFormingOrFutureCount: number;
  readonly referencePrice: number;
  readonly activeZones: readonly IntradayTriggerZone[];
  readonly allZones: readonly IntradayTriggerZone[];
  readonly visibleSweeps: readonly LiquiditySweepEvent[];
  readonly allSweeps: readonly LiquiditySweepEvent[];
}

export interface IntradayTriggerZoneDto {
  readonly id: string;
  readonly timeframe: IntradayTriggerTimeframe;
  readonly methodology: 'OHLCV';
  readonly state: FvgLifecycleState;
  readonly initialDirection: FvgDirection;
  readonly activeDirection: FvgDirection;
  readonly isInverted: boolean;
  readonly anchorStartTime: number;
  readonly formedAtTime: number;
  readonly formedAtBarIndex: number;
  readonly gapLow: number;
  readonly gapHigh: number;
  readonly gapWidth: number;
  readonly midpoint: number;
  readonly mitigationRatio: number;
  readonly ifvgMitigationRatio: number;
  readonly mitigatedAtTime: number | null;
  readonly invertedAtTime: number | null;
  readonly invertedAtBarIndex: number | null;
  readonly ifvgMitigatedAtTime: number | null;
  readonly expiredAtTime: number | null;
  readonly distanceToPrice: number | null;
}

export interface LiquiditySweepEventDto {
  readonly id: string;
  readonly timeframe: IntradayTriggerTimeframe;
  readonly methodology: 'OHLCV';
  readonly provenanceLabel: 'OHLCV_WICK_CLOSE_RECOVERY';
  readonly levelId: SweepTargetLevelId;
  readonly levelSide: SweepLevelSide;
  readonly direction: FvgDirection;
  readonly levelPrice: number;
  readonly barTime: number;
  readonly barIndex: number;
  readonly wickExtreme: number;
  readonly closePrice: number;
  readonly wickExcursion: number;
  readonly closeRecovery: number;
}

export interface IntradayTriggersDto {
  readonly status: 'OK' | 'UNSUPPORTED_TIMEFRAME' | 'NO_CLOSED_BARS';
  readonly methodology: 'OHLCV';
  readonly timeframe: IntradayTriggerTimeframe | null;
  readonly barSeconds: number | null;
  readonly asOfUtcSec: number;
  readonly closedBarCount: number;
  readonly excludedFormingOrFutureCount: number;
  readonly referencePrice: number | null;
  readonly activeZones: readonly IntradayTriggerZoneDto[];
  readonly visibleSweeps: readonly LiquiditySweepEventDto[];
}

export const DEFAULT_MAX_ACTIVE_ZONES = 3;
export const DEFAULT_MIN_ABS_GAP = 0.01;
export const DEFAULT_MIN_GAP_RATIO = 0.0004;
export const DEFAULT_MIN_DISPLACEMENT_BODY_RATIO = 0.45;
export const DEFAULT_MIN_ABS_SWEEP_EXCURSION = 0;
export const DEFAULT_MIN_SWEEP_EXCURSION_RATIO = 0.0001;
export const DEFAULT_MIN_ABS_SWEEP_RECOVERY = 0;
export const DEFAULT_MIN_SWEEP_RECOVERY_RATIO = 0.00005;
export const DEFAULT_SWEEP_COOLDOWN_BARS = 3;
export const DEFAULT_MAX_VISIBLE_SWEEPS = 6;

const SWEEP_LEVEL_ORDER: readonly SweepTargetLevelId[] = [
  'PDH',
  'PDL',
  'PMH',
  'PML',
  'ORH',
  'ORL',
  'CALL_WALL',
  'PUT_WALL',
];

const TIE_EPS = 1e-12;

interface ResolvedTriggerConfig {
  readonly timeframe: IntradayTriggerTimeframe;
  readonly barSeconds: 60 | 300;
  readonly minAbsGap: number;
  readonly minGapRatio: number;
  readonly minDisplacementBodyRatio: number;
  readonly maxTripletSpanSec: number;
  readonly maxZoneAgeBars: number;
  readonly maxActiveZones: number;
  readonly minAbsSweepExcursion: number;
  readonly minSweepExcursionRatio: number;
  readonly minAbsSweepRecovery: number;
  readonly minSweepRecoveryRatio: number;
  readonly sweepCooldownBars: number;
  readonly maxVisibleSweeps: number;
}

interface InternalFsmZone {
  readonly id: string;
  readonly timeframe: IntradayTriggerTimeframe;
  readonly state: FvgLifecycleState;
  readonly initialDirection: FvgDirection;
  readonly activeDirection: FvgDirection;
  readonly isInverted: boolean;
  readonly anchorStartTime: number;
  readonly formedAtTime: number;
  readonly formedAtBarIndex: number;
  readonly gapLow: number;
  readonly gapHigh: number;
  readonly gapWidth: number;
  readonly midpoint: number;
  readonly mitigationRatio: number;
  readonly ifvgMitigationRatio: number;
  readonly mitigatedAtTime: number | null;
  readonly invertedAtTime: number | null;
  readonly invertedAtBarIndex: number | null;
  readonly ifvgMitigatedAtTime: number | null;
  readonly expiredAtTime: number | null;
}

export interface IntradayTriggersLiveState {
  readonly config: ResolvedTriggerConfig;
  readonly watermark1mSec: number;
  readonly closedBarCount: number;
  readonly excludedFormingOrFutureCount: number;
  readonly prevBar: IntradayTriggerBarInput | null;
  readonly prevPrevBar: IntradayTriggerBarInput | null;
  readonly pending5mBucketStart: number | null;
  readonly pending5mBars: readonly IntradayTriggerBarInput[];
  readonly referenceLevels: readonly NormalizedSweepReferenceLevel[];
  readonly zones: readonly InternalFsmZone[];
  readonly lastSweepBarIndexByLevel: Readonly<Partial<Record<SweepTargetLevelId, number>>>;
  readonly sweeps: readonly LiquiditySweepEvent[];
  readonly result: IntradayTriggersResult;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function resolveTriggerTimeframe(timeframe: string): IntradayTriggerTimeframe | null {
  if (timeframe === '1m') return '1m';
  if (timeframe === '5m') return '5m';
  return null;
}

function resolveConfig(options: IntradayTriggersOptions): ResolvedTriggerConfig | null {
  const tf = resolveTriggerTimeframe(options.timeframe);
  if (tf === null) return null;
  const barSeconds: 60 | 300 = tf === '1m' ? 60 : 300;
  const maxActiveRaw = options.maxActiveZones ?? DEFAULT_MAX_ACTIVE_ZONES;
  const maxActiveZones = Math.max(1, Math.min(3, Math.floor(Number.isFinite(maxActiveRaw) ? maxActiveRaw : 3)));
  const maxZoneAgeDefault = tf === '1m' ? 120 : 78;
  const maxZoneAgeRaw = options.maxZoneAgeBars ?? maxZoneAgeDefault;
  const maxTripletSpanRaw = options.maxTripletSpanSec ?? 6 * barSeconds;
  const sweepCooldownRaw = options.sweepCooldownBars ?? DEFAULT_SWEEP_COOLDOWN_BARS;
  const maxVisibleSweepsRaw = options.maxVisibleSweeps ?? DEFAULT_MAX_VISIBLE_SWEEPS;

  return {
    timeframe: tf,
    barSeconds,
    minAbsGap: Math.max(0, options.minAbsGap ?? DEFAULT_MIN_ABS_GAP),
    minGapRatio: Math.max(0, options.minGapRatio ?? DEFAULT_MIN_GAP_RATIO),
    minDisplacementBodyRatio: clampRatio(options.minDisplacementBodyRatio ?? DEFAULT_MIN_DISPLACEMENT_BODY_RATIO),
    maxTripletSpanSec: Math.max(barSeconds * 2, Number.isFinite(maxTripletSpanRaw) ? maxTripletSpanRaw : 6 * barSeconds),
    maxZoneAgeBars: Math.max(1, Math.floor(Number.isFinite(maxZoneAgeRaw) ? maxZoneAgeRaw : maxZoneAgeDefault)),
    maxActiveZones,
    minAbsSweepExcursion: Math.max(0, options.minAbsSweepExcursion ?? DEFAULT_MIN_ABS_SWEEP_EXCURSION),
    minSweepExcursionRatio: Math.max(0, options.minSweepExcursionRatio ?? DEFAULT_MIN_SWEEP_EXCURSION_RATIO),
    minAbsSweepRecovery: Math.max(0, options.minAbsSweepRecovery ?? DEFAULT_MIN_ABS_SWEEP_RECOVERY),
    minSweepRecoveryRatio: Math.max(0, options.minSweepRecoveryRatio ?? DEFAULT_MIN_SWEEP_RECOVERY_RATIO),
    sweepCooldownBars: Math.max(1, Math.floor(Number.isFinite(sweepCooldownRaw) ? sweepCooldownRaw : DEFAULT_SWEEP_COOLDOWN_BARS)),
    maxVisibleSweeps: Math.max(1, Math.floor(Number.isFinite(maxVisibleSweepsRaw) ? maxVisibleSweepsRaw : DEFAULT_MAX_VISIBLE_SWEEPS)),
  };
}

function isValidOhlcvBar(bar: IntradayTriggerBarInput): boolean {
  return (
    Number.isSafeInteger(bar.time) &&
    bar.time > 0 &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    Number.isFinite(bar.volume) &&
    bar.open > 0 &&
    bar.high > 0 &&
    bar.low > 0 &&
    bar.close > 0 &&
    bar.volume >= 0 &&
    bar.high >= bar.low &&
    bar.high >= bar.open &&
    bar.high >= bar.close &&
    bar.low <= bar.open &&
    bar.low <= bar.close
  );
}

function sanitizeAndSortClosedBars(
  bars: readonly IntradayTriggerBarInput[],
  barSeconds: number,
  asOfUtcSec: number,
): {
  readonly closedBars: readonly IntradayTriggerBarInput[];
  readonly excludedFormingOrFutureCount: number;
} {
  if (!Number.isFinite(asOfUtcSec)) {
    return { closedBars: [], excludedFormingOrFutureCount: bars.length };
  }
  const deduped = new Map<number, IntradayTriggerBarInput>();
  let excluded = 0;
  for (const bar of bars) {
    if (!isValidOhlcvBar(bar)) {
      excluded += 1;
      continue;
    }
    if (bar.time + barSeconds > asOfUtcSec) {
      excluded += 1;
      continue;
    }
    deduped.set(bar.time, bar);
  }
  const closedBars = [...deduped.values()].sort((a, b) => a.time - b.time);
  return { closedBars, excludedFormingOrFutureCount: excluded };
}

export function normalizeSweepReferenceLevels(
  levels: readonly SweepReferenceLevelInput[] | undefined,
): readonly NormalizedSweepReferenceLevel[] {
  if (levels === undefined || levels.length === 0) return [];
  const byId = new Map<SweepTargetLevelId, NormalizedSweepReferenceLevel>();
  for (const lvl of levels) {
    if (lvl.status === 'UNAVAILABLE' || lvl.status === 'PROVISIONAL') continue;
    const price = lvl.price;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
    const activeFromRaw = lvl.activeFromUtcSec;
    const activeFromUtcSec =
      typeof activeFromRaw === 'number' && Number.isFinite(activeFromRaw) && activeFromRaw >= 0
        ? activeFromRaw
        : 0;
    byId.set(lvl.id, {
      id: lvl.id,
      side: lvl.side,
      price,
      activeFromUtcSec,
    });
  }
  const ordered: NormalizedSweepReferenceLevel[] = [];
  for (const id of SWEEP_LEVEL_ORDER) {
    const item = byId.get(id);
    if (item !== undefined) ordered.push(item);
  }
  return ordered;
}

export function buildSweepReferenceLevelsFromSession(params: {
  readonly sessionLevels?: readonly SessionLevel[];
  readonly callWall?: number | null;
  readonly putWall?: number | null;
  readonly wallsActiveFromUtcSec?: number | null;
}): readonly SweepReferenceLevelInput[] {
  const result: SweepReferenceLevelInput[] = [];
  if (params.sessionLevels !== undefined) {
    for (const lvl of params.sessionLevels) {
      const side: SweepLevelSide =
        lvl.id === 'PDH' || lvl.id === 'PMH' || lvl.id === 'ORH' ? 'HIGH' : 'LOW';
      result.push({
        id: lvl.id,
        side,
        price: lvl.value,
        status: lvl.status,
        activeFromUtcSec: Number.isFinite(lvl.endExclusive) ? lvl.endExclusive : 0,
      });
    }
  }
  const wallStart =
    typeof params.wallsActiveFromUtcSec === 'number' && Number.isFinite(params.wallsActiveFromUtcSec)
      ? params.wallsActiveFromUtcSec
      : 0;
  if (typeof params.callWall === 'number' && Number.isFinite(params.callWall) && params.callWall > 0) {
    result.push({
      id: 'CALL_WALL',
      side: 'HIGH',
      price: params.callWall,
      status: 'DEFINITIVE',
      activeFromUtcSec: wallStart,
    });
  }
  if (typeof params.putWall === 'number' && Number.isFinite(params.putWall) && params.putWall > 0) {
    result.push({
      id: 'PUT_WALL',
      side: 'LOW',
      price: params.putWall,
      status: 'DEFINITIVE',
      activeFromUtcSec: wallStart,
    });
  }
  return result;
}

function advanceZoneOnClosedBar(
  zone: InternalFsmZone,
  bar: IntradayTriggerBarInput,
  barIndex: number,
  maxZoneAgeBars: number,
): InternalFsmZone {
  if (zone.state === 'IFVG_MITIGATED' || zone.state === 'EXPIRED') {
    return zone;
  }

  const ageAnchorIdx =
    zone.isInverted && zone.invertedAtBarIndex !== null
      ? zone.invertedAtBarIndex
      : zone.formedAtBarIndex;
  if (barIndex - ageAnchorIdx > maxZoneAgeBars) {
    return {
      ...zone,
      state: 'EXPIRED',
      expiredAtTime: bar.time,
    };
  }

  if (zone.state === 'ACTIVE_UNMITIGATED' || zone.state === 'ACTIVE_PARTIALLY_MITIGATED') {
    if (zone.initialDirection === 'BULLISH') {
      if (bar.close < zone.gapLow) {
        return {
          ...zone,
          state: 'INVERTED_IFVG_ACTIVE',
          activeDirection: 'BEARISH',
          isInverted: true,
          mitigationRatio: 1,
          ifvgMitigationRatio: 0,
          mitigatedAtTime: zone.mitigatedAtTime ?? bar.time,
          invertedAtTime: bar.time,
          invertedAtBarIndex: barIndex,
        };
      }
      if (bar.low <= zone.gapLow) {
        return {
          ...zone,
          state: 'MITIGATED_FILLED',
          mitigationRatio: 1,
          mitigatedAtTime: bar.time,
        };
      }
      if (bar.low < zone.gapHigh) {
        const nextFill = Math.max(
          zone.mitigationRatio,
          clampRatio((zone.gapHigh - bar.low) / zone.gapWidth),
        );
        return {
          ...zone,
          state: 'ACTIVE_PARTIALLY_MITIGATED',
          mitigationRatio: nextFill,
        };
      }
      return zone;
    }

    // initialDirection === 'BEARISH'
    if (bar.close > zone.gapHigh) {
      return {
        ...zone,
        state: 'INVERTED_IFVG_ACTIVE',
        activeDirection: 'BULLISH',
        isInverted: true,
        mitigationRatio: 1,
        ifvgMitigationRatio: 0,
        mitigatedAtTime: zone.mitigatedAtTime ?? bar.time,
        invertedAtTime: bar.time,
        invertedAtBarIndex: barIndex,
      };
    }
    if (bar.high >= zone.gapHigh) {
      return {
        ...zone,
        state: 'MITIGATED_FILLED',
        mitigationRatio: 1,
        mitigatedAtTime: bar.time,
      };
    }
    if (bar.high > zone.gapLow) {
      const nextFill = Math.max(
        zone.mitigationRatio,
        clampRatio((bar.high - zone.gapLow) / zone.gapWidth),
      );
      return {
        ...zone,
        state: 'ACTIVE_PARTIALLY_MITIGATED',
        mitigationRatio: nextFill,
      };
    }
    return zone;
  }

  if (zone.state === 'MITIGATED_FILLED') {
    if (zone.initialDirection === 'BULLISH' && bar.close < zone.gapLow) {
      return {
        ...zone,
        state: 'INVERTED_IFVG_ACTIVE',
        activeDirection: 'BEARISH',
        isInverted: true,
        ifvgMitigationRatio: 0,
        invertedAtTime: bar.time,
        invertedAtBarIndex: barIndex,
      };
    }
    if (zone.initialDirection === 'BEARISH' && bar.close > zone.gapHigh) {
      return {
        ...zone,
        state: 'INVERTED_IFVG_ACTIVE',
        activeDirection: 'BULLISH',
        isInverted: true,
        ifvgMitigationRatio: 0,
        invertedAtTime: bar.time,
        invertedAtBarIndex: barIndex,
      };
    }
    return zone;
  }

  // zone.state === 'INVERTED_IFVG_ACTIVE'
  if (zone.activeDirection === 'BEARISH') {
    if (bar.high >= zone.gapHigh || bar.close > zone.gapHigh) {
      return {
        ...zone,
        state: 'IFVG_MITIGATED',
        ifvgMitigationRatio: 1,
        ifvgMitigatedAtTime: bar.time,
      };
    }
    if (bar.high > zone.gapLow) {
      const nextIfvgFill = Math.max(
        zone.ifvgMitigationRatio,
        clampRatio((bar.high - zone.gapLow) / zone.gapWidth),
      );
      return {
        ...zone,
        ifvgMitigationRatio: nextIfvgFill,
      };
    }
    return zone;
  }

  // zone.activeDirection === 'BULLISH'
  if (bar.low <= zone.gapLow || bar.close < zone.gapLow) {
    return {
      ...zone,
      state: 'IFVG_MITIGATED',
      ifvgMitigationRatio: 1,
      ifvgMitigatedAtTime: bar.time,
    };
  }
  if (bar.low < zone.gapHigh) {
    const nextIfvgFill = Math.max(
      zone.ifvgMitigationRatio,
      clampRatio((zone.gapHigh - bar.low) / zone.gapWidth),
    );
    return {
      ...zone,
      ifvgMitigationRatio: nextIfvgFill,
    };
  }
  return zone;
}

function tryDetectFvgFromTriplet(
  c0: IntradayTriggerBarInput,
  c1: IntradayTriggerBarInput,
  c2: IntradayTriggerBarInput,
  formedAtBarIndex: number,
  config: ResolvedTriggerConfig,
): InternalFsmZone | null {
  if (c2.time - c0.time > config.maxTripletSpanSec) return null;
  const c1Range = c1.high - c1.low;
  if (!(c1Range > 0)) return null;
  const c1Body = Math.abs(c1.close - c1.open);
  if (c1Body < config.minDisplacementBodyRatio * c1Range) return null;

  const minGapWidth = Math.max(config.minAbsGap, config.minGapRatio * c1.close);

  if (c2.low > c0.high && c1.close > c1.open) {
    const gapLow = c0.high;
    const gapHigh = c2.low;
    const gapWidth = gapHigh - gapLow;
    if (gapWidth >= minGapWidth && gapWidth > 0) {
      return {
        id: `fvg:${config.timeframe}:${String(c2.time)}:BULLISH`,
        timeframe: config.timeframe,
        state: 'ACTIVE_UNMITIGATED',
        initialDirection: 'BULLISH',
        activeDirection: 'BULLISH',
        isInverted: false,
        anchorStartTime: c0.time,
        formedAtTime: c2.time,
        formedAtBarIndex,
        gapLow,
        gapHigh,
        gapWidth,
        midpoint: 0.5 * (gapLow + gapHigh),
        mitigationRatio: 0,
        ifvgMitigationRatio: 0,
        mitigatedAtTime: null,
        invertedAtTime: null,
        invertedAtBarIndex: null,
        ifvgMitigatedAtTime: null,
        expiredAtTime: null,
      };
    }
  }

  if (c2.high < c0.low && c1.close < c1.open) {
    const gapLow = c2.high;
    const gapHigh = c0.low;
    const gapWidth = gapHigh - gapLow;
    if (gapWidth >= minGapWidth && gapWidth > 0) {
      return {
        id: `fvg:${config.timeframe}:${String(c2.time)}:BEARISH`,
        timeframe: config.timeframe,
        state: 'ACTIVE_UNMITIGATED',
        initialDirection: 'BEARISH',
        activeDirection: 'BEARISH',
        isInverted: false,
        anchorStartTime: c0.time,
        formedAtTime: c2.time,
        formedAtBarIndex,
        gapLow,
        gapHigh,
        gapWidth,
        midpoint: 0.5 * (gapLow + gapHigh),
        mitigationRatio: 0,
        ifvgMitigationRatio: 0,
        mitigatedAtTime: null,
        invertedAtTime: null,
        invertedAtBarIndex: null,
        ifvgMitigatedAtTime: null,
        expiredAtTime: null,
      };
    }
  }

  return null;
}

function detectSweepsOnClosedBar(
  bar: IntradayTriggerBarInput,
  barIndex: number,
  prevBar: IntradayTriggerBarInput | null,
  levels: readonly NormalizedSweepReferenceLevel[],
  lastSweepBarIndexByLevel: Partial<Record<SweepTargetLevelId, number>>,
  config: ResolvedTriggerConfig,
): readonly LiquiditySweepEvent[] {
  if (levels.length === 0) return [];
  const emitted: LiquiditySweepEvent[] = [];
  for (const level of levels) {
    if (bar.time < level.activeFromUtcSec) continue;
    const lastIdx = lastSweepBarIndexByLevel[level.id];
    if (lastIdx !== undefined && barIndex - lastIdx < config.sweepCooldownBars) {
      continue;
    }
    const eligiblePrev =
      prevBar !== null && prevBar.time >= level.activeFromUtcSec ? prevBar : null;
    const minExc = Math.max(
      config.minAbsSweepExcursion,
      config.minSweepExcursionRatio * level.price,
    );
    const minRec = Math.max(
      config.minAbsSweepRecovery,
      config.minSweepRecoveryRatio * level.price,
    );

    if (level.side === 'HIGH') {
      if (eligiblePrev !== null && eligiblePrev.close > level.price) continue;
      const excursion = bar.high - level.price;
      const recovery = level.price - bar.close;
      if (bar.high > level.price && bar.close < level.price && excursion >= minExc && recovery >= minRec) {
        lastSweepBarIndexByLevel[level.id] = barIndex;
        emitted.push({
          id: `sweep:${config.timeframe}:${String(bar.time)}:${level.id}`,
          timeframe: config.timeframe,
          methodology: 'OHLCV',
          provenanceLabel: 'OHLCV_WICK_CLOSE_RECOVERY',
          levelId: level.id,
          levelSide: 'HIGH',
          direction: 'BEARISH',
          levelPrice: level.price,
          barTime: bar.time,
          barIndex,
          wickExtreme: bar.high,
          closePrice: bar.close,
          wickExcursion: excursion,
          closeRecovery: recovery,
        });
      }
      continue;
    }

    // level.side === 'LOW'
    if (eligiblePrev !== null && eligiblePrev.close < level.price) continue;
    const excursion = level.price - bar.low;
    const recovery = bar.close - level.price;
    if (bar.low < level.price && bar.close > level.price && excursion >= minExc && recovery >= minRec) {
      lastSweepBarIndexByLevel[level.id] = barIndex;
      emitted.push({
        id: `sweep:${config.timeframe}:${String(bar.time)}:${level.id}`,
        timeframe: config.timeframe,
        methodology: 'OHLCV',
        provenanceLabel: 'OHLCV_WICK_CLOSE_RECOVERY',
        levelId: level.id,
        levelSide: 'LOW',
        direction: 'BULLISH',
        levelPrice: level.price,
        barTime: bar.time,
        barIndex,
        wickExtreme: bar.low,
        closePrice: bar.close,
        wickExcursion: excursion,
        closeRecovery: recovery,
      });
    }
  }
  return emitted;
}

function computeDistanceToZone(referencePrice: number, gapLow: number, gapHigh: number): number {
  if (!Number.isFinite(referencePrice)) return Number.NaN;
  if (referencePrice >= gapLow && referencePrice <= gapHigh) return 0;
  if (referencePrice < gapLow) return gapLow - referencePrice;
  return referencePrice - gapHigh;
}

function isZoneActive(state: FvgLifecycleState): boolean {
  return (
    state === 'ACTIVE_UNMITIGATED' ||
    state === 'ACTIVE_PARTIALLY_MITIGATED' ||
    state === 'INVERTED_IFVG_ACTIVE'
  );
}

function finalizeResult(params: {
  readonly config: ResolvedTriggerConfig;
  readonly asOfUtcSec: number;
  readonly closedBarCount: number;
  readonly excludedFormingOrFutureCount: number;
  readonly referencePrice: number;
  readonly zones: readonly InternalFsmZone[];
  readonly sweeps: readonly LiquiditySweepEvent[];
}): IntradayTriggersResult {
  const refPrice = params.referencePrice;
  const allZones: IntradayTriggerZone[] = params.zones.map((z) => ({
    ...z,
    methodology: 'OHLCV',
    distanceToPrice: computeDistanceToZone(refPrice, z.gapLow, z.gapHigh),
  }));

  const activeCandidates = allZones.filter((z) => isZoneActive(z.state));
  activeCandidates.sort((a, b) => {
    const distA = Number.isFinite(a.distanceToPrice) ? a.distanceToPrice : Number.POSITIVE_INFINITY;
    const distB = Number.isFinite(b.distanceToPrice) ? b.distanceToPrice : Number.POSITIVE_INFINITY;
    if (Math.abs(distA - distB) > TIE_EPS) return distA - distB;

    const remA = a.isInverted ? 1 - a.ifvgMitigationRatio : 1 - a.mitigationRatio;
    const remB = b.isInverted ? 1 - b.ifvgMitigationRatio : 1 - b.mitigationRatio;
    if (Math.abs(remA - remB) > TIE_EPS) return remB - remA;

    const eventA = a.invertedAtTime ?? a.formedAtTime;
    const eventB = b.invertedAtTime ?? b.formedAtTime;
    if (eventA !== eventB) return eventB - eventA;

    return a.gapLow - b.gapLow;
  });

  const activeZones = activeCandidates.slice(0, params.config.maxActiveZones);
  const visibleSweeps =
    params.sweeps.length <= params.config.maxVisibleSweeps
      ? [...params.sweeps]
      : params.sweeps.slice(params.sweeps.length - params.config.maxVisibleSweeps);

  return {
    status: params.closedBarCount === 0 ? 'NO_CLOSED_BARS' : 'OK',
    methodology: 'OHLCV',
    timeframe: params.config.timeframe,
    barSeconds: params.config.barSeconds,
    asOfUtcSec: params.asOfUtcSec,
    closedBarCount: params.closedBarCount,
    excludedFormingOrFutureCount: params.excludedFormingOrFutureCount,
    referencePrice: refPrice,
    activeZones,
    allZones,
    visibleSweeps,
    allSweeps: [...params.sweeps],
  };
}

export function computeIntradayTriggers(
  bars: readonly IntradayTriggerBarInput[],
  options: IntradayTriggersOptions,
): IntradayTriggersResult {
  const config = resolveConfig(options);
  if (config === null) {
    return {
      status: 'UNSUPPORTED_TIMEFRAME',
      methodology: 'OHLCV',
      timeframe: null,
      barSeconds: Number.NaN,
      asOfUtcSec: options.asOfUtcSec,
      closedBarCount: 0,
      excludedFormingOrFutureCount: 0,
      referencePrice: Number.NaN,
      activeZones: [],
      allZones: [],
      visibleSweeps: [],
      allSweeps: [],
    };
  }

  const { closedBars, excludedFormingOrFutureCount } = sanitizeAndSortClosedBars(
    bars,
    config.barSeconds,
    options.asOfUtcSec,
  );
  const levels = normalizeSweepReferenceLevels(options.referenceLevels);

  let zones: InternalFsmZone[] = [];
  const lastSweepIdx: Partial<Record<SweepTargetLevelId, number>> = {};
  const sweeps: LiquiditySweepEvent[] = [];

  for (let k = 0; k < closedBars.length; k += 1) {
    const bar = closedBars[k];
    if (bar === undefined) continue;
    zones = zones.map((z) => advanceZoneOnClosedBar(z, bar, k, config.maxZoneAgeBars));
    if (k >= 2) {
      const c0 = closedBars[k - 2];
      const c1 = closedBars[k - 1];
      if (c0 !== undefined && c1 !== undefined) {
        const created = tryDetectFvgFromTriplet(c0, c1, bar, k, config);
        if (created !== null) zones.push(created);
      }
    }
    const prevBar = k > 0 ? (closedBars[k - 1] ?? null) : null;
    const barSweeps = detectSweepsOnClosedBar(
      bar,
      k,
      prevBar,
      levels,
      lastSweepIdx,
      config,
    );
    for (const ev of barSweeps) sweeps.push(ev);
  }

  const lastClosed = closedBars[closedBars.length - 1];
  const explicitRef = options.referencePrice;
  const referencePrice =
    typeof explicitRef === 'number' && Number.isFinite(explicitRef)
      ? explicitRef
      : lastClosed !== undefined
        ? lastClosed.close
        : Number.NaN;

  return finalizeResult({
    config,
    asOfUtcSec: options.asOfUtcSec,
    closedBarCount: closedBars.length,
    excludedFormingOrFutureCount,
    referencePrice,
    zones,
    sweeps,
  });
}

function advanceInternalLiveOneClosedBar(
  prevState: IntradayTriggersLiveState,
  bar: IntradayTriggerBarInput,
  asOfUtcSec: number,
  referenceLevelsOverride?: readonly SweepReferenceLevelInput[],
  referencePriceOverride?: number | null,
): IntradayTriggersLiveState {
  const { config } = prevState;
  const k = prevState.closedBarCount;
  const levels =
    referenceLevelsOverride !== undefined
      ? normalizeSweepReferenceLevels(referenceLevelsOverride)
      : prevState.referenceLevels;

  const nextZones: InternalFsmZone[] = prevState.zones.map((z) =>
    advanceZoneOnClosedBar(z, bar, k, config.maxZoneAgeBars),
  );
  if (prevState.prevPrevBar !== null && prevState.prevBar !== null) {
    const created = tryDetectFvgFromTriplet(
      prevState.prevPrevBar,
      prevState.prevBar,
      bar,
      k,
      config,
    );
    if (created !== null) nextZones.push(created);
  }

  const nextLastSweepIdx: Partial<Record<SweepTargetLevelId, number>> = {
    ...prevState.lastSweepBarIndexByLevel,
  };
  const newSweeps = detectSweepsOnClosedBar(
    bar,
    k,
    prevState.prevBar,
    levels,
    nextLastSweepIdx,
    config,
  );
  const nextSweeps =
    newSweeps.length === 0 ? prevState.sweeps : [...prevState.sweeps, ...newSweeps];

  const refPrice =
    typeof referencePriceOverride === 'number' && Number.isFinite(referencePriceOverride)
      ? referencePriceOverride
      : bar.close;

  const result = finalizeResult({
    config,
    asOfUtcSec,
    closedBarCount: k + 1,
    excludedFormingOrFutureCount: prevState.excludedFormingOrFutureCount,
    referencePrice: refPrice,
    zones: nextZones,
    sweeps: nextSweeps,
  });

  return {
    ...prevState,
    closedBarCount: k + 1,
    prevPrevBar: prevState.prevBar,
    prevBar: bar,
    referenceLevels: levels,
    zones: nextZones,
    lastSweepBarIndexByLevel: nextLastSweepIdx,
    sweeps: nextSweeps,
    result,
  };
}

function aggregateBarsToSingleBar(
  bucketStart: number,
  bars: readonly IntradayTriggerBarInput[],
): IntradayTriggerBarInput | null {
  if (bars.length === 0) return null;
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (first === undefined || last === undefined) return null;
  let high = first.high;
  let low = first.low;
  let volume = 0;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
  }
  return {
    time: bucketStart,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
  };
}

export function createIntradayTriggersLiveState(
  bars: readonly IntradayTriggerBarInput[],
  options: IntradayTriggersOptions,
): IntradayTriggersLiveState | null {
  const config = resolveConfig(options);
  if (config === null) return null;

  const { closedBars, excludedFormingOrFutureCount } = sanitizeAndSortClosedBars(
    bars,
    config.barSeconds,
    options.asOfUtcSec,
  );
  const levels = normalizeSweepReferenceLevels(options.referenceLevels);

  let zones: InternalFsmZone[] = [];
  const lastSweepIdx: Partial<Record<SweepTargetLevelId, number>> = {};
  const sweeps: LiquiditySweepEvent[] = [];

  for (let k = 0; k < closedBars.length; k += 1) {
    const bar = closedBars[k];
    if (bar === undefined) continue;
    zones = zones.map((z) => advanceZoneOnClosedBar(z, bar, k, config.maxZoneAgeBars));
    if (k >= 2) {
      const c0 = closedBars[k - 2];
      const c1 = closedBars[k - 1];
      if (c0 !== undefined && c1 !== undefined) {
        const created = tryDetectFvgFromTriplet(c0, c1, bar, k, config);
        if (created !== null) zones.push(created);
      }
    }
    const prevBar = k > 0 ? (closedBars[k - 1] ?? null) : null;
    const barSweeps = detectSweepsOnClosedBar(
      bar,
      k,
      prevBar,
      levels,
      lastSweepIdx,
      config,
    );
    for (const ev of barSweeps) sweeps.push(ev);
  }

  const lastClosed = closedBars[closedBars.length - 1] ?? null;
  const prevPrev = closedBars.length >= 2 ? (closedBars[closedBars.length - 2] ?? null) : null;
  const explicitRef = options.referencePrice;
  const referencePrice =
    typeof explicitRef === 'number' && Number.isFinite(explicitRef)
      ? explicitRef
      : lastClosed !== null
        ? lastClosed.close
        : Number.NaN;

  const watermark1mSec =
    lastClosed !== null
      ? config.timeframe === '1m'
        ? lastClosed.time
        : lastClosed.time + 240
      : 0;

  return {
    config,
    watermark1mSec,
    closedBarCount: closedBars.length,
    excludedFormingOrFutureCount,
    prevBar: lastClosed,
    prevPrevBar: prevPrev,
    pending5mBucketStart: null,
    pending5mBars: [],
    referenceLevels: levels,
    zones,
    lastSweepBarIndexByLevel: lastSweepIdx,
    sweeps,
    result: finalizeResult({
      config,
      asOfUtcSec: options.asOfUtcSec,
      closedBarCount: closedBars.length,
      excludedFormingOrFutureCount,
      referencePrice,
      zones,
      sweeps,
    }),
  };
}

/**
 * Avanza el estado incremental ÚNICAMENTE al recibir una barra `1m` cerrada
 * posterior al watermark. En modo `5m`, acumula minutos del bucket y solo
 * dispara transición cuando cierra el bucket de `300s`. Nunca se ejecuta en ticks.
 */
export function advanceIntradayTriggersLiveOnClosed1m(
  state: IntradayTriggersLiveState,
  closed1mBar: IntradayTriggerBarInput,
  asOfUtcSec: number,
  referenceLevelsOverride?: readonly SweepReferenceLevelInput[],
  referencePriceOverride?: number | null,
): IntradayTriggersLiveState {
  if (!isValidOhlcvBar(closed1mBar)) return state;
  if (!Number.isFinite(asOfUtcSec) || closed1mBar.time + 60 > asOfUtcSec) return state;
  if (closed1mBar.time <= state.watermark1mSec) return state;

  if (state.config.timeframe === '1m') {
    const advanced = advanceInternalLiveOneClosedBar(
      state,
      closed1mBar,
      asOfUtcSec,
      referenceLevelsOverride,
      referencePriceOverride,
    );
    return {
      ...advanced,
      watermark1mSec: closed1mBar.time,
    };
  }

  // Modo '5m': acumular minutos cerrados hasta confirmar cierre de bucket de 300s.
  const bucketStart = Math.floor(closed1mBar.time / 300) * 300;
  let working = state;

  if (
    working.pending5mBucketStart !== null &&
    bucketStart > working.pending5mBucketStart
  ) {
    const flushedBar = aggregateBarsToSingleBar(
      working.pending5mBucketStart,
      working.pending5mBars,
    );
    if (flushedBar !== null && flushedBar.time + 300 <= asOfUtcSec) {
      working = {
        ...advanceInternalLiveOneClosedBar(
          working,
          flushedBar,
          asOfUtcSec,
          referenceLevelsOverride,
          referencePriceOverride,
        ),
        pending5mBucketStart: null,
        pending5mBars: [],
      };
    }
  }

  const currentBars =
    working.pending5mBucketStart === bucketStart
      ? [...working.pending5mBars.filter((b) => b.time !== closed1mBar.time), closed1mBar]
      : [closed1mBar];
  currentBars.sort((a, b) => a.time - b.time);

  const isBucketFinalMinute =
    closed1mBar.time + 60 === bucketStart + 300 && bucketStart + 300 <= asOfUtcSec;
  if (isBucketFinalMinute) {
    const closed5m = aggregateBarsToSingleBar(bucketStart, currentBars);
    if (closed5m !== null) {
      const advanced = advanceInternalLiveOneClosedBar(
        working,
        closed5m,
        asOfUtcSec,
        referenceLevelsOverride,
        referencePriceOverride,
      );
      return {
        ...advanced,
        watermark1mSec: closed1mBar.time,
        pending5mBucketStart: null,
        pending5mBars: [],
      };
    }
  }

  return {
    ...working,
    watermark1mSec: closed1mBar.time,
    pending5mBucketStart: bucketStart,
    pending5mBars: currentBars,
    ...(referenceLevelsOverride !== undefined
      ? { referenceLevels: normalizeSweepReferenceLevels(referenceLevelsOverride) }
      : {}),
  };
}

export function serializeIntradayTriggersResult(
  result: IntradayTriggersResult,
): IntradayTriggersDto {
  return {
    status: result.status,
    methodology: result.methodology,
    timeframe: result.timeframe,
    barSeconds: Number.isFinite(result.barSeconds) ? result.barSeconds : null,
    asOfUtcSec: result.asOfUtcSec,
    closedBarCount: result.closedBarCount,
    excludedFormingOrFutureCount: result.excludedFormingOrFutureCount,
    referencePrice: Number.isFinite(result.referencePrice) ? result.referencePrice : null,
    activeZones: result.activeZones.map((z) => ({
      ...z,
      distanceToPrice: Number.isFinite(z.distanceToPrice) ? z.distanceToPrice : null,
    })),
    visibleSweeps: [...result.visibleSweeps],
  };
}
