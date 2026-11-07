import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeSessionVwap,
  createInitialSessionVwapState,
  projectLiveSessionVwap,
  updateSessionVwap,
  type SessionVwapOptions,
  type SessionVwapPoint,
  type SessionVwapPriceSource,
  type SessionVwapSource,
  type SessionVwapState,
} from '../src/core/sessionVwap.js';
import type { Bar } from '../src/core/types.js';

type FixtureScalar = number | 'NaN';

interface FixtureBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: FixtureScalar;
  vw?: FixtureScalar | null;
}

interface FixturePoint {
  time: number;
  vwap: FixtureScalar;
  cumVolume: FixtureScalar;
  frozen: boolean;
  source: SessionVwapSource;
}

interface FixtureOptions {
  market: 'EQUITY' | 'CRYPTO';
  barSeconds: number;
  priceSource?: SessionVwapPriceSource;
}

interface FixtureCase {
  description: string;
  options: FixtureOptions;
  bars: FixtureBar[];
  points: FixturePoint[];
}

interface FixtureErrorCase {
  description: string;
  options: FixtureOptions;
  bars: FixtureBar[];
}

interface FixtureFile {
  metadata: {
    generator: string;
    command: string;
    method: string;
    tolerance: string;
    nanEncoding: string;
    nullVwMeaning: string;
    seeds: Record<string, number>;
  };
  cases: Record<string, FixtureCase>;
  errorCases: Record<string, FixtureErrorCase>;
}

const fixturePath = resolve(
  process.cwd(),
  'fixtures/session_vwap_reference.json',
);
const fixtureContent = readFileSync(fixturePath, 'utf-8');
const fixture = JSON.parse(fixtureContent) as FixtureFile;

const EQUITY_5M: SessionVwapOptions = {
  market: 'EQUITY',
  barSeconds: 300,
};

const EQUITY_1M: SessionVwapOptions = {
  market: 'EQUITY',
  barSeconds: 60,
};

const CRYPTO_15M: SessionVwapOptions = {
  market: 'CRYPTO',
  barSeconds: 900,
};

let maxVwapRelativeDifference = 0;
let maxCumVolumeRelativeDifference = 0;

