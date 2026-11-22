/**
 * Pieza 50.7 (Bloque A) — AVWAP de ancla única con HLC3 y bandas del mismo estado.
 *
 * Referencia independiente: `tools/gen_avwap_pieza50_7_reference.py`
 * (sumas explícitas en dos pasadas, Decimal prec 60, precio HLC3, `vw` excluido).
 * Fixture: `fixtures/avwap_pieza50_7_reference.json` (tolerancia 1e-9).
 *
 * Cubre: `vw` ≠ HLC3, pesos desiguales, volumen 0/no finito antes y después del
 * primer punto, HLC inválido con `vw` válido, índices de ancla inválidos, máscaras
 * NaN, simetría y doble amplitud de bandas, timestamps/ancla, y uso efectivo en
 * `StockDetailView` (ancla única, marcador y fecha).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calculateAnchoredVwap } from '../src/core/avwap.js';
import type { Bar } from '../src/core/types.js';
import {
  computeAnchoredVwapPure,
  computeAnchoredVwapWithAnchor,
  computeSingleAnchorAvwapOverlayPure,
  type MinimalOhlcvBar,
} from '../web/src/components/stock-detail/stockDetailMath.js';

type FixtureScalar = number | string | null;

interface ScenarioExpected {
  readonly vwap: readonly FixtureScalar[];
  readonly upper1: readonly FixtureScalar[];
  readonly lower1: readonly FixtureScalar[];
  readonly upper2: readonly FixtureScalar[];
  readonly lower2: readonly FixtureScalar[];
  readonly anchorTimeSec: number | null;
  readonly anchorIndex: number;
  readonly legacyVwCenter?: readonly FixtureScalar[];
}

interface Scenario {
  readonly name: string;
  readonly notes: string;
  readonly anchorIndex: number;
  readonly bars: readonly (readonly FixtureScalar[])[];
  readonly expected: ScenarioExpected;
}

interface AvwapFixture {
  readonly meta: { readonly tolerance: number };
  readonly scenarios: readonly Scenario[];
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures', 'avwap_pieza50_7_reference.json'), 'utf-8'),
) as AvwapFixture;
const TOL = fixture.meta.tolerance;

function decodeNumber(value: FixtureScalar | undefined): number {
  if (value === undefined || value === null) return Number.NaN;
  switch (value) {
    case 'NaN':
      return Number.NaN;
    case 'Infinity':
      return Number.POSITIVE_INFINITY;
    case '-Infinity':
      return Number.NEGATIVE_INFINITY;
    default:
      return typeof value === 'number' ? value : Number.NaN;
  }
}

function toMathBar(raw: readonly FixtureScalar[]): MinimalOhlcvBar {
  return {
    time: decodeNumber(raw[0]),
    open: decodeNumber(raw[1]),
    high: decodeNumber(raw[2]),
    low: decodeNumber(raw[3]),
    close: decodeNumber(raw[4]),
    volume: decodeNumber(raw[5]),
    vw: decodeNumber(raw[6]),
  };
}

function toCoreBar(raw: readonly FixtureScalar[]): Bar {
  return {
    time: decodeNumber(raw[0]),
    open: decodeNumber(raw[1]),
    high: decodeNumber(raw[2]),
    low: decodeNumber(raw[3]),
    close: decodeNumber(raw[4]),
    volume: decodeNumber(raw[5]),
    vw: decodeNumber(raw[6]),
  };
}

function scenarioByName(name: string): Scenario {
  const found = fixture.scenarios.find((scenario) => scenario.name === name);
  if (found === undefined) throw new Error(`Fixture scenario not found: ${name}`);
  return found;
}

function expectNumberOrNaN(
  actual: number | undefined,
  expected: FixtureScalar | undefined,
  context: string,
): void {
  const target = decodeNumber(expected);
  if (Number.isNaN(target)) {
    expect(Number.isNaN(actual), context).toBe(true);
    return;
  }
  expect(Number.isFinite(actual), context).toBe(true);
  const diff = Math.abs((actual ?? Number.NaN) - target);
  expect(diff, context).toBeLessThanOrEqual(TOL * Math.max(1, Math.abs(target)));
}

function expectSeries(actual: readonly number[], expected: readonly FixtureScalar[], name: string): void {
  expect(actual.length, `${name} length`).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expectNumberOrNaN(actual[index], expected[index], `${name}[${String(index)}]`);
  }
}

function emittedIndices(expected: ScenarioExpected): number[] {
  const indices: number[] = [];
  for (let index = 0; index < expected.vwap.length; index += 1) {
    if (!Number.isNaN(decodeNumber(expected.vwap[index]))) indices.push(index);
  }
  return indices;
}

describe('Pieza 50.7 Bloque A — AVWAP HLC3 + bandas del mismo estado (referencia Python)', () => {
  it('coincide con la referencia en centro, cuatro bandas, máscara, ancla y timestamp', () => {
    for (const scenario of fixture.scenarios) {
      const mathBars = scenario.bars.map(toMathBar);
      const overlay = computeSingleAnchorAvwapOverlayPure(mathBars, scenario.anchorIndex);

      expectSeries(overlay.vwap, scenario.expected.vwap, `${scenario.name} vwap`);
      expectSeries(overlay.upper1, scenario.expected.upper1, `${scenario.name} upper1`);
      expectSeries(overlay.lower1, scenario.expected.lower1, `${scenario.name} lower1`);
      expectSeries(overlay.upper2, scenario.expected.upper2, `${scenario.name} upper2`);
      expectSeries(overlay.lower2, scenario.expected.lower2, `${scenario.name} lower2`);

      expect(overlay.anchorIndex, `${scenario.name} anchorIndex`).toBe(
        scenario.expected.anchorIndex,
      );
      expect(overlay.anchorTimeSec, `${scenario.name} anchorTimeSec`).toBe(
        scenario.expected.anchorTimeSec,
      );
      if (overlay.anchorIndex >= 0) {
        const anchorBar = mathBars[overlay.anchorIndex];
        expect(overlay.anchorTimeSec).toBe(anchorBar?.time);
      }
    }
  });

  it('el núcleo emitido por `calculateAnchoredVwap` coincide punto a punto y por timestamp', () => {
    for (const scenario of fixture.scenarios) {
      const coreBars = scenario.bars.map(toCoreBar);
      const points = calculateAnchoredVwap(coreBars, scenario.anchorIndex);
      const indices = emittedIndices(scenario.expected);
      expect(points.length, `${scenario.name} points`).toBe(indices.length);
      indices.forEach((barIndex, pointIndex) => {
        const point = points[pointIndex];
        const raw = scenario.bars[barIndex];
        expect(point?.time, `${scenario.name} time[${String(pointIndex)}]`).toBe(decodeNumber(raw?.[0]));
        expectNumberOrNaN(point?.vwap, scenario.expected.vwap[barIndex], `${scenario.name} center`);
        expectNumberOrNaN(point?.upper1, scenario.expected.upper1[barIndex], `${scenario.name} u1`);
        expectNumberOrNaN(point?.lower1, scenario.expected.lower1[barIndex], `${scenario.name} l1`);
        expectNumberOrNaN(point?.upper2, scenario.expected.upper2[barIndex], `${scenario.name} u2`);
        expectNumberOrNaN(point?.lower2, scenario.expected.lower2[barIndex], `${scenario.name} l2`);
      });
    }
  });

  it('bandas simétricas respecto del centro con doble amplitud exacta para 2σ', () => {
    for (const name of ['vw_distinto_hlc3', 'pesos_desiguales']) {
      const scenario = scenarioByName(name);
      const overlay = computeSingleAnchorAvwapOverlayPure(scenario.bars.map(toMathBar), scenario.anchorIndex);
      const indices = emittedIndices(scenario.expected);
      // Primer punto efectivo: un solo contribuyente → σ = 0 y las cinco salidas
      // coinciden con el centro.
      const firstIndex = indices[0];
      if (firstIndex !== undefined) {
        const center = overlay.vwap[firstIndex] ?? Number.NaN;
        expect(overlay.upper1[firstIndex], `${name} σ=0 u1`).toBeCloseTo(center, 12);
        expect(overlay.lower1[firstIndex], `${name} σ=0 l1`).toBeCloseTo(center, 12);
        expect(overlay.upper2[firstIndex], `${name} σ=0 u2`).toBeCloseTo(center, 12);
        expect(overlay.lower2[firstIndex], `${name} σ=0 l2`).toBeCloseTo(center, 12);
      }
      for (const index of indices.slice(1)) {
        const center = overlay.vwap[index] ?? Number.NaN;
        const sigma1 = (overlay.upper1[index] ?? Number.NaN) - center;
        expect(sigma1, `${name} σ>0[${String(index)}]`).toBeGreaterThan(0);
        expect(
          (center - (overlay.lower1[index] ?? Number.NaN)) - sigma1,
          `${name} simetría 1σ[${String(index)}]`,
        ).toBeCloseTo(0, 9);
        expect(
          (overlay.upper2[index] ?? Number.NaN) - center - 2 * sigma1,
          `${name} doble amplitud 2σ[${String(index)}]`,
        ).toBeCloseTo(0, 9);
        expect(
          center - (overlay.lower2[index] ?? Number.NaN) - 2 * sigma1,
          `${name} simetría 2σ[${String(index)}]`,
        ).toBeCloseTo(0, 9);
      }
    }
  });

  it('documenta el cambio numérico intencional: HLC3 en lugar de `vw`', () => {
    const scenario = scenarioByName('vw_distinto_hlc3');
    const legacy = scenario.expected.legacyVwCenter;
    expect(legacy).toBeDefined();
    const overlay = computeSingleAnchorAvwapOverlayPure(scenario.bars.map(toMathBar), 0);
    for (let index = 0; index < overlay.vwap.length; index += 1) {
      const legacyValue = decodeNumber(legacy?.[index]);
      expect(overlay.vwap[index], `vw_distinto_hlc3[${String(index)}]`).toBeCloseTo(
        decodeNumber(scenario.expected.vwap[index]),
        9,
      );
      expect(overlay.vwap[index], `vw_distinto_hlc3 legacy[${String(index)}]`).not.toBeCloseTo(
        legacyValue,
        9,
      );
    }
  });

  it('índice de ancla inválido (negativo, fuera de rango y no entero) no produce puntos', () => {
    const scenario = scenarioByName('indice_ancla_invalido');
    const bars = scenario.bars.map(toMathBar);
    for (const badIndex of [-1, scenario.bars.length, 1.5]) {
      const overlay = computeSingleAnchorAvwapOverlayPure(bars, badIndex);
      expect(overlay.anchorIndex).toBe(-1);
      expect(overlay.anchorTimeSec).toBeNull();
      expect(overlay.vwap.every((value) => Number.isNaN(value))).toBe(true);
      expect(overlay.upper2.every((value) => Number.isNaN(value))).toBe(true);
      expect(calculateAnchoredVwap(scenario.bars.map(toCoreBar), badIndex)).toEqual([]);
    }
  });

  it('conserva `computeAnchoredVwapPure` y `computeAnchoredVwapWithAnchor` para sus llamadores', () => {
    const bars: MinimalOhlcvBar[] = [
      { time: 1_000, open: 100, high: 102, low: 98, close: 100, volume: 10 },
      { time: 1_600, open: 101, high: 103, low: 99, close: 101, volume: 20 },
    ];
    expect(computeAnchoredVwapPure(bars, -1).every((value) => Number.isNaN(value))).toBe(true);
    const legacy = computeAnchoredVwapWithAnchor(bars, 0);
    expect(legacy.effectiveAnchorIndex).toBe(0);
    const expectedSecond = (((100 + 102 + 98) / 3) * 10 + ((101 + 103 + 99) / 3) * 20) / 30;
    expect(legacy.series[1]).toBeCloseTo(expectedSecond, 12);
  });

  it('la vista usa el cálculo HLC3 y sincroniza ancla, fecha y marcador (guardas estructurales)', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );
    // Ancla única alimentada por la función pura nueva (HLC3 + bandas del mismo estado).
    expect(src).toContain('computeSingleAnchorAvwapOverlayPure(');
    expect(src).toContain('const avwapAnchorAvailable = singleAvwap.anchorIndex >= 0;');
    expect(src).toContain('const avwapEffectiveAnchorTimeSec = singleAvwap.anchorTimeSec;');
    // Adaptadores locales eliminados por quedar sin uso.
    expect(src).not.toContain('barsToGgalChartPoints');
    expect(src).not.toContain('alignVwapPointsToBars');
    expect(src).not.toContain('computeAnchoredVwapSeries');
    // Auto-AVWAP intacto: conserva su cálculo y proyección.
    expect(src.split('computeAnchoredVwapWithAnchor(').length - 1).toBe(1);
    expect(src).toContain("const isAutoAvwapMode = avwapMode === 'AUTO_INSTITUTIONAL';");
    expect(src).toContain('resolveAutoAvwapBarIndex(bars, anchor.anchorTimeSec, effectiveChartTimeframe)');
    // Marcador y fecha toman el primer punto efectivo.
    expect(src).toContain('const anchorSec = bundle.avwapEffectiveAnchorTimeSec;');
    expect(src).toContain('chartBundle.avwapEffectiveAnchorTimeSec');
    // La ausencia de línea antes del ancla se resuelve con la máscara NaN → null.
    expect(src).toContain('value != null && Number.isFinite(value)');
  });
});
