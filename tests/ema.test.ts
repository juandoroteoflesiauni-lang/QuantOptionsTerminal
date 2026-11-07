import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  calculateEma,
  computeEmaSuite,
  EMA_PERIODS,
  emaWarmupWeight,
  projectLiveEma,
} from '../src/core/ema.js';

interface FixtureCase {
  description: string;
  closes: Array<number | string | null>;
  expected: Record<string, Array<number | string | null>>;
}

interface PandasCrossCheckSeries {
  pandasEwmAdjustFalseFromIndex1000: Array<number | string | null>;
  maxRelativeDiff: number;
  maxAbsoluteDiff: number;
}

interface FixtureFile {
  metadata: {
    generator: string;
    command: string;
    method: string;
    tolerance: number;
    seeds: Record<string, number>;
  };
  cases: Record<string, FixtureCase>;
  pandasCrossCheck: {
    description: string;
    sourceCase: string;
    startIndex: number;
    tolerance: number;
    pandasVersion: string;
    series: Record<string, PandasCrossCheckSeries>;
  };
}

function parseFixtureValue(value: number | string | null): number {
  if (value === null || value === 'NaN') {
    return Number.NaN;
  }
  if (value === 'Infinity') {
    return Number.POSITIVE_INFINITY;
  }
  if (value === '-Infinity') {
    return Number.NEGATIVE_INFINITY;
  }
  return Number(value);
}

function relativeDiff(actual: number, expected: number): number {
  if (Number.isNaN(actual) && Number.isNaN(expected)) {
    return 0;
  }
  if (actual === expected) {
    return 0;
  }
  const absExpected = Math.abs(expected);
  if (absExpected === 0) {
    return Math.abs(actual);
  }
  return Math.abs(actual - expected) / absExpected;
}

function valueAt(series: readonly number[], index: number): number {
  const value = series[index];
  if (value === undefined) {
    throw new Error(`Índice fuera de límites: ${index.toString()}`);
  }
  return value;
}

const fixturePath = resolve(process.cwd(), 'fixtures/ema_reference.json');
const fixtureContent = readFileSync(fixturePath, 'utf-8');
const fixture = JSON.parse(fixtureContent) as FixtureFile;

let maxFixtureRelativeDiff = 0;
let maxPandasRelativeDiff = 0;

