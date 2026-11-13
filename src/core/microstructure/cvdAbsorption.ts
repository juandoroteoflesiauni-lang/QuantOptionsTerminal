/**
 * Motor puro de Cumulative Volume Delta (CVD) de sesión ET y Detector de
 * Absorción Pasiva en Niveles Clave (Bloque C / Pieza 10).
 *
 * Garantías de diseño:
 *  - Funciones puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Reutiliza `getMarketParts` de `src/core/sessions.ts` (`America/New_York`, EST/EDT).
 *  - Cero Look-Ahead Bias: filtra `bar.time + barSeconds <= asOfUtcSec` y calcula
 *    percentiles empíricos estrictamente sobre la ventana histórica `[t - W + 1 .. t]`.
 *  - Sin mezcla silenciosa de modos de delta dentro de una misma sesión ET y
 *    sin fallbacks numéricos que oculten `NaN`.
 */

import { getMarketParts, RTH_START_MINUTES } from '../sessions.js';
import type { Bar } from '../types.js';
import {
  assertNonNegativeFiniteOption,
  assertPositiveIntegerOption,
  assertValidUtcSeconds,
  computeEmpiricalPercentile,
  filterClosedBars,
  validateOhlcvBars,
} from './mtfStructure.js';

export const PRE_MARKET_START_MINUTES = 4 * 60; // 04:00 ET
export const RTH_END_MINUTES = 16 * 60; // 16:00 ET
export const AFTER_HOURS_END_MINUTES = 20 * 60; // 20:00 ET

export const DEFAULT_CVD_WINDOW_BARS = 20;
export const DEFAULT_CVD_MIN_WINDOW_BARS = 20;
export const DEFAULT_ABSORPTION_MIN_VOLUME_PERCENTILE = 90;
export const DEFAULT_ABSORPTION_MIN_DELTA_PERCENTILE = 90;
export const DEFAULT_ABSORPTION_MAX_BODY_PERCENTILE = 25;
export const DEFAULT_LEVEL_PROXIMITY_ATR = 0.15;

export type CvdSessionScope = 'FULL_ET' | 'RTH';
export type DeltaMode = 'TICK_EXACT' | 'OHLCV_INTRABAR_APPROX';
export type EffectiveDeltaMode = DeltaMode | 'INSUFFICIENT_DATA';
export type AbsorbingSide = 'BUY_ABSORPTION' | 'SELL_ABSORPTION' | 'NONE';

export interface CvdBar extends Bar {
  readonly buyVolume?: number;
  readonly sellVolume?: number;
}

export interface KeyPriceLevel {
  readonly name: string;
  readonly price: number;
}

export interface MatchedKeyLevel {
  readonly name: string;
  readonly price: number;
  readonly tolerance: number;
  readonly distance: number;
}

export interface CvdAbsorptionOptions {
  /** Instante de evaluación sin look-ahead en segundos UTC enteros (`bar.time + barSeconds <= asOfUtcSec`). */
  readonly asOfUtcSec: number;
  /** Duración de cada barra en segundos UTC enteros (`> 0`). */
  readonly barSeconds: number;
  /** Ventana de sesión ET para reinicio de `sessionCvd` (`04:00` en `FULL_ET`, `09:30` en `RTH`). */
  readonly sessionScope?: CvdSessionScope;
  /** Lista de niveles clave a vigilar (`PMH`, `PML`, `PDH`, `PDL`, `EMA21_15M`, `CALL_WALL`, `PUT_WALL`, etc.). */
  readonly levels: readonly KeyPriceLevel[];
  /** ATR positivo usado para calcular tolerancia `levelProximityAtr * atr`. */
  readonly atr?: number;
  /** Múltiplo de ATR para proximidad a niveles (por defecto `0.15` cuando se provee `atr`). */
  readonly levelProximityAtr?: number;
  /** Tolerancia porcentual alternativa (ej. `0.001` = 10 bps) cuando no se usa modo ATR. */
  readonly levelProximityPct?: number;
  /** Tamaño máximo de la ventana rolling `[t - window + 1 .. t]` (por defecto `20`). */
  readonly windowBars?: number;
  /** Mínimo de barras cerradas antes de calcular percentiles de absorción (por defecto `20`). */
  readonly minWindowBars?: number;
  readonly minVolumePercentile?: number;
  readonly minDeltaPercentile?: number;
  readonly maxBodyDisplacementPercentile?: number;
  /** Si es `true`, reinicia la ventana de percentiles en cada sesión; por defecto `false` (histórico continuo). */
  readonly resetPercentileWindowOnSession?: boolean;
}

