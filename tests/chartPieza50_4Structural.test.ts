/**
 * Pieza 50.4 — Referencia independiente (Python) + guardas estructurales:
 *  1) `resampleDailyToWeekly` (1W nativo sin APIs extra, lunes feriado y feriados BYMA).
 *  2) `computeVolumeProfileAmt` acotado a `lookbackBars` (252 ruedas) con `windowBars`.
 *  3) AVWAP: snap a la vela más cercana, ancla efectiva y serie alineada.
 *
 * Fixture: fixtures/chart_pieza50_4_reference.json (tools/gen_chart_pieza50_4_reference.py).
 * Tolerancia global <= 1e-9; argumentos profundamente congelados (sin mutación).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS,
  computeVolumeProfileAmt,
  type VolumeProfileAmtResult,
} from '../src/core/microstructure/volumeProfileAmt.js';
import {
  getCalendarWeekMondayKey,
  resampleDailyToWeekly,
} from '../src/core/resampleWeekly.js';
import {
  findNearestBarIndex,
  resolveEffectiveAvwapAnchorIndex,
} from '../src/core/stockDetailChartNavigation.js';
import { computeAnchoredVwapWithAnchor } from '../web/src/components/stock-detail/stockDetailMath.js';
import type { Bar } from '../src/core/types.js';

type JsonNumber = number | null;

interface WeeklyCase {
  readonly name: string;
  readonly timeZone: string;
  readonly bars: readonly Record<string, JsonNumber>[];
  readonly expected: readonly Record<string, JsonNumber>[];
}

interface VolumeProfileCase {
  readonly name: string;
  readonly bars: readonly Record<string, JsonNumber>[];
  readonly options: {
    readonly asOfUtcSec: number;
    readonly barSeconds: number;
    readonly tickSize: number;
    readonly lookbackBars?: number;
  };
  readonly expected: {
    readonly status: string;
    readonly closedBarCount: number;
    readonly excludedFutureCount: number;
    readonly windowBars: number;
    readonly poc: JsonNumber;
    readonly vah: JsonNumber;
    readonly val: JsonNumber;
    readonly profileVwap: JsonNumber;
    readonly totalVolume: JsonNumber;
    readonly valueAreaVolume: JsonNumber;
    readonly valueAreaCoverage: JsonNumber;
    readonly minPrice: JsonNumber;
    readonly maxPrice: JsonNumber;
    readonly bins: readonly {
      readonly price: number;
      readonly volume: number;
      readonly volumeShare: number;
      readonly volumePercentile: number;
      readonly classification: string;
    }[];
  };
}

interface AvwapFixture {
  readonly nearestCases: readonly {
    readonly name: string;
    readonly bars: readonly Record<string, JsonNumber>[];
    readonly target: JsonNumber;
    readonly expected: number;
  }[];
  readonly effectiveAnchorCases: readonly {
    readonly name: string;
    readonly bars: readonly Record<string, JsonNumber>[];
    readonly requestedAnchorIndex: number;
    readonly expected: {
      readonly series: readonly JsonNumber[];
      readonly requestedAnchorIndex: number;
      readonly effectiveAnchorIndex: number;
      readonly effectiveAnchorTime: JsonNumber;
    };
  }[];
}

interface ChartFixture {
  readonly meta: { readonly generator: string; readonly tolerance: number };
  readonly weeklyResampleCases: readonly WeeklyCase[];
  readonly volumeProfile252Cases: readonly VolumeProfileCase[];
  readonly avwapAnchorCases: AvwapFixture;
}

const fixturePath = join(process.cwd(), 'fixtures', 'chart_pieza50_4_reference.json');
const fixture: ChartFixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as ChartFixture;
const TOL = fixture.meta.tolerance;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function decodeNumber(value: JsonNumber | undefined): number {
  return value === null || value === undefined ? Number.NaN : value;
}

function expectClose(actual: number, expected: number, tol = TOL): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(expected)));
}

function expectNumberOrNaN(actual: number, expected: JsonNumber, tol = TOL): void {
  if (expected === null) {
    expect(Number.isNaN(actual)).toBe(true);
  } else {
    expect(Number.isFinite(actual)).toBe(true);
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
  }
}

function toBar(row: Record<string, JsonNumber>): Bar {
  const vw = row['vw'];
  return {
    time: decodeNumber(row['time']),
    open: decodeNumber(row['open']),
    high: decodeNumber(row['high']),
    low: decodeNumber(row['low']),
    close: decodeNumber(row['close']),
    volume: decodeNumber(row['volume']),
    ...(vw !== null && vw !== undefined ? { vw } : {}),
  };
}

function toTimedBar(row: Record<string, JsonNumber>): {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vw?: number | null | undefined;
} {
  return {
    time: decodeNumber(row['time']),
    open: decodeNumber(row['open']),
    high: decodeNumber(row['high']),
    low: decodeNumber(row['low']),
    close: decodeNumber(row['close']),
    volume: decodeNumber(row['volume']),
    ...(row['vw'] !== undefined ? { vw: row['vw'] } : {}),
  };
}

describe('Pieza 50.4 — Volume Profile 252D, 1W nativo y AVWAP (referencia Python <= 1e-9)', () => {
  it('resamplea diario→semanal por semana calendario en la zona del mercado sin mutar la entrada', () => {
    for (const testCase of fixture.weeklyResampleCases) {
      const input = deepFreeze(structuredClone(testCase.bars));
      const before = JSON.stringify(input);
      const bars = input.map(toBar);
      const weekly = resampleDailyToWeekly(bars, testCase.timeZone);
      expect(JSON.stringify(input), testCase.name).toBe(before);

      expect(weekly.length, testCase.name).toBe(testCase.expected.length);
      weekly.forEach((bar, idx) => {
        const exp = testCase.expected[idx];
        if (exp === undefined) throw new Error(`fila semanal extra en ${testCase.name}`);
        expect(bar.time, `${testCase.name}[${String(idx)}].time`).toBe(exp['time']);
        expectClose(bar.open, decodeNumber(exp['open']));
        expectClose(bar.high, decodeNumber(exp['high']));
        expectClose(bar.low, decodeNumber(exp['low']));
        expectClose(bar.close, decodeNumber(exp['close']));
        expectClose(bar.volume, decodeNumber(exp['volume']));
        const expVw = exp['vw'];
        if (expVw === null || expVw === undefined) {
          expect(bar.vw, `${testCase.name}[${String(idx)}].vw`).toBeUndefined();
        } else {
          expectClose(bar.vw ?? Number.NaN, expVw);
        }
      });
      // Claves semanales deterministas (lunes civil).
      const keys = new Set(
        bars
          .filter(
            (bar) =>
              Number.isInteger(bar.time) && Math.abs(bar.time) <= 1e11,
          )
          .map((bar) => getCalendarWeekMondayKey(bar.time, testCase.timeZone))
          .filter((key): key is string => key !== null),
      );
      expect(keys.size, testCase.name).toBeGreaterThanOrEqual(testCase.expected.length);
    }

    // Feriado lunes US (MLK 2025-01-20): la semana arranca el martes 21 con tiempo real.
    const mlk = fixture.weeklyResampleCases.find((c) => c.name === 'us_mlk_holiday_monday');
    expect(mlk).toBeDefined();
    if (mlk !== undefined) {
      const weekly = resampleDailyToWeekly(mlk.bars.map(toBar), mlk.timeZone);
      const second = weekly[1];
      const expectedSecond = mlk.expected[1];
      expect(second).toBeDefined();
      expect(expectedSecond).toBeDefined();
      if (second !== undefined && expectedSecond !== undefined) {
        expect(second.time).toBe(expectedSecond['time']);
        expect(new Date(second.time * 1_000).toISOString()).toBe('2025-01-21T21:00:00.000Z');
        expect(second.time).not.toBe(new Date('2025-01-20T21:00:00.000Z').getTime() / 1_000);
      }
    }
  });

  it('acota el Volume Profile a lookbackBars=252 (windowBars) y preserva el modo histórico completo', () => {
    expect(DEFAULT_VOLUME_PROFILE_LOOKBACK_BARS).toBe(252);
    for (const testCase of fixture.volumeProfile252Cases) {
      const input = deepFreeze(structuredClone(testCase.bars));
      const before = JSON.stringify(input);
      const options = deepFreeze({ ...testCase.options });
      const actual: VolumeProfileAmtResult = computeVolumeProfileAmt(input.map(toBar), options);
      expect(JSON.stringify(input), testCase.name).toBe(before);

      expect(actual.status, testCase.name).toBe(testCase.expected.status);
      expect(actual.closedBarCount, `${testCase.name}.closedBarCount`).toBe(
        testCase.expected.closedBarCount,
      );
      expect(actual.windowBars, `${testCase.name}.windowBars`).toBe(testCase.expected.windowBars);
      expect(actual.excludedFutureCount, `${testCase.name}.excludedFutureCount`).toBe(
        testCase.expected.excludedFutureCount,
      );
      expectNumberOrNaN(actual.poc, testCase.expected.poc);
      expectNumberOrNaN(actual.vah, testCase.expected.vah);
      expectNumberOrNaN(actual.val, testCase.expected.val);
      expectNumberOrNaN(actual.profileVwap, testCase.expected.profileVwap);
      expectNumberOrNaN(actual.totalVolume, testCase.expected.totalVolume);
      expectNumberOrNaN(actual.valueAreaVolume, testCase.expected.valueAreaVolume);
      expectNumberOrNaN(actual.valueAreaCoverage, testCase.expected.valueAreaCoverage);
      expectNumberOrNaN(actual.minPrice, testCase.expected.minPrice);
      expectNumberOrNaN(actual.maxPrice, testCase.expected.maxPrice);
      expect(actual.bins.length, `${testCase.name}.bins`).toBe(testCase.expected.bins.length);
      actual.bins.forEach((bin, idx) => {
        const exp = testCase.expected.bins[idx];
        if (exp === undefined) throw new Error(`bin extra en ${testCase.name}`);
        expectClose(bin.price, exp.price);
        expectClose(bin.volume, exp.volume);
        expectClose(bin.volumeShare, exp.volumeShare);
        expectClose(bin.volumePercentile, exp.volumePercentile);
        expect(bin.classification, `${testCase.name}.bin[${String(idx)}]`).toBe(exp.classification);
      });
    }

    // Contrato operativo: con lookback el POC viejo (100) queda fuera y la barra futura tambien.
    const windowed = fixture.volumeProfile252Cases.find(
      (c) => c.name === 'windowed_252_over_320_with_future_bar',
    );
    const full = fixture.volumeProfile252Cases.find((c) => c.name === 'full_history_without_lookback');
    expect(windowed?.expected.poc).toBe(200);
    expect(windowed?.expected.windowBars).toBe(252);
    expect(full?.expected.poc).toBe(100);
    expect(full?.expected.windowBars).toBe(320);
  });

  it('AVWAP: snap sin sesgo hacia adelante, ancla efectiva y serie coinciden con la referencia', () => {
    for (const testCase of fixture.avwapAnchorCases.nearestCases) {
      const bars = deepFreeze(structuredClone(testCase.bars)).map((row) => ({ time: decodeNumber(row['time']) }));
      const target = testCase.target === null ? Number.NaN : testCase.target;
      expect(findNearestBarIndex(bars, target), testCase.name).toBe(testCase.expected);
    }

    for (const testCase of fixture.avwapAnchorCases.effectiveAnchorCases) {
      const input = deepFreeze(structuredClone(testCase.bars));
      const before = JSON.stringify(input);
      const bars = input.map(toTimedBar);
      const effective = resolveEffectiveAvwapAnchorIndex(bars, testCase.requestedAnchorIndex);
      expect(effective, `${testCase.name}.effective`).toBe(testCase.expected.effectiveAnchorIndex);

      const result = computeAnchoredVwapWithAnchor(bars, testCase.requestedAnchorIndex);
      expect(result.requestedAnchorIndex, testCase.name).toBe(testCase.expected.requestedAnchorIndex);
      expect(result.effectiveAnchorIndex, testCase.name).toBe(testCase.expected.effectiveAnchorIndex);
      if (testCase.expected.effectiveAnchorTime === null) {
        expect(result.effectiveAnchorTime, testCase.name).toBeNull();
      } else {
        expect(result.effectiveAnchorTime, testCase.name).toBe(testCase.expected.effectiveAnchorTime);
      }
      expect(result.series.length, `${testCase.name}.series`).toBe(testCase.expected.series.length);
      result.series.forEach((value, idx) => {
        const exp = testCase.expected.series[idx];
        if (exp === undefined) throw new Error(`serie extra en ${testCase.name}`);
        expectNumberOrNaN(value, exp);
      });
      expect(JSON.stringify(input), testCase.name).toBe(before);
    }

    // Desfase de 1 vela: ancla con volume 0 avanza y el primer punto visible nace en la misma vela.
    const advance = fixture.avwapAnchorCases.effectiveAnchorCases.find(
      (c) => c.name === 'advance_from_zero_volume_1_to_2',
    );
    expect(advance?.expected.effectiveAnchorIndex).toBe(2);
    expect(Number.isNaN(decodeNumber(advance?.expected.series[1]))).toBe(true);
    expect(Number.isFinite(decodeNumber(advance?.expected.series[2]))).toBe(true);
  });

  it('guardas estructurales de StockDetailView.tsx (1W, marcadores v5, higiene Piezas 48–49.1)', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );

    // 1W a la derecha de 1D en CHART_TIMEFRAMES.
    const idx1D = src.indexOf("{ id: '1D', label: '1D' }");
    const idx1W = src.indexOf("{ id: '1W', label: '1W' }");
    expect(idx1D).toBeGreaterThan(-1);
    expect(idx1W).toBeGreaterThan(idx1D);

    // Derivación semanal nativa + snap sin sesgo + ancla efectiva.
    expect(src).toContain('resampleDailyToWeekly');
    expect(src).toContain('findNearestBarIndex(bars, clickedTimeSec)');
    expect(src).toContain('computeAnchoredVwapWithAnchor');

    // API v5.3.0 de marcadores: plugin creado con createSeriesMarkers, nunca candles.setMarkers().
    expect(src).toContain('createSeriesMarkers');
    expect(src).not.toContain('candles.setMarkers(');
    expect(src).toContain('markersPlugin.setMarkers([])');

    // Higiene visual Piezas 48–49.1.
    expect(src).not.toContain('backdrop-blur-');
    expect(src).not.toContain('animate-pulse');
    expect(src).not.toContain('animate-ping');
    expect(src).toContain('tabular-nums');
    expect(src).toContain('min-w-[132px]');
    expect(src).toContain('POC/VAH/VAL · ${vpWindowTag}');
    expect(src).toContain('1Y · 252R');

    // 1W no dispara requests propios (apiTimeframe 1D) ni VWAP intradiario.
    expect(src).toContain("const apiTimeframe: TerminalTimeframe = timeframe === '1W' ? '1D' : timeframe;");
    expect(src).toContain("effectiveChartTimeframe === '1D' || effectiveChartTimeframe === '1W'");
  });
});
