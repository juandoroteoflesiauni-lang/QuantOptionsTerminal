import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateMacroVolatilityRegime,
  evaluateMarketBreadth,
} from '../src/core/microstructure/breadthMacro.js';
import { analyzeCvdAndAbsorption } from '../src/core/microstructure/cvdAbsorption.js';
import {
  detectRsiDivergences,
  detectSmtDivergences,
} from '../src/core/microstructure/divergences.js';
import { evaluateMtfStructure } from '../src/core/microstructure/mtfStructure.js';
import { evaluateOpeningAuction } from '../src/core/microstructure/openingAuction.js';
import type { CvdBar } from '../src/core/microstructure/cvdAbsorption.js';
import { computeDealerExposure, type ExposureContractInput } from '../src/core/options/exposure.js';
import { computeSliceVolMetrics } from '../src/core/options/volMetrics.js';
import { buildVolSlice, type VolQuoteInput } from '../src/core/options/volSurface.js';
import { MAX_TIME_SECONDS } from '../src/core/sessions.js';
import {
  DEFAULT_AD_SLOPE_WINDOW,
  DEFAULT_PILLAR_WEIGHTS,
  evaluateTerminalConfluence,
  PILLAR_IDS,
} from '../src/core/terminal/confluenceOrchestrator.js';
import {
  computeIntradayRealizedVol,
  computeVrpSpread,
  INTRADAY_5M_ANNUALIZATION_FACTOR,
  INTRADAY_5M_BAR_SECONDS,
} from '../src/core/terminal/realizedVol.js';
import {
  assertJsonSafeSerialized,
  serializeTerminalSnapshot,
} from '../src/core/terminal/serializer.js';
import type {
  IntradayRealizedVolResult,
  SerializedMetadata,
  TerminalConfluenceInputs,
  TerminalConfluenceSnapshot,
  TerminalSerializedEnvelope,
} from '../src/core/terminal/types.js';
import type { Bar } from '../src/core/types.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(THIS_DIR, '../fixtures/terminal_confluence_reference.json');

const PRECISION_LIMIT = 1e-12;

interface PrecisionTracker {
  scalarsChecked: number;
  maxAbsDiff: number;
  maxRelDiff: number;
}

const tracker: PrecisionTracker = {
  scalarsChecked: 0,
  maxAbsDiff: 0,
  maxRelDiff: 0,
};

function recordNumericComparison(actual: number, expected: number | null, label: string): void {
  tracker.scalarsChecked += 1;
  if (expected === null) {
    expect(Number.isNaN(actual), `${label}: expected NaN, got ${String(actual)}`).toBe(true);
    return;
  }
  expect(Number.isFinite(actual), `${label}: expected finite ${String(expected)}, got ${String(actual)}`).toBe(true);
  const absDiff = Math.abs(actual - expected);
  const denom = Math.max(1e-15, Math.abs(expected));
  const relDiff = absDiff / denom;
  if (absDiff > tracker.maxAbsDiff) {
    tracker.maxAbsDiff = absDiff;
  }
  if (relDiff > tracker.maxRelDiff) {
    tracker.maxRelDiff = relDiff;
  }
  expect(
    absDiff <= PRECISION_LIMIT || relDiff <= PRECISION_LIMIT,
    `${label}: actual=${String(actual)} expected=${String(expected)} abs=${String(absDiff)} rel=${String(relDiff)}`,
  ).toBe(true);
}

function recordSerializedNumericComparison(
  actual: number | null,
  expected: number | null,
  label: string,
): void {
  tracker.scalarsChecked += 1;
  if (expected === null) {
    expect(actual, `${label}: expected null, got ${String(actual)}`).toBeNull();
    return;
  }
  if (actual === null) {
    throw new Error(`${label}: expected finite ${String(expected)}, got null`);
  }
  const absDiff = Math.abs(actual - expected);
  const denom = Math.max(1e-15, Math.abs(expected));
  const relDiff = absDiff / denom;
  if (absDiff > tracker.maxAbsDiff) {
    tracker.maxAbsDiff = absDiff;
  }
  if (relDiff > tracker.maxRelDiff) {
    tracker.maxRelDiff = relDiff;
  }
  expect(
    absDiff <= PRECISION_LIMIT || relDiff <= PRECISION_LIMIT,
    `${label}: actual=${String(actual)} expected=${String(expected)}`,
  ).toBe(true);
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

const NULLABLE_INPUT_OBJECT_KEYS = new Set<string>([
  'mtf',
  'exposure',
  'volMetrics',
  'openingAuction',
  'cvdAbsorption',
  'rsiDivergences',
  'smtDivergences',
  'breadth',
  'macroVol',
  'realizedVol',
  'referenceLevels',
  'latestDivergence',
  'currentSessionDate',
  'options',
  'weights',
]);

function decodeNumericNullsToNaN(value: unknown, keyName?: string): unknown {
  if (value === null) {
    if (keyName !== undefined && NULLABLE_INPUT_OBJECT_KEYS.has(keyName)) {
      return null;
    }
    return Number.NaN;
  }
  if (Array.isArray(value)) {
    return value.map((elem) => decodeNumericNullsToNaN(elem));
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec)) {
      out[k] = decodeNumericNullsToNaN(rec[k], k);
    }
    return out;
  }
  return value;
}

