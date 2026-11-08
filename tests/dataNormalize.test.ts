import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeBingxKlines } from '../src/data/normalizeBingx.js';
import { normalizeMassiveAggs } from '../src/data/normalizeMassive.js';
import type {
  BaseNormalizeReport,
  BingxNormalizeReport,
  DataProvider,
  DiscardCause,
  MassiveNormalizeReport,
  NormalizeOptions,
} from '../src/data/types.js';

interface FixtureBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vw?: number;
}

interface FixtureDiscard {
  cause: DiscardCause;
  time: number | null;
}

interface FixtureGap {
  previousTime: number;
  nextTime: number;
  diffSeconds: number;
  missingBars: number;
  sessionKey: string;
}

interface FixtureFormingBar {
  time: number;
  reason: 'intervalContainsNow' | 'closeTimeContainsServerTime';
}

interface FixtureProviderError {
  code: number;
  message: string;
}

interface FixtureBaseReport {
  provider: DataProvider;
  received: number;
  accepted: number;
  discarded: number;
  discardCounts: Record<DiscardCause, number>;
  discards: FixtureDiscard[];
  reordered: boolean;
  gaps: FixtureGap[];
  gapDetection: 'performed' | 'skippedDaily';
  formingBar: FixtureFormingBar | null;
  malformedResponse: boolean;
  providerError: FixtureProviderError | null;
}

interface FixtureMassiveReport extends FixtureBaseReport {
  provider: 'massive';
  vwMissing: number;
  vwZero: number;
  vwNonFinite: number;
  vwOutsideRange: number;
}

interface FixtureBingxReport extends FixtureBaseReport {
  provider: 'bingx';
  vwCandidateBars: number;
  vwCandidateMissing: number;
  vwCandidateZeroVolume: number;
  vwCandidateOutsideRange: number;
  vwExposed: false;
}

interface FixtureOptions {
  barSeconds: number;
  now?: number;
}

interface FixtureCase<TReport> {
  description: string;
  options: FixtureOptions;
  raw: unknown;
  bars: FixtureBar[];
  report: TReport;
}

interface FixtureFile {
  metadata: {
    generator: string;
    command: string;
    method: string;
    tolerance: string;
    discardOrder: DiscardCause[];
    nonFiniteEncoding: string;
    bingxVwDecision: string;
  };
  normalizers: {
    massive: { cases: Record<string, FixtureCase<FixtureMassiveReport>> };
    bingx: { cases: Record<string, FixtureCase<FixtureBingxReport>> };
  };
}

interface SamplePage {
  body: unknown;
}

interface SampleScenario {
  pages: SamplePage[];
}

interface SampleFile {
  scenarios: Record<string, SampleScenario>;
}

const fixturePath = resolve(
  process.cwd(),
  'fixtures/data_layer_reference.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile;

const samplesPath = resolve(process.cwd(), 'fixtures/samples');

function decodeOptions(raw: FixtureOptions): NormalizeOptions {
  if (raw.now === undefined) {
    return { barSeconds: raw.barSeconds };
  }
  return { barSeconds: raw.barSeconds, now: raw.now };
}

function at<T>(values: readonly T[], index: number, context: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`${context}: índice fuera de límites ${index.toString()}`);
  }
  return value;
}

function expectBarsEqual(
  actual: readonly FixtureBar[],
  expected: readonly FixtureBar[],
  context: string,
): void {
  expect(actual.length, `${context} length`).toBe(expected.length);
  for (let index = 0; index < expected.length; index++) {
    const actualBar = at(actual, index, context);
    const expectedBar = at(expected, index, context);
    const barContext = `${context}[${index.toString()}]`;

    expect(actualBar.time, `${barContext} time`).toBe(expectedBar.time);
    expect(actualBar.open, `${barContext} open`).toBe(expectedBar.open);
    expect(actualBar.high, `${barContext} high`).toBe(expectedBar.high);
    expect(actualBar.low, `${barContext} low`).toBe(expectedBar.low);
    expect(actualBar.close, `${barContext} close`).toBe(expectedBar.close);
    expect(actualBar.volume, `${barContext} volume`).toBe(expectedBar.volume);

    const expectedHasVw = Object.hasOwn(expectedBar, 'vw');
    const actualHasVw = Object.hasOwn(actualBar, 'vw');
    expect(actualHasVw, `${barContext} vw presence`).toBe(expectedHasVw);
    if (expectedHasVw) {
      expect(actualBar.vw, `${barContext} vw`).toBe(expectedBar.vw);
    }
  }
}

