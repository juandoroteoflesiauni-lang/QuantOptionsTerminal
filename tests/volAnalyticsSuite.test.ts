import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildExpectedConeAndLognormalSummary,
  buildNormalizedMoneynessMatrix,
  buildSeparatedOtmSmile,
  computeCclVolAndAdrCorrelation,
  computeDualBymaVsOpraSurface,
  computeHistoricalVolConditionalTable,
  computeOperativeRegimeSuggestion,
  computeParityAndSyntheticRatesByStrike,
  computeRatiosAndStructureCosts,
  computeRollingRvDistributionAtWindow,
  type DualBymaOpraSurfaceResult,
  type ExpectedConeDensitySummary,
  type HistoricalVolConditionalResult,
  type NormalizedMoneynessMatrixResult,
  type ParityAndSyntheticSuiteResult,
  type RatiosAndStructureCostsResult,
  type SeparatedSmileResult,
} from '../src/core/options/volAnalyticsSuite.js';

const TOLERANCE = 1e-11;

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const val of Object.values(obj as Record<string, unknown>)) {
    deepFreeze(val);
  }
  return obj;
}

function mustAt<T>(arr: readonly T[], idx: number): T {
  const item = arr[idx];
  expect(item).toBeDefined();
  if (item === undefined) {
    throw new Error(`Missing element at index ${String(idx)}`);
  }
  return item;
}

function expectCloseOrNaN(actual: number, expected: number | null, tol = TOLERANCE): void {
  if (expected === null || !Number.isFinite(expected)) {
    expect(Number.isNaN(actual)).toBe(true);
    return;
  }
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThan(tol);
}

