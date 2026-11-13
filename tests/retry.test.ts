import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseRetryAfterSeconds,
  retryDelayMs,
} from '../src/data/retry.js';

interface FixtureParseCase {
  readonly id: string;
  readonly value: string | null;
  readonly now_ms: number;
  readonly expected: number | null;
}

interface FixtureDelayCase {
  readonly id: string;
  readonly attempt: number;
  readonly retry_after_seconds: number | null;
  readonly base_delay_ms: number;
  readonly max_delay_ms: number;
  readonly expected: number;
}

interface RetryFixture {
  readonly parse_cases: readonly FixtureParseCase[];
  readonly delay_cases: readonly FixtureDelayCase[];
}

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'fixtures/retry_reference.json'),
    'utf-8',
  ),
) as RetryFixture;

describe('ritmo y reintento: referencia independiente (fixture de Python)', () => {
  describe('parseRetryAfterSeconds', () => {
    for (const c of fixture.parse_cases) {
      it(c.id, () => {
        const actual = parseRetryAfterSeconds(c.value, c.now_ms);
        if (c.expected === null) {
          expect(actual).toBeNull();
          return;
        }
        expect(actual).not.toBeNull();
        expect(Math.abs((actual ?? 0) - c.expected)).toBeLessThanOrEqual(1e-9);
      });
    }
  });

  describe('retryDelayMs', () => {
    for (const c of fixture.delay_cases) {
      it(c.id, () => {
        const actual = retryDelayMs({
          attempt: c.attempt,
          retryAfterSeconds: c.retry_after_seconds,
          baseDelayMs: c.base_delay_ms,
          maxDelayMs: c.max_delay_ms,
        });
        expect(Math.abs(actual - c.expected)).toBeLessThanOrEqual(1e-9);
      });
    }
  });
});
