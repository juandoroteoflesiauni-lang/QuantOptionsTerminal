import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  calculateAnchoredVwap,
  computeAnchoredVwap,
  createInitialAvwapState,
  projectLiveAvwap,
  resolveAnchorIndex,
  updateAvwap,
  type AvwapAnchor,
  type AvwapPoint,
  type AvwapState,
} from '../src/core/avwap.js';
import type { Market } from '../src/core/sessions.js';
import type { Bar } from '../src/core/types.js';

type FixtureScalar = number | 'NaN' | 'Infinity' | '-Infinity';

type FixtureBarTuple = [
  number,
  FixtureScalar,
  FixtureScalar,
  FixtureScalar,
  FixtureScalar,
  FixtureScalar,
];

type FixturePointTuple = [
  number,
  FixtureScalar,
  FixtureScalar,
  FixtureScalar,
  FixtureScalar,
  FixtureScalar,
  FixtureScalar,
  FixtureScalar,
  FixtureScalar,
  FixtureScalar,
];

interface FixtureAnchorResult {
  anchor: AvwapAnchor;
  visibleStart: number;
  anchorIndex: number;
  points: FixturePointTuple[];
}

interface FixtureCase {
  description: string;
  market: Market;
  bars: FixtureBarTuple[];
  anchors: FixtureAnchorResult[];
}

interface FixtureAnchorCase {
  description: string;
  market: Market;
  anchor: AvwapAnchor;
  visibleStart: number;
  bars: FixtureBarTuple[];
  expectedAnchorIndex: number;
}

interface FixtureErrorCase {
  description: string;
  market: Market;
  anchor: AvwapAnchor;
  visibleStart: number;
  bars: FixtureBarTuple[];
}

interface FixtureFile {
  metadata: {
    generator: string;
    command: string;
    method: string;
    tolerance: string;
    barOrder: string[];
    pointOrder: string[];
    nanEncoding: string;
    seeds: Record<string, number>;
  };
  cases: Record<string, FixtureCase>;
  anchorCases: Record<string, FixtureAnchorCase>;
  errorCases: Record<string, FixtureErrorCase>;
}

const fixturePath = resolve(process.cwd(), 'fixtures/avwap_reference.json');
const fixtureContent = readFileSync(fixturePath, 'utf-8');
const fixture = JSON.parse(fixtureContent) as FixtureFile;

const ALL_ANCHORS: readonly AvwapAnchor[] = [
  'SESSION',
  'WEEK',
  'MONTH',
  'YTD',
  'HIGH_VOLUME_BAR',
  'FULL_HISTORY',
];

let maxVwapDifference = 0;
let maxStdDevDifference = 0;
let maxCumVolumeDifference = 0;
let maxBandDifference = 0;