function expectBaseReport(
  actual: BaseNormalizeReport<DataProvider>,
  expected: FixtureBaseReport,
  context: string,
): void {
  expect(actual.provider, `${context} provider`).toBe(expected.provider);
  expect(actual.received, `${context} received`).toBe(expected.received);
  expect(actual.accepted, `${context} accepted`).toBe(expected.accepted);
  expect(actual.discarded, `${context} discarded`).toBe(expected.discarded);
  expect(actual.discardCounts, `${context} discardCounts`).toEqual(
    expected.discardCounts,
  );
  expect(actual.discards, `${context} discards`).toEqual(expected.discards);
  expect(actual.reordered, `${context} reordered`).toBe(expected.reordered);
  expect(actual.gaps, `${context} gaps`).toEqual(expected.gaps);
  expect(actual.gapDetection, `${context} gapDetection`).toBe(
    expected.gapDetection,
  );
  expect(actual.formingBar, `${context} formingBar`).toEqual(
    expected.formingBar,
  );
  expect(actual.malformedResponse, `${context} malformedResponse`).toBe(
    expected.malformedResponse,
  );
  expect(actual.providerError, `${context} providerError`).toEqual(
    expected.providerError,
  );
}

function expectMassiveReport(
  actual: MassiveNormalizeReport,
  expected: FixtureMassiveReport,
  context: string,
): void {
  expectBaseReport(actual, expected, context);
  expect(actual.vwMissing, `${context} vwMissing`).toBe(expected.vwMissing);
  expect(actual.vwZero, `${context} vwZero`).toBe(expected.vwZero);
  expect(actual.vwNonFinite, `${context} vwNonFinite`).toBe(
    expected.vwNonFinite,
  );
  expect(actual.vwOutsideRange, `${context} vwOutsideRange`).toBe(
    expected.vwOutsideRange,
  );
}