export interface CvdBarEvaluation {
  readonly time: number;
  readonly sessionDate: string;
  readonly deltaMode: DeltaMode;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly barDelta: number;
  readonly sessionCvd: number;
  readonly volumePercentile: number;
  readonly deltaPercentile: number;
  readonly bodyDisplacementPercentile: number;
  readonly absorptionTriggered: boolean;
  readonly absorbingSide: AbsorbingSide;
  readonly matchedLevels: readonly MatchedKeyLevel[];
}

export interface PassiveAbsorptionEvent {
  readonly time: number;
  readonly sessionDate: string;
  readonly deltaMode: DeltaMode;
  readonly close: number;
  readonly high: number;
  readonly low: number;
  readonly volume: number;
  readonly barDelta: number;
  readonly sessionCvd: number;
  readonly absorbingSide: 'BUY_ABSORPTION' | 'SELL_ABSORPTION';
  readonly volumePercentile: number;
  readonly deltaPercentile: number;
  readonly bodyDisplacementPercentile: number;
  readonly primaryLevel: MatchedKeyLevel;
  readonly matchedLevels: readonly MatchedKeyLevel[];
}

export interface SessionDeltaModeInfo {
  readonly sessionDate: string;
  readonly deltaMode: DeltaMode;
  readonly barCount: number;
  readonly finalSessionCvd: number;
}

export interface CvdAbsorptionResult {
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly sessionScope: CvdSessionScope;
  readonly closedInSessionCount: number;
  readonly excludedFutureCount: number;
  readonly excludedOutOfSessionCount: number;
  readonly skippedInvalidLevelCount: number;
  readonly toleranceValid: boolean;
  readonly atrProximityTolerance: number;
  readonly deltaMode: EffectiveDeltaMode;
  readonly sessionDeltaModes: readonly SessionDeltaModeInfo[];
  readonly currentSessionDate: string | null;
  readonly currentSessionCvd: number;
  readonly bars: readonly CvdBarEvaluation[];
  readonly absorptionEvents: readonly PassiveAbsorptionEvent[];
}

interface ScopedClosedBar {
  readonly bar: CvdBar;
  readonly sessionDate: string;
}

interface ToleranceSpec {
  readonly mode: 'ATR' | 'PCT';
  readonly toleranceValid: boolean;
  readonly atrTolerance: number;
  readonly pctFraction: number;
}

function isInSessionScope(minutesOfDay: number, scope: CvdSessionScope): boolean {
  if (scope === 'FULL_ET') {
    return minutesOfDay >= PRE_MARKET_START_MINUTES && minutesOfDay < AFTER_HOURS_END_MINUTES;
  }
  return minutesOfDay >= RTH_START_MINUTES && minutesOfDay < RTH_END_MINUTES;
}

function validateTickFields(bars: readonly CvdBar[]): void {
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined) {
      continue;
    }
    if (bar.buyVolume !== undefined && Number.isFinite(bar.buyVolume) && bar.buyVolume < 0) {
      throw new Error(`bars[${String(i)}].buyVolume must be >= 0 (got ${String(bar.buyVolume)})`);
    }
    if (bar.sellVolume !== undefined && Number.isFinite(bar.sellVolume) && bar.sellVolume < 0) {
      throw new Error(`bars[${String(i)}].sellVolume must be >= 0 (got ${String(bar.sellVolume)})`);
    }
  }
}

