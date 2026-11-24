import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  advanceSessionVwapCheckpoint,
  buildSessionVwapCheckpoint,
  projectLiveSessionVwap,
  projectLiveSessionVwapFromCheckpoint,
  type LiveChartBar,
} from '../src/core/realtimePropagation.js';
import { computeEmaSeries, computeSessionVwapSeries, computeAnchoredVwapSeries, computeVolumeProfile } from '../src/core/ggal/technicalIndicators.js';

interface VwapFixture {
  readonly cases: readonly {
    readonly name: string;
    readonly marketTz: string;
    readonly closedBars: readonly LiveChartBar[];
    readonly steps: readonly {
      readonly closedBarsCount: number;
      readonly formingBar: LiveChartBar;
      readonly expectedVwap: number | null;
    }[];
  }[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(resolve(HERE, '../fixtures/perf1_session_vwap_checkpoint.json'), 'utf8'),
) as VwapFixture;

describe('Perf-1 — O(1) Session VWAP checkpoint and zero-copy indicators equivalence', () => {
  it('matches independent Python fixture within 1e-9 and matches full O(N) projectLiveSessionVwap within 1e-12', () => {
    for (const tc of FIXTURE.cases) {
      const firstStep = tc.steps[0];
      expect(firstStep, tc.name).toBeDefined();
      if (firstStep === undefined) continue;
      let checkpoint = buildSessionVwapCheckpoint(
        tc.closedBars.slice(0, firstStep.closedBarsCount),
        tc.marketTz,
      );
      let prevClosedCount = firstStep.closedBarsCount;

      for (const step of tc.steps) {
        while (prevClosedCount < step.closedBarsCount) {
          const justClosed = tc.closedBars[prevClosedCount];
          if (justClosed !== undefined) {
            checkpoint = advanceSessionVwapCheckpoint(checkpoint, justClosed, tc.marketTz);
          }
          prevClosedCount += 1;
        }
        const ckptRes = projectLiveSessionVwapFromCheckpoint(checkpoint, step.formingBar, tc.marketTz);
        const fullRes = projectLiveSessionVwap(
          tc.closedBars.slice(0, step.closedBarsCount),
          step.formingBar,
          tc.marketTz,
        );
        if (step.expectedVwap === null) {
          expect(ckptRes, tc.name).toBeNull();
          expect(fullRes, tc.name).toBeNull();
        } else {
          expect(ckptRes, tc.name).not.toBeNull();
          expect(fullRes, tc.name).not.toBeNull();
          if (ckptRes === null || fullRes === null) continue;
          expect(ckptRes.timeSec).toBe(step.formingBar.timeSec);
          expect(Math.abs(ckptRes.value - step.expectedVwap)).toBeLessThanOrEqual(1e-9);
          expect(Math.abs(ckptRes.value - fullRes.value)).toBeLessThanOrEqual(1e-12);
        }
      }
    }
  });

  it('handles NaN, zero volume forming bar, session rollover without checkpoint advance, and pre-sorted/unsorted GGAL indicators', () => {
    const startSec = Date.UTC(2025, 4, 5, 13, 30, 0) / 1_000;
    const closed: LiveChartBar[] = [
      { timeSec: startSec, open: 100, high: 102, low: 99, close: 101, volume: 1_000 },
      { timeSec: startSec + 300, open: 101, high: 103, low: 100, close: 102, volume: 0 },
    ];
    const ckpt = buildSessionVwapCheckpoint(closed, 'America/New_York');
    expect(
      projectLiveSessionVwapFromCheckpoint(ckpt, {
        timeSec: startSec + 600,
        open: 102,
        high: 103,
        low: 101,
        close: Number.NaN,
        volume: 500,
      }, 'America/New_York'),
    ).toBeNull();
    expect(
      projectLiveSessionVwapFromCheckpoint(ckpt, {
        timeSec: startSec + 600,
        open: 102,
        high: 103,
        low: 101,
        close: 102,
        volume: 0,
      }, 'America/New_York'),
    ).toBeNull();

    // Presorted vs unsorted GGAL indicators yield identical results without mutating frozen inputs
    const frozenBars = Array.from({ length: 30 }, (_, idx) =>
      Object.freeze({
        timeSec: startSec + idx * 300,
        open: 100 + idx * 0.2,
        high: 101 + idx * 0.2,
        low: 99 + idx * 0.2,
        close: 100.5 + idx * 0.2,
        volume: 500 + idx * 10,
      }),
    );
    const reversedFrozen = [...frozenBars].reverse();
    expect(computeEmaSeries(frozenBars, 9)).toEqual(computeEmaSeries(reversedFrozen, 9));
    expect(computeSessionVwapSeries(frozenBars, 'America/New_York')).toEqual(
      computeSessionVwapSeries(reversedFrozen, 'America/New_York'),
    );
    expect(computeAnchoredVwapSeries(frozenBars, startSec + 900)).toEqual(
      computeAnchoredVwapSeries(reversedFrozen, startSec + 900),
    );
    expect(computeVolumeProfile(frozenBars, 12, 'America/New_York')).toEqual(
      computeVolumeProfile(reversedFrozen, 12, 'America/New_York'),
    );
  });
});
