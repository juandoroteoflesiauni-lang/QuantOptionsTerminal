/**
 * Suite Vitest 100 % offline para la Pieza 17 (Bloque III Parte 1 — Motores 7, 8 y 9):
 *  - `src/core/options/probabilisticDivergence.ts`: Breeden-Litzenberger (ℚ), distribución
 *    empírica histórica (ℙ) con colas > 3σ Overnight vs. RTH, cruces P vs. Q, y Cono/IV Rank.
 *  - `src/core/options/syntheticRates.ts`: Tasa implícita del sintético, Borrow Regime (HTB),
 *    Conversión/Reversión ejecutable, Buy-Write y Calendar Rolls con fricciones e IVA.
 *
 * Referencia independiente en Python: `fixtures/prob_divergence_synth_reference.json`
 * generada por `tools/gen_prob_divergence_synth_fixture.py` (tolerancia <= 1e-9).
 */

import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyzeEmpiricalDistributionP,
  computeVolConeAndRank,
  type DailyBarInput,
  type EmpiricalDistributionOptions,
  type EmpiricalDistributionResult,
  evaluatePqLevelDivergence,
  extractRiskNeutralDistributionQ,
  type PqDivergenceClassification,
  type PqLevelDivergenceResult,
  type RiskNeutralDistributionInput,
  type RiskNeutralDistributionResult,
  type TargetLevelInput,
  type VolConeAndRankInput,
  type VolConeAndRankResult,
} from '../src/core/options/probabilisticDivergence.js';
import {
  type BorrowRegime,
  type BuyWriteInput,
  type BuyWriteResult,
  type CalendarRollInput,
  type CalendarRollResult,
  computeSyntheticImpliedRates,
  type ConversionReversalInput,
  type ConversionReversalResult,
  type ConversionReversalSignal,
  evaluateBuyWrite,
  evaluateCalendarRoll,
  evaluateConversionReversal,
  type SyntheticImpliedRatesInput,
  type SyntheticImpliedRatesResult,
} from '../src/core/options/syntheticRates.js';
import { MAX_TIME_SECONDS } from '../src/core/sessions.js';

const SCALAR_TOLERANCE = 1e-11;

interface JsonRiskNeutralNode {
  readonly strike: number;
  readonly iv: number;
  readonly callPrice: number;
  readonly dCdK: number;
  readonly d2CdK2: number;
  readonly probAboveQ: number;
  readonly rawDensityQ: number;
  readonly densityQ: number;
}

interface JsonRiskNeutralResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly rawArea: number | null;
  readonly normalizedArea: number | null;
  readonly meanQ: number | null;
  readonly varianceQ: number | null;
  readonly stdDevQ: number | null;
  readonly skewnessQ: number | null;
  readonly excessKurtosisQ: number | null;
  readonly nodes: readonly JsonRiskNeutralNode[];
}

interface JsonEmpiricalResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly usedBarsCount: number;
  readonly horizonSamplesCount: number;
  readonly meanLogReturn: number | null;
  readonly stdDevLogReturn: number | null;
  readonly skewness: number | null;
  readonly excessKurtosis: number | null;
  readonly overnightVariance: number | null;
  readonly rthVariance: number | null;
  readonly overnightVarianceShare: number | null;
  readonly rthVarianceShare: number | null;
  readonly tailEventsCount: number;
  readonly tailFrequencyPct: number | null;
  readonly overnightTailContributionShare: number | null;
  readonly horizonLogReturns: readonly number[];
  readonly projectedTerminalPrices: readonly number[];
  readonly tailEvents: readonly {
    readonly time: number;
    readonly totalReturn: number;
    readonly zScore: number;
    readonly overnightReturn: number;
    readonly rthReturn: number;
    readonly overnightShare: number;
  }[];
}

interface JsonPqResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly levels: readonly {
    readonly label: string;
    readonly price: number;
    readonly direction: 'ABOVE' | 'BELOW';
    readonly probP: number | null;
    readonly probQ: number | null;
    readonly pqSpread: number | null;
    readonly pqRatio: number | null;
    readonly classification: PqDivergenceClassification;
  }[];
}