describe('AVWAP anclado (SPEC puntos 5 y 9)', () => {
  describe('Referencia independiente (fixtures)', () => {
    for (const [caseName, caseData] of Object.entries(fixture.cases)) {
      for (const anchorData of caseData.anchors) {
        const label =
          `${caseName} ${anchorData.anchor}` +
          ` visibleStart=${anchorData.visibleStart.toString()}`;

        it(`verifica contra fixture independiente: ${label}`, () => {
          const bars = caseData.bars.map(decodeBar);
          const result = computeAnchoredVwap(bars, anchorData.anchor, {
            market: caseData.market,
            visibleStart: anchorData.visibleStart,
          });

          expect(result.anchorIndex, `${label} anchorIndex`).toBe(
            anchorData.anchorIndex,
          );
          expect(result.points, `${label} points length`).toHaveLength(
            anchorData.points.length,
          );

          for (let index = 0; index < anchorData.points.length; index++) {
            const actual = result.points[index];
            const expected = anchorData.points[index];
            if (actual === undefined || expected === undefined) {
              throw new Error(
                `${label}: índice fuera de límites ${index.toString()}`,
              );
            }

            const context = `${label}[${index.toString()}]`;

            expect(actual.time, `${context} time`).toBe(expected[0]);

            const vwapDifference = relativeDifference(
              actual.vwap,
              decodeNumber(expected[1]),
            );
            maxVwapDifference = Math.max(
              maxVwapDifference,
              vwapDifference,
            );
            expect(vwapDifference, `${context} vwap`).toBeLessThanOrEqual(
              1e-9,
            );

            const stdDevDifference = relativeDifference(
              actual.stdDev,
              decodeNumber(expected[2]),
            );
            maxStdDevDifference = Math.max(
              maxStdDevDifference,
              stdDevDifference,
            );
            expect(
              stdDevDifference,
              `${context} stdDev`,
            ).toBeLessThanOrEqual(1e-9);

            const cumVolumeDifference = relativeDifference(
              actual.cumVolume,
              decodeNumber(expected[3]),
            );
            maxCumVolumeDifference = Math.max(
              maxCumVolumeDifference,
              cumVolumeDifference,
            );
            expect(
              cumVolumeDifference,
              `${context} cumVolume`,
            ).toBeLessThanOrEqual(1e-9);

            const actualBands = [
              actual.upper1,
              actual.lower1,
              actual.upper2,
              actual.lower2,
              actual.upper2_5,
              actual.lower2_5,
            ];
            const expectedBands = [
              decodeNumber(expected[4]),
              decodeNumber(expected[5]),
              decodeNumber(expected[6]),
              decodeNumber(expected[7]),
              decodeNumber(expected[8]),
              decodeNumber(expected[9]),
            ];

            for (
              let bandIndex = 0;
              bandIndex < actualBands.length;
              bandIndex++
            ) {
              const actualBand = actualBands[bandIndex];
              const expectedBand = expectedBands[bandIndex];
              if (actualBand === undefined || expectedBand === undefined) {
                throw new Error(`${context}: banda fuera de límites`);
              }
              const bandDifference = relativeDifference(
                actualBand,
                expectedBand,
              );
              maxBandDifference = Math.max(maxBandDifference, bandDifference);
              expect(
                bandDifference,
                `${context} banda ${bandIndex.toString()}`,
              ).toBeLessThanOrEqual(1e-9);
            }
          }
        });
      }
    }

    it('reporta la máxima diferencia relativa observada contra el fixture', () => {
      console.log(
        `[AVWAP Fixture Reference] Max relative difference -> vwap: ` +
          `${maxVwapDifference.toExponential(4)}, stdDev: ` +
          `${maxStdDevDifference.toExponential(4)}, cumVolume: ` +
          `${maxCumVolumeDifference.toExponential(4)}, bands: ` +
          maxBandDifference.toExponential(4),
      );
      expect(maxVwapDifference).toBeLessThanOrEqual(1e-9);
      expect(maxStdDevDifference).toBeLessThanOrEqual(1e-9);
      expect(maxCumVolumeDifference).toBeLessThanOrEqual(1e-9);
      expect(maxBandDifference).toBeLessThanOrEqual(1e-9);
    });
  });

  describe('Casos del ancla (fixtures)', () => {
    for (const [caseName, caseData] of Object.entries(
      fixture.anchorCases,
    )) {
      it(`resuelve ${caseName} (${caseData.description})`, () => {
        const bars = caseData.bars.map(decodeBar);
        const options = {
          market: caseData.market,
          visibleStart: caseData.visibleStart,
        };

        expect(
          resolveAnchorIndex(bars, caseData.anchor, options),
          `${caseName} anchorIndex`,
        ).toBe(caseData.expectedAnchorIndex);

        const result = computeAnchoredVwap(
          bars,
          caseData.anchor,
          options,
        );
        expect(result.anchorIndex, `${caseName} compute anchorIndex`).toBe(
          caseData.expectedAnchorIndex,
        );
        if (caseData.expectedAnchorIndex < 0) {
          expect(result.points).toEqual([]);
        } else {
          expect(result.points.length).toBeGreaterThan(0);
        }
      });
    }

    it('rechaza los casos de error del fixture', () => {
      for (const [caseName, caseData] of Object.entries(
        fixture.errorCases,
      )) {
        const bars = caseData.bars.map(decodeBar);
        const options = {
          market: caseData.market,
          visibleStart: caseData.visibleStart,
        };

        expect(
          () => computeAnchoredVwap(bars, caseData.anchor, options),
          `${caseName} compute`,
        ).toThrow();
        expect(
          () => resolveAnchorIndex(bars, caseData.anchor, options),
          `${caseName} resolve`,
        ).toThrow();
      }
    });

    it('devuelve -1 para array vacío con cualquier ancla', () => {
      for (const anchor of ALL_ANCHORS) {
        expect(
          resolveAnchorIndex([], anchor, { market: 'EQUITY' }),
          anchor,
        ).toBe(-1);
      }
    });

    it('devuelve -1 para visibleStart inválido', () => {
      const bars = getCaseBars('a_equity_5m_dst');
      const invalidVisibleStarts = [
        -1,
        bars.length,
        2.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ];

      for (const visibleStart of invalidVisibleStarts) {
        for (const anchor of ALL_ANCHORS) {
          expect(
            resolveAnchorIndex(bars, anchor, {
              market: 'EQUITY',
              visibleStart,
            }),
            `${anchor} visibleStart=${String(visibleStart)}`,
          ).toBe(-1);
        }
      }
    });
  });

  describe('Ancla inválida en calculateAnchoredVwap', () => {
    it('devuelve [] con -1, largo, 2.5 y NaN', () => {
      const bars = getCaseBars('a_equity_5m_dst');
      const invalidAnchorIndices = [
        -1,
        bars.length,
        2.5,
        Number.NaN,
      ];

      for (const anchorIndex of invalidAnchorIndices) {
        expect(
          calculateAnchoredVwap(bars, anchorIndex),
          String(anchorIndex),
        ).toEqual([]);
      }
    });
  });

  describe('Invariancia con visibleStart', () => {
    it('HIGH_VOLUME_BAR y FULL_HISTORY no dependen de barras previas', () => {
      const bars = getCaseBars('a_equity_5m_dst');
      const visibleStart = Math.floor(bars.length / 3);
      const visibleBars = bars.slice(visibleStart);

      for (const anchor of [
        'HIGH_VOLUME_BAR',
        'FULL_HISTORY',
      ] as const) {
        const withPrefix = computeAnchoredVwap(bars, anchor, {
          market: 'EQUITY',
          visibleStart,
        });
        const withoutPrefix = computeAnchoredVwap(visibleBars, anchor, {
          market: 'EQUITY',
        });

        if (anchor === 'FULL_HISTORY') {
          expect(withPrefix.anchorIndex).toBe(visibleStart);
          expect(withoutPrefix.anchorIndex).toBe(0);
        } else {
          expect(withoutPrefix.anchorIndex).toBeGreaterThanOrEqual(0);
          expect(withPrefix.anchorIndex).toBe(
            visibleStart + withoutPrefix.anchorIndex,
          );
        }

        expect(withPrefix.points, anchor).toEqual(withoutPrefix.points);
      }
    });
  });

  describe('Bandas', () => {
    it('usa el mismo stdDev para ±1, ±2 y ±2.5 sin recalcular', () => {
      const bars = getCaseBars('a_equity_5m_dst');
      const result = computeAnchoredVwap(bars, 'FULL_HISTORY', {
        market: 'EQUITY',
      });

      expect(result.points.length).toBeGreaterThan(0);
      let sawPositiveStdDev = false;

      for (const point of result.points) {
        if (point.stdDev > 0) {
          sawPositiveStdDev = true;
        }

        expect(point.upper1).toBe(point.vwap + point.stdDev);
        expect(point.lower1).toBe(point.vwap - point.stdDev);
        expect(point.upper2).toBe(point.vwap + 2 * point.stdDev);
        expect(point.lower2).toBe(point.vwap - 2 * point.stdDev);
        expect(point.upper2_5).toBe(point.vwap + 2.5 * point.stdDev);
        expect(point.lower2_5).toBe(point.vwap - 2.5 * point.stdDev);

        expectBandSymmetry(point, point.upper1, point.lower1, '1');
        expectBandSymmetry(point, point.upper2, point.lower2, '2');
        expectBandSymmetry(point, point.upper2_5, point.lower2_5, '2.5');
      }

      expect(sawPositiveStdDev).toBe(true);
    });
  });

  describe('Inmutabilidad', () => {
    it('no muta barras con Object.freeze', () => {
      const sourceBars = getCaseBars('a_equity_5m_dst').slice(0, 200);
      const bars = Object.freeze(
        sourceBars.map((bar) => Object.freeze({ ...bar })),
      );
      const snapshot = JSON.stringify(bars);

      const result = computeAnchoredVwap(bars, 'FULL_HISTORY', {
        market: 'EQUITY',
      });

      expect(JSON.stringify(bars)).toBe(snapshot);
      expect(result.points).toHaveLength(200);
    });

    it('no muta el estado con Object.freeze', () => {
      const bars = getCaseBars('a_equity_5m_dst').slice(0, 50);
      const previous = computeAnchoredVwap(bars, 'FULL_HISTORY', {
        market: 'EQUITY',
      });
      const state = deepFreeze<AvwapState>({
        welford: { ...previous.state.welford },
      });
      const snapshot = JSON.stringify(state);
      const lastBar = at(bars, bars.length - 1, 'última barra');

      const step = updateAvwap(
        state,
        makeHlcBar(lastBar.time + 300, 120, 500),
      );

      expect(JSON.stringify(state)).toBe(snapshot);
      expect(step.state).not.toBe(state);
      expect(step.state.welford).not.toBe(state.welford);
      expect(step.point).not.toBeNull();
    });
  });

  describe('Proyección en vivo', () => {
    const closedBars: readonly Bar[] = [
      makeHlcBar(utcSeconds(2025, 3, 12, 13, 30), 100, 10),
      makeHlcBar(utcSeconds(2025, 3, 12, 13, 35), 110, 20),
    ];
    const formingTime = utcSeconds(2025, 3, 12, 13, 40);

    it('100 ticks desde el MISMO closedState; el último coincide con la barra completa', () => {
      const closed = computeAnchoredVwap(closedBars, 'FULL_HISTORY', {
        market: 'EQUITY',
      });
      const closedState = closed.state;
      const snapshot = JSON.stringify(closedState);
      const projections: AvwapPoint[] = [];

      for (let tick = 1; tick <= 100; tick++) {
        const price = 120 + tick * 0.05;
        const point = projectLiveAvwap(
          closedState,
          makeHlcBar(formingTime, price, tick * 10),
        );
        if (point === null) {
          throw new Error(`El tick ${tick.toString()} no produjo punto`);
        }
        projections.push(point);
      }

      expect(JSON.stringify(closedState)).toBe(snapshot);

      for (let index = 0; index < projections.length; index++) {
        const point = at(projections, index, 'proyecciones');
        const expectedCumVolume = 30 + (index + 1) * 10;
        expectRelative(
          point.cumVolume,
          expectedCumVolume,
          1e-12,
          `tick cumVolume ${index.toString()}`,
        );
      }

      const lastProjection = at(
        projections,
        projections.length - 1,
        'última proyección',
      );
      const completedBar = makeHlcBar(formingTime, 125, 1000);
      const completed = computeAnchoredVwap(
        [...closedBars, completedBar],
        'FULL_HISTORY',
        { market: 'EQUITY' },
      );
      const lastCompleted = at(
        completed.points,
        completed.points.length - 1,
        'barra completa',
      );

      expectPointClose(
        lastProjection,
        lastCompleted,
        1e-12,
        'proyección final',
      );
    });

    it('encadenar el estado de cada tick NO da lo mismo que proyectar desde closedState', () => {
      const closed = computeAnchoredVwap(closedBars, 'FULL_HISTORY', {
        market: 'EQUITY',
      });
      const direct = projectLiveAvwap(
        closed.state,
        makeHlcBar(formingTime, 125, 1000),
      );
      if (direct === null) {
        throw new Error('La proyección directa no produjo punto');
      }

      let chainedState = closed.state;
      let chainedPoint: AvwapPoint | null = null;

      for (let tick = 1; tick <= 100; tick++) {
        const step = updateAvwap(
          chainedState,
          makeHlcBar(
            formingTime + tick,
            120 + tick * 0.05,
            tick * 10,
          ),
        );
        chainedState = step.state;
        chainedPoint = step.point;
      }

      if (chainedPoint === null) {
        throw new Error('La cadena de ticks no produjo punto');
      }

      expect(chainedPoint.cumVolume).not.toBe(direct.cumVolume);
      expect(chainedPoint.cumVolume).toBeGreaterThan(direct.cumVolume);

      const difference =
        Math.abs(chainedPoint.vwap - direct.vwap) / Math.abs(direct.vwap);
      expect(difference).toBeGreaterThan(1e-6);
    });
  });

  describe('Rendimiento', () => {
    it('mide 4.000 barras y una proyección en vivo con 500 y 5.000 barras previas', () => {
      const bars = makePerformanceBars(4000);
      const computeStart = performance.now();
      const result = computeAnchoredVwap(bars, 'FULL_HISTORY', {
        market: 'CRYPTO',
      });
      const computeElapsed = performance.now() - computeStart;

      const state500 = buildClosedState(makePerformanceBars(500));
      const state5000 = buildClosedState(makePerformanceBars(5000));
      const formingBar = makeHlcBar(
        utcSeconds(2025, 1, 1, 0, 0) + 5000 * 900 + 900,
        60_000,
        1_000,
      );

      const projection500Micros = measureProjection(
        state500,
        formingBar,
      );
      const projection5000Micros = measureProjection(
        state5000,
        formingBar,
      );

      console.log(
        `[AVWAP Performance] 4.000 barras en ` +
          `${computeElapsed.toFixed(3)} ms; proyección en vivo: ` +
          `${projection500Micros.toFixed(4)} µs/call con 500 barras y ` +
          `${projection5000Micros.toFixed(4)} µs/call con 5.000 barras`,
      );

      expect(result.points).toHaveLength(4000);
      expect(Number.isFinite(projection500Micros)).toBe(true);
      expect(Number.isFinite(projection5000Micros)).toBe(true);
    });
  });
});