describe('EMA (SPEC punto 2)', () => {
  describe('Referencia independiente (fixtures)', () => {
    for (const [caseName, caseData] of Object.entries(fixture.cases)) {
      for (const [periodKey, expectedRaw] of Object.entries(caseData.expected)) {
        it(`verifica contra fixture independiente: ${caseName}, periodo ${periodKey}`, () => {
          const period = Number(periodKey);
          const closes = caseData.closes.map(parseFixtureValue);
          const expected = expectedRaw.map(parseFixtureValue);

          expect(Number.isInteger(period)).toBe(true);
          expect(expected).toHaveLength(closes.length);

          const actual = calculateEma(closes, period);
          expect(actual).toHaveLength(expected.length);

          for (let i = 0; i < actual.length; i++) {
            const actualValue = valueAt(actual, i);
            const expectedValue = valueAt(expected, i);

            if (Number.isNaN(expectedValue)) {
              expect(Number.isNaN(actualValue)).toBe(true);
            } else {
              expect(Number.isNaN(actualValue)).toBe(false);
              const diff = relativeDiff(actualValue, expectedValue);
              if (diff > maxFixtureRelativeDiff) {
                maxFixtureRelativeDiff = diff;
              }
              expect(diff).toBeLessThanOrEqual(1e-9);
            }
          }
        });
      }
    }

    it('reporta la máxima diferencia relativa observada contra el fixture', () => {
      console.log(
        `[EMA Fixture Reference Report] Max relative difference: ${maxFixtureRelativeDiff.toExponential(4)}`,
      );
      expect(maxFixtureRelativeDiff).toBeLessThanOrEqual(1e-9);
    });
  });

  describe('Comprobación cruzada con pandas (segundo fixture)', () => {
    it('coincide con pandas.ewm(span=N, adjust=False) desde la barra 1000', () => {
      const crossCheck = fixture.pandasCrossCheck;
      const sourceCase = fixture.cases[crossCheck.sourceCase];
      if (sourceCase === undefined) {
        throw new Error(`No se encontró el caso fuente ${crossCheck.sourceCase}`);
      }

      const closes = sourceCase.closes.map(parseFixtureValue);
      const startIndex = crossCheck.startIndex;

      for (const [periodKey, pandasSeries] of Object.entries(crossCheck.series)) {
        const period = Number(periodKey);
        const actual = calculateEma(closes, period);
        const pandasValues =
          pandasSeries.pandasEwmAdjustFalseFromIndex1000.map(parseFixtureValue);

        expect(pandasValues).toHaveLength(closes.length - startIndex);
        expect(pandasSeries.maxRelativeDiff).toBeLessThan(crossCheck.tolerance);

        for (let offset = 0; offset < pandasValues.length; offset++) {
          const index = startIndex + offset;
          const actualValue = valueAt(actual, index);
          const pandasValue = valueAt(pandasValues, offset);

          expect(Number.isNaN(actualValue)).toBe(false);
          expect(Number.isNaN(pandasValue)).toBe(false);

          const diff = relativeDiff(actualValue, pandasValue);
          if (diff > maxPandasRelativeDiff) {
            maxPandasRelativeDiff = diff;
          }
          expect(diff).toBeLessThan(crossCheck.tolerance);
        }
      }

      console.log(
        `[EMA pandas Cross-Check Report] pandas ${crossCheck.pandasVersion}, desde índice ${startIndex.toString()}: max relative difference ${maxPandasRelativeDiff.toExponential(4)}`,
      );
    });
  });

  describe('Arranque y semilla SMA', () => {
    it('NaN exacto en 0..period-2 y valor numérico en period-1 para los 4 periodos', () => {
      const closes = Array.from(
        { length: 500 },
        (_, index) => 100 + Math.sin(index / 11) * 5 + index * 0.01,
      );

      for (const period of EMA_PERIODS) {
        const ema = calculateEma(closes, period);

        for (let i = 0; i < period - 1; i++) {
          expect(Number.isNaN(valueAt(ema, i))).toBe(true);
        }

        const seed =
          closes.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
        expect(Number.isNaN(valueAt(ema, period - 1))).toBe(false);
        expect(valueAt(ema, period - 1)).toBeCloseTo(seed, 12);
      }
    });

    it('con precios constantes la EMA es exactamente ese precio', () => {
      const price = 42.5;
      const closes = Object.freeze(new Array<number>(500).fill(price));

      for (const period of EMA_PERIODS) {
        const ema = calculateEma(closes, period);
        for (let i = period - 1; i < ema.length; i++) {
          expect(valueAt(ema, i)).toBe(price);
        }
      }
    });

    it('un cierre no finito invalida ese índice y todos los siguientes', () => {
      const closes = [100, 101, 102, Number.NaN, 104, 105, 106, 107, 108, 109, 110];
      const ema = calculateEma(closes, 3);

      expect(Number.isNaN(valueAt(ema, 0))).toBe(true);
      expect(Number.isNaN(valueAt(ema, 1))).toBe(true);
      expect(valueAt(ema, 2)).toBeCloseTo((100 + 101 + 102) / 3, 12);

      for (let i = 3; i < ema.length; i++) {
        expect(Number.isNaN(valueAt(ema, i))).toBe(true);
      }

      // NaN dentro de la semilla: toda la serie queda en NaN.
      const seedPoisoned = calculateEma([100, Number.NaN, 102, 103, 104], 3);
      for (const value of seedPoisoned) {
        expect(Number.isNaN(value)).toBe(true);
      }

      // Infinity también es un cierre no finito y envenena el resto.
      const infinityPoisoned = calculateEma([100, 101, 102, 103, 104, Infinity, 106], 3);
      expect(Number.isNaN(valueAt(infinityPoisoned, 5))).toBe(true);
      expect(Number.isNaN(valueAt(infinityPoisoned, 6))).toBe(true);
    });
  });

  describe('projectLiveEma', () => {
    it('100 ticks sobre la misma barra, siempre desde la EMA cerrada, dan el mismo resultado que el último tick', () => {
      const lastClosedEma = 123.456;
      const period = 9;
      const prices = Array.from({ length: 100 }, (_, index) => 100 + index * 0.5);

      const direct = projectLiveEma(lastClosedEma, valueAt(prices, 99), period);
      const projections = prices.map((price) =>
        projectLiveEma(lastClosedEma, price, period),
      );

      for (const projection of projections) {
        expect(Number.isFinite(projection)).toBe(true);
      }
      expect(valueAt(projections, 99)).toBe(direct);
    });

    it('encadenar la EMA del tick anterior NO da el mismo resultado (error que se evita)', () => {
      const lastClosedEma = 100;
      const period = 9;
      const prices = Array.from({ length: 100 }, (_, index) => 100 + index);

      const direct = projectLiveEma(lastClosedEma, valueAt(prices, 99), period);

      let chained = lastClosedEma;
      for (const price of prices) {
        chained = projectLiveEma(chained, price, period);
      }

      expect(chained).not.toBe(direct);
      expect(Math.abs(chained - direct)).toBeGreaterThan(1);

      console.log(
        `[projectLiveEma] directo=${direct.toFixed(6)}, encadenado=${chained.toFixed(6)}, diferencia=${Math.abs(chained - direct).toFixed(6)}`,
      );
    });

    it('devuelve NaN si la EMA cerrada o el precio vivo no son finitos', () => {
      const nonFiniteValues = [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ];

      for (const badValue of nonFiniteValues) {
        expect(Number.isNaN(projectLiveEma(badValue, 100, 9))).toBe(true);
        expect(Number.isNaN(projectLiveEma(100, badValue, 9))).toBe(true);
      }
    });
  });

  describe('emaWarmupWeight', () => {
    it('emaWarmupWeight(200, 1000) es aproximadamente 4.4e-5', () => {
      // Cálculo: (1 - 2/201)^1000 = (199/201)^1000 ≈ 4.5396e-5 ≈ 4.4e-5.
      const weight = emaWarmupWeight(200, 1000);
      console.log(
        `[emaWarmupWeight] (199/201)^1000 = ${weight.toExponential(6)}`,
      );
      expect(Math.abs(weight / 4.4e-5 - 1)).toBeLessThan(0.05);
    });

    it('en la semilla el peso es 1 y decae según (1-alpha)^barras', () => {
      const period = 21;
      const alpha = 2 / (period + 1);

      expect(emaWarmupWeight(period, 0)).toBe(1);
      expect(emaWarmupWeight(period, 1)).toBeCloseTo(1 - alpha, 15);
      expect(emaWarmupWeight(period, 10)).toBeCloseTo(
        Math.pow(1 - alpha, 10),
        15,
      );
    });
  });

  describe('Validación de periodo', () => {
    it('lanza error para periodos 0, -1, 2.5 y NaN', () => {
      for (const period of [0, -1, 2.5, Number.NaN]) {
        expect(() => calculateEma([1, 2, 3], period)).toThrow();
        expect(() => projectLiveEma(100, 101, period)).toThrow();
        expect(() => emaWarmupWeight(period, 10)).toThrow();
      }
    });
  });

  describe('computeEmaSuite', () => {
    it('devuelve las series de 9, 21, 50 y 200', () => {
      const closes = Array.from(
        { length: 500 },
        (_, index) => 100 + Math.sin(index / 5) * 2,
      );
      const suite = computeEmaSuite(closes);

      for (const period of EMA_PERIODS) {
        expect(suite[period]).toEqual(calculateEma(closes, period));
        expect(suite[period]).toHaveLength(closes.length);
      }
    });
  });

  describe('Inmutabilidad', () => {
    it('el array de entrada queda idéntico (Object.freeze)', () => {
      const closes = Object.freeze(
        Array.from({ length: 300 }, (_, index) => 100 + index * 0.1),
      );
      const snapshot = [...closes];

      calculateEma(closes, 9);
      computeEmaSuite(closes);
      projectLiveEma(100, 101, 9);

      expect(closes).toEqual(snapshot);
    });
  });

  describe('Rendimiento', () => {
    it('procesa 5.000 cierres para los 4 periodos y reporta el tiempo medido', () => {
      const closes = Array.from(
        { length: 5000 },
        (_, index) => 100 + Math.sin(index / 7.3) * 3 + index * 0.002,
      );

      const startTime = performance.now();
      const suite = computeEmaSuite(closes);
      const elapsed = performance.now() - startTime;

      for (const period of EMA_PERIODS) {
        expect(suite[period]).toHaveLength(5000);
      }

      console.log(
        `[EMA Performance Benchmark] 5.000 cierres x 4 periodos (9, 21, 50, 200) en ${elapsed.toFixed(3)} ms`,
      );
    });
  });
});