describe('VWAP de sesión (SPEC punto 4)', () => {
  describe('Referencia independiente (fixtures)', () => {
    for (const [caseName, caseData] of Object.entries(fixture.cases)) {
      it(`verifica contra fixture independiente: ${caseName} (${caseData.description})`, () => {
        const bars = caseData.bars.map(decodeBar);
        const options = decodeOptions(caseData.options);
        const result = computeSessionVwap(bars, options);

        expect(result.points).toHaveLength(caseData.points.length);

        for (let index = 0; index < caseData.points.length; index++) {
          const actual = result.points[index];
          const expected = caseData.points[index];
          if (actual === undefined || expected === undefined) {
            throw new Error(
              `${caseName}: índice fuera de límites ${index.toString()}`,
            );
          }

          const context = `${caseName}[${index.toString()}]`;
          expect(actual.time, context).toBe(expected.time);
          expect(actual.frozen, context).toBe(expected.frozen);
          expect(actual.source, context).toBe(expected.source);

          const expectedVwap = decodeNumber(expected.vwap);
          const expectedCumVolume = decodeNumber(expected.cumVolume);

          const vwapDifference = relativeDifference(
            actual.vwap,
            expectedVwap,
          );
          maxVwapRelativeDifference = Math.max(
            maxVwapRelativeDifference,
            vwapDifference,
          );
          expect(vwapDifference, `${context} vwap`).toBeLessThanOrEqual(1e-9);

          const cumVolumeDifference = relativeDifference(
            actual.cumVolume,
            expectedCumVolume,
          );
          maxCumVolumeRelativeDifference = Math.max(
            maxCumVolumeRelativeDifference,
            cumVolumeDifference,
          );
          expect(cumVolumeDifference, `${context} cumVolume`).toBeLessThanOrEqual(
            1e-9,
          );
        }
      });
    }

    it('reporta la máxima diferencia relativa observada contra el fixture', () => {
      console.log(
        `[Session VWAP Fixture Reference] Max relative difference -> vwap: ${maxVwapRelativeDifference.toExponential(4)}, cumVolume: ${maxCumVolumeRelativeDifference.toExponential(4)}`,
      );
      expect(maxVwapRelativeDifference).toBeLessThanOrEqual(1e-9);
      expect(maxCumVolumeRelativeDifference).toBeLessThanOrEqual(1e-9);
    });

    it('las barras de acciones sin vw coinciden con priceSource HLC3 explícito', () => {
      const f1 = getFixtureCase('f1_equity_15m_hlc3_explicit');
      const f2 = getFixtureCase('f2_equity_15m_no_vw_default');
      const result1 = computeSessionVwap(
        f1.bars.map(decodeBar),
        decodeOptions(f1.options),
      );
      const result2 = computeSessionVwap(
        f2.bars.map(decodeBar),
        decodeOptions(f2.options),
      );

      expect(result2.points).toHaveLength(result1.points.length);
      for (let index = 0; index < result1.points.length; index++) {
        const point1 = at(result1.points, index, 'f1');
        const point2 = at(result2.points, index, 'f2');
        expect(point2.frozen).toBe(point1.frozen);
        if (point1.frozen) {
          expect(point1.source).toBe('NONE');
          expect(point2.source).toBe('NONE');
        } else {
          expect(point1.source).toBe('HLC3');
          expect(point2.source).toBe('HLC3');
        }
        expectRelative(point2.vwap, point1.vwap, 1e-12, 'f2 vwap');
        expectRelative(
          point2.cumVolume,
          point1.cumVolume,
          1e-12,
          'f2 cumVolume',
        );
      }
    });

    it('cripto con la fuente por defecto HLC3 ignora el vw (con y sin vw coinciden)', () => {
      const e1 = getFixtureCase('e1_crypto_15m_with_vw');
      const e2 = getFixtureCase('e2_crypto_15m_without_vw');
      const result1 = computeSessionVwap(
        e1.bars.map(decodeBar),
        decodeOptions(e1.options),
      );
      const result2 = computeSessionVwap(
        e2.bars.map(decodeBar),
        decodeOptions(e2.options),
      );

      expect(result2.points).toHaveLength(result1.points.length);
      for (let index = 0; index < result1.points.length; index++) {
        const point1 = at(result1.points, index, 'e1');
        const point2 = at(result2.points, index, 'e2');
        expect(point2.source).toBe('HLC3');
        expect(point1.source).toBe('HLC3');
        expect(point2.frozen).toBe(false);
        expect(point1.frozen).toBe(false);
        expectRelative(point2.vwap, point1.vwap, 1e-12, 'e2 vwap');
        expectRelative(
          point2.cumVolume,
          point1.cumVolume,
          1e-12,
          'e2 cumVolume',
        );
      }
    });
  });

  describe('Casos de error del fixture', () => {
    for (const [caseName, caseData] of Object.entries(fixture.errorCases)) {
      it(`rechaza ${caseName} (${caseData.description})`, () => {
        const bars = caseData.bars.map(decodeBar);
        const options = decodeOptions(caseData.options);
        expect(() => computeSessionVwap(bars, options)).toThrow();
      });
    }

    it('la restricción de barSeconds solo aplica a EQUITY', () => {
      expect(() =>
        computeSessionVwap([], { market: 'EQUITY', barSeconds: 3600 }),
      ).toThrow();
      expect(() =>
        computeSessionVwap([], { market: 'CRYPTO', barSeconds: 3600 }),
      ).not.toThrow();
    });

    it('rechaza barSeconds no entero o no positivo', () => {
      for (const barSeconds of [0, -300, 1.5, Number.NaN]) {
        expect(() =>
          computeSessionVwap([], { market: 'CRYPTO', barSeconds }),
        ).toThrow();
      }
    });
  });

  describe('Acumulación y congelado en acciones', () => {
    it('la barra de 15:55 ET acumula en el VWAP de sesión', () => {
      const result = computeSessionVwap(july15SessionBars(), EQUITY_5M);
      const point = at(result.points, 1, '15:55');

      expect(point.frozen).toBe(false);
      expect(point.source).toBe('VW');
      expectRelative(point.vwap, 105, 1e-12, 'vwap 15:55');
      expectRelative(point.cumVolume, 200, 1e-12, 'cumVolume 15:55');
    });

    it('las barras de 16:00 y 19:55 ET devuelven el valor de 15:55 con frozen=true', () => {
      const bars = [
        ...july15SessionBars(),
        makeBar(JUL15_1600, 999, 999, 999),
        makeBar(JUL15_1955, 999, 999, 999),
      ];
      const result = computeSessionVwap(bars, EQUITY_5M);
      const lastRth = at(result.points, 1, '15:55');

      for (const index of [2, 3]) {
        const point = at(result.points, index, 'fuera de RTH');
        expect(point.frozen).toBe(true);
        expect(point.source).toBe('NONE');
        expectRelative(point.vwap, 105, 1e-12, 'vwap congelado');
        expectRelative(point.cumVolume, 200, 1e-12, 'cumVolume congelado');
        expect(point.cumVolume).toBe(lastRth.cumVolume);
      }
    });

    it('en 1m, la barra de 19:59 ET devuelve el valor de 15:55 con frozen=true', () => {
      const bars = [
        makeBar(JUL15_0930, 100, 100, 100),
        makeBar(JUL15_1555, 110, 100, 110),
        makeBar(JUL15_1600, 999, 999, 999),
        makeBar(JUL15_1959, 999, 999, 999),
      ];
      const result = computeSessionVwap(bars, EQUITY_1M);
      const lastRth = at(result.points, 1, '15:55');
      const point = at(result.points, 3, '19:59');

      expect(point.frozen).toBe(true);
      expect(point.source).toBe('NONE');
      expectRelative(point.vwap, lastRth.vwap, 1e-12, 'vwap congelado 1m');
      expect(point.cumVolume).toBe(lastRth.cumVolume);
    });

    it('las 04:00 ET del día siguiente siguen congeladas con el valor del día anterior', () => {
      const bars = [
        ...july15SessionBars(),
        makeBar(JUL16_0400, 999, 999, 999),
      ];
      const result = computeSessionVwap(bars, EQUITY_5M);
      const point = at(result.points, 2, '04:00 siguiente');

      expect(point.frozen).toBe(true);
      expect(point.source).toBe('NONE');
      expectRelative(point.vwap, 105, 1e-12, 'vwap premarket siguiente');
      expectRelative(point.cumVolume, 200, 1e-12, 'cumVolume premarket');
    });

    it('09:30 ET reinicia la sesión: cumVolume es el volumen de esa barra', () => {
      const bars = [
        ...july15SessionBars(),
        makeBar(JUL16_0400, 999, 999, 999),
        makeBar(JUL16_0930, 200, 50, 200),
      ];
      const result = computeSessionVwap(bars, EQUITY_5M);
      const point = at(result.points, 3, '09:30 reinicio');

      expect(point.frozen).toBe(false);
      expect(point.source).toBe('VW');
      expectRelative(point.vwap, 200, 1e-12, 'vwap tras reinicio');
      expectRelative(point.cumVolume, 50, 1e-12, 'cumVolume tras reinicio');
    });

    it('el viernes pasa al lunes sin acumular el fin de semana', () => {
      const bars = [
        makeBar(JUL11_0930, 100, 100, 100),
        makeBar(JUL11_1555, 110, 100, 110),
        makeBar(JUL12_1200, 999, 999, 999),
        makeBar(JUL13_1200, 999, 999, 999),
        makeBar(JUL14_0400, 999, 999, 999),
        makeBar(JUL14_0930, 130, 10, 130),
      ];
      const result = computeSessionVwap(bars, EQUITY_5M);

      for (const index of [2, 3, 4]) {
        const frozenPoint = at(result.points, index, 'fin de semana');
        expect(frozenPoint.frozen).toBe(true);
        expect(frozenPoint.source).toBe('NONE');
        expectRelative(frozenPoint.vwap, 105, 1e-12, 'viernes congelado');
        expectRelative(
          frozenPoint.cumVolume,
          200,
          1e-12,
          'volumen viernes congelado',
        );
      }

      const mondayOpen = at(result.points, 5, 'lunes 09:30');
      expect(mondayOpen.frozen).toBe(false);
      expectRelative(mondayOpen.vwap, 130, 1e-12, 'lunes reinicio');
      expectRelative(mondayOpen.cumVolume, 10, 1e-12, 'volumen lunes');
    });
  });

  describe('Fuente de precio', () => {
    it('EQUITY usa TRADE_VWAP por defecto y CRYPTO usa HLC3 por defecto', () => {
      const equityResult = computeSessionVwap(
        [
          {
            time: JUL15_0930,
            open: 100,
            high: 110,
            low: 90,
            close: 95,
            volume: 10,
            vw: 105,
          },
        ],
        EQUITY_5M,
      );
      const equityPoint = at(equityResult.points, 0, 'equity default');
      expect(equityPoint.source).toBe('VW');
      expectRelative(equityPoint.vwap, 105, 1e-12, 'equity default vwap');

      const cryptoResult = computeSessionVwap(
        [
          {
            time: utcSeconds(2025, 1, 1, 0, 0),
            open: 100,
            high: 110,
            low: 90,
            close: 95,
            volume: 10,
            vw: 105,
          },
        ],
        CRYPTO_15M,
      );
      const cryptoPoint = at(cryptoResult.points, 0, 'crypto default');
      expect(cryptoPoint.source).toBe('HLC3');
      expectRelative(
        cryptoPoint.vwap,
        (110 + 90 + 95) / 3,
        1e-12,
        'crypto default vwap',
      );
    });

    it('vw ausente, 0 o NaN cae a HLC3 solo en esa barra', () => {
      const bars: Bar[] = [
        makeBar(JUL15_0930, 100, 10, 100),
        {
          time: JUL15_0930 + 300,
          open: 105,
          high: 110,
          low: 100,
          close: 105,
          volume: 10,
        },
        {
          time: JUL15_0930 + 600,
          open: 115,
          high: 120,
          low: 110,
          close: 115,
          volume: 10,
          vw: 0,
        },
        {
          time: JUL15_0930 + 900,
          open: 125,
          high: 130,
          low: 120,
          close: 125,
          volume: 10,
          vw: Number.NaN,
        },
        makeBar(JUL15_0930 + 1200, 140, 10, 140),
      ];

      const result = computeSessionVwap(bars, EQUITY_5M);
      const expectedSources: SessionVwapSource[] = [
        'VW',
        'HLC3',
        'HLC3',
        'HLC3',
        'VW',
      ];
      const expectedVwaps = [100, 102.5, 320 / 3, 111.25, 117];
      const expectedCumVolumes = [10, 20, 30, 40, 50];

      for (let index = 0; index < expectedSources.length; index++) {
        const point = at(result.points, index, 'fallback');
        expect(point.source).toBe(at(expectedSources, index, 'sources'));
        expectRelative(
          point.vwap,
          at(expectedVwaps, index, 'vwaps'),
          1e-12,
          `fallback vwap ${index.toString()}`,
        );
        expectRelative(
          point.cumVolume,
          at(expectedCumVolumes, index, 'volumes'),
          1e-12,
          `fallback cumVolume ${index.toString()}`,
        );
      }
    });

    it('si el precio resultante no es finito, Welford ignora la barra', () => {
      const bars: Bar[] = [
        makeBar(JUL15_0930, 100, 10, 100),
        {
          time: JUL15_0930 + 300,
          open: 100,
          high: Number.NaN,
          low: Number.NaN,
          close: Number.NaN,
          volume: 10,
        },
      ];
      const result = computeSessionVwap(bars, EQUITY_5M);
      const point = at(result.points, 1, 'precio no finito');

      expect(point.frozen).toBe(false);
      expect(point.source).toBe('HLC3');
      expectRelative(point.vwap, 100, 1e-12, 'vwap sin acumular');
      expectRelative(point.cumVolume, 10, 1e-12, 'volumen sin acumular');
    });
  });

  describe('Cripto', () => {
    it('cripto reinicia a las 00:00 UTC y no congela', () => {
      const bars: Bar[] = [
        makeBar(utcSeconds(2025, 1, 1, 23, 45), 100, 10, 999),
        makeBar(utcSeconds(2025, 1, 2, 0, 0), 200, 10, 999),
        makeBar(utcSeconds(2025, 1, 2, 0, 15), 210, 10, 999),
      ];
      const result = computeSessionVwap(bars, CRYPTO_15M);

      const beforeMidnight = at(result.points, 0, '23:45');
      const atMidnight = at(result.points, 1, '00:00');
      const afterMidnight = at(result.points, 2, '00:15');

      expect(beforeMidnight.frozen).toBe(false);
      expect(beforeMidnight.source).toBe('HLC3');
      expectRelative(beforeMidnight.vwap, 100, 1e-12, 'vwap 23:45');

      expect(atMidnight.frozen).toBe(false);
      expect(atMidnight.source).toBe('HLC3');
      expectRelative(atMidnight.vwap, 200, 1e-12, 'vwap 00:00');
      expectRelative(atMidnight.cumVolume, 10, 1e-12, 'volumen 00:00');

      expect(afterMidnight.frozen).toBe(false);
      expectRelative(afterMidnight.vwap, 205, 1e-12, 'vwap 00:15');
      expectRelative(afterMidnight.cumVolume, 20, 1e-12, 'volumen 00:15');
    });
  });

  describe('Inmutabilidad', () => {
    it('las barras con Object.freeze quedan idénticas tras computeSessionVwap', () => {
      const bars = Object.freeze([
        Object.freeze(makeBar(JUL15_0930, 100, 100, 100)),
        Object.freeze(makeBar(JUL15_1555, 110, 100, 110)),
        Object.freeze(makeBar(JUL15_1600, 999, 999, 999)),
      ]);
      const before = JSON.stringify(bars);

      const result = computeSessionVwap(bars, EQUITY_5M);

      expect(JSON.stringify(bars)).toBe(before);
      expect(result.points).toHaveLength(bars.length);
    });

    it('el estado con Object.freeze queda idéntico tras updateSessionVwap', () => {
      const previous = computeSessionVwap(july15SessionBars(), EQUITY_5M);
      const state = deepFreeze<SessionVwapState>({
        welford: { ...previous.state.welford },
        sessionKey: previous.state.sessionKey,
        lastTime: previous.state.lastTime,
        last:
          previous.state.last === null
            ? null
            : { ...previous.state.last },
      });
      const snapshot = JSON.stringify(state);

      const step = updateSessionVwap(
        state,
        makeBar(JUL15_1600, 999, 999, 999),
        EQUITY_5M,
      );

      expect(JSON.stringify(state)).toBe(snapshot);
      expect(step.state).not.toBe(state);
      expect(step.point.frozen).toBe(true);
    });
  });

  describe('Proyección en vivo', () => {
    const closedBars: readonly Bar[] = [
      makeBar(JUL15_0930, 100, 100, 100),
      makeBar(JUL15_1550, 110, 200, 110),
    ];

    it('100 ticks desde el MISMO closedState; el último coincide con la barra completa', () => {
      const closed = computeSessionVwap(closedBars, EQUITY_5M);
      const closedState = closed.state;
      const snapshot = JSON.stringify(closedState);
      const projections: SessionVwapPoint[] = [];

      for (let tick = 1; tick <= 100; tick++) {
        const point = projectLiveSessionVwap(
          closedState,
          makeFormingBar(JUL15_1555, tick * 10, 120 + tick * 0.05),
          EQUITY_5M,
        );
        projections.push(point);
      }

      expect(JSON.stringify(closedState)).toBe(snapshot);
      for (let index = 0; index < projections.length; index++) {
        const point = at(projections, index, 'ticks');
        expect(point.frozen).toBe(false);
        expect(point.source).toBe('VW');
        expectRelative(
          point.cumVolume,
          300 + (index + 1) * 10,
          1e-12,
          `tick cumVolume ${index.toString()}`,
        );
      }

      const lastProjection = at(
        projections,
        projections.length - 1,
        'último tick',
      );
      const completedBar = makeFormingBar(JUL15_1555, 1000, 125);
      const completed = computeSessionVwap(
        [...closedBars, completedBar],
        EQUITY_5M,
      );
      const lastCompleted = at(
        completed.points,
        completed.points.length - 1,
        'barra completa',
      );

      expect(lastProjection.time).toBe(lastCompleted.time);
      expect(lastProjection.frozen).toBe(lastCompleted.frozen);
      expect(lastProjection.source).toBe(lastCompleted.source);
      expectRelative(
        lastProjection.vwap,
        lastCompleted.vwap,
        1e-12,
        'proyección final vwap',
      );
      expectRelative(
        lastProjection.cumVolume,
        lastCompleted.cumVolume,
        1e-12,
        'proyección final cumVolume',
      );
    });

    it('encadenar el estado de cada tick NO da lo mismo que proyectar desde closedState', () => {
      const closed = computeSessionVwap(closedBars, EQUITY_5M);
      const direct = projectLiveSessionVwap(
        closed.state,
        makeFormingBar(JUL15_1555, 1000, 125),
        EQUITY_5M,
      );

      let chainedState = closed.state;
      let chainedPoint: SessionVwapPoint | null = null;

      for (let tick = 1; tick <= 100; tick++) {
        // Los tiempos crecen solo para satisfacer la validación de orden.
        // El error que se demuestra es reutilizar el estado de cada tick.
        const step = updateSessionVwap(
          chainedState,
          makeFormingBar(JUL15_1555 + tick, tick * 10, 120 + tick * 0.05),
          EQUITY_5M,
        );
        chainedState = step.state;
        chainedPoint = step.point;
      }

      if (chainedPoint === null) {
        throw new Error('La cadena de ticks no produjo ningún punto');
      }

      expectRelative(direct.cumVolume, 1300, 1e-12, 'directo cumVolume');
      expect(chainedPoint.cumVolume).toBe(50800);
      expect(chainedPoint.cumVolume).not.toBe(direct.cumVolume);

      const difference =
        Math.abs(chainedPoint.vwap - direct.vwap) / Math.abs(direct.vwap);
      expect(difference).toBeGreaterThan(1e-6);
    });
  });

  describe('Rendimiento', () => {
    it('mide 4.000 barras y una proyección en vivo sin aserción de tiempo', () => {
      const bars: Bar[] = [];
      const start = utcSeconds(2025, 1, 2, 14, 30);

      for (let index = 0; index < 4000; index++) {
        const price = 100 + (index % 50) * 0.1;
        bars.push(
          makeBar(
            start + index * 300,
            price,
            1000 + (index % 100),
            price,
          ),
        );
      }

      const computeStart = performance.now();
      const result = computeSessionVwap(bars, EQUITY_5M);
      const computeElapsed = performance.now() - computeStart;

      const lastBar = at(bars, bars.length - 1, 'última barra');
      const formingTime = lastBar.time + 300;

      const projectionStart = performance.now();
      const point = projectLiveSessionVwap(
        result.state,
        makeBar(formingTime, 150, 500, 150),
        EQUITY_5M,
      );
      const projectionElapsed = performance.now() - projectionStart;

      console.log(
        `[Session VWAP Performance] 4.000 barras en ${computeElapsed.toFixed(3)} ms; proyección en vivo en ${projectionElapsed.toFixed(4)} ms`,
      );

      expect(result.points).toHaveLength(4000);
      expect(point.time).toBe(formingTime);
      expect(Number.isFinite(point.cumVolume)).toBe(true);
    });
  });

  describe('Validación de la serie', () => {
    it('rechaza tiempos no crecientes en updateSessionVwap', () => {
      const first = makeBar(JUL15_0930 + 300, 100, 10, 100);
      const second = makeBar(JUL15_0930, 100, 10, 100);

      expect(() =>
        computeSessionVwap([first, second], EQUITY_5M),
      ).toThrow();
      expect(() =>
        updateSessionVwap(
          createInitialSessionVwapState(),
          makeBar(JUL15_0930 * 1000, 100, 10, 100),
          EQUITY_5M,
        ),
      ).toThrow();
    });
  });
});

