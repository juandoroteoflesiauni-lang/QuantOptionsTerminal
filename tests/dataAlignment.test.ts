import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alignDown } from '../src/data/alignment.js';
import type { DataProvider, Timeframe } from '../src/data/types.js';

interface FixtureAlignmentCase {
  description: string;
  provider: DataProvider;
  timeframe: Timeframe;
  time: number;
  expected: number;
}

interface FixtureFile {
  alignment: { cases: Record<string, FixtureAlignmentCase> };
}

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'fixtures/data_layer_reference.json'),
    'utf-8',
  ),
) as FixtureFile;

describe('alignDown: referencia independiente', () => {
  for (const [name, testCase] of Object.entries(
    fixture.alignment.cases,
  )) {
    it(`${name} (${testCase.description})`, () => {
      const aligned = alignDown(
        testCase.time,
        testCase.timeframe,
        testCase.provider,
      );

      expect(aligned).toBe(testCase.expected);
      // Nunca sube.
      expect(aligned).toBeLessThanOrEqual(testCase.time);
      // Idempotente: el resultado ya es un límite de barra.
      expect(
        alignDown(aligned, testCase.timeframe, testCase.provider),
      ).toBe(aligned);
    });
  }

  it('rechaza tiempos no enteros o no finitos', () => {
    for (const time of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => alignDown(time, '1m', 'massive')).toThrow();
      expect(() => alignDown(time, '4h', 'bingx')).toThrow();
    }
  });
});