interface JsonConeResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly ivAtm: number | null;
  readonly ivMin: number | null;
  readonly ivMax: number | null;
  readonly ivRank: number | null;
  readonly ivPercentile: number | null;
  readonly cones: readonly {
    readonly horizonDays: number;
    readonly sigmaMovePct: number;
    readonly upper1Sigma: number;
    readonly lower1Sigma: number;
    readonly upper2Sigma: number;
    readonly lower2Sigma: number;
  }[];
}

interface JsonSynthResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly medianImpliedRate: number | null;
  readonly medianImpliedTna: number | null;
  readonly impliedBorrowRate: number | null;
  readonly borrowRegime: BorrowRegime;
  readonly strikes: readonly {
    readonly strike: number;
    readonly callMid: number;
    readonly putMid: number;
    readonly syntheticForward: number;
    readonly impliedRateContinuous: number;
    readonly impliedTna: number;
    readonly absLogMoneyness: number;
  }[];
}

interface JsonConvRevResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly conversionNetCost: number | null;
  readonly conversionAnnualizedTna: number | null;
  readonly conversionEdgeVsRiskFreeBps: number | null;
  readonly reversalNetProceeds: number | null;
  readonly shortBorrowCost: number | null;
  readonly reversalTerminalObligation: number | null;
  readonly reversalAnnualizedTna: number | null;
  readonly reversalEdgeVsRiskFreeBps: number | null;
  readonly netEdgeVsRiskFreeBps: number | null;
  readonly arbitrageSignal: ConversionReversalSignal;
}

interface JsonBuyWriteResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly totalFeesPerShare: number | null;
  readonly netCostBasis: number | null;
  readonly breakevenPrice: number | null;
  readonly downsideProtectionPct: number | null;
  readonly staticProfitPerShare: number | null;
  readonly staticReturnPct: number | null;
  readonly staticAnnualizedTna: number | null;
  readonly maxAssignedProfitPerShare: number | null;
  readonly maxAssignedReturnPct: number | null;
  readonly assignedAnnualizedTna: number | null;
}

interface JsonCalendarRollResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly rollDurationYears: number | null;
  readonly grossRollCredit: number | null;
  readonly rollFeesPerShare: number | null;
  readonly netRollCredit: number | null;
  readonly annualizedRollYield: number | null;
  readonly annualizedRollYieldOnSpot: number | null;
  readonly netThetaDiff: number | null;
  readonly netVegaDiff: number | null;
}

interface ProbDivSynthFixture {
  readonly asOfUtcSec: number;
  readonly qCases: readonly {
    readonly name: string;
    readonly input: RiskNeutralDistributionInput;
    readonly expected: JsonRiskNeutralResult;
  }[];
  readonly pBars: readonly DailyBarInput[];
  readonly pCases: readonly {
    readonly name: string;
    readonly options: EmpiricalDistributionOptions;
    readonly expected: JsonEmpiricalResult;
  }[];
  readonly pqDivergenceCase: {
    readonly spot: number;
    readonly qInput: RiskNeutralDistributionInput;
    readonly pBars: readonly DailyBarInput[];
    readonly pOptions: EmpiricalDistributionOptions;
    readonly targets: readonly TargetLevelInput[];
    readonly minEdgeSpread: number;
    readonly expected: JsonPqResult;
  };
  readonly coneAndRankCase: {
    readonly input: VolConeAndRankInput;
    readonly expected: JsonConeResult;
  };
  readonly syntheticRatesCases: readonly {
    readonly name: string;
    readonly input: SyntheticImpliedRatesInput;
    readonly expected: JsonSynthResult;
  }[];
  readonly conversionReversalCases: readonly {
    readonly name: string;
    readonly input: ConversionReversalInput;
    readonly expected: JsonConvRevResult;
  }[];
  readonly buyWriteCases: readonly {
    readonly name: string;
    readonly input: BuyWriteInput;
    readonly expected: JsonBuyWriteResult;
  }[];
  readonly calendarRollCases: readonly {
    readonly name: string;
    readonly input: CalendarRollInput;
    readonly expected: JsonCalendarRollResult;
  }[];
}