function decodeNumber(value: FixtureScalar): number {
  return value === 'NaN' ? Number.NaN : value;
}

function decodeBar(raw: FixtureBar): Bar {
  const bar: Bar = {
    time: raw.time,
    open: raw.open,
    high: raw.high,
    low: raw.low,
    close: raw.close,
    volume: decodeNumber(raw.volume),
  };

  if (raw.vw === undefined || raw.vw === null) {
    return bar;
  }
  return { ...bar, vw: decodeNumber(raw.vw) };
}

function decodeOptions(raw: FixtureOptions): SessionVwapOptions {
  if (raw.priceSource === undefined) {
    return { market: raw.market, barSeconds: raw.barSeconds };
  }
  return {
    market: raw.market,
    barSeconds: raw.barSeconds,
    priceSource: raw.priceSource,
  };
}

function getFixtureCase(name: string): FixtureCase {
  const value = fixture.cases[name];
  if (value === undefined) {
    throw new Error(`Caso de fixture no encontrado: ${name}`);
  }
  return value;
}

function at<T>(values: readonly T[], index: number, context: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`${context}: índice fuera de límites ${index.toString()}`);
  }
  return value;
}

function relativeDifference(actual: number, expected: number): number {
  if (Number.isNaN(expected)) {
    return Number.isNaN(actual) ? 0 : Number.POSITIVE_INFINITY;
  }
  if (Number.isNaN(actual)) {
    return Number.POSITIVE_INFINITY;
  }
  if (actual === expected) {
    return 0;
  }
  const denominator = Math.abs(expected);
  if (denominator === 0) {
    return Math.abs(actual);
  }
  return Math.abs(actual - expected) / denominator;
}

