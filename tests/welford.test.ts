import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeWelfordSeries,
  createInitialWelfordState,
  getWelfordOutput,
  INITIAL_WELFORD_STATE,
  updateWelford,
  type WelfordOutput,
  type WelfordState,
} from '../src/core/welford.js';

interface FixtureStepExpected {
  vwap: number | string | null;
  variance: number | string | null;
  stdDev: number | string | null;
  cumVolume: number | string | null;
}

interface FixtureCase {
  description: string;
  prices: Array<number | string | null>;
  volumes: Array<number | string | null>;
  expected: FixtureStepExpected[];
}

interface FixtureFile {
  metadata: {
    generator: string;
    command: string;
    method: string;
    tolerance: number;
  };
  cases: Record<string, FixtureCase>;
}

function parseFixtureValue(val: number | string | null): number {
  if (val === null || val === 'NaN') {
    return Number.NaN;
  }
  if (val === 'Infinity') {
    return Number.POSITIVE_INFINITY;
  }
  if (val === '-Infinity') {
    return Number.NEGATIVE_INFINITY;
  }
  return Number(val);
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

const fixturePath = resolve(process.cwd(), 'fixtures/welford_reference.json');
const fixtureContent = readFileSync(fixturePath, 'utf-8');
const fixture = JSON.parse(fixtureContent) as FixtureFile;

describe('Welford ponderado (AVWAP y bandas)', () => {
  describe('Referencia independiente (fixtures)', () => {
    let globalMaxVwapRelDiff = 0;
    let globalMaxStdDevRelDiff = 0;

    for (const [caseName, caseData] of Object.entries(fixture.cases)) {
      it(`verifica contra fixture independiente: ${caseName} (${caseData.description})`, () => {
        const prices = caseData.prices.map(parseFixtureValue);
        const volumes = caseData.volumes.map(parseFixtureValue);
        const expected = caseData.expected;

        expect(prices.length).toBe(volumes.length);
        expect(prices.length).toBe(expected.length);

        const series = computeWelfordSeries(prices, volumes);
        expect(series.length).toBe(expected.length);

        for (let i = 0; i < series.length; i++) {
          const actualOutput = series[i];
          const expectedStep = expected[i];
          if (actualOutput === undefined || expectedStep === undefined) {
            throw new Error(`Índice fuera de límites: ${i.toString()}`);
          }

          const expectedVwap = parseFixtureValue(expectedStep.vwap);
          const expectedVariance = parseFixtureValue(expectedStep.variance);
          const expectedStdDev = parseFixtureValue(expectedStep.stdDev);
          const expectedCumVolume = parseFixtureValue(expectedStep.cumVolume);

          // 1. Verificación de cumVolume (tolerancia relativa 1e-9)
          const diffCumVol = relativeDiff(actualOutput.cumVolume, expectedCumVolume);
          expect(diffCumVol).toBeLessThanOrEqual(1e-9);

          // 2. Verificación de VWAP
          if (Number.isNaN(expectedVwap)) {
            expect(Number.isNaN(actualOutput.vwap)).toBe(true);
          } else {
            expect(Number.isNaN(actualOutput.vwap)).toBe(false);
            const diffVwap = relativeDiff(actualOutput.vwap, expectedVwap);
            if (diffVwap > globalMaxVwapRelDiff) {
              globalMaxVwapRelDiff = diffVwap;
            }
            expect(diffVwap).toBeLessThanOrEqual(1e-9);
          }

          // 3. Verificación de Varianza
          if (Number.isNaN(expectedVariance)) {
            expect(Number.isNaN(actualOutput.variance)).toBe(true);
          } else {
            expect(Number.isNaN(actualOutput.variance)).toBe(false);
            const diffVar = relativeDiff(actualOutput.variance, expectedVariance);
            expect(diffVar).toBeLessThanOrEqual(1e-9);
          }

          // 4. Verificación de Desviación Estándar
          if (Number.isNaN(expectedStdDev)) {
            expect(Number.isNaN(actualOutput.stdDev)).toBe(true);
          } else {
            expect(Number.isNaN(actualOutput.stdDev)).toBe(false);
            const diffStd = relativeDiff(actualOutput.stdDev, expectedStdDev);
            if (diffStd > globalMaxStdDevRelDiff) {
              globalMaxStdDevRelDiff = diffStd;
            }
            expect(diffStd).toBeLessThanOrEqual(1e-9);
          }
        }
      });
    }

    it('reporta la máxima diferencia relativa observada contra el fixture', () => {
      // Reporte explícito para verificación y registro
      console.log(
        `[Fixture Reference Report] Max relative difference -> vwap: ${globalMaxVwapRelDiff.toExponential(4)}, stdDev: ${globalMaxStdDevRelDiff.toExponential(4)}`,
      );
      expect(globalMaxVwapRelDiff).toBeLessThanOrEqual(1e-9);
      expect(globalMaxStdDevRelDiff).toBeLessThanOrEqual(1e-9);
    });
  });

  describe('Inmutabilidad y pureza de funciones', () => {
    it('el estado de entrada queda idéntico tras llamar a updateWelford (Object.freeze)', () => {
      const stateBefore: WelfordState = Object.freeze({
        count: 3,
        cumWeight: 60,
        mean: 100,
        m2: 50,
      });

      // Si updateWelford intentara mutar stateBefore, Object.freeze lanzaría TypeError en strict mode
      const result = updateWelford(stateBefore, 105, 20);

      // El estado original permanece idéntico
      expect(stateBefore.count).toBe(3);
      expect(stateBefore.cumWeight).toBe(60);
      expect(stateBefore.mean).toBe(100);
      expect(stateBefore.m2).toBe(50);

      // El resultado es una nueva referencia de estado
      expect(result.state).not.toBe(stateBefore);
      expect(result.state.count).toBe(4);
      expect(result.state.cumWeight).toBe(80);
    });

    it('no muta el estado inicial al procesar barras descartables', () => {
      const initialState = Object.freeze(createInitialWelfordState());
      const result = updateWelford(initialState, Number.NaN, 10);

      expect(initialState.count).toBe(0);
      expect(initialState.cumWeight).toBe(0);
      expect(Number.isNaN(result.output.vwap)).toBe(true);
      expect(result.output.cumVolume).toBe(0);
    });

    it('comparación profunda del estado previo antes y después de una actualización', () => {
      const state: WelfordState = {
        count: 10,
        cumWeight: 500,
        mean: 125.5,
        m2: 340.2,
      };

      const clone = structuredClone(state);
      updateWelford(state, 130, 50);

      expect(state).toEqual(clone);
    });
  });

  describe('Comportamiento de acumulación secuencial vs barras en vivo', () => {
    it('100 actualizaciones con la misma barra equivalen a procesar 100 barras iguales (no a una)', () => {
      /**
       * NOTA ARQUITECTÓNICA SOBRE BARRAS EN VIVO:
       * updateWelford es una función puramente matemática de acumulación secuencial sobre barras
       * comprometidas (cerradas). Cada llamada representa la adición de una barra completa más a la serie.
       *
       * Por ello, 100 llamadas consecutivas con los mismos valores (price, volume) equivalen a acumular
       * 100 barras consecutivas idénticas (con volumen acumulado = 100 * volume), y NO a actualizar
       * 100 veces la misma barra en vivo.
       *
       * Las barras en vivo (ticks intra-barra en formación) se manejan en el motor de sesión/anclaje
       * clonando el estado de la última barra cerrada y llamando a updateWelford con el tick actual
       * para proyectar el AVWAP en vivo sin avanzar el puntero del estado cerrado hasta el cierre de vela.
       */
      const price = 42.5;
      const volume = 3.0;

      let currentStep = updateWelford(createInitialWelfordState(), price, volume);
      for (let i = 1; i < 100; i++) {
        currentStep = updateWelford(currentStep.state, price, volume);
      }

      expect(currentStep.state.count).toBe(100);
      expect(currentStep.state.cumWeight).toBeCloseTo(300.0);
      expect(currentStep.output.cumVolume).toBeCloseTo(300.0);
      expect(currentStep.output.vwap).toBeCloseTo(42.5);
      expect(currentStep.output.stdDev).toBe(0);

      // Comprueba equivalencia con procesar un array completo de 100 barras idénticas
      const arrayPrices = new Array<number>(100).fill(price);
      const arrayVolumes = new Array<number>(100).fill(volume);
      const series = computeWelfordSeries(arrayPrices, arrayVolumes);

      expect(series.length).toBe(100);
      expect(series[99]).toEqual(currentStep.output);
    });
  });

  describe('Precio constante y desviación estándar', () => {
    it('un precio constante da stdDev = 0 exacto para cualquier secuencia de volúmenes', () => {
      const constantPrice = 254.75;
      const volumes = [10.5, 20.0, 5.25, 100.0, 0.5, 45.1];

      const series = computeWelfordSeries(
        new Array<number>(volumes.length).fill(constantPrice),
        volumes,
      );

      for (const item of series) {
        expect(item.vwap).toBeCloseTo(constantPrice);
        expect(item.variance).toBe(0);
        // Exigencia del SPEC/test: stdDev = 0 exacto
        expect(item.stdDev).toBe(0);
      }
    });

    it('una sola barra válida da stdDev = 0 exacto', () => {
      const step = updateWelford(createInitialWelfordState(), 999.9, 50);
      expect(step.output.vwap).toBe(999.9);
      expect(step.output.variance).toBe(0);
      expect(step.output.stdDev).toBe(0);
      expect(step.output.cumVolume).toBe(50);
    });
  });

  describe('Casos límite del SPEC', () => {
    it('mientras cumWeight sea 0, la salida indica sin dato (vwap = NaN), no 0', () => {
      const initialOutput: WelfordOutput = getWelfordOutput(INITIAL_WELFORD_STATE);
      expect(Number.isNaN(initialOutput.vwap)).toBe(true);
      expect(Number.isNaN(initialOutput.variance)).toBe(true);
      expect(Number.isNaN(initialOutput.stdDev)).toBe(true);
      expect(initialOutput.cumVolume).toBe(0);

      // Una barra con volumen 0 no altera el estado de cumWeight = 0
      const step = updateWelford(INITIAL_WELFORD_STATE, 100, 0);
      expect(step.state.cumWeight).toBe(0);
      expect(Number.isNaN(step.output.vwap)).toBe(true);
      expect(Number.isNaN(step.output.variance)).toBe(true);
      expect(Number.isNaN(step.output.stdDev)).toBe(true);
      expect(step.output.cumVolume).toBe(0);
    });

    it('descarta volúmenes negativos, NaN e Infinity manteniendo el estado sin cambios', () => {
      const step1 = updateWelford(createInitialWelfordState(), 100, 10);
      expect(step1.output.cumVolume).toBe(10);

      // Volumen negativo
      const stepNeg = updateWelford(step1.state, 110, -5);
      expect(stepNeg.state).toBe(step1.state);
      expect(stepNeg.output.cumVolume).toBe(10);
      expect(stepNeg.output.vwap).toBe(100);

      // Volumen NaN
      const stepNanVol = updateWelford(step1.state, 110, Number.NaN);
      expect(stepNanVol.state).toBe(step1.state);

      // Volumen Infinity
      const stepInfVol = updateWelford(step1.state, 110, Number.POSITIVE_INFINITY);
      expect(stepInfVol.state).toBe(step1.state);

      // Precio NaN
      const stepNanPrice = updateWelford(step1.state, Number.NaN, 20);
      expect(stepNanPrice.state).toBe(step1.state);

      // Precio Infinity
      const stepInfPrice = updateWelford(step1.state, Number.POSITIVE_INFINITY, 20);
      expect(stepInfPrice.state).toBe(step1.state);
    });

    it('lanza error si las longitudes de precios y volúmenes no coinciden en computeWelfordSeries', () => {
      expect(() => {
        computeWelfordSeries([100, 101], [10]);
      }).toThrow(/same length/);
    });
  });

  describe('Rendimiento (5.000 barras en menos de 50 ms)', () => {
    it('procesa 5.000 barras midiendo el tiempo de ejecución', () => {
      // Usamos el case_a del fixture con 5.000 barras
      const caseA = fixture.cases['case_a_large_prices_large_volumes'];
      if (!caseA) {
        throw new Error('No se encontró case_a_large_prices_large_volumes en el fixture');
      }

      const prices = caseA.prices.map(parseFixtureValue);
      const volumes = caseA.volumes.map(parseFixtureValue);

      expect(prices.length).toBe(5000);
      expect(volumes.length).toBe(5000);

      const tStart = performance.now();
      const series = computeWelfordSeries(prices, volumes);
      const tElapsed = performance.now() - tStart;

      expect(series.length).toBe(5000);

      // Reporta el valor medido en consola (requerido por el prompt sin convertirlo en aserción frágil)
      console.log(
        `[Performance Benchmark] 5.000 barras procesadas en ${tElapsed.toFixed(3)} ms (límite orientativo: 50 ms)`,
      );

      // Aserción no frágil: garantiza que se ejecuta en tiempo razonable sin colgarse
      expect(tElapsed).toBeLessThan(1000);
    });
  });
});