interface RawRealizedVolExpected {
  readonly status: 'OK' | 'NO_DATA';
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly annualizationFactor: number;
  readonly closedRthBarCount: number;
  readonly excludedFutureCount: number;
  readonly excludedNonRthCount: number;
  readonly sessionCount: number;
  readonly totalAvailableReturns: number;
  readonly returnsCount: number;
  readonly meanLogReturn: number | null;
  readonly realizedVolAnnualized: number | null;
  readonly rvCenteredAnnualized: number | null;
  readonly sessions: readonly {
    readonly sessionDate: string;
    readonly rthBarCount: number;
    readonly returnsCount: number;
  }[];
}

interface RawConfluenceScenario {
  readonly name: string;
  readonly inputs: Record<string, unknown>;
  readonly metadata: SerializedMetadata;
  readonly expectedSnapshot: {
    readonly status: 'OK' | 'NO_DATA';
    readonly asOfUtcSec: number | null;
    readonly activePillarsCount: number;
    readonly totalPillarsCount: number;
    readonly totalActiveWeight: number;
    readonly confluenceScore: number | null;
    readonly directionalBias: string;
    readonly gammaRegime: string;
    readonly pillars: readonly {
      readonly id: string;
      readonly label: string;
      readonly status: 'OK' | 'NO_DATA';
      readonly score: number | null;
      readonly weight: number;
      readonly weightedContribution: number | null;
      readonly summaryCode: string;
    }[];
    readonly keyLevels: readonly {
      readonly name: string;
      readonly source: string;
      readonly price: number;
    }[];
    readonly metrics: Record<string, number | string | boolean | null>;
  };
  readonly expectedEnvelope: TerminalSerializedEnvelope;
}