const FIXTURE: ProbDivSynthFixture = JSON.parse(
  readFileSync(new URL('../fixtures/prob_divergence_synth_reference.json', import.meta.url), 'utf8'),
) as ProbDivSynthFixture;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const prop = (value as Record<string, unknown>)[key];
      deepFreeze(prop);
    }
  }
  return value;
}

let checkedScalars = 0;
let maxAbsDiff = 0;
let maxRelDiff = 0;

function expectScalarClose(
  actual: number,
  expected: number | null,
  label: string,
): void {
  if (expected === null) {
    expect(Number.isNaN(actual), `${label} expected NaN`).toBe(true);
    return;
  }
  expect(Number.isFinite(actual), `${label} expected finite`).toBe(true);
  const absDiff = Math.abs(actual - expected);
  const scale = Math.max(1, Math.abs(expected));
  const relDiff = absDiff / scale;
  checkedScalars += 1;
  if (absDiff > maxAbsDiff) {
    maxAbsDiff = absDiff;
  }
  if (relDiff > maxRelDiff) {
    maxRelDiff = relDiff;
  }
  expect(absDiff / scale, `${label} diff actual=${String(actual)} expected=${String(expected)}`).toBeLessThanOrEqual(
    SCALAR_TOLERANCE,
  );
}