function assertPercentileRange(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be in [0, 100] (got ${String(value)})`);
  }
  return value;
}

function resolveToleranceSpec(options: CvdAbsorptionOptions): ToleranceSpec {
  if (options.levelProximityAtr !== undefined && options.levelProximityPct !== undefined) {
    throw new Error('Cannot specify both levelProximityAtr and levelProximityPct simultaneously');
  }

  if (options.atr !== undefined) {
    const mult = assertNonNegativeFiniteOption(
      options.levelProximityAtr ?? DEFAULT_LEVEL_PROXIMITY_ATR,
      'levelProximityAtr',
    );
    if (!Number.isFinite(options.atr) || options.atr <= 0) {
      return {
        mode: 'ATR',
        toleranceValid: false,
        atrTolerance: Number.NaN,
        pctFraction: Number.NaN,
      };
    }
    return {
      mode: 'ATR',
      toleranceValid: true,
      atrTolerance: mult * options.atr,
      pctFraction: Number.NaN,
    };
  }

  if (options.levelProximityPct !== undefined) {
    const pct = assertNonNegativeFiniteOption(options.levelProximityPct, 'levelProximityPct');
    return {
      mode: 'PCT',
      toleranceValid: true,
      atrTolerance: Number.NaN,
      pctFraction: pct,
    };
  }

  throw new Error('Must specify atr (with optional levelProximityAtr) or levelProximityPct');
}

function computeBarDelta(bar: CvdBar, mode: DeltaMode): number {
  if (mode === 'TICK_EXACT') {
    const buy = bar.buyVolume;
    const sell = bar.sellVolume;
    if (buy === undefined || sell === undefined || !Number.isFinite(buy) || !Number.isFinite(sell)) {
      return Number.NaN;
    }
    return buy - sell;
  }

  if (
    !Number.isFinite(bar.open) ||
    !Number.isFinite(bar.high) ||
    !Number.isFinite(bar.low) ||
    !Number.isFinite(bar.close) ||
    !Number.isFinite(bar.volume)
  ) {
    return Number.NaN;
  }
  const range = bar.high - bar.low;
  if (range === 0 || bar.volume === 0) {
    return 0;
  }
  const clvNumerator = bar.close - bar.low - (bar.high - bar.close);
  return bar.volume * (clvNumerator / range);
}

function findMatchedKeyLevels(
  bar: CvdBar,
  levels: readonly KeyPriceLevel[],
  spec: ToleranceSpec,
): readonly MatchedKeyLevel[] {
  if (!spec.toleranceValid || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close)) {
    return [];
  }
  const matches: MatchedKeyLevel[] = [];
  for (const level of levels) {
    const tol = spec.mode === 'ATR' ? spec.atrTolerance : spec.pctFraction * Math.abs(level.price);
    if (!Number.isFinite(tol) || tol < 0) {
      continue;
    }
    if (bar.low <= level.price + tol && bar.high >= level.price - tol) {
      matches.push({
        name: level.name,
        price: level.price,
        tolerance: tol,
        distance: Math.abs(bar.close - level.price),
      });
    }
  }
  matches.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return matches;
}

/**
 * Calcula el CVD por sesión ET (`FULL_ET` o `RTH`) sin look-ahead y detecta eventos de
 * absorción pasiva (`BUY_ABSORPTION` / `SELL_ABSORPTION`) sobre niveles clave mediante
 * rangos percentil empíricos en ventana móvil `[t - W + 1 .. t]`.
 */
export function analyzeCvdAndAbsorption(
  bars: readonly CvdBar[],
  options: CvdAbsorptionOptions,
): CvdAbsorptionResult {
  assertValidUtcSeconds(options.asOfUtcSec, 'asOfUtcSec');
  const barSeconds = assertPositiveIntegerOption(options.barSeconds, 'barSeconds', 1);
  const sessionScope: CvdSessionScope = options.sessionScope ?? 'FULL_ET';

  const windowBars = assertPositiveIntegerOption(
    options.windowBars ?? DEFAULT_CVD_WINDOW_BARS,
    'windowBars',
    1,
  );
  const minWindowBars = assertPositiveIntegerOption(
    options.minWindowBars ?? Math.min(DEFAULT_CVD_MIN_WINDOW_BARS, windowBars),
    'minWindowBars',
    1,
  );
  if (minWindowBars > windowBars) {
    throw new Error(
      `minWindowBars (${String(minWindowBars)}) cannot exceed windowBars (${String(windowBars)})`,
    );
  }

  const minVolumePercentile = assertPercentileRange(
    options.minVolumePercentile ?? DEFAULT_ABSORPTION_MIN_VOLUME_PERCENTILE,
    'minVolumePercentile',
  );
  const minDeltaPercentile = assertPercentileRange(
    options.minDeltaPercentile ?? DEFAULT_ABSORPTION_MIN_DELTA_PERCENTILE,
    'minDeltaPercentile',
  );
  const maxBodyDisplacementPercentile = assertPercentileRange(
    options.maxBodyDisplacementPercentile ?? DEFAULT_ABSORPTION_MAX_BODY_PERCENTILE,
    'maxBodyDisplacementPercentile',
  );
  const resetPercentileWindowOnSession = options.resetPercentileWindowOnSession ?? false;

  const toleranceSpec = resolveToleranceSpec(options);

  validateOhlcvBars(bars, 'bars');
  validateTickFields(bars);

  const validLevels: KeyPriceLevel[] = [];
  let skippedInvalidLevelCount = 0;
  for (const lvl of options.levels) {
    if (lvl.name.trim().length === 0 || !Number.isFinite(lvl.price)) {
      skippedInvalidLevelCount += 1;
      continue;
    }
    validLevels.push({ name: lvl.name, price: lvl.price });
  }

  const { closed, excludedFutureCount } = filterClosedBars(bars, barSeconds, options.asOfUtcSec);

  const scopedBars: ScopedClosedBar[] = [];
  let excludedOutOfSessionCount = 0;
  for (const bar of closed) {
    const parts = getMarketParts(bar.time, 'EQUITY');
    if (!isInSessionScope(parts.minutesOfDay, sessionScope)) {
      excludedOutOfSessionCount += 1;
      continue;
    }
    scopedBars.push({ bar, sessionDate: parts.dateKey });
  }

  if (scopedBars.length === 0) {
    return {
      asOfUtcSec: options.asOfUtcSec,
      barSeconds,
      sessionScope,
      closedInSessionCount: 0,
      excludedFutureCount,
      excludedOutOfSessionCount,
      skippedInvalidLevelCount,
      toleranceValid: toleranceSpec.toleranceValid,
      atrProximityTolerance: toleranceSpec.atrTolerance,
      deltaMode: 'INSUFFICIENT_DATA',
      sessionDeltaModes: [],
      currentSessionDate: null,
      currentSessionCvd: Number.NaN,
      bars: [],
      absorptionEvents: [],
    };
  }

  // Determinar deltaMode uniforme por cada sesión ET (sin mezclar dentro de la sesión)
  const sessionHasMissingTick = new Map<string, boolean>();
  for (const entry of scopedBars) {
    const hasBothTickProps =
      entry.bar.buyVolume !== undefined && entry.bar.sellVolume !== undefined;
    const prevMissing = sessionHasMissingTick.get(entry.sessionDate) ?? false;
    sessionHasMissingTick.set(entry.sessionDate, prevMissing || !hasBothTickProps);
  }

  const evaluations: CvdBarEvaluation[] = [];
  const absorptionEvents: PassiveAbsorptionEvent[] = [];
  const sessionInfos: SessionDeltaModeInfo[] = [];

  let activeSessionDate: string | null = null;
  let activeSessionBarCount = 0;
  let sessionCvd = 0;
  let sessionPoisoned = false;
  let activeDeltaMode: DeltaMode = 'OHLCV_INTRABAR_APPROX';

  let windowStartOffset = 0;
  const rollingVolumes: number[] = [];
  const rollingAbsDeltas: number[] = [];
  const rollingBodies: number[] = [];

  for (let i = 0; i < scopedBars.length; i += 1) {
    const entry = scopedBars[i];
    if (entry === undefined) {
      continue;
    }
    const { bar, sessionDate } = entry;

    if (activeSessionDate !== sessionDate) {
      if (activeSessionDate !== null) {
        sessionInfos.push({
          sessionDate: activeSessionDate,
          deltaMode: activeDeltaMode,
          barCount: activeSessionBarCount,
          finalSessionCvd: sessionPoisoned ? Number.NaN : sessionCvd,
        });
      }
      activeSessionDate = sessionDate;
      activeSessionBarCount = 0;
      sessionCvd = 0;
      sessionPoisoned = false;
      activeDeltaMode = (sessionHasMissingTick.get(sessionDate) ?? true)
        ? 'OHLCV_INTRABAR_APPROX'
        : 'TICK_EXACT';
      if (resetPercentileWindowOnSession) {
        windowStartOffset = i;
      }
    }

    activeSessionBarCount += 1;
    const barDelta = computeBarDelta(bar, activeDeltaMode);
    if (!Number.isFinite(barDelta)) {
      sessionPoisoned = true;
    } else if (!sessionPoisoned) {
      sessionCvd += barDelta;
    }
    const currentCvd = sessionPoisoned ? Number.NaN : sessionCvd;

    const absDelta = Number.isFinite(barDelta) ? Math.abs(barDelta) : Number.NaN;
    const bodyDisplacement =
      Number.isFinite(bar.open) && Number.isFinite(bar.close)
        ? Math.abs(bar.close - bar.open)
        : Number.NaN;

    rollingVolumes.push(bar.volume);
    rollingAbsDeltas.push(absDelta);
    rollingBodies.push(bodyDisplacement);

    const startIdx = Math.max(windowStartOffset, i - windowBars + 1);
    const windowLength = i - startIdx + 1;

    let volumePercentile = Number.NaN;
    let deltaPercentile = Number.NaN;
    let bodyDisplacementPercentile = Number.NaN;

    if (windowLength >= minWindowBars) {
      volumePercentile = computeEmpiricalPercentile(
        rollingVolumes.slice(startIdx, i + 1),
        bar.volume,
      );
      deltaPercentile = computeEmpiricalPercentile(
        rollingAbsDeltas.slice(startIdx, i + 1),
        absDelta,
      );
      bodyDisplacementPercentile = computeEmpiricalPercentile(
        rollingBodies.slice(startIdx, i + 1),
        bodyDisplacement,
      );
    }

    const matchedLevels = findMatchedKeyLevels(bar, validLevels, toleranceSpec);

    const percentileCriteriaMet =
      Number.isFinite(volumePercentile) &&
      volumePercentile >= minVolumePercentile &&
      Number.isFinite(deltaPercentile) &&
      deltaPercentile >= minDeltaPercentile &&
      Number.isFinite(bodyDisplacementPercentile) &&
      bodyDisplacementPercentile <= maxBodyDisplacementPercentile;

    let absorbingSide: AbsorbingSide = 'NONE';
    let absorptionTriggered = false;
    if (
      percentileCriteriaMet &&
      matchedLevels.length > 0 &&
      Number.isFinite(barDelta) &&
      barDelta !== 0
    ) {
      absorbingSide = barDelta < 0 ? 'BUY_ABSORPTION' : 'SELL_ABSORPTION';
      absorptionTriggered = true;
      const primaryLevel = matchedLevels[0];
      if (primaryLevel !== undefined) {
        absorptionEvents.push({
          time: bar.time,
          sessionDate,
          deltaMode: activeDeltaMode,
          close: bar.close,
          high: bar.high,
          low: bar.low,
          volume: bar.volume,
          barDelta,
          sessionCvd: currentCvd,
          absorbingSide,
          volumePercentile,
          deltaPercentile,
          bodyDisplacementPercentile,
          primaryLevel,
          matchedLevels,
        });
      }
    }

    evaluations.push({
      time: bar.time,
      sessionDate,
      deltaMode: activeDeltaMode,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      barDelta,
      sessionCvd: currentCvd,
      volumePercentile,
      deltaPercentile,
      bodyDisplacementPercentile,
      absorptionTriggered,
      absorbingSide,
      matchedLevels,
    });
  }

  if (activeSessionDate !== null) {
    sessionInfos.push({
      sessionDate: activeSessionDate,
      deltaMode: activeDeltaMode,
      barCount: activeSessionBarCount,
      finalSessionCvd: sessionPoisoned ? Number.NaN : sessionCvd,
    });
  }

  const lastEval = evaluations[evaluations.length - 1];
  return {
    asOfUtcSec: options.asOfUtcSec,
    barSeconds,
    sessionScope,
    closedInSessionCount: evaluations.length,
    excludedFutureCount,
    excludedOutOfSessionCount,
    skippedInvalidLevelCount,
    toleranceValid: toleranceSpec.toleranceValid,
    atrProximityTolerance: toleranceSpec.atrTolerance,
    deltaMode: lastEval !== undefined ? lastEval.deltaMode : 'INSUFFICIENT_DATA',
    sessionDeltaModes: sessionInfos,
    currentSessionDate: activeSessionDate,
    currentSessionCvd: lastEval !== undefined ? lastEval.sessionCvd : Number.NaN,
    bars: evaluations,
    absorptionEvents,
  };
}