interface FixturePayload {
  readonly meta: {
    readonly annualizationFactor5m: number;
    readonly barSeconds5m: number;
  };
  readonly realizedVolMultiSessionDst: {
    readonly bars: readonly Bar[];
    readonly asOfCutoff: number;
    readonly asOfEndDay1BeforeClose: number;
    readonly asOfEndDay1ExactClose: number;
    readonly fullResult: RawRealizedVolExpected;
    readonly rolling77Result: RawRealizedVolExpected;
    readonly beforeCloseDay1Result: RawRealizedVolExpected;
    readonly exactCloseDay1Result: RawRealizedVolExpected;
    readonly flatOvernightResult: RawRealizedVolExpected;
    readonly iv30dSample: number;
    readonly expectedVrpFull: number;
  };
  readonly realizedVolShortage: {
    readonly bars: readonly Bar[];
    readonly asOfUtcSec: number;
    readonly expected: RawRealizedVolExpected;
  };
  readonly realizedVolCorruptedClose: {
    readonly bars: readonly Bar[];
    readonly asOfUtcSec: number;
    readonly expected: RawRealizedVolExpected;
  };
  readonly vrpCases: readonly {
    readonly iv30d: number | null;
    readonly rv: number | null;
    readonly expected: number | null;
  }[];
  readonly confluenceScenarios: readonly RawConfluenceScenario[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixturePayload;

function assertRealizedVolMatches(
  actual: IntradayRealizedVolResult,
  expected: RawRealizedVolExpected,
  label: string,
): void {
  expect(actual.status, `${label}.status`).toBe(expected.status);
  expect(actual.asOfUtcSec, `${label}.asOfUtcSec`).toBe(expected.asOfUtcSec);
  expect(actual.barSeconds, `${label}.barSeconds`).toBe(expected.barSeconds);
  recordNumericComparison(actual.annualizationFactor, expected.annualizationFactor, `${label}.annualizationFactor`);
  expect(actual.closedRthBarCount, `${label}.closedRthBarCount`).toBe(expected.closedRthBarCount);
  expect(actual.excludedFutureCount, `${label}.excludedFutureCount`).toBe(expected.excludedFutureCount);
  expect(actual.excludedNonRthCount, `${label}.excludedNonRthCount`).toBe(expected.excludedNonRthCount);
  expect(actual.sessionCount, `${label}.sessionCount`).toBe(expected.sessionCount);
  expect(actual.totalAvailableReturns, `${label}.totalAvailableReturns`).toBe(expected.totalAvailableReturns);
  expect(actual.returnsCount, `${label}.returnsCount`).toBe(expected.returnsCount);
  expect(actual.sessions, `${label}.sessions`).toEqual(expected.sessions);
  recordNumericComparison(actual.meanLogReturn, expected.meanLogReturn, `${label}.meanLogReturn`);
  recordNumericComparison(actual.realizedVolAnnualized, expected.realizedVolAnnualized, `${label}.realizedVolAnnualized`);
  recordNumericComparison(actual.rvCenteredAnnualized, expected.rvCenteredAnnualized, `${label}.rvCenteredAnnualized`);
}

function assertSnapshotMatches(
  actual: TerminalConfluenceSnapshot,
  expected: RawConfluenceScenario['expectedSnapshot'],
  label: string,
): void {
  expect(actual.status, `${label}.status`).toBe(expected.status);
  expect(actual.asOfUtcSec, `${label}.asOfUtcSec`).toBe(expected.asOfUtcSec);
  expect(actual.activePillarsCount, `${label}.activePillarsCount`).toBe(expected.activePillarsCount);
  expect(actual.totalPillarsCount, `${label}.totalPillarsCount`).toBe(expected.totalPillarsCount);
  recordNumericComparison(actual.totalActiveWeight, expected.totalActiveWeight, `${label}.totalActiveWeight`);
  recordNumericComparison(actual.confluenceScore, expected.confluenceScore, `${label}.confluenceScore`);
  expect(actual.directionalBias, `${label}.directionalBias`).toBe(expected.directionalBias);
  expect(actual.gammaRegime, `${label}.gammaRegime`).toBe(expected.gammaRegime);

  expect(actual.pillars.length, `${label}.pillars.length`).toBe(expected.pillars.length);
  for (let i = 0; i < expected.pillars.length; i += 1) {
    const actP = actual.pillars[i];
    const expP = expected.pillars[i];
    if (actP === undefined || expP === undefined) {
      throw new Error(`${label}: missing pillar index ${String(i)}`);
    }
    expect(actP.id).toBe(expP.id);
    expect(actP.label).toBe(expP.label);
    expect(actP.status).toBe(expP.status);
    expect(actP.summaryCode).toBe(expP.summaryCode);
    recordNumericComparison(actP.weight, expP.weight, `${label}.pillar[${expP.id}].weight`);
    recordNumericComparison(actP.score, expP.score, `${label}.pillar[${expP.id}].score`);
    recordNumericComparison(
      actP.weightedContribution,
      expP.weightedContribution,
      `${label}.pillar[${expP.id}].weightedContribution`,
    );
  }

  expect(actual.keyLevels.length, `${label}.keyLevels.length`).toBe(expected.keyLevels.length);
  for (let i = 0; i < expected.keyLevels.length; i += 1) {
    const actLv = actual.keyLevels[i];
    const expLv = expected.keyLevels[i];
    if (actLv === undefined || expLv === undefined) {
      throw new Error(`${label}: missing keyLevel index ${String(i)}`);
    }
    expect(actLv.name, `${label}.keyLevels[${String(i)}].name`).toBe(expLv.name);
    expect(actLv.source, `${label}.keyLevels[${String(i)}].source`).toBe(expLv.source);
    recordNumericComparison(actLv.price, expLv.price, `${label}.keyLevels[${expLv.name}].price`);
    if (i > 0) {
      const prevLv = actual.keyLevels[i - 1];
      if (prevLv !== undefined) {
        expect(actLv.price >= prevLv.price).toBe(true);
      }
    }
  }

  const numericMetricKeys: readonly (keyof TerminalConfluenceSnapshot['metrics'])[] = [
    'spot',
    'netDollarGex',
    'netDex',
    'gammaFlipSpot',
    'callWallStrike',
    'putWallStrike',
    'expectedMove',
    'expectedMovePct',
    'iv30d',
    'riskReversal25',
    'butterfly25',
    'realizedVolAnnualized',
    'rvCenteredAnnualized',
    'vrpSpread',
    'vixLevel',
    'vixSlope',
    'cboeSkewLevel',
    'positionSizeMultiplier',
    'adLineSlope',
    'latestAdLine',
    'currentSessionCvd',
    'latestRsi',
  ];

  for (const key of numericMetricKeys) {
    const actVal = actual.metrics[key];
    const expVal = expected.metrics[key];
    if (typeof actVal === 'number') {
      recordNumericComparison(
        actVal,
        typeof expVal === 'number' ? expVal : null,
        `${label}.metrics.${key}`,
      );
    }
  }
  expect(actual.metrics.vixRegime).toBe(expected.metrics['vixRegime']);
  expect(actual.metrics.tailRiskAlert).toBe(expected.metrics['tailRiskAlert']);
}

function assertEnvelopeMatches(
  actual: TerminalSerializedEnvelope,
  expected: TerminalSerializedEnvelope,
  label: string,
): void {
  expect(actual.schemaVersion, `${label}.schemaVersion`).toBe(expected.schemaVersion);
  expect(actual.envelopeStatus, `${label}.envelopeStatus`).toBe(expected.envelopeStatus);
  expect(actual.nonFiniteFieldCount, `${label}.nonFiniteFieldCount`).toBe(
    expected.nonFiniteFieldCount,
  );
  expect(actual.nonFinitePaths, `${label}.nonFinitePaths`).toEqual(expected.nonFinitePaths);
  expect(actual.metadata, `${label}.metadata`).toEqual(expected.metadata);

  expect(actual.snapshot.status).toBe(expected.snapshot.status);
  expect(actual.snapshot.asOfUtcSec).toBe(expected.snapshot.asOfUtcSec);
  expect(actual.snapshot.activePillarsCount).toBe(expected.snapshot.activePillarsCount);
  expect(actual.snapshot.directionalBias).toBe(expected.snapshot.directionalBias);
  expect(actual.snapshot.gammaRegime).toBe(expected.snapshot.gammaRegime);
  recordSerializedNumericComparison(
    actual.snapshot.confluenceScore,
    expected.snapshot.confluenceScore,
    `${label}.envelope.confluenceScore`,
  );

  for (let i = 0; i < expected.snapshot.pillars.length; i += 1) {
    const actP = actual.snapshot.pillars[i];
    const expP = expected.snapshot.pillars[i];
    if (actP === undefined || expP === undefined) {
      throw new Error(`${label}: missing envelope pillar ${String(i)}`);
    }
    recordSerializedNumericComparison(actP.score, expP.score, `${label}.env.pillar[${expP.id}].score`);
    recordSerializedNumericComparison(
      actP.weightedContribution,
      expP.weightedContribution,
      `${label}.env.pillar[${expP.id}].weightedContribution`,
    );
  }

  for (const k of Object.keys(expected.snapshot.metrics)) {
    const key = k as keyof TerminalSerializedEnvelope['snapshot']['metrics'];
    const expVal = expected.snapshot.metrics[key];
    const actVal = actual.snapshot.metrics[key];
    if (typeof expVal === 'number' || expVal === null) {
      if (key !== 'tailRiskAlert') {
        recordSerializedNumericComparison(
          actVal as number | null,
          expVal,
          `${label}.env.metrics.${key}`,
        );
      }
    }
  }
}

describe('Pieza 12 — Intraday Realized Vol (5m RTH), VRP, Terminal Confluence & JSON-Safe Serializer', () => {
  it('matches independent Python constants and multi-session DST Realized Vol (< 1e-12)', () => {
    expect(INTRADAY_5M_BAR_SECONDS).toBe(fixture.meta.barSeconds5m);
    expect(DEFAULT_AD_SLOPE_WINDOW).toBe(5);
    expect(PILLAR_IDS.length).toBe(6);
    expect(DEFAULT_PILLAR_WEIGHTS.mtf).toBe(1);
    recordNumericComparison(
      INTRADAY_5M_ANNUALIZATION_FACTOR,
      fixture.meta.annualizationFactor5m,
      'annualizationFactor',
    );

    const rv = fixture.realizedVolMultiSessionDst;
    const frozenBars = deepFreeze(structuredClone(rv.bars));

    const actualFull = computeIntradayRealizedVol(frozenBars, {
      asOfUtcSec: rv.asOfCutoff,
      minReturns: 77,
    });
    assertRealizedVolMatches(actualFull, rv.fullResult, 'rv_multi_full');

    const actualRolling77 = computeIntradayRealizedVol(frozenBars, {
      asOfUtcSec: rv.asOfCutoff,
      minReturns: 77,
      maxReturns: 77,
    });
    assertRealizedVolMatches(actualRolling77, rv.rolling77Result, 'rv_multi_rolling77');

    // Boundary look-ahead: 15:59:59 EST excludes 15:55 bar -> 76 returns -> NO_DATA; 16:00:00 EST -> OK (77 returns)
    const beforeClose = computeIntradayRealizedVol(frozenBars, {
      asOfUtcSec: rv.asOfEndDay1BeforeClose,
      minReturns: 77,
    });
    assertRealizedVolMatches(beforeClose, rv.beforeCloseDay1Result, 'rv_before_close_day1');
    expect(beforeClose.status).toBe('NO_DATA');
    expect(Number.isNaN(beforeClose.realizedVolAnnualized)).toBe(true);

    const exactClose = computeIntradayRealizedVol(frozenBars, {
      asOfUtcSec: rv.asOfEndDay1ExactClose,
      minReturns: 77,
    });
    assertRealizedVolMatches(exactClose, rv.exactCloseDay1Result, 'rv_exact_close_day1');
    expect(exactClose.status).toBe('OK');

    // Overnight jump (+8.5%) exclusion verification: flat overnight series must yield exact same RV!
    const flatOvernightRes = computeIntradayRealizedVol(frozenBars, {
      asOfUtcSec: rv.asOfCutoff,
      minReturns: 77,
    });
    assertRealizedVolMatches(
      flatOvernightRes,
      rv.flatOvernightResult,
      'rv_overnight_jump_invariance',
    );
    expect(
      Math.abs(
        flatOvernightRes.realizedVolAnnualized - (rv.flatOvernightResult.realizedVolAnnualized ?? 0),
      ),
    ).toBeLessThanOrEqual(PRECISION_LIMIT);

    const vrp = computeVrpSpread(rv.iv30dSample, actualFull.realizedVolAnnualized);
    recordNumericComparison(vrp, rv.expectedVrpFull, 'vrp_multi_full');
  });

  it('returns NO_DATA and NaN on insufficient returns, corrupted closes, and invalid VRP inputs', () => {
    const shortRes = computeIntradayRealizedVol(deepFreeze(structuredClone(fixture.realizedVolShortage.bars)), {
      asOfUtcSec: fixture.realizedVolShortage.asOfUtcSec,
      minReturns: 77,
    });
    assertRealizedVolMatches(shortRes, fixture.realizedVolShortage.expected, 'rv_shortage');

    const corruptRes = computeIntradayRealizedVol(
      deepFreeze(structuredClone(fixture.realizedVolCorruptedClose.bars)),
      {
        asOfUtcSec: fixture.realizedVolCorruptedClose.asOfUtcSec,
        minReturns: 50,
      },
    );
    assertRealizedVolMatches(corruptRes, fixture.realizedVolCorruptedClose.expected, 'rv_corrupt');

    for (let i = 0; i < fixture.vrpCases.length; i += 1) {
      const c = fixture.vrpCases[i];
      if (c === undefined) {
        continue;
      }
      const actual = computeVrpSpread(
        c.iv30d ?? Number.NaN,
        c.rv ?? Number.NaN,
      );
      recordNumericComparison(actual, c.expected, `vrpCases[${String(i)}]`);
    }
    expect(Number.isNaN(computeVrpSpread(Number.POSITIVE_INFINITY, 0.2))).toBe(true);
  });

  it('guarantees zero Look-Ahead Bias & strict overnight gap isolation in computeIntradayRealizedVol', () => {
    const rv = fixture.realizedVolMultiSessionDst;
    const baseBars = structuredClone(rv.bars) as Bar[];
    const baseline = computeIntradayRealizedVol(deepFreeze(baseBars), {
      asOfUtcSec: rv.asOfCutoff,
      minReturns: 77,
    });

    // Mutate bars after asOfCutoff with violent +/-50% swings + append future session
    const wildFutureBars: Bar[] = baseBars.map((b, idx) =>
      b.time + 300 > rv.asOfCutoff
        ? {
            ...b,
            close: b.close * (idx % 2 === 0 ? 1.5 : 0.5),
          }
        : b,
    );
    const futureRes = computeIntradayRealizedVol(deepFreeze(wildFutureBars), {
      asOfUtcSec: rv.asOfCutoff,
      minReturns: 77,
    });
    expect(futureRes.realizedVolAnnualized).toBe(baseline.realizedVolAnnualized);
    expect(futureRes.rvCenteredAnnualized).toBe(baseline.rvCenteredAnnualized);
    expect(futureRes.returnsCount).toBe(baseline.returnsCount);

    // Extreme +25% overnight jump between Friday EST close & Monday EDT open leaves RV bit-for-bit identical
    const day2StartUtc = Date.UTC(2025, 2, 10, 0, 0, 0) / 1000;
    const jumpedBars: Bar[] = baseBars.map((b) =>
      b.time >= day2StartUtc
        ? {
            ...b,
            open: b.open * 1.25,
            high: b.high * 1.25,
            low: b.low * 1.25,
            close: b.close * 1.25,
          }
        : b,
    );
    const jumpedRes = computeIntradayRealizedVol(deepFreeze(jumpedBars), {
      asOfUtcSec: rv.asOfCutoff,
      minReturns: 77,
    });
    expect(
      Math.abs(jumpedRes.realizedVolAnnualized - baseline.realizedVolAnnualized),
    ).toBeLessThan(1e-15);
    expect(
      Math.abs(jumpedRes.rvCenteredAnnualized - baseline.rvCenteredAnnualized),
    ).toBeLessThan(1e-15);
  });

  it('matches all 5 independent Python confluence + serialization scenarios (< 1e-12) with deepFreeze', () => {
    for (const scenario of fixture.confluenceScenarios) {
      const decodedInputs = decodeNumericNullsToNaN(
        structuredClone(scenario.inputs),
      ) as TerminalConfluenceInputs;
      const frozenInputs = deepFreeze(decodedInputs);
      const frozenMetadata = deepFreeze(structuredClone(scenario.metadata));

      const snapshot = evaluateTerminalConfluence(frozenInputs);
      assertSnapshotMatches(snapshot, scenario.expectedSnapshot, scenario.name);

      const frozenSnapshot = deepFreeze(snapshot);
      const envelope = serializeTerminalSnapshot(frozenSnapshot, frozenMetadata);
      assertEnvelopeMatches(envelope, scenario.expectedEnvelope, scenario.name);

      const jsonText = assertJsonSafeSerialized(envelope);
      expect(jsonText).not.toMatch(/(?<=[:,[])\s*(?:NaN|-?Infinity|undefined)\b/);
      expect(JSON.parse(jsonText)).toEqual(envelope);
    }

    console.info(
      `[terminalConfluence.test] Fixture precision summary: ${String(tracker.scalarsChecked)} scalars checked, maxAbsDiff=${tracker.maxAbsDiff.toExponential(3)}, maxRelDiff=${tracker.maxRelDiff.toExponential(3)} (limit <= 1e-12)`,
    );
  });

  it('handles empty {} inputs cleanly as NO_DATA without silent numeric fallbacks', () => {
    const emptyInputs = deepFreeze<TerminalConfluenceInputs>({});
    const snapshot = evaluateTerminalConfluence(emptyInputs);

    expect(snapshot.status).toBe('NO_DATA');
    expect(snapshot.asOfUtcSec).toBeNull();
    expect(snapshot.activePillarsCount).toBe(0);
    expect(snapshot.totalPillarsCount).toBe(6);
    expect(snapshot.totalActiveWeight).toBe(0);
    expect(Number.isNaN(snapshot.confluenceScore)).toBe(true);
    expect(snapshot.directionalBias).toBe('NO_DATA');
    expect(snapshot.gammaRegime).toBe('NO_DATA');
    expect(snapshot.keyLevels).toEqual([]);
    expect(snapshot.metrics.vixRegime).toBe('NO_DATA');
    expect(snapshot.metrics.tailRiskAlert).toBeNull();
    expect(Number.isNaN(snapshot.metrics.vrpSpread)).toBe(true);

    const env = serializeTerminalSnapshot(snapshot, {
      symbol: 'SPY',
      generatedAtUtcSec: 1_741_620_000,
    });
    expect(env.envelopeStatus).toBe('NO_DATA');
    expect(env.snapshot.confluenceScore).toBeNull();
    expect(env.snapshot.metrics.spot).toBeNull();
    expect(env.nonFiniteFieldCount).toBeGreaterThan(20);
    assertJsonSafeSerialized(env);
  });

  it('rejects millisecond timestamps, invalid config options, and non-JSON payloads strictly', () => {
    const validTs = Math.floor(Date.UTC(2025, 2, 10, 14, 0, 0) / 1000);
    const msTs = validTs * 1000;
    expect(msTs).toBeGreaterThan(MAX_TIME_SECONDS);

    expect(() =>
      computeIntradayRealizedVol([], { asOfUtcSec: msTs }),
    ).toThrow(/UTC seconds/i);
    expect(() =>
      computeIntradayRealizedVol([{ time: msTs, open: 100, high: 101, low: 99, close: 100, volume: 10 }], {
        asOfUtcSec: validTs,
      }),
    ).toThrow(/UTC seconds/i);
    expect(() =>
      computeIntradayRealizedVol([], { asOfUtcSec: validTs, barSeconds: 60 }),
    ).toThrow(/300/);
    expect(() =>
      computeIntradayRealizedVol([], { asOfUtcSec: validTs, minReturns: 80, maxReturns: 50 }),
    ).toThrow(/maxReturns/);

    expect(() =>
      evaluateTerminalConfluence({
        options: { asOfUtcSec: msTs },
      }),
    ).toThrow(/UTC seconds/i);
    expect(() =>
      evaluateTerminalConfluence({
        options: { weights: { mtf: -0.5 } },
      }),
    ).toThrow(/weights\.mtf/);

    const emptySnap = evaluateTerminalConfluence({});
    expect(() =>
      serializeTerminalSnapshot(emptySnap, { symbol: '   ', generatedAtUtcSec: validTs }),
    ).toThrow(/symbol/);
    expect(() =>
      serializeTerminalSnapshot(emptySnap, { symbol: 'SPY', generatedAtUtcSec: msTs }),
    ).toThrow(/UTC seconds/);

    expect(() => assertJsonSafeSerialized({ bad: Number.NaN })).toThrow(/Non-finite/);
    expect(() => assertJsonSafeSerialized({ arr: [1, Number.POSITIVE_INFINITY] })).toThrow(
      /Non-finite/,
    );
    expect(() => assertJsonSafeSerialized({ undef: undefined })).toThrow(/Non-JSON/);
  });

  it('wires real outputs from Piezas 5, 6, 9, 10, 11 & RV cleanly end-to-end into JSON-safe envelope', () => {
    const start1d = Math.floor(Date.UTC(2024, 0, 2, 14, 30, 0) / 1000);
    const bars1d: Bar[] = Array.from({ length: 220 }, (_, i) => {
      const c = 450 + i * 0.65 + Math.sin(i * 0.25) * 1.2;
      return {
        time: start1d + i * 86_400,
        open: c - 0.5,
        high: c + 1.5,
        low: c - 1.2,
        close: c,
        volume: 50_000_000 + i * 10_000,
      };
    });

    const start4h = Math.floor(Date.UTC(2025, 1, 10, 14, 30, 0) / 1000);
    const bars4h: Bar[] = Array.from({ length: 70 }, (_, i) => {
      const c = 570 + i * 0.35;
      return {
        time: start4h + i * 14_400,
        open: c - 0.3,
        high: c + 0.9,
        low: c - 0.8,
        close: c,
        volume: 8_000_000,
      };
    });

    const start15m = Math.floor(Date.UTC(2025, 2, 10, 13, 30, 0) / 1000); // 09:30 EDT
    const bars15m: Bar[] = Array.from({ length: 30 }, (_, i) => {
      const c = 590 + i * 0.12;
      return {
        time: start15m + i * 900,
        open: c - 0.1,
        high: c + 0.25,
        low: c - 0.2,
        close: c,
        volume: 1_500_000,
      };
    });

    const rvBars = fixture.realizedVolMultiSessionDst.bars;
    const asOf = Math.floor(Date.UTC(2025, 2, 10, 15, 0, 0) / 1000); // 11:00 EDT
    const bars5mRthForMtf: Bar[] = Array.from({ length: 80 }, (_, i) => {
      const c = 588 + i * 0.08 + Math.sin(i * 0.2) * 0.25;
      return {
        time: asOf - (80 - i) * 300,
        open: c - 0.05,
        high: c + 0.15,
        low: c - 0.15,
        close: c,
        volume: 250_000,
      };
    });

    const mtf = evaluateMtfStructure(
      deepFreeze({ bars1d, bars4h, bars15m, bars5m: bars5mRthForMtf }),
      { asOfUtcSec: asOf },
    );

    const expiryUtcSec = asOf + 30 * 86_400;
    const spot = 594.0;
    const exposureContracts: readonly ExposureContractInput[] = [
      { contractType: 'call', strike: 605, expiryUtcSec, openInterest: 15_000, sharesPerContract: 100, iv: 0.175 },
      { contractType: 'call', strike: 595, expiryUtcSec, openInterest: 12_000, sharesPerContract: 100, iv: 0.18 },
      { contractType: 'put', strike: 580, expiryUtcSec, openInterest: 9_000, sharesPerContract: 100, iv: 0.20 },
      { contractType: 'put', strike: 590, expiryUtcSec, openInterest: 4_000, sharesPerContract: 100, iv: 0.185 },
    ];
    const exposure = computeDealerExposure(
      deepFreeze(exposureContracts),
      deepFreeze({ spot, nowUtcSec: asOf, rate: 0.045, dividendYield: 0.013 }),
    );

    const quotes: readonly VolQuoteInput[] = [
      { strike: 560, contractType: 'put', iv: 0.23, bid: 1.8, ask: 2.0, openInterest: 1000 },
      { strike: 575, contractType: 'put', iv: 0.205, bid: 3.1, ask: 3.3, openInterest: 2000 },
      { strike: 590, contractType: 'put', iv: 0.185, bid: 7.4, ask: 7.6, openInterest: 3000 },
      { strike: 595, contractType: 'call', iv: 0.18, bid: 8.2, ask: 8.4, openInterest: 3500 },
      { strike: 610, contractType: 'call', iv: 0.165, bid: 2.4, ask: 2.6, openInterest: 2200 },
      { strike: 625, contractType: 'call', iv: 0.155, bid: 0.7, ask: 0.85, openInterest: 1500 },
    ];
    const slice = buildVolSlice({
      timeToExpiry: 30 / 365,
      expirySec: expiryUtcSec,
      forward: spot * Math.exp((0.045 - 0.013) * (30 / 365)),
      spot,
      rate: 0.045,
      dividendYield: 0.013,
      quotes: deepFreeze(quotes),
    });
    const volMetrics = computeSliceVolMetrics(slice);

    const day10PmStart = Math.floor(Date.UTC(2025, 2, 10, 12, 0, 0) / 1000); // 08:00 EDT
    const openingBars = [
      ...Array.from({ length: 18 }, (_, i) => ({
        time: day10PmStart + i * 300,
        open: 591 + i * 0.05,
        high: 591.5 + i * 0.05,
        low: 590.8 + i * 0.05,
        close: 591.2 + i * 0.05,
        volume: 20_000,
      })),
      ...Array.from({ length: 18 }, (_, i) => ({
        time: Math.floor(Date.UTC(2025, 2, 10, 13, 30, 0) / 1000) + i * 300,
        open: 592 + i * 0.12,
        high: 592.4 + i * 0.12,
        low: 591.9 + i * 0.12,
        close: 592.3 + i * 0.12,
        volume: 120_000,
      })),
    ];
    const openingAuction = evaluateOpeningAuction(deepFreeze(openingBars), {
      asOfUtcSec: asOf,
      barSeconds: 300,
      prevRthClose: 589.5,
      prevRthHigh: 591.0,
      prevRthLow: 586.5,
      atr14d: 5.5,
      expectedWindowVolume: 700_000,
    });

    const cvdBars: readonly CvdBar[] = openingBars.map((b) => ({
      ...b,
      buyVolume: b.volume * 0.65,
      sellVolume: b.volume * 0.35,
    }));
    const cvdAbsorption = analyzeCvdAndAbsorption(deepFreeze(cvdBars), {
      asOfUtcSec: asOf,
      barSeconds: 300,
      sessionScope: 'RTH',
      levels: [{ name: 'PMH', price: openingAuction.pmh }],
      atr: 1.5,
    });

    const divBarsPrimary = Array.from({ length: 40 }, (_, i) => {
      const c = 585 + i * 0.25 + Math.sin(i * 0.4) * 1.1;
      return {
        time: asOf - (40 - i) * 300,
        open: c - 0.1,
        high: c + 0.3,
        low: c - 0.3,
        close: c,
        volume: 50_000,
      };
    });
    const divBarsCorrelated = divBarsPrimary.map((b, i) => ({
      ...b,
      close: b.close * 0.85 + Math.cos(i * 0.35) * 0.5,
      high: b.high * 0.85 + 0.5,
      low: b.low * 0.85 - 0.5,
    }));
    const rsiDivergences = detectRsiDivergences(deepFreeze(divBarsPrimary), {
      asOfUtcSec: asOf,
      barSeconds: 300,
    });
    const smtDivergences = detectSmtDivergences(
      deepFreeze(divBarsPrimary),
      deepFreeze(divBarsCorrelated),
      { asOfUtcSec: asOf, barSeconds: 300 },
    );

    const breadthSeries = Array.from({ length: 12 }, (_, i) => ({
      time: asOf - (12 - i) * 300,
      indexClose: 590 + i * 0.3,
      advances: 340,
      declines: 160,
    }));
    const breadth = evaluateMarketBreadth(deepFreeze(breadthSeries), {
      asOfUtcSec: asOf,
      barSeconds: 300,
    });

    const macroVol = evaluateMacroVolatilityRegime(
      deepFreeze({
        vix: Array.from({ length: 6 }, (_, i) => ({
          time: asOf - (6 - i) * 86_400,
          value: 14.5 - i * 0.15,
        })),
        cboeSkew: 132.0,
      }),
      { asOfUtcSec: asOf },
    );

    const realizedVol = computeIntradayRealizedVol(deepFreeze(structuredClone(rvBars)), {
      asOfUtcSec: fixture.realizedVolMultiSessionDst.asOfCutoff,
      minReturns: 77,
    });

    const snapshot = evaluateTerminalConfluence(
      deepFreeze({
        mtf,
        exposure,
        volMetrics,
        openingAuction,
        cvdAbsorption,
        rsiDivergences,
        smtDivergences,
        breadth,
        macroVol,
        realizedVol,
        referenceLevels: { pdh: 591.0, pdl: 586.5, pdc: 589.5 },
        options: { asOfUtcSec: asOf },
      }),
    );

    expect(snapshot.status).toBe('OK');
    expect(snapshot.activePillarsCount).toBe(6);
    expect(snapshot.keyLevels.length).toBeGreaterThanOrEqual(10);
    expect(Number.isFinite(snapshot.confluenceScore)).toBe(true);
    expect(Number.isFinite(snapshot.metrics.vrpSpread)).toBe(true);

    const envelope = serializeTerminalSnapshot(snapshot, {
      symbol: 'SPY',
      generatedAtUtcSec: asOf,
      timeframe: '5m',
      sessionDate: '2025-03-10',
      asOfUtcSec: asOf,
    });

    expect(envelope.envelopeStatus).toBe('OK');
    expect(envelope.nonFiniteFieldCount).toBe(0);
    const json = assertJsonSafeSerialized(envelope);
    expect(json.length).toBeGreaterThan(200);
  });
});