function expectRelative(
  actual: number,
  expected: number,
  tolerance: number,
  context: string,
): number {
  if (Number.isNaN(expected)) {
    expect(
      Number.isNaN(actual),
      `${context}: expected NaN, got ${String(actual)}`,
    ).toBe(true);
    return 0;
  }

  expect(
    Number.isNaN(actual),
    `${context}: expected ${String(expected)}, got NaN`,
  ).toBe(false);

  if (expected === 0) {
    expect(actual, `${context}: expected 0, got ${String(actual)}`).toBe(0);
    return 0;
  }

  const difference = Math.abs(actual - expected) / Math.abs(expected);
  expect(
    difference,
    `${context}: actual=${String(actual)}, expected=${String(expected)}`,
  ).toBeLessThanOrEqual(tolerance);
  return difference;
}

function utcSeconds(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

const JUL11_0930 = utcSeconds(2025, 7, 11, 13, 30);
const JUL11_1555 = utcSeconds(2025, 7, 11, 19, 55);
const JUL12_1200 = utcSeconds(2025, 7, 12, 16, 0);
const JUL13_1200 = utcSeconds(2025, 7, 13, 16, 0);
const JUL14_0400 = utcSeconds(2025, 7, 14, 8, 0);
const JUL14_0930 = utcSeconds(2025, 7, 14, 13, 30);
const JUL15_0930 = utcSeconds(2025, 7, 15, 13, 30);
const JUL15_1550 = utcSeconds(2025, 7, 15, 19, 50);
const JUL15_1555 = utcSeconds(2025, 7, 15, 19, 55);
const JUL15_1600 = utcSeconds(2025, 7, 15, 20, 0);
const JUL15_1955 = utcSeconds(2025, 7, 15, 23, 55);
const JUL15_1959 = utcSeconds(2025, 7, 15, 23, 59);
const JUL16_0400 = utcSeconds(2025, 7, 16, 8, 0);
const JUL16_0930 = utcSeconds(2025, 7, 16, 13, 30);

function july15SessionBars(): readonly Bar[] {
  return [
    makeBar(JUL15_0930, 100, 100, 100),
    makeBar(JUL15_1555, 110, 100, 110),
  ];
}

function makeBar(
  time: number,
  price: number,
  volume: number,
  vw?: number,
): Bar {
  const bar: Bar = {
    time,
    open: price,
    high: price,
    low: price,
    close: price,
    volume,
  };
  if (vw === undefined) {
    return bar;
  }
  return { ...bar, vw };
}

function makeFormingBar(
  time: number,
  cumulativeVolume: number,
  cumulativeVw: number,
): Bar {
  return {
    time,
    open: cumulativeVw,
    high: cumulativeVw,
    low: cumulativeVw,
    close: cumulativeVw,
    volume: cumulativeVolume,
    vw: cumulativeVw,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