function expectBingxReport(
  actual: BingxNormalizeReport,
  expected: FixtureBingxReport,
  context: string,
): void {
  expectBaseReport(actual, expected, context);
  expect(actual.vwCandidateBars, `${context} vwCandidateBars`).toBe(
    expected.vwCandidateBars,
  );
  expect(actual.vwCandidateMissing, `${context} vwCandidateMissing`).toBe(
    expected.vwCandidateMissing,
  );
  expect(
    actual.vwCandidateZeroVolume,
    `${context} vwCandidateZeroVolume`,
  ).toBe(expected.vwCandidateZeroVolume);
  expect(
    actual.vwCandidateOutsideRange,
    `${context} vwCandidateOutsideRange`,
  ).toBe(expected.vwCandidateOutsideRange);
  expect(actual.vwExposed, `${context} vwExposed`).toBe(false);
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

function readSample(name: string): SampleFile {
  return JSON.parse(
    readFileSync(resolve(samplesPath, name), 'utf-8'),
  ) as SampleFile;
}

function mergeMassiveRows(sample: SampleFile, scenario: string): unknown[] {
  const rows: unknown[] = [];
  for (const page of sample.scenarios[scenario]?.pages ?? []) {
    const body = page.body;
    if (
      typeof body === 'object' &&
      body !== null &&
      Array.isArray((body as Record<string, unknown>)['results'])
    ) {
      rows.push(...((body as Record<string, unknown>)['results'] as unknown[]));
    }
  }
  return rows;
}

function mergeBingxRows(sample: SampleFile, scenario: string): unknown[] {
  const rows: unknown[] = [];
  for (const page of sample.scenarios[scenario]?.pages ?? []) {
    const body = page.body;
    if (
      typeof body === 'object' &&
      body !== null &&
      Array.isArray((body as Record<string, unknown>)['data'])
    ) {
      rows.push(...((body as Record<string, unknown>)['data'] as unknown[]));
    }
  }
  return rows;
}

describe('Capa de datos: normalizadores (SPEC punto 6)', () => {
  describe('Referencia independiente (fixtures)', () => {
    for (const [caseName, caseData] of Object.entries(
      fixture.normalizers.massive.cases,
    )) {
      it(`Massive: ${caseName} (${caseData.description})`, () => {
        const raw = deepFreeze(structuredClone(caseData.raw));
        const snapshot = JSON.stringify(raw);
        const result = normalizeMassiveAggs(raw, decodeOptions(caseData.options));

        expect(JSON.stringify(raw), `${caseName} raw mutado`).toBe(snapshot);
        expectBarsEqual(result.bars, caseData.bars, caseName);
        expectMassiveReport(result.report, caseData.report, caseName);
      });
    }

    for (const [caseName, caseData] of Object.entries(
      fixture.normalizers.bingx.cases,
    )) {
      it(`BingX: ${caseName} (${caseData.description})`, () => {
        const raw = deepFreeze(structuredClone(caseData.raw));
        const snapshot = JSON.stringify(raw);
        const result = normalizeBingxKlines(raw, decodeOptions(caseData.options));

        expect(JSON.stringify(raw), `${caseName} raw mutado`).toBe(snapshot);
        expectBarsEqual(result.bars, caseData.bars, caseName);
        expectBingxReport(result.report, caseData.report, caseName);
      });
    }
  });

  describe('Evidencia de las muestras reales', () => {
    it('Massive SPY 1m: 922 barras, 38 minutos ausentes y 104 vw fuera de rango', () => {
      const sample = readSample('SPY_1m_2026-11-06.json');
      const rows = mergeMassiveRows(sample, 'day');
      const result = normalizeMassiveAggs(
        { status: 'OK', results: rows },
        { barSeconds: 60, now: 1_794_093_240 },
      );

      expect(result.bars).toHaveLength(922);
      expect(result.report.received).toBe(922);
      expect(result.report.accepted).toBe(922);
      expect(result.report.discarded).toBe(0);
      expect(result.report.reordered).toBe(false);
      expect(result.report.gaps).toHaveLength(23);
      expect(
        result.report.gaps.reduce(
          (sum, gap) => sum + gap.missingBars,
          0,
        ),
      ).toBe(38);
      expect(result.report.vwMissing).toBe(0);
      expect(result.report.vwZero).toBe(0);
      expect(result.report.vwNonFinite).toBe(0);
      expect(result.report.vwOutsideRange).toBe(104);
      expect(result.report.formingBar).toBeNull();

      expect(at(result.bars, 0, 'primera').time).toBe(1_793_955_600);
      expect(at(result.bars, result.bars.length - 1, 'última').time).toBe(
        1_794_013_140,
      );
      for (let index = 1; index < result.bars.length; index++) {
        expect(
          at(result.bars, index, 'orden').time,
          `orden ${index.toString()}`,
        ).toBeGreaterThan(at(result.bars, index - 1, 'orden').time);
      }
    });

    it('Massive SPY 1D: gapDetection=skippedDaily', () => {
      const sample = readSample('SPY_1D_2026-11-06.json');
      const rows = mergeMassiveRows(sample, 'day');
      const result = normalizeMassiveAggs(
        { status: 'OK', results: rows },
        { barSeconds: 86_400, now: 1_794_093_240 },
      );

      expect(result.bars).toHaveLength(30);
      expect(result.report.gapDetection).toBe('skippedDaily');
      expect(result.report.gaps).toHaveLength(0);
    });

    it('BingX BTC-USDT 1m: 1.440 barras, 10 candidatos fuera y vw nunca expuesto', () => {
      const sample = readSample('BTC-USDT_1m_2026-11-06.json');
      const rows = mergeBingxRows(sample, 'day');
      const result = normalizeBingxKlines(
        { code: 0, timestamp: 1_794_081_077_996, data: rows },
        { barSeconds: 60, now: 1_794_081_077 },
      );

      expect(result.bars).toHaveLength(1_440);
      expect(result.report.received).toBe(1_440);
      expect(result.report.accepted).toBe(1_440);
      expect(result.report.discarded).toBe(0);
      expect(result.report.reordered).toBe(true);
      expect(result.report.vwCandidateBars).toBe(1_440);
      expect(result.report.vwCandidateMissing).toBe(0);
      expect(result.report.vwCandidateZeroVolume).toBe(0);
      expect(result.report.vwCandidateOutsideRange).toBe(10);
      expect(result.report.vwExposed).toBe(false);

      for (const bar of result.bars) {
        expect(Object.hasOwn(bar, 'vw')).toBe(false);
      }
      expect(at(result.bars, 0, 'primera').time).toBe(1_793_923_200);
      expect(at(result.bars, result.bars.length - 1, 'última').time).toBe(
        1_794_009_540,
      );
    });

    it('BingX BTC-USDT 5m: 0 candidatos fuera, pero vw sigue sin exponerse', () => {
      const sample = readSample('BTC-USDT_5m_2026-11-06.json');
      const rows = mergeBingxRows(sample, 'day');
      const result = normalizeBingxKlines(
        { code: 0, timestamp: 1_794_081_077_996, data: rows },
        { barSeconds: 300, now: 1_794_081_077 },
      );

      expect(result.bars).toHaveLength(288);
      expect(result.report.vwCandidateOutsideRange).toBe(0);
      expect(result.report.vwExposed).toBe(false);
      for (const bar of result.bars) {
        expect(Object.hasOwn(bar, 'vw')).toBe(false);
      }
    });
  });

  describe('Validación de opciones', () => {
    it('rechaza barSeconds no entero o no positivo', () => {
      for (const barSeconds of [0, -60, 1.5, Number.NaN]) {
        expect(() =>
          normalizeMassiveAggs({ status: 'OK', results: [] }, { barSeconds }),
        ).toThrow();
        expect(() =>
          normalizeBingxKlines({ code: 0, data: [] }, { barSeconds }),
        ).toThrow();
      }
    });

    it('rechaza now no entero o no finito', () => {
      for (const now of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          normalizeMassiveAggs(
            { status: 'OK', results: [] },
            { barSeconds: 60, now },
          ),
        ).toThrow();
        expect(() =>
          normalizeBingxKlines(
            { code: 0, data: [] },
            { barSeconds: 60, now },
          ),
        ).toThrow();
      }
    });
  });

  describe('Estadísticas del candidato VWAP de BingX', () => {
    it('reporta el candidato fuera de rango sin exponer vw', () => {
      const result = normalizeBingxKlines(
        {
          code: 0,
          data: [
            [1_794_000_000_000, 100, 110, 90, 100, 2, 1_794_000_059_999, 200],
            [1_794_000_060_000, 100, 110, 90, 100, 2, 1_794_000_119_999, 178],
            [1_794_000_120_000, 100, 110, 90, 100, 2, 1_794_000_179_999, 222],
          ],
        },
        { barSeconds: 60 },
      );

      expect(result.report.vwCandidateBars).toBe(3);
      expect(result.report.vwCandidateOutsideRange).toBe(2);
      expect(result.report.vwExposed).toBe(false);
      for (const bar of result.bars) {
        expect(Object.hasOwn(bar, 'vw')).toBe(false);
      }
    });
  });
});
