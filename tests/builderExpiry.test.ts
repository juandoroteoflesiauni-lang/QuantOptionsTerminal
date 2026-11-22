import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

interface BuilderLegInput {
  readonly side: 'Compra' | 'Venta';
  readonly type: 'Call' | 'Put' | 'Subyacente';
  readonly strike: number;
  readonly qty: number;
  readonly premium: number;
}

interface ExpiryBounds {
  readonly maxGain: number | null;
  readonly maxLoss: number | null;
  readonly unlimitedGain: boolean;
  readonly unlimitedLoss: boolean;
}

interface ExpiryCase extends ExpiryBounds {
  readonly name: string;
  readonly spot: number;
  readonly legs: readonly BuilderLegInput[];
}

type BuilderLeg = BuilderLegInput & { id: string; iv: number; delta: number; theta: number };
interface BuilderApi {
  readonly computeBuilderAnalytics: (
    legs: readonly BuilderLeg[], simSpot: number, simDaysLeft: number, simIvShiftPts: number,
    simTlrPct: number, baseSpot: number, baseDays: number, rows: readonly never[],
  ) => ExpiryBounds;
}

const specifier = '../web/src/components/options/optionsDerived';
const { computeBuilderAnalytics } = (await import(/* @vite-ignore */ specifier)) as BuilderApi;
const cases = JSON.parse(readFileSync(new URL('../fixtures/builder_expiry_reference.json', import.meta.url), 'utf8')) as ExpiryCase[];

it.each(cases)('calcula los extremos al vencimiento de $name', ({ spot, legs, ...expected }) => {
  const position = legs.map((leg, i) => ({ ...leg, id: String(i), iv: 20, delta: 0.5, theta: 0 }));
  const result = computeBuilderAnalytics(position, spot, 30, 0, 0, spot, 30, []);
  expect(result.unlimitedGain).toBe(expected.unlimitedGain);
  expect(result.unlimitedLoss).toBe(expected.unlimitedLoss);
  for (const key of ['maxGain', 'maxLoss'] as const) {
    const bound = expected[key];
    if (bound === null) {
      expect(result[key]).toBeNaN();
    } else {
      const actual = result[key];
      expect(actual).not.toBeNull();
      expect(Math.abs(Number(actual) - bound)).toBeLessThanOrEqual(1e-9);
    }
  }
});

it('deja los extremos sin calcular si falta la prima', () => {
  const result = computeBuilderAnalytics(
    [{ id: 'sin-prima', side: 'Venta', type: 'Call', strike: 100, qty: 1, premium: NaN, iv: 20, delta: 0.5, theta: 0 }],
    100, 30, 0, 0, 100, 30, [],
  );
  expect(result.maxGain).toBeNaN();
  expect(result.maxLoss).toBeNaN();
  expect(result.unlimitedGain).toBe(false);
  expect(result.unlimitedLoss).toBe(false);
});