interface SuiteFixture {
  readonly inputs: {
    readonly shortSmile: Parameters<typeof buildSeparatedOtmSmile>[0];
    readonly midSmile: Parameters<typeof buildSeparatedOtmSmile>[0];
    readonly matrixSlices: Parameters<typeof buildNormalizedMoneynessMatrix>[0];
    readonly bars: Parameters<typeof computeHistoricalVolConditionalTable>[0]['bars'];
    readonly expectedCone: Parameters<typeof buildExpectedConeAndLognormalSummary>[0];
    readonly parity: Parameters<typeof computeParityAndSyntheticRatesByStrike>[0];
    readonly ratiosAndStructures: Parameters<typeof computeRatiosAndStructureCosts>[0];
    readonly dualSurface: Parameters<typeof computeDualBymaVsOpraSurface>[0];
  };
  readonly expected: {
    readonly shortSmileOtmOnly: {
      readonly status: 'OK' | 'NO_DATA';
      readonly onlyOtm: boolean;
      readonly isShortDteSlice: boolean;
      readonly excludedItmCount: number;
      readonly callPoints: readonly { strike: number; moneynessPct: number; delta: number; ivPct: number; isOtm: boolean; isShortDteItm: boolean }[];
      readonly putPoints: readonly { strike: number; moneynessPct: number; delta: number; ivPct: number; isOtm: boolean; isShortDteItm: boolean }[];
      readonly compositeOtmPoints: readonly { strike: number; moneynessPct: number; ivPct: number; sourceSide: string }[];
      readonly atmIvPct: number | null;
      readonly callWingAvgIvPct: number | null;
      readonly putWingAvgIvPct: number | null;
      readonly callVsPutSkewPp: number | null;
      readonly iv25DeltaCallPct: number | null;
      readonly iv25DeltaPutPct: number | null;
      readonly riskReversal25DeltaPp: number | null;
    };
    readonly shortSmileAll: {
      readonly status: 'OK' | 'NO_DATA';
      readonly onlyOtm: boolean;
      readonly isShortDteSlice: boolean;
      readonly excludedItmCount: number;
      readonly callPoints: readonly { strike: number; moneynessPct: number; delta: number; ivPct: number; isOtm: boolean; isShortDteItm: boolean }[];
      readonly putPoints: readonly { strike: number; moneynessPct: number; delta: number; ivPct: number; isOtm: boolean; isShortDteItm: boolean }[];
      readonly atmIvPct: number | null;
    };
    readonly midSmileOtmOnly: {
      readonly status: 'OK' | 'NO_DATA';
      readonly atmIvPct: number | null;
      readonly callWingAvgIvPct: number | null;
      readonly putWingAvgIvPct: number | null;
      readonly callVsPutSkewPp: number | null;
      readonly iv25DeltaCallPct: number | null;
      readonly iv25DeltaPutPct: number | null;
      readonly riskReversal25DeltaPp: number | null;
    };
    readonly moneynessMatrix: {
      readonly status: 'OK' | 'NO_DATA';
      readonly offsetsPct: readonly number[];
      readonly rows: readonly {
        readonly expiryCode: string;
        readonly atmIvPct: number | null;
        readonly cells: readonly { readonly offsetPct: number; readonly ivPct: number | null }[];
      }[];
      readonly termRegime: string;
      readonly termSpreadPp: number | null;
    };
    readonly historicalVolConditional: {
      readonly status: 'OK' | 'NO_DATA';
      readonly barsUsed: number;
      readonly historyObservations: number;
      readonly pairedObservations: number;
      readonly currentEvalVolPct: number | null;
      readonly latestRv20Pct: number | null;
      readonly latestRv23Pct: number | null;
      readonly latestRv60Pct: number | null;
      readonly vrpVsRv23Pts: number | null;
      readonly ivRank: number | null;
      readonly ivPercentile: number | null;
      readonly quantiles: Record<string, number | null>;
      readonly operativeRegime: { readonly code: string };
      readonly buckets: readonly {
        readonly id: string;
        readonly minBoundPct: number | null;
        readonly maxBoundPct: number | null;
        readonly occurrences: number;
        readonly avgVolChange30dPts: number | null;
        readonly avgUnderlyingReturn30dPct: number | null;
        readonly pctVolDecreased: number | null;
        readonly isCurrent: boolean;
      }[];
      readonly seasonalityMonths: readonly {
        readonly monthIndex: number;
        readonly tradingDays: number;
        readonly monthsSampled: number;
        readonly meanDailyReturnPct: number | null;
        readonly avgMonthlyReturnPct: number | null;
        readonly annualizedVolPct: number | null;
        readonly positiveMonthRatePct: number | null;
      }[];
      readonly extremeSessions: readonly {
        readonly time: number;
        readonly date: string;
        readonly logReturnPct: number;
        readonly simpleReturnPct: number;
        readonly zScore: number;
        readonly direction: 'UP' | 'DOWN';
      }[];
    };
    readonly rvDistributions: Record<
      'rv20' | 'rv60' | 'rv120',
      {
        readonly minPct: number;
        readonly p25Pct: number;
        readonly medianPct: number;
        readonly p75Pct: number;
        readonly maxPct: number;
        readonly currentPct: number;
        readonly observations: number;
      }
    >;
    readonly expectedCone: {
      readonly dailyMoveAbs: number | null;
      readonly dailyMovePct: number | null;
      readonly horizonMove1SigmaPct: number | null;
      readonly upper1Sigma: number | null;
      readonly lower1Sigma: number | null;
      readonly upper2Sigma: number | null;
      readonly lower2Sigma: number | null;
      readonly probQAboveSpotPct: number | null;
      readonly probQBelowMinus10Pct: number | null;
      readonly comparisonNodes: readonly {
        readonly strike: number;
        readonly densityQ: number;
        readonly lognormalDensity: number | null;
        readonly probAboveQ: number;
      }[];
    };
    readonly parity: {
      readonly medianMidTeaPct: number | null;
      readonly medianTeaTomadoraPct: number | null;
      readonly medianTeaColocadoraPct: number | null;
      readonly bestColocadoraStrike: number | null;
      readonly bestColocadoraTeaPct: number | null;
      readonly bestTomadoraStrike: number | null;
      readonly bestTomadoraTeaPct: number | null;
      readonly strikes: readonly {
        readonly strike: number;
        readonly ivSpreadPp: number | null;
        readonly syntheticForwardMid: number | null;
        readonly midImpliedTeaPct: number | null;
        readonly teaTomadoraPct: number | null;
        readonly teaColocadoraPct: number | null;
        readonly canLendAboveBenchmark: boolean;
        readonly canBorrowBelowBenchmark: boolean;
        readonly edgeColocadoraBps: number | null;
        readonly edgeTomadoraBps: number | null;
      }[];
    };
    readonly ratiosAndStructures: {
      readonly callRatios: readonly {
        readonly side: 'CALL' | 'PUT';
        readonly targetOffsetPct: number;
        readonly longStrike: number;
        readonly shortStrike: number;
        readonly otmLotsPerBought: number;
        readonly netCash1x2: number;
        readonly outerBreakeven1x2: number;
      }[];
      readonly putRatios: readonly {
        readonly side: 'CALL' | 'PUT';
        readonly targetOffsetPct: number;
        readonly longStrike: number;
        readonly shortStrike: number;
        readonly otmLotsPerBought: number;
        readonly netCash1x2: number;
        readonly outerBreakeven1x2: number;
      }[];
      readonly structures: readonly {
        readonly id: string;
        readonly strikes: readonly number[];
        readonly width: number;
        readonly netDebit: number;
        readonly maxProfit: number;
        readonly costPctOfMaxProfit: number;
        readonly costPctOfWidth: number;
        readonly rewardRiskRatio: number;
        readonly bs2002HistoricalPercentile: number | null;
        readonly bs2002HistoricalMinPct: number | null;
        readonly bs2002HistoricalMedianPct: number | null;
        readonly bs2002HistoricalMaxPct: number | null;
        readonly bs2002HistoricalObs: number;
      }[];
    };
    readonly dualSurface: {
      readonly bymaAtmIvPct: number | null;
      readonly opraAtmIvPct: number | null;
      readonly theoreticalAtmIvPct: number | null;
      readonly atmSpreadBymaVsOpraPp: number | null;
      readonly atmSpreadBymaVsTheoreticalPp: number | null;
      readonly nodes: readonly {
        readonly offsetPct: number;
        readonly bymaIvPct: number | null;
        readonly opraAdrIvPct: number | null;
        readonly theoreticalBymaIvPct: number | null;
        readonly spreadBymaMinusOpraPp: number | null;
        readonly spreadBymaMinusTheoreticalPp: number | null;
      }[];
    };
  };
}