type NumericPointKey = Exclude<keyof AvwapPoint, 'time'>;

const NUMERIC_POINT_KEYS: readonly NumericPointKey[] = [
  'vwap',
  'stdDev',
  'cumVolume',
  'upper1',
  'lower1',
  'upper2',
  'lower2',
  'upper2_5',
  'lower2_5',
];

function decodeNumber(value: FixtureScalar): number {
  switch (value) {
    case 'NaN':
      return Number.NaN;
    case 'Infinity':
      return Number.POSITIVE_INFINITY;
    case '-Infinity':
      return Number.NEGATIVE_INFINITY;
    default:
      return value;
  }
}

function decodeBar(raw: FixtureBarTuple): Bar {
  return {
    time: raw[0],
    open: decodeNumber(raw[1]),
    high: decodeNumber(raw[2]),
    low: decodeNumber(raw[3]),
    close: decodeNumber(raw[4]),
    volume: decodeNumber(raw[5]),
  };
}

function getCaseBars(name: string): Bar[] {
  const caseData = fixture.cases[name];
  if (caseData === undefined) {
    throw new Error(`Caso de fixture no encontrado: ${name}`);
  }
  return caseData.bars.map(decodeBar);
}

function at<T>(values: readonly T[], index: number, context: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(
      `${context}: índice fuera de límites ${index.toString()}`,
    );
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
): void {
  if (Number.isNaN(expected)) {
    expect(
      Number.isNaN(actual),
      `${context}: expected NaN, got ${String(actual)}`,
    ).toBe(true);
    return;
  }

  expect(
    Number.isNaN(actual),
    `${context}: expected ${String(expected)}, got NaN`,
  ).toBe(false);

  if (expected === 0) {
    expect(actual, `${context}: expected 0, got ${String(actual)}`).toBe(0);
    return;
  }

  const difference = Math.abs(actual - expected) / Math.abs(expected);
  expect(
    difference,
    `${context}: actual=${String(actual)}, expected=${String(expected)}`,
  ).toBeLessThanOrEqual(tolerance);
}