describe('Pieza 17 — Divergencia Probabilística (P vs Q), Colas >3σ, Cono y Tasas Implícitas del Sintético', () => {
  afterAll(() => {
    console.info(
      `[probDivergenceSynth.test] Fixture precision summary: ${String(checkedScalars)} scalars checked, maxAbsDiff=${maxAbsDiff.toExponential(3)}, maxRelDiff=${maxRelDiff.toExponential(3)} (limit <= ${SCALAR_TOLERANCE.toExponential(0)})`,
    );
  });

  it('extractRiskNeutralDistributionQ matches Breeden-Litzenberger Python reference within 1e-11 and preserves immutability', () => {
    for (const qCase of FIXTURE.qCases) {
      const frozenInput = deepFreeze(structuredClone(qCase.input));
      const actual: RiskNeutralDistributionResult = extractRiskNeutralDistributionQ(frozenInput);

      expect(actual.status, qCase.name).toBe(qCase.expected.status);
      expectScalarClose(actual.rawArea, qCase.expected.rawArea, `${qCase.name}.rawArea`);
      expectScalarClose(actual.normalizedArea, qCase.expected.normalizedArea, `${qCase.name}.normalizedArea`);
      expectScalarClose(actual.meanQ, qCase.expected.meanQ, `${qCase.name}.meanQ`);
      expectScalarClose(actual.varianceQ, qCase.expected.varianceQ, `${qCase.name}.varianceQ`);
      expectScalarClose(actual.stdDevQ, qCase.expected.stdDevQ, `${qCase.name}.stdDevQ`);
      expectScalarClose(actual.skewnessQ, qCase.expected.skewnessQ, `${qCase.name}.skewnessQ`);
      expectScalarClose(actual.excessKurtosisQ, qCase.expected.excessKurtosisQ, `${qCase.name}.excessKurtosisQ`);

      expect(actual.nodes.length, `${qCase.name}.nodes.length`).toBe(qCase.expected.nodes.length);
      for (let i = 0; i < qCase.expected.nodes.length; i += 1) {
        const expNode = qCase.expected.nodes[i];
        const actNode = actual.nodes[i];
        if (expNode === undefined || actNode === undefined) {
          throw new Error(`Missing Q node at ${String(i)}`);
        }
        expectScalarClose(actNode.strike, expNode.strike, `${qCase.name}.node[${String(i)}].strike`);
        expectScalarClose(actNode.callPrice, expNode.callPrice, `${qCase.name}.node[${String(i)}].callPrice`);
        expectScalarClose(actNode.dCdK, expNode.dCdK, `${qCase.name}.node[${String(i)}].dCdK`);
        expectScalarClose(actNode.d2CdK2, expNode.d2CdK2, `${qCase.name}.node[${String(i)}].d2CdK2`);
        expectScalarClose(actNode.probAboveQ, expNode.probAboveQ, `${qCase.name}.node[${String(i)}].probAboveQ`);
        expectScalarClose(actNode.rawDensityQ, expNode.rawDensityQ, `${qCase.name}.node[${String(i)}].rawDensityQ`);
        expectScalarClose(actNode.densityQ, expNode.densityQ, `${qCase.name}.node[${String(i)}].densityQ`);
      }

      // Shuffled strike order must still sort and deduplicate cleanly to identical result
      const reversedInput = deepFreeze({
        ...structuredClone(qCase.input),
        nodes: [...qCase.input.nodes].reverse(),
      });
      const fromReversed = extractRiskNeutralDistributionQ(reversedInput);
      expectScalarClose(fromReversed.meanQ, qCase.expected.meanQ, `${qCase.name}.reversed.meanQ`);
    }
  });

  it('analyzeEmpiricalDistributionP matches Python reference for fat tails (>3σ), Overnight/RTH variance split, and causal filtering', () => {
    const frozenBars = deepFreeze(structuredClone(FIXTURE.pBars));

    for (const pCase of FIXTURE.pCases) {
      const frozenOpts = deepFreeze(structuredClone(pCase.options));
      const actual: EmpiricalDistributionResult = analyzeEmpiricalDistributionP(frozenBars, frozenOpts);

      expect(actual.status, pCase.name).toBe(pCase.expected.status);
      expect(actual.usedBarsCount, `${pCase.name}.usedBarsCount`).toBe(pCase.expected.usedBarsCount);
      expect(actual.horizonSamplesCount, `${pCase.name}.horizonSamplesCount`).toBe(pCase.expected.horizonSamplesCount);
      expectScalarClose(actual.meanLogReturn, pCase.expected.meanLogReturn, `${pCase.name}.meanLogReturn`);
      expectScalarClose(actual.stdDevLogReturn, pCase.expected.stdDevLogReturn, `${pCase.name}.stdDevLogReturn`);
      expectScalarClose(actual.skewness, pCase.expected.skewness, `${pCase.name}.skewness`);
      expectScalarClose(actual.excessKurtosis, pCase.expected.excessKurtosis, `${pCase.name}.excessKurtosis`);
      expectScalarClose(actual.overnightVariance, pCase.expected.overnightVariance, `${pCase.name}.overnightVariance`);
      expectScalarClose(actual.rthVariance, pCase.expected.rthVariance, `${pCase.name}.rthVariance`);
      expectScalarClose(actual.overnightVarianceShare, pCase.expected.overnightVarianceShare, `${pCase.name}.overnightVarianceShare`);
      expectScalarClose(actual.rthVarianceShare, pCase.expected.rthVarianceShare, `${pCase.name}.rthVarianceShare`);
      expect(actual.tailEventsCount, `${pCase.name}.tailEventsCount`).toBe(pCase.expected.tailEventsCount);
      expectScalarClose(actual.tailFrequencyPct, pCase.expected.tailFrequencyPct, `${pCase.name}.tailFrequencyPct`);
      expectScalarClose(
        actual.overnightTailContributionShare,
        pCase.expected.overnightTailContributionShare,
        `${pCase.name}.overnightTailContributionShare`,
      );

      expect(actual.tailEvents.length).toBe(pCase.expected.tailEvents.length);
      for (let i = 0; i < pCase.expected.tailEvents.length; i += 1) {
        const expEv = pCase.expected.tailEvents[i];
        const actEv = actual.tailEvents[i];
        if (expEv === undefined || actEv === undefined) {
          throw new Error(`Missing tail event at ${String(i)}`);
        }
        expect(actEv.time).toBe(expEv.time);
        expectScalarClose(actEv.totalReturn, expEv.totalReturn, `${pCase.name}.tail[${String(i)}].totalReturn`);
        expectScalarClose(actEv.zScore, expEv.zScore, `${pCase.name}.tail[${String(i)}].zScore`);
        expectScalarClose(actEv.overnightShare, expEv.overnightShare, `${pCase.name}.tail[${String(i)}].overnightShare`);
      }

      // Zero Look-Ahead Bias check: appending bars strictly after asOfUtcSec must change nothing
      const withFutureBars = deepFreeze([
        ...structuredClone(FIXTURE.pBars),
        {
          time: frozenOpts.asOfUtcSec + 86_400,
          open: 15_000,
          close: 25_000,
        },
      ]);
      const causalActual = analyzeEmpiricalDistributionP(withFutureBars, frozenOpts);
      expect(causalActual).toEqual(actual);
    }
  });

  it('evaluatePqLevelDivergence & computeVolConeAndRank match Python reference across all divergence regimes and horizons', () => {
    const pqCfg = FIXTURE.pqDivergenceCase;
    const qDist = extractRiskNeutralDistributionQ(deepFreeze(structuredClone(pqCfg.qInput)));
    const pDist = analyzeEmpiricalDistributionP(
      deepFreeze(structuredClone(pqCfg.pBars)),
      deepFreeze(structuredClone(pqCfg.pOptions)),
    );

    const actualPq: PqLevelDivergenceResult = evaluatePqLevelDivergence(
      deepFreeze({
        spot: pqCfg.spot,
        qDistribution: qDist,
        pDistribution: pDist,
        targetLevels: structuredClone(pqCfg.targets),
        minEdgeSpread: pqCfg.minEdgeSpread,
      }),
    );

    expect(actualPq.status).toBe(pqCfg.expected.status);
    expect(actualPq.levels.length).toBe(pqCfg.expected.levels.length);
    for (let i = 0; i < pqCfg.expected.levels.length; i += 1) {
      const expLvl = pqCfg.expected.levels[i];
      const actLvl = actualPq.levels[i];
      if (expLvl === undefined || actLvl === undefined) {
        throw new Error(`Missing PQ level at ${String(i)}`);
      }
      expect(actLvl.label).toBe(expLvl.label);
      expect(actLvl.direction).toBe(expLvl.direction);
      expect(actLvl.classification).toBe(expLvl.classification);
      expectScalarClose(actLvl.probP, expLvl.probP, `pq.${expLvl.label}.probP`);
      expectScalarClose(actLvl.probQ, expLvl.probQ, `pq.${expLvl.label}.probQ`);
      expectScalarClose(actLvl.pqSpread, expLvl.pqSpread, `pq.${expLvl.label}.pqSpread`);
      expectScalarClose(actLvl.pqRatio, expLvl.pqRatio, `pq.${expLvl.label}.pqRatio`);
    }

    const coneCfg = FIXTURE.coneAndRankCase;
    const actualCone: VolConeAndRankResult = computeVolConeAndRank(
      deepFreeze(structuredClone(coneCfg.input)),
    );
    expect(actualCone.status).toBe(coneCfg.expected.status);
    expectScalarClose(actualCone.ivAtm, coneCfg.expected.ivAtm, 'cone.ivAtm');
    expectScalarClose(actualCone.ivMin, coneCfg.expected.ivMin, 'cone.ivMin');
    expectScalarClose(actualCone.ivMax, coneCfg.expected.ivMax, 'cone.ivMax');
    expectScalarClose(actualCone.ivRank, coneCfg.expected.ivRank, 'cone.ivRank');
    expectScalarClose(actualCone.ivPercentile, coneCfg.expected.ivPercentile, 'cone.ivPercentile');
    expect(actualCone.cones.length).toBe(coneCfg.expected.cones.length);
    for (let i = 0; i < coneCfg.expected.cones.length; i += 1) {
      const expPt = coneCfg.expected.cones[i];
      const actPt = actualCone.cones[i];
      if (expPt === undefined || actPt === undefined) {
        throw new Error(`Missing cone point at ${String(i)}`);
      }
      expect(actPt.horizonDays).toBe(expPt.horizonDays);
      expectScalarClose(actPt.sigmaMovePct, expPt.sigmaMovePct, `cone.${String(expPt.horizonDays)}.sigmaMovePct`);
      expectScalarClose(actPt.upper1Sigma, expPt.upper1Sigma, `cone.${String(expPt.horizonDays)}.upper1Sigma`);
      expectScalarClose(actPt.lower1Sigma, expPt.lower1Sigma, `cone.${String(expPt.horizonDays)}.lower1Sigma`);
      expectScalarClose(actPt.upper2Sigma, expPt.upper2Sigma, `cone.${String(expPt.horizonDays)}.upper2Sigma`);
      expectScalarClose(actPt.lower2Sigma, expPt.lower2Sigma, `cone.${String(expPt.horizonDays)}.lower2Sigma`);
    }
  });

  it('computeSyntheticImpliedRates, evaluateConversionReversal, evaluateBuyWrite & evaluateCalendarRoll match Python reference within 1e-11', () => {
    for (const sCase of FIXTURE.syntheticRatesCases) {
      const actual: SyntheticImpliedRatesResult = computeSyntheticImpliedRates(
        deepFreeze(structuredClone(sCase.input)),
      );
      expect(actual.status, sCase.name).toBe(sCase.expected.status);
      expect(actual.borrowRegime, sCase.name).toBe(sCase.expected.borrowRegime);
      expectScalarClose(actual.medianImpliedRate, sCase.expected.medianImpliedRate, `${sCase.name}.medianImpliedRate`);
      expectScalarClose(actual.medianImpliedTna, sCase.expected.medianImpliedTna, `${sCase.name}.medianImpliedTna`);
      expectScalarClose(actual.impliedBorrowRate, sCase.expected.impliedBorrowRate, `${sCase.name}.impliedBorrowRate`);
      expect(actual.strikes.length).toBe(sCase.expected.strikes.length);
      for (let i = 0; i < sCase.expected.strikes.length; i += 1) {
        const expS = sCase.expected.strikes[i];
        const actS = actual.strikes[i];
        if (expS === undefined || actS === undefined) {
          throw new Error(`Missing strike node at ${String(i)}`);
        }
        expectScalarClose(actS.syntheticForward, expS.syntheticForward, `${sCase.name}.s[${String(i)}].syntheticForward`);
        expectScalarClose(actS.impliedRateContinuous, expS.impliedRateContinuous, `${sCase.name}.s[${String(i)}].impliedRate`);
        expectScalarClose(actS.impliedTna, expS.impliedTna, `${sCase.name}.s[${String(i)}].impliedTna`);
      }
    }

    for (const cCase of FIXTURE.conversionReversalCases) {
      const actual: ConversionReversalResult = evaluateConversionReversal(
        deepFreeze(structuredClone(cCase.input)),
      );
      expect(actual.status, cCase.name).toBe(cCase.expected.status);
      expect(actual.arbitrageSignal, cCase.name).toBe(cCase.expected.arbitrageSignal);
      expectScalarClose(actual.conversionNetCost, cCase.expected.conversionNetCost, `${cCase.name}.convNetCost`);
      expectScalarClose(actual.conversionAnnualizedTna, cCase.expected.conversionAnnualizedTna, `${cCase.name}.convTna`);
      expectScalarClose(actual.conversionEdgeVsRiskFreeBps, cCase.expected.conversionEdgeVsRiskFreeBps, `${cCase.name}.convBps`);
      expectScalarClose(actual.reversalNetProceeds, cCase.expected.reversalNetProceeds, `${cCase.name}.revProceeds`);
      expectScalarClose(actual.shortBorrowCost, cCase.expected.shortBorrowCost, `${cCase.name}.shortBorrow`);
      expectScalarClose(actual.reversalTerminalObligation, cCase.expected.reversalTerminalObligation, `${cCase.name}.revOblig`);
      expectScalarClose(actual.reversalAnnualizedTna, cCase.expected.reversalAnnualizedTna, `${cCase.name}.revTna`);
      expectScalarClose(actual.reversalEdgeVsRiskFreeBps, cCase.expected.reversalEdgeVsRiskFreeBps, `${cCase.name}.revBps`);
      expectScalarClose(actual.netEdgeVsRiskFreeBps, cCase.expected.netEdgeVsRiskFreeBps, `${cCase.name}.netEdge`);
    }

    for (const bwCase of FIXTURE.buyWriteCases) {
      const actual: BuyWriteResult = evaluateBuyWrite(deepFreeze(structuredClone(bwCase.input)));
      expect(actual.status, bwCase.name).toBe(bwCase.expected.status);
      expectScalarClose(actual.totalFeesPerShare, bwCase.expected.totalFeesPerShare, `${bwCase.name}.fees`);
      expectScalarClose(actual.netCostBasis, bwCase.expected.netCostBasis, `${bwCase.name}.basis`);
      expectScalarClose(actual.breakevenPrice, bwCase.expected.breakevenPrice, `${bwCase.name}.breakeven`);
      expectScalarClose(actual.downsideProtectionPct, bwCase.expected.downsideProtectionPct, `${bwCase.name}.prot`);
      expectScalarClose(actual.staticProfitPerShare, bwCase.expected.staticProfitPerShare, `${bwCase.name}.staticProfit`);
      expectScalarClose(actual.staticReturnPct, bwCase.expected.staticReturnPct, `${bwCase.name}.staticPct`);
      expectScalarClose(actual.staticAnnualizedTna, bwCase.expected.staticAnnualizedTna, `${bwCase.name}.staticTna`);
      expectScalarClose(actual.maxAssignedProfitPerShare, bwCase.expected.maxAssignedProfitPerShare, `${bwCase.name}.maxProfit`);
      expectScalarClose(actual.maxAssignedReturnPct, bwCase.expected.maxAssignedReturnPct, `${bwCase.name}.maxPct`);
      expectScalarClose(actual.assignedAnnualizedTna, bwCase.expected.assignedAnnualizedTna, `${bwCase.name}.maxTna`);
    }

    for (const rCase of FIXTURE.calendarRollCases) {
      const actual: CalendarRollResult = evaluateCalendarRoll(deepFreeze(structuredClone(rCase.input)));
      expect(actual.status, rCase.name).toBe(rCase.expected.status);
      expectScalarClose(actual.rollDurationYears, rCase.expected.rollDurationYears, `${rCase.name}.dur`);
      expectScalarClose(actual.grossRollCredit, rCase.expected.grossRollCredit, `${rCase.name}.gross`);
      expectScalarClose(actual.rollFeesPerShare, rCase.expected.rollFeesPerShare, `${rCase.name}.fees`);
      expectScalarClose(actual.netRollCredit, rCase.expected.netRollCredit, `${rCase.name}.net`);
      expectScalarClose(actual.annualizedRollYield, rCase.expected.annualizedRollYield, `${rCase.name}.yieldStrike`);
      expectScalarClose(actual.annualizedRollYieldOnSpot, rCase.expected.annualizedRollYieldOnSpot, `${rCase.name}.yieldSpot`);
      expectScalarClose(actual.netThetaDiff, rCase.expected.netThetaDiff, `${rCase.name}.thetaDiff`);
      expectScalarClose(actual.netVegaDiff, rCase.expected.netVegaDiff, `${rCase.name}.vegaDiff`);
    }
  });

  it('enforces Zero Silent Fallbacks and returns NO_DATA + NaN on invalid, short, crossed or out-of-range inputs', () => {
    const firstQ = FIXTURE.qCases[0]?.input;
    if (firstQ === undefined) {
      throw new Error('Missing fixture qCases[0]');
    }
    const shortQ = extractRiskNeutralDistributionQ({
      ...firstQ,
      nodes: firstQ.nodes.slice(0, 4),
    });
    expect(shortQ.status).toBe('NO_DATA');
    expect(Number.isNaN(shortQ.meanQ)).toBe(true);
    expect(shortQ.nodes).toEqual([]);

    const badTimeQ = extractRiskNeutralDistributionQ({ ...firstQ, timeToExpiry: 0 });
    expect(badTimeQ.status).toBe('NO_DATA');
    expect(Number.isNaN(badTimeQ.rawArea)).toBe(true);

    const shortP = analyzeEmpiricalDistributionP(FIXTURE.pBars.slice(0, 15), {
      asOfUtcSec: FIXTURE.asOfUtcSec,
      spot: 6400,
      horizonDays: 1,
      minHistoryBars: 30,
    });
    expect(shortP.status).toBe('NO_DATA');
    expect(Number.isNaN(shortP.stdDevLogReturn)).toBe(true);

    const futureSecP = analyzeEmpiricalDistributionP(FIXTURE.pBars, {
      asOfUtcSec: MAX_TIME_SECONDS + 1,
      spot: 6400,
      horizonDays: 1,
    });
    expect(futureSecP.status).toBe('NO_DATA');

    const pqBad = evaluatePqLevelDivergence({
      spot: 6400,
      qDistribution: shortQ,
      pDistribution: shortP,
      targetLevels: [{ label: 'X', price: 6500 }],
    });
    expect(pqBad.status).toBe('NO_DATA');

    const flatIvCone = computeVolConeAndRank({
      spot: 6400,
      ivAtm: 0.45,
      horizonsDays: [30],
      ivHistory: [0.45, 0.45, 0.45, 0.45, 0.45],
      minIvHistoryCount: 5,
    });
    expect(flatIvCone.status).toBe('OK');
    expect(Number.isNaN(flatIvCone.ivRank)).toBe(true);
    expectScalarClose(flatIvCone.ivPercentile, 100, 'flatIvCone.ivPercentile');

    const invalidCone = computeVolConeAndRank({
      spot: -10,
      ivAtm: 0.45,
      horizonsDays: [30],
      ivHistory: [0.45],
    });
    expect(invalidCone.status).toBe('NO_DATA');
    expect(Number.isNaN(invalidCone.ivAtm)).toBe(true);

    const impossibleSynth = computeSyntheticImpliedRates({
      spot: 6400,
      riskFreeRate: 0.3,
      dividendYield: 0,
      timeToExpiry: 0.1,
      pairs: [{ strike: 6400, callMid: 7000, putMid: 10 }],
    });
    expect(impossibleSynth.status).toBe('NO_DATA');
    expect(impossibleSynth.borrowRegime).toBe('NO_DATA');
    expect(Number.isNaN(impossibleSynth.medianImpliedRate)).toBe(true);

    const crossedConv = evaluateConversionReversal({
      strike: 6400,
      timeToExpiry: 0.1,
      riskFreeTna: 0.3,
      spotBid: 6410,
      spotAsk: 6400, // crossed!
      callBid: 400,
      callAsk: 410,
      putBid: 180,
      putAsk: 190,
    });
    expect(crossedConv.status).toBe('NO_DATA');
    expect(crossedConv.arbitrageSignal).toBe('NO_DATA');
    expect(Number.isNaN(crossedConv.conversionNetCost)).toBe(true);

    const nanFeeBw = evaluateBuyWrite({
      spotAsk: 6400,
      strike: 6800,
      callBid: 385,
      timeToExpiry: 0.1,
      stockFeeRate: Number.NaN,
    });
    expect(nanFeeBw.status).toBe('NO_DATA');
    expect(Number.isNaN(nanFeeBw.netCostBasis)).toBe(true);

    const invertedRoll = evaluateCalendarRoll({
      spot: 6400,
      strike: 6400,
      nearAsk: 300,
      farBid: 750,
      nearTimeToExpiry: 0.2,
      farTimeToExpiry: 0.1, // far <= near
      nearThetaDaily: -5,
      farThetaDaily: -3,
      nearVegaPer1Pct: 6,
      farVegaPer1Pct: 10,
    });
    expect(invertedRoll.status).toBe('NO_DATA');
    expect(Number.isNaN(invertedRoll.netRollCredit)).toBe(true);
  });
});
