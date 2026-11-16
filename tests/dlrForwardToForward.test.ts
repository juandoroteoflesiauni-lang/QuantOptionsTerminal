import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeForwardToForwardPct } from '../src/server/primaryRofexLoader.js';

interface ForwardToForwardFixtureCase {
  readonly id: string;
  readonly input: {
    readonly nearDays: number;
    readonly nearPrice: number | null;
    readonly farDays: number;
    readonly farPrice: number | null;
  };
  readonly expected: number | null;
}

interface ForwardToForwardFixture {
  readonly schemaVersion: number;
  readonly forwardToForwardCases: readonly ForwardToForwardFixtureCase[];
}

function loadReferenceFixture(): ForwardToForwardFixture {
  const raw = readFileSync(
    resolve(process.cwd(), 'fixtures/dlr_forward_to_forward_reference.json'),
    'utf8',
  );
  return JSON.parse(raw) as ForwardToForwardFixture;
}

function expectCloseOrNaN(actual: number, expected: number | null, tol = 1e-9): void {
  if (expected === null) {
    expect(Number.isNaN(actual)).toBe(true);
    return;
  }
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

describe('DLR forward-to-forward continuo anualizado (Primary ROFEX)', () => {
  it('valida paridad exacta (< 1e-9) contra fixtures/dlr_forward_to_forward_reference.json sin mutar entradas', () => {
    const fixture = loadReferenceFixture();
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.forwardToForwardCases.length).toBeGreaterThan(0);

    for (const c of fixture.forwardToForwardCases) {
      const inputSnapshot = JSON.stringify(c.input);
      const actual = computeForwardToForwardPct({
        nearDays: c.input.nearDays,
        nearPrice: c.input.nearPrice ?? Number.NaN,
        farDays: c.input.farDays,
        farPrice: c.input.farPrice ?? Number.NaN,
      });
      expect(JSON.stringify(c.input), c.id).toBe(inputSnapshot);
      expectCloseOrNaN(actual, c.expected);
    }
  });

  it('devuelve NaN ante días o precios no finitos, y no lanza', () => {
    const cases: readonly {
      readonly nearDays: number;
      readonly nearPrice: number;
      readonly farDays: number;
      readonly farPrice: number;
    }[] = [
      { nearDays: Number.NaN, nearPrice: 1562.5, farDays: 46, farPrice: 1595.5 },
      { nearDays: 16, nearPrice: Number.POSITIVE_INFINITY, farDays: 46, farPrice: 1595.5 },
      { nearDays: 16, nearPrice: 1562.5, farDays: Number.NaN, farPrice: 1595.5 },
      { nearDays: 16, nearPrice: 1562.5, farDays: 46, farPrice: Number.NaN },
    ];
    for (const input of cases) {
      expect(Number.isNaN(computeForwardToForwardPct(input))).toBe(true);
    }
  });
});