function expectPointClose(
  actual: AvwapPoint,
  expected: AvwapPoint,
  tolerance: number,
  context: string,
): void {
  expect(actual.time, `${context} time`).toBe(expected.time);
  for (const key of NUMERIC_POINT_KEYS) {
    expectRelative(actual[key], expected[key], tolerance, `${context} ${key}`);
  }
}

function expectBandSymmetry(
  point: AvwapPoint,
  upper: number,
  lower: number,
  label: string,
): void {
  const upperDistance = upper - point.vwap;
  const lowerDistance = point.vwap - lower;
  const scale = Math.max(
    1,
    Math.abs(upperDistance),
    Math.abs(lowerDistance),
  );

  expect(
    Math.abs(upperDistance - lowerDistance) / scale,
    `simetría ±${label}`,
  ).toBeLessThanOrEqual(1e-12);
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

function makeHlcBar(time: number, price: number, volume: number): Bar {
  return {
    time,
    open: price,
    high: price,
    low: price,
    close: price,
    volume,
  };
}

function makePerformanceBars(count: number): Bar[] {
  const bars: Bar[] = [];
  const start = utcSeconds(2025, 1, 1, 0, 0);

  for (let index = 0; index < count; index++) {
    const price = 60_000 + (index % 100) * 0.25;
    bars.push(
      makeHlcBar(
        start + index * 900,
        price,
        1_000 + (index % 500),
      ),
    );
  }

  return bars;
}

function buildClosedState(bars: readonly Bar[]): AvwapState {
  let state = createInitialAvwapState();
  for (const bar of bars) {
    state = updateAvwap(state, bar).state;
  }
  return state;
}

function measureProjection(
  closedState: AvwapState,
  formingBar: Bar,
): number {
  const iterations = 50_000;
  let last: AvwapPoint | null = null;

  // Calentamiento para que la primera llamada no sesgue la medida.
  last = projectLiveAvwap(closedState, formingBar);

  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    last = projectLiveAvwap(closedState, formingBar);
  }
  const elapsed = performance.now() - start;

  if (last === null) {
    throw new Error('La proyección de rendimiento no produjo punto');
  }
  expect(Number.isFinite(last.cumVolume)).toBe(true);

  return (elapsed / iterations) * 1000;
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