const fixturePath = join(process.cwd(), 'fixtures', 'vol_analytics_suite_reference.json');
const fixture = deepFreeze(JSON.parse(readFileSync(fixturePath, 'utf-8')) as SuiteFixture);

describe('volAnalyticsSuite pure quantitative engines (Pieza 27)', () => {
  it('filters contaminated short-DTE ITM spikes when onlyOtm=true and marks them when onlyOtm=false (< 1e-11)', () => {
    const resOtm: SeparatedSmileResult = buildSeparatedOtmSmile(fixture.inputs.shortSmile, { onlyOtm: true });
    const expOtm = fixture.expected.shortSmileOtmOnly;
    expect(resOtm.status).toBe(expOtm.status);
    expect(resOtm.onlyOtm).toBe(true);
    expect(resOtm.isShortDteSlice).toBe(true);
    expect(resOtm.excludedItmCount).toBe(expOtm.excludedItmCount);
    expect(resOtm.callPoints.every((p) => p.isOtm && !p.isShortDteItm)).toBe(true);
    expect(resOtm.putPoints.every((p) => p.isOtm && !p.isShortDteItm)).toBe(true);
    expect(resOtm.callPoints.every((p) => p.ivPct < 100)).toBe(true);
    expect(resOtm.putPoints.every((p) => p.ivPct < 100)).toBe(true);
    expectCloseOrNaN(resOtm.atmIvPct, expOtm.atmIvPct);

    resOtm.callPoints.forEach((pt, idx) => {
      const ref = mustAt(expOtm.callPoints, idx);
      expect(pt.strike).toBe(ref.strike);
      expectCloseOrNaN(pt.moneynessPct, ref.moneynessPct);
      expectCloseOrNaN(pt.delta, ref.delta);
      expectCloseOrNaN(pt.ivPct, ref.ivPct);
    });
    resOtm.putPoints.forEach((pt, idx) => {
      const ref = mustAt(expOtm.putPoints, idx);
      expect(pt.strike).toBe(ref.strike);
      expectCloseOrNaN(pt.moneynessPct, ref.moneynessPct);
      expectCloseOrNaN(pt.delta, ref.delta);
      expectCloseOrNaN(pt.ivPct, ref.ivPct);
    });

    const resAll = buildSeparatedOtmSmile(fixture.inputs.shortSmile, { onlyOtm: false });
    const expAll = fixture.expected.shortSmileAll;
    expect(resAll.excludedItmCount).toBe(0);
    expect(resAll.callPoints.some((p) => p.isShortDteItm && p.ivPct > 150)).toBe(true);
    expect(resAll.putPoints.some((p) => p.isShortDteItm && p.ivPct > 150)).toBe(true);
    expectCloseOrNaN(resAll.atmIvPct, expAll.atmIvPct);
  });

  it('computes separated wing skew and 25-delta risk reversal cleanly (< 1e-11)', () => {
    const res = buildSeparatedOtmSmile(fixture.inputs.midSmile, { onlyOtm: true });
    const exp = fixture.expected.midSmileOtmOnly;
    expect(res.status).toBe(exp.status);
    expectCloseOrNaN(res.atmIvPct, exp.atmIvPct);
    expectCloseOrNaN(res.callWingAvgIvPct, exp.callWingAvgIvPct);
    expectCloseOrNaN(res.putWingAvgIvPct, exp.putWingAvgIvPct);
    expectCloseOrNaN(res.callVsPutSkewPp, exp.callVsPutSkewPp);
    expectCloseOrNaN(res.iv25DeltaCallPct, exp.iv25DeltaCallPct);
    expectCloseOrNaN(res.iv25DeltaPutPct, exp.iv25DeltaPutPct);
    expectCloseOrNaN(res.riskReversal25DeltaPp, exp.riskReversal25DeltaPp);
  });

  it('builds normalized moneyness matrix (-20%..+20%) with NaN outside observed range and accurate term regime (< 1e-11)', () => {
    const matrix: NormalizedMoneynessMatrixResult = buildNormalizedMoneynessMatrix(fixture.inputs.matrixSlices);
    const exp = fixture.expected.moneynessMatrix;
    expect(matrix.status).toBe(exp.status);
    expect(matrix.termRegime).toBe(exp.termRegime);
    expectCloseOrNaN(matrix.termSpreadPp, exp.termSpreadPp);

    matrix.rows.forEach((row, rIdx) => {
      const expRow = mustAt(exp.rows, rIdx);
      expect(row.expiryCode).toBe(expRow.expiryCode);
      expectCloseOrNaN(row.atmIvPct, expRow.atmIvPct);
      row.cells.forEach((cell, cIdx) => {
        const expCell = mustAt(expRow.cells, cIdx);
        expect(cell.offsetPct).toBe(expCell.offsetPct);
        expectCloseOrNaN(cell.ivPct, expCell.ivPct);
      });
    });
  });

  it('computes conditional quintile table, rolling RV distributions, monthly seasonality and >3σ extreme sessions (< 1e-11)', () => {
    const res: HistoricalVolConditionalResult = computeHistoricalVolConditionalTable({
      bars: fixture.inputs.bars,
      currentIvAtmPct: 52.5,
    });
    const exp = fixture.expected.historicalVolConditional;

    expect(res.status).toBe(exp.status);
    expect(res.barsUsed).toBe(exp.barsUsed);
    expect(res.historyObservations).toBe(exp.historyObservations);
    expect(res.pairedObservations).toBe(exp.pairedObservations);
    expectCloseOrNaN(res.currentEvalVolPct, exp.currentEvalVolPct);
    expectCloseOrNaN(res.latestRv20Pct, exp.latestRv20Pct);
    expectCloseOrNaN(res.latestRv23Pct, exp.latestRv23Pct);
    expectCloseOrNaN(res.latestRv60Pct, exp.latestRv60Pct);
    expectCloseOrNaN(res.vrpVsRv23Pts, exp.vrpVsRv23Pts);
    expectCloseOrNaN(res.ivRank, exp.ivRank);
    expectCloseOrNaN(res.ivPercentile, exp.ivPercentile);
    expect(res.operativeRegime.code).toBe(exp.operativeRegime.code);

    for (const key of ['minPct', 'p20Pct', 'p40Pct', 'p60Pct', 'p80Pct', 'maxPct', 'medianPct'] as const) {
      expectCloseOrNaN(res.quantiles[key], exp.quantiles[key] ?? null);
    }

    res.buckets.forEach((b, idx) => {
      const eb = mustAt(exp.buckets, idx);
      expect(b.id).toBe(eb.id);
      expect(b.occurrences).toBe(eb.occurrences);
      expect(b.isCurrent).toBe(eb.isCurrent);
      expectCloseOrNaN(b.minBoundPct, eb.minBoundPct);
      expectCloseOrNaN(b.maxBoundPct, eb.maxBoundPct);
      expectCloseOrNaN(b.avgVolChange30dPts, eb.avgVolChange30dPts);
      expectCloseOrNaN(b.avgUnderlyingReturn30dPct, eb.avgUnderlyingReturn30dPct);
      expectCloseOrNaN(b.pctVolDecreased, eb.pctVolDecreased);
    });

    res.seasonalityMonths.forEach((m, idx) => {
      const em = mustAt(exp.seasonalityMonths, idx);
      expect(m.monthIndex).toBe(em.monthIndex);
      expect(m.tradingDays).toBe(em.tradingDays);
      expect(m.monthsSampled).toBe(em.monthsSampled);
      expectCloseOrNaN(m.meanDailyReturnPct, em.meanDailyReturnPct);
      expectCloseOrNaN(m.avgMonthlyReturnPct, em.avgMonthlyReturnPct);
      expectCloseOrNaN(m.annualizedVolPct, em.annualizedVolPct);
      expectCloseOrNaN(m.positiveMonthRatePct, em.positiveMonthRatePct);
    });

    expect(res.extremeSessions.length).toBe(exp.extremeSessions.length);
    expect(res.extremeSessions.length).toBeGreaterThanOrEqual(2);
    res.extremeSessions.forEach((s, idx) => {
      const es = mustAt(exp.extremeSessions, idx);
      expect(s.time).toBe(es.time);
      expect(s.date).toBe(es.date);
      expect(s.direction).toBe(es.direction);
      expectCloseOrNaN(s.logReturnPct, es.logReturnPct);
      expectCloseOrNaN(s.simpleReturnPct, es.simpleReturnPct);
      expectCloseOrNaN(s.zScore, es.zScore);
    });

    for (const [key, win] of [
      ['rv20', 20],
      ['rv60', 60],
      ['rv120', 120],
    ] as const) {
      const dist = computeRollingRvDistributionAtWindow(fixture.inputs.bars, win);
      const ed = fixture.expected.rvDistributions[key];
      expect(dist.observations).toBe(ed.observations);
      expectCloseOrNaN(dist.minPct, ed.minPct);
      expectCloseOrNaN(dist.p25Pct, ed.p25Pct);
      expectCloseOrNaN(dist.medianPct, ed.medianPct);
      expectCloseOrNaN(dist.p75Pct, ed.p75Pct);
      expectCloseOrNaN(dist.maxPct, ed.maxPct);
      expectCloseOrNaN(dist.currentPct, ed.currentPct);
    }

    expect(computeOperativeRegimeSuggestion({ ivRank: 78, vrpPts: 8 }).code).toBe('VENTA_PRIMA_CUBIERTA');
    expect(computeOperativeRegimeSuggestion({ ivRank: 18, vrpPts: -2 }).code).toBe('COMPRA_CONVEXIDAD_CALENDAR');
    expect(computeOperativeRegimeSuggestion({ ivRank: 50, vrpPts: 3 }).code).toBe('NEUTRAL_SELECTIVO');
  });

  it('builds expected move cone (±1σ/±2σ) and Q vs analytical Lognormal comparison nodes (< 1e-11)', () => {
    const cone: ExpectedConeDensitySummary = buildExpectedConeAndLognormalSummary(fixture.inputs.expectedCone);
    const exp = fixture.expected.expectedCone;
    expect(cone.status).toBe('OK');
    expectCloseOrNaN(cone.dailyMoveAbs, exp.dailyMoveAbs);
    expectCloseOrNaN(cone.dailyMovePct, exp.dailyMovePct);
    expectCloseOrNaN(cone.horizonMove1SigmaPct, exp.horizonMove1SigmaPct);
    expectCloseOrNaN(cone.upper1Sigma, exp.upper1Sigma);
    expectCloseOrNaN(cone.lower1Sigma, exp.lower1Sigma);
    expectCloseOrNaN(cone.upper2Sigma, exp.upper2Sigma);
    expectCloseOrNaN(cone.lower2Sigma, exp.lower2Sigma);
    expectCloseOrNaN(cone.probQAboveSpotPct, exp.probQAboveSpotPct);
    expectCloseOrNaN(cone.probQBelowMinus10Pct, exp.probQBelowMinus10Pct);

    cone.comparisonNodes.forEach((n, idx) => {
      const en = mustAt(exp.comparisonNodes, idx);
      expect(n.strike).toBe(en.strike);
      expectCloseOrNaN(n.densityQ, en.densityQ);
      expectCloseOrNaN(n.lognormalDensity, en.lognormalDensity);
      expectCloseOrNaN(n.probAboveQ, en.probAboveQ);
    });
  });

  it('computes strike-by-strike Put-Call parity and enforces TEA Tomadora >= TEA Colocadora on clean BBO quotes (< 1e-11)', () => {
    const parity: ParityAndSyntheticSuiteResult = computeParityAndSyntheticRatesByStrike(fixture.inputs.parity);
    const exp = fixture.expected.parity;
    expect(parity.status).toBe('OK');
    expectCloseOrNaN(parity.medianMidTeaPct, exp.medianMidTeaPct);
    expectCloseOrNaN(parity.medianTeaTomadoraPct, exp.medianTeaTomadoraPct);
    expectCloseOrNaN(parity.medianTeaColocadoraPct, exp.medianTeaColocadoraPct);
    expect(parity.bestColocadoraStrike).toBe(exp.bestColocadoraStrike);
    expectCloseOrNaN(parity.bestColocadoraTeaPct, exp.bestColocadoraTeaPct);
    expect(parity.bestTomadoraStrike).toBe(exp.bestTomadoraStrike);
    expectCloseOrNaN(parity.bestTomadoraTeaPct, exp.bestTomadoraTeaPct);

    parity.strikes.forEach((row, idx) => {
      const er = mustAt(exp.strikes, idx);
      expect(row.strike).toBe(er.strike);
      expectCloseOrNaN(row.ivSpreadPp, er.ivSpreadPp);
      expectCloseOrNaN(row.syntheticForwardMid, er.syntheticForwardMid);
      expectCloseOrNaN(row.midImpliedTeaPct, er.midImpliedTeaPct);
      expectCloseOrNaN(row.teaTomadoraPct, er.teaTomadoraPct);
      expectCloseOrNaN(row.teaColocadoraPct, er.teaColocadoraPct);
      expect(row.canLendAboveBenchmark).toBe(er.canLendAboveBenchmark);
      expect(row.canBorrowBelowBenchmark).toBe(er.canBorrowBelowBenchmark);
      expectCloseOrNaN(row.edgeColocadoraBps, er.edgeColocadoraBps);
      expectCloseOrNaN(row.edgeTomadoraBps, er.edgeTomadoraBps);
      // Invariante no-arbitraje bid/ask BBO cuando bid<ask: tasa tomadora >= tasa colocadora
      if (Number.isFinite(row.teaTomadoraPct) && Number.isFinite(row.teaColocadoraPct)) {
        expect(row.teaTomadoraPct).toBeGreaterThanOrEqual(row.teaColocadoraPct - 1e-9);
      }
    });
  });

  it('computes 1:N call/put ratios and relative structure costs + Bjerksund-Stensland 2002 historical percentile (< 1e-11)', () => {
    const ratios: RatiosAndStructureCostsResult = computeRatiosAndStructureCosts(fixture.inputs.ratiosAndStructures);
    const exp = fixture.expected.ratiosAndStructures;
    expect(ratios.status).toBe('OK');

    expect(ratios.callRatios.length).toBe(exp.callRatios.length);
    ratios.callRatios.forEach((r, idx) => {
      const er = mustAt(exp.callRatios, idx);
      expect(r.targetOffsetPct).toBe(er.targetOffsetPct);
      expect(r.longStrike).toBe(er.longStrike);
      expect(r.shortStrike).toBe(er.shortStrike);
      expectCloseOrNaN(r.otmLotsPerBought, er.otmLotsPerBought);
      expectCloseOrNaN(r.netCash1x2, er.netCash1x2);
      expectCloseOrNaN(r.outerBreakeven1x2, er.outerBreakeven1x2);
    });

    expect(ratios.putRatios.length).toBe(exp.putRatios.length);
    ratios.putRatios.forEach((r, idx) => {
      const er = mustAt(exp.putRatios, idx);
      expect(r.targetOffsetPct).toBe(er.targetOffsetPct);
      expect(r.longStrike).toBe(er.longStrike);
      expect(r.shortStrike).toBe(er.shortStrike);
      expectCloseOrNaN(r.otmLotsPerBought, er.otmLotsPerBought);
      expectCloseOrNaN(r.netCash1x2, er.netCash1x2);
      expectCloseOrNaN(r.outerBreakeven1x2, er.outerBreakeven1x2);
    });

    expect(ratios.structures.length).toBe(exp.structures.length);
    ratios.structures.forEach((st, idx) => {
      const es = mustAt(exp.structures, idx);
      expect(st.id).toBe(es.id);
      expect(st.strikes).toEqual(es.strikes);
      expectCloseOrNaN(st.width, es.width);
      expectCloseOrNaN(st.netDebit, es.netDebit);
      expectCloseOrNaN(st.maxProfit, es.maxProfit);
      expectCloseOrNaN(st.costPctOfMaxProfit, es.costPctOfMaxProfit);
      expectCloseOrNaN(st.costPctOfWidth, es.costPctOfWidth);
      expectCloseOrNaN(st.rewardRiskRatio, es.rewardRiskRatio);
      expect(st.bs2002HistoricalObs).toBe(es.bs2002HistoricalObs);
      expectCloseOrNaN(st.bs2002HistoricalPercentile, es.bs2002HistoricalPercentile);
      expectCloseOrNaN(st.bs2002HistoricalMinPct, es.bs2002HistoricalMinPct);
      expectCloseOrNaN(st.bs2002HistoricalMedianPct, es.bs2002HistoricalMedianPct);
      expectCloseOrNaN(st.bs2002HistoricalMaxPct, es.bs2002HistoricalMaxPct);
    });
  });

  it('computes dual BYMA vs OPRA ADR implied surface and theoretical CCL volatility decomposition (< 1e-11)', () => {
    const dual: DualBymaOpraSurfaceResult = computeDualBymaVsOpraSurface(fixture.inputs.dualSurface);
    const exp = fixture.expected.dualSurface;
    expect(dual.status).toBe('OK');
    expectCloseOrNaN(dual.bymaAtmIvPct, exp.bymaAtmIvPct);
    expectCloseOrNaN(dual.opraAtmIvPct, exp.opraAtmIvPct);
    expectCloseOrNaN(dual.theoreticalAtmIvPct, exp.theoreticalAtmIvPct);
    expectCloseOrNaN(dual.atmSpreadBymaVsOpraPp, exp.atmSpreadBymaVsOpraPp);
    expectCloseOrNaN(dual.atmSpreadBymaVsTheoreticalPp, exp.atmSpreadBymaVsTheoreticalPp);

    dual.nodes.forEach((n, idx) => {
      const en = mustAt(exp.nodes, idx);
      expect(n.offsetPct).toBe(en.offsetPct);
      expectCloseOrNaN(n.bymaIvPct, en.bymaIvPct);
      expectCloseOrNaN(n.opraAdrIvPct, en.opraAdrIvPct);
      expectCloseOrNaN(n.theoreticalBymaIvPct, en.theoreticalBymaIvPct);
      expectCloseOrNaN(n.spreadBymaMinusOpraPp, en.spreadBymaMinusOpraPp);
      expectCloseOrNaN(n.spreadBymaMinusTheoreticalPp, en.spreadBymaMinusTheoreticalPp);
    });
  });

  it('returns NO_DATA / NaN cleanly on missing or degenerate inputs (Zero Silent Fallbacks)', () => {
    const badSmile = buildSeparatedOtmSmile({
      spot: 0,
      timeToExpiryYears: 0.1,
      daysToExpiry: 30,
      rate: 0.35,
      dividendYield: 0,
      contracts: [],
    });
    expect(badSmile.status).toBe('NO_DATA');
    expect(Number.isNaN(badSmile.atmIvPct)).toBe(true);

    const badMatrix = buildNormalizedMoneynessMatrix([]);
    expect(badMatrix.status).toBe('NO_DATA');
    expect(badMatrix.termRegime).toBe('NO_DATA');

    const badHist = computeHistoricalVolConditionalTable({
      bars: [{ time: 1700000000, close: 100 }],
      currentIvAtmPct: null,
    });
    expect(badHist.status).toBe('NO_DATA');
    expect(Number.isNaN(badHist.ivRank)).toBe(true);
    expect(badHist.operativeRegime.code).toBe('NO_DATA');

    const badParity = computeParityAndSyntheticRatesByStrike({
      spotMid: -10,
      daysToExpiry: 30,
      dividendYield: 0,
      benchmarkTeaPct: null,
      pairs: [],
    });
    expect(badParity.status).toBe('NO_DATA');

    const badRatios = computeRatiosAndStructureCosts({
      spot: 7000,
      daysToExpiry: 30,
      rate: 0.3,
      dividendYield: 0,
      strikes: [],
    });
    expect(badRatios.status).toBe('NO_DATA');

    const badDual = computeDualBymaVsOpraSurface({
      arUnderlying: 'GGAL',
      adrTicker: 'GGAL',
      adrRatio: 10,
      bymaSpotArs: 0,
      adrSpotUsd: 50,
      cclImplicit: 1200,
      bymaExpiryCode: 'X',
      bymaDays: 30,
      opraExpiryDate: '2026-06-19',
      opraDays: 30,
      bymaCompositeOtmPoints: [],
      opraCompositeOtmPoints: [],
      cclAnnualVolPct: Number.NaN,
      corrAdrCcl: Number.NaN,
    });
    expect(badDual.status).toBe('NO_DATA');
  });

  it('computes daily aligned CCL volatility and ADR/CCL return correlation accurately', () => {
    const daySec = 86_400;
    const baseTime = 1_740_000_000;
    const arBars = Array.from({ length: 40 }, (_, i) => {
      const adr = 50 * Math.exp(0.002 * i + 0.015 * Math.sin(i * 0.4));
      const ccl = 1200 * Math.exp(0.001 * i - 0.006 * Math.cos(i * 0.35));
      return { time: baseTime + i * daySec, close: (adr * ccl) / 10 };
    });
    const adrBars = Array.from({ length: 40 }, (_, i) => ({
      time: baseTime + i * daySec,
      close: 50 * Math.exp(0.002 * i + 0.015 * Math.sin(i * 0.4)),
    }));

    const corrRes = computeCclVolAndAdrCorrelation({
      arBars: deepFreeze(arBars),
      adrBars: deepFreeze(adrBars),
      adrRatio: 10,
    });
    expect(corrRes.status).toBe('OK');
    expect(corrRes.observations).toBe(39);
    expect(corrRes.cclAnnualVolPct).toBeGreaterThan(1);
    expect(corrRes.corrAdrCcl).toBeGreaterThanOrEqual(-1);
    expect(corrRes.corrAdrCcl).toBeLessThanOrEqual(1);

    const shortCorr = computeCclVolAndAdrCorrelation({
      arBars: arBars.slice(0, 5),
      adrBars: adrBars.slice(0, 5),
      adrRatio: 10,
    });
    expect(shortCorr.status).toBe('NO_DATA');
    expect(Number.isNaN(shortCorr.cclAnnualVolPct)).toBe(true);
  });

  it('serializes NaN metrics as clean JSON null without leaking raw NaN/Infinity tokens', () => {
    const partialMatrix = buildNormalizedMoneynessMatrix(fixture.inputs.matrixSlices);
    const partialDual = computeDualBymaVsOpraSurface(fixture.inputs.dualSurface);
    const jsonPayload = JSON.stringify(
      {
        partialMatrix,
        partialDual,
        nonDualMessage: 'Activo sin ADR dual — Ver estructura completa en Tab 2',
      },
      (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? null : v),
    );
    expect(jsonPayload.includes('NaN')).toBe(false);
    expect(jsonPayload.includes('Infinity')).toBe(false);
    expect(jsonPayload).toContain('Activo sin ADR dual — Ver estructura completa en Tab 2');
  });
});
