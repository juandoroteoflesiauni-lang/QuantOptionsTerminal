import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chiSquareInvCdf,
  evaluateDualProbabilityDensity,
  invNormCdf,
  logGamma,
  regularizedIncompleteBeta,
  studentTCdf,
  studentTInvCdf,
  type HistoricalDualObservation,
  type OptionSliceIvNode,
  type PhysicalTerminalNode,
} from '../src/core/ggal/dualDensity.js';
import {
  classifySessionRegime,
  evaluateParityGap,
  type ParityGapInput,
} from '../src/core/ggal/parityGap.js';
import {
  evaluateStrategySelector,
  type StrategySelectorInput,
} from '../src/core/ggal/strategySelector.js';
import {
  computeEffectiveAnexoBOi,
  evaluateStructureAndPinning,
  type StructurePinningInput,
} from '../src/core/ggal/structurePinning.js';
import {
  BYMA_FEE_SCHEDULE,
  computeBymaFeeRate,
  computeBymaShortLoanRate,
  computeExpiration1530ArtUtcSec,
  computeSettlementCalendarDays,
  computeUsEquityFeeRate,
  computeUsOptionFeeRate,
  getBuenosAiresParts,
  getNewYorkPartsAndDst,
  isFinraTafSuspendedUtc,
} from '../src/core/ggal/types.js';
import {
  computeBymaOptionEvalParams,
  computeEwmaCorrelation,
  computeHarRvForecast,
  evaluateCrossCurrencyVolTriangle,
  evaluatePreExDivEarlyExercise,
  greeksBymaAmericanBs02,
  priceBymaAmericanBs02,
  solveBymaAmericanIvHybrid,
  type BymaOptionEvalParamsInput,
  type BymaOptionQuoteInput,
  type DailyLogReturnObservation,
  type EarlyExercisePreExDivInput,
  type OpraMaturitySliceInput,
  type ReturnPairObservation,
} from '../src/core/ggal/volTriangle.js';
import { getFormatterCacheSizeForTests } from '../src/core/sessions.js';

const TOLERANCE = 1e-11;

type NumOrMarker = number | '__NaN__' | '__PosInf__' | '__NegInf__' | null;

function decodeNum(v: NumOrMarker): number {
  if (v === '__NaN__') {
    return Number.NaN;
  }
  if (v === '__PosInf__') {
    return Number.POSITIVE_INFINITY;
  }
  if (v === '__NegInf__') {
    return Number.NEGATIVE_INFINITY;
  }
  if (v === null) {
    return Number.NaN;
  }
  return v;
}

function expectClose(actual: number, expectedRaw: NumOrMarker, tol = TOLERANCE): void {
  const expected = decodeNum(expectedRaw);
  if (Number.isNaN(expected)) {
    expect(Number.isNaN(actual)).toBe(true);
    return;
  }
  expect(Number.isFinite(actual)).toBe(true);
  const scale = Math.max(1, Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol * scale);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        deepFreeze(child);
      }
    }
  }
  return value;
}

interface GgalSpecialistFixture {
  readonly feesAndCalendar: {
    readonly bymaEquityStdRate_1M: number;
    readonly bymaEquityBlockRate_25M: number;
    readonly bymaOptionPremiumRate: number;
    readonly bymaExerciseRate: number;
    readonly bymaSovereignBondRate_exVat: number;
    readonly bymaShortLoan30d: number;
    readonly bymaShortLoan120d_capped90d: number;
    readonly finraTafSuspended_q4_2026: boolean;
    readonly finraTafSuspended_2027: boolean;
    readonly usEquitySellQ4_2026: number;
    readonly usEquitySell2027: number;
    readonly usOptionSellQ4_2026: number;
    readonly usOptionSell2027: number;
    readonly settleCalDaysFriNov20_withNov23Hol: number;
    readonly exp1530ArtDec18: number;
  };
  readonly motor1: {
    readonly input_overlap: ParityGapInput;
    readonly overlap: {
      readonly asOfUtcSec: number;
      readonly sessionRegime: string;
      readonly dstMode: string;
      readonly deltaAr1Days: number;
      readonly deltaUs1Days: number;
      readonly signal: string;
      readonly spot: {
        readonly byma24hArs: number;
        readonly bymaCiArs: NumOrMarker;
        readonly adrMidUsd: number;
        readonly fairBymaOpenArs: number;
        readonly fairAdrUsd: number;
      };
      readonly ccl: {
        readonly cclGgal24h: number;
        readonly cclGgalCiTo24h: NumOrMarker;
        readonly cclAl30_24h: number;
        readonly cclGd30_24h: number;
        readonly cclSovereignBenchmark: number;
        readonly spreadLogBps: number;
        readonly ouMeanBps: number;
        readonly ouHalfLifeDays: number;
        readonly ouEqSigmaBps: number;
        readonly zScore: number;
        readonly netEdgeAfterCostsBps: number;
        readonly closeProbability5d: number;
      };
      readonly ouCalibration: {
        readonly excludedFutureCount: number;
        readonly observationsUsed: number;
        readonly phi: number;
        readonly kappaPerDay: number;
        readonly muLog: number;
        readonly eqSigma: number;
      };
    };
    readonly nasdaqSoloEst: { readonly asOfUtcSec: number; readonly dstMode: string; readonly sessionRegime: string };
    readonly julyCloseEdt: { readonly asOfUtcSec: number; readonly dstMode: string; readonly sessionRegime: string };
    readonly input_preopen: ParityGapInput;
    readonly preopenEdt: {
      readonly sessionRegime: string;
      readonly dstMode: string;
      readonly spot: { readonly fairBymaOpenArs: number };
      readonly preOpenOptionRepricing: readonly {
        readonly tickerByma: string;
        readonly prevCloseArs: number;
        readonly fairOpenArs: number;
        readonly deltaRepricePct: number;
      }[];
    };
    readonly staleLock: { readonly signal: string; readonly cclGgal24h: NumOrMarker };
    readonly eodCierre: { readonly signal: string; readonly ccl: { readonly cclGgal24h: number } };
  };
  readonly motor2: {
    readonly bymaEvalInput: BymaOptionEvalParamsInput;
    readonly unitBs02: {
      readonly evalParams: {
        readonly adjustedSpotArs: number;
        readonly forwardArs: number;
        readonly rEff: number;
        readonly pvDividendsArs: number;
      };
      readonly strike: number;
      readonly sigma: number;
      readonly callPrice: number;
      readonly putPrice: number;
      readonly callGreeks: {
        readonly price: number;
        readonly delta: number;
        readonly gamma: number;
        readonly vega: number;
        readonly theta: number;
        readonly vanna: number;
        readonly charm: number;
      };
      readonly ivCheckFromCallQuote: { readonly iv: number; readonly arbFlag: string };
    };
    readonly preExDivEarlyExercise: {
      readonly input: EarlyExercisePreExDivInput;
      readonly continuationValueArs: number;
      readonly earlyExerciseNetValueArs: number;
      readonly edgeArs: number;
      readonly shouldExerciseEarly: boolean;
    };
    readonly returnHistory: readonly ReturnPairObservation[];
    readonly cclReturnHistory: readonly DailyLogReturnObservation[];
    readonly opraSlices: readonly OpraMaturitySliceInput[];
    readonly normalScenario: {
      readonly bymaOptions: readonly BymaOptionQuoteInput[];
      readonly bymaAtmIvPct: number;
      readonly opraAdrAtmIvPct: number;
      readonly realizedCorrEwma: number;
      readonly harRvCclPct: number;
      readonly impliedCclVolPct: number | null;
      readonly impliedCorrelation: number | null;
      readonly overwritingCompressionScore: number;
      readonly arbViolationsCount: number;
      readonly boundaryRegime: string;
    };
    readonly dualRootScenario: {
      readonly bymaOptions: readonly BymaOptionQuoteInput[];
      readonly realizedCorrEwmaOverride: number;
      readonly harRvCclAnnualOverride: number;
      readonly impliedCclVolPct: number | null;
      readonly impliedCorrelation: number | null;
      readonly boundaryRegime: string;
    };
    readonly violationScenario: {
      readonly bymaOptions: readonly BymaOptionQuoteInput[];
      readonly realizedCorrEwmaOverride: number;
      readonly harRvCclAnnualOverride: number;
      readonly impliedCclVolPct: number | null;
      readonly impliedCorrelation: number | null;
      readonly boundaryRegime: string;
    };
  };
  readonly motor3: {
    readonly specialFunctions: {
      readonly logGamma_5_5: number;
      readonly regIncBeta_035_25_40: number;
      readonly studentTCdf_175_4: number;
      readonly studentTInvCdf_092_4: number;
      readonly invNormCdf_0975: number;
      readonly chi2InvCdf_080_5: number;
    };
    readonly baseConfig: {
      readonly asOfUtcSec: number;
      readonly expiryDate: string;
      readonly dteCalendar: number;
      readonly spotByma24hArs: number;
      readonly spotAdrUsd: number;
      readonly expectedCerGrowthOverHorizon: number;
      readonly historicalSeries: readonly HistoricalDualObservation[];
      readonly copulaSampleCount: number;
      readonly gridSize: number;
      readonly bymaForward: number;
      readonly opraForward: number;
      readonly timeToExpiryYears: number;
      readonly timeToSettleYearsByma: number;
      readonly bymaRiskFree: number;
      readonly opraRiskFree: number;
    };
    readonly bymaNodesAligned: readonly OptionSliceIvNode[];
    readonly opraNodesStd: readonly OptionSliceIvNode[];
    readonly alignedResult: {
      readonly physicalMetricsUsd: {
        readonly expectedReturnPct: number;
        readonly volatilityPct: number;
        readonly cvar95UsdPct: number;
        readonly studentTCopulaDof: number;
        readonly studentTCopulaRho: number;
      };
      readonly riskNeutralBymaArs: {
        readonly impliedMean: number;
        readonly impliedVolPct: number;
        readonly impliedSkewness: number;
        readonly impliedExcessKurtosis: number;
        readonly leftTail10PctProbDiff: number;
        readonly rightTail10PctProbDiff: number;
        readonly klDivergencePvsQ: number;
      };
      readonly riskNeutralOpraUsd: {
        readonly impliedMean: number;
        readonly impliedVolPct: number;
        readonly impliedSkewness: number;
        readonly impliedExcessKurtosis: number;
        readonly leftTail10PctProbDiff: number;
        readonly rightTail10PctProbDiff: number;
        readonly klDivergencePvsQ: number;
      };
      readonly tailDislocationSignal: string;
      readonly simulatedNodes: readonly PhysicalTerminalNode[];
    };
    readonly bymaNodesLeftPanic: readonly OptionSliceIvNode[];
    readonly leftPanicResult: {
      readonly tailDislocationSignal: string;
      readonly riskNeutralBymaArs: {
        readonly leftTail10PctProbDiff: number;
        readonly klDivergencePvsQ: number;
      };
    };
  };
  readonly motor4: {
    readonly inputPinLocked: StructurePinningInput;
    readonly pinLocked: {
      readonly anexoBLagTradingDays: number;
      readonly isExpiryDay: boolean;
      readonly minutesTo1530Cutoff: number | null;
      readonly regime: string;
      readonly zeroGammaLevelArs: NumOrMarker;
      readonly callWallArs: number;
      readonly putWallArs: number;
      readonly peakPinStrikeArs: number;
      readonly maxPinScore: number;
      readonly maxUncoveredCrossedConcentrationPct: number;
      readonly netEffectiveGexArsPer1Pct: number;
      readonly netVannaArsPerVolPt: number;
      readonly netCharmArsPerDay: number;
      readonly bymaNetSignedArs: number;
      readonly adrNetSignedUsd: number;
    };
    readonly inputNegGamma: StructurePinningInput;
    readonly negGamma: {
      readonly isExpiryDay: boolean;
      readonly minutesTo1530Cutoff: number | null;
      readonly regime: string;
      readonly netEffectiveGexArsPer1Pct: number;
    };
  };
  readonly motor5: {
    readonly input: StrategySelectorInput;
    readonly spotChecks: {
      readonly bullCall_5000_5800: {
        readonly id: string;
        readonly expectedValueUnderP: number;
        readonly netSharpeProxy: number;
        readonly opraEquivalentSharpe: number | null;
        readonly bymaAdvantageBps: number | null;
      };
      readonly bearPut_5800_5000: {
        readonly id: string;
        readonly expectedValueUnderP: number;
        readonly netSharpeProxy: number;
      };
      readonly buyWrite_5800: {
        readonly id: string;
        readonly marginRequired: number;
        readonly tnaYieldPct: number;
        readonly spreadOverLecapBps: number;
        readonly expectedValueUnderP: number;
        readonly netSharpeProxy: number;
        readonly opraEquivalentSharpe: number | null;
        readonly bymaAdvantageBps: number | null;
      };
      readonly calendar_5800_di_fe: {
        readonly id: string;
        readonly sigmaFwd: number;
        readonly expectedValueUnderP: number;
        readonly netSharpeProxy: number;
      };
      readonly ratio_1x2: {
        readonly id: string;
        readonly marginRequired: number;
        readonly expectedValueUnderP: number;
        readonly netSharpeProxy: number;
      };
      readonly ratio_1x3: {
        readonly id: string;
        readonly marginRequired: number;
        readonly expectedValueUnderP: number;
        readonly netSharpeProxy: number;
      };
    };
  };
}

function loadFixture(): GgalSpecialistFixture {
  const path = resolve(process.cwd(), 'fixtures', 'ggal_specialist_reference.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as GgalSpecialistFixture;
}

const fx = deepFreeze(loadFixture());

describe('Pieza 20 — GGAL Specialist Core Engines', () => {
  describe('BYMA 2026 Fee Schedule, US Q4-2026 FINRA TAF & Calendars', () => {
    it('matches Python stdlib fee rates (standard, block tier, ex-VAT bonds, short loan, SEC 31, FINRA TAF)', () => {
      const f = fx.feesAndCalendar;
      expectClose(computeBymaFeeRate(1_000_000, 'EQUITY'), f.bymaEquityStdRate_1M);
      expectClose(
        computeBymaFeeRate(25_000_000, 'EQUITY', { ...BYMA_FEE_SCHEDULE, useEquityBlockTier: true }),
        f.bymaEquityBlockRate_25M,
      );
      expectClose(computeBymaFeeRate(100_000, 'OPTION_PREMIUM'), f.bymaOptionPremiumRate);
      expectClose(computeBymaFeeRate(500_000, 'EXERCISE'), f.bymaExerciseRate);
      expectClose(computeBymaFeeRate(1_000_000, 'SOVEREIGN_BOND'), f.bymaSovereignBondRate_exVat);
      expectClose(computeBymaShortLoanRate(30), f.bymaShortLoan30d);
      expectClose(computeBymaShortLoanRate(120), f.bymaShortLoan120d_capped90d);

      const tQ4 = Math.floor(Date.parse('2026-11-18T16:00:00Z') / 1000);
      const t2027 = Math.floor(Date.parse('2027-02-10T16:00:00Z') / 1000);
      expect(isFinraTafSuspendedUtc(tQ4)).toBe(f.finraTafSuspended_q4_2026);
      expect(isFinraTafSuspendedUtc(t2027)).toBe(f.finraTafSuspended_2027);
      expectClose(computeUsEquityFeeRate(tQ4, 45, 'SELL'), f.usEquitySellQ4_2026);
      expectClose(computeUsEquityFeeRate(t2027, 45, 'SELL'), f.usEquitySell2027);
      expectClose(computeUsOptionFeeRate(tQ4, 2.5, 'SELL'), f.usOptionSellQ4_2026);
      expectClose(computeUsOptionFeeRate(t2027, 2.5, 'SELL'), f.usOptionSell2027);

      expect(computeSettlementCalendarDays('2026-11-20', 1, new Set(['2026-11-23']))).toBe(
        f.settleCalDaysFriNov20_withNov23Hol,
      );
      expect(computeExpiration1530ArtUtcSec('2026-12-18')).toBe(f.exp1530ArtDec18);
      // Verify ART clock never mutates core sessions.ts formatter cache size
      expect(getBuenosAiresParts(tQ4).hour).toBe(13);
      expect(getNewYorkPartsAndDst(tQ4).utcOffsetMinutes).toBe(-300);
      expect(getNewYorkPartsAndDst(tQ4).dstMode).toBe('EST');
      expect(getFormatterCacheSizeForTests()).toBeLessThanOrEqual(2);
    });

    it('rejects non-integer / millisecond timestamps without silent fallback', () => {
      expect(isFinraTafSuspendedUtc(1_790_812_800_000)).toBe(false);
      expect(Number.isNaN(computeBymaFeeRate(-100, 'EQUITY'))).toBe(true);
      expect(Number.isNaN(computeUsOptionFeeRate(1_790_812_800_000, 2.5, 'SELL'))).toBe(true);
    });
  });

  describe('Motor 1 — Parity Gap, Sovereign Benchmark & Pre-Open Repricing', () => {
    it('evaluates simultaneous OVERLAP with causal OU exclusion and 4-leg frictions to < 1e-11', () => {
      const m1 = fx.motor1;
      const out = evaluateParityGap(deepFreeze(m1.input_overlap));
      const exp = m1.overlap;

      expect(out.sessionRegime).toBe(exp.sessionRegime);
      expect(out.dstMode).toBe(exp.dstMode);
      expect(out.deltaAr1Days).toBe(exp.deltaAr1Days);
      expect(out.deltaUs1Days).toBe(exp.deltaUs1Days);
      expect(out.signal).toBe(exp.signal);
      expect(out.ouCalibration.excludedFutureCount).toBe(exp.ouCalibration.excludedFutureCount);
      expect(out.ouCalibration.observationsUsed).toBe(exp.ouCalibration.observationsUsed);

      expectClose(out.spot.byma24hArs, exp.spot.byma24hArs);
      expectClose(out.spot.bymaCiArs, exp.spot.bymaCiArs);
      expectClose(out.spot.adrMidUsd, exp.spot.adrMidUsd);
      expectClose(out.spot.fairBymaOpenArs, exp.spot.fairBymaOpenArs);
      expectClose(out.spot.fairAdrUsd, exp.spot.fairAdrUsd);

      expectClose(out.ccl.cclGgal24h, exp.ccl.cclGgal24h);
      expectClose(out.ccl.cclGgalCiTo24h, exp.ccl.cclGgalCiTo24h);
      expectClose(out.ccl.cclAl30_24h, exp.ccl.cclAl30_24h);
      expectClose(out.ccl.cclGd30_24h, exp.ccl.cclGd30_24h);
      expectClose(out.ccl.cclSovereignBenchmark, exp.ccl.cclSovereignBenchmark);
      expectClose(out.ccl.spreadLogBps, exp.ccl.spreadLogBps);
      expectClose(out.ccl.ouMeanBps, exp.ccl.ouMeanBps);
      expectClose(out.ccl.ouHalfLifeDays, exp.ccl.ouHalfLifeDays);
      expectClose(out.ccl.ouEqSigmaBps, exp.ccl.ouEqSigmaBps);
      expectClose(out.ccl.zScore, exp.ccl.zScore);
      expectClose(out.ccl.netEdgeAfterCostsBps, exp.ccl.netEdgeAfterCostsBps);
      expectClose(out.ccl.closeProbability5d, exp.ccl.closeProbability5d);
      expectClose(out.ouCalibration.phi, exp.ouCalibration.phi);
    });

    it('detects EST NASDAQ_SOLO_17_18, July EDT CLOSED, pre-11:00 ART option repricing, STALE_DATA_LOCK and EOD_CIERRE', () => {
      const m1 = fx.motor1;
      const nasdaq = classifySessionRegime(m1.nasdaqSoloEst.asOfUtcSec);
      expect(nasdaq.sessionRegime).toBe(m1.nasdaqSoloEst.sessionRegime);
      expect(nasdaq.dstMode).toBe(m1.nasdaqSoloEst.dstMode);

      const julyClose = classifySessionRegime(m1.julyCloseEdt.asOfUtcSec);
      expect(julyClose.sessionRegime).toBe(m1.julyCloseEdt.sessionRegime);
      expect(julyClose.dstMode).toBe(m1.julyCloseEdt.dstMode);

      const preOpenOut = evaluateParityGap(deepFreeze(m1.input_preopen));
      expect(preOpenOut.sessionRegime).toBe(m1.preopenEdt.sessionRegime);
      expect(preOpenOut.dstMode).toBe(m1.preopenEdt.dstMode);
      expectClose(preOpenOut.spot.fairBymaOpenArs, m1.preopenEdt.spot.fairBymaOpenArs);
      expect(preOpenOut.preOpenOptionRepricing).toHaveLength(1);
      const repr0 = preOpenOut.preOpenOptionRepricing[0];
      const expRepr0 = m1.preopenEdt.preOpenOptionRepricing[0];
      expect(repr0?.tickerByma).toBe(expRepr0?.tickerByma);
      expectClose(repr0?.fairOpenArs ?? Number.NaN, expRepr0?.fairOpenArs ?? '__NaN__');
      expectClose(repr0?.deltaRepricePct ?? Number.NaN, expRepr0?.deltaRepricePct ?? '__NaN__');

      const staleOut = evaluateParityGap(
        deepFreeze({
          ...m1.input_overlap,
          data912TimestampSec: m1.input_overlap.asOfUtcSec - 45,
          marketMode: 'LIVE',
        }),
      );
      expect(staleOut.signal).toBe(m1.staleLock.signal);
      expect(staleOut.feedStalenessSec.data912).toBe(45);

      const invalidQuoteOut = evaluateParityGap(
        deepFreeze({
          ...m1.input_overlap,
          byma24h: { bid: 0, ask: 5110 },
        }),
      );
      expect(Number.isNaN(invalidQuoteOut.ccl.cclGgal24h)).toBe(true);

      const eodOut = evaluateParityGap(
        deepFreeze({
          ...m1.input_overlap,
          data912TimestampSec: m1.input_overlap.asOfUtcSec - 7200,
          massiveTimestampSec: m1.input_overlap.asOfUtcSec - 7200,
          marketMode: 'EOD_CIERRE',
        }),
      );
      expect(eodOut.signal).not.toBe('STALE_DATA_LOCK');
      expectClose(eodOut.ccl.cclGgal24h, m1.eodCierre.ccl.cclGgal24h);
    });

    it('throws on millisecond timestamps cleanly', () => {
      expect(() =>
        evaluateParityGap(
          deepFreeze({
            ...fx.motor1.input_overlap,
            asOfUtcSec: fx.motor1.input_overlap.asOfUtcSec * 1000,
          }),
        ),
      ).toThrow();
    });
  });

  describe('Motor 2 — Cross-Currency Vol Triangle & BYMA BS02 T+0/24hs', () => {
    it('prices and inverts BS02 T+0/24hs with discrete dividends and verifies H_6 early exercise', () => {
      const m2 = fx.motor2;
      const ep = computeBymaOptionEvalParams(deepFreeze(m2.bymaEvalInput));
      expect(ep).not.toBeNull();
      if (ep === null) {
        return;
      }

      expectClose(ep.adjustedSpotArs, m2.unitBs02.evalParams.adjustedSpotArs);
      expectClose(ep.forwardArs, m2.unitBs02.evalParams.forwardArs);
      expectClose(ep.rEff, m2.unitBs02.evalParams.rEff);
      expectClose(ep.pvDividendsArs, m2.unitBs02.evalParams.pvDividendsArs);

      const cPx = priceBymaAmericanBs02(ep, m2.unitBs02.strike, m2.unitBs02.sigma, 'call');
      const pPx = priceBymaAmericanBs02(ep, m2.unitBs02.strike, m2.unitBs02.sigma, 'put');
      expectClose(cPx, m2.unitBs02.callPrice);
      expectClose(pPx, m2.unitBs02.putPrice);

      const g = greeksBymaAmericanBs02(ep, m2.unitBs02.strike, m2.unitBs02.sigma, 'call');
      expectClose(g.price, m2.unitBs02.callGreeks.price);
      expectClose(g.delta, m2.unitBs02.callGreeks.delta);
      expectClose(g.gamma, m2.unitBs02.callGreeks.gamma);
      expectClose(g.vega, m2.unitBs02.callGreeks.vega);
      expectClose(g.theta, m2.unitBs02.callGreeks.theta);
      expectClose(g.vanna, m2.unitBs02.callGreeks.vanna);
      expectClose(g.charm, m2.unitBs02.callGreeks.charm);

      const ivRes = solveBymaAmericanIvHybrid(ep, m2.unitBs02.strike, 'call', {
        bid: m2.unitBs02.callPrice - 2,
        ask: m2.unitBs02.callPrice + 2,
      });
      expect(ivRes.arbFlag).toBe(m2.unitBs02.ivCheckFromCallQuote.arbFlag);
      expectClose(ivRes.iv, m2.unitBs02.ivCheckFromCallQuote.iv, 1e-9);

      const arbViol = solveBymaAmericanIvHybrid(ep, 4400, 'call', {
        bid: ep.adjustedSpotArs - 4430,
        ask: ep.adjustedSpotArs - 4420,
      });
      expect(arbViol.arbFlag).toBe('ARB_INTRINSIC_VIOLATION');
      expect(Number.isNaN(arbViol.iv)).toBe(true);

      const earlyEx = evaluatePreExDivEarlyExercise(deepFreeze(m2.preExDivEarlyExercise.input));
      expect(earlyEx.shouldExerciseEarly).toBe(m2.preExDivEarlyExercise.shouldExerciseEarly);
      expectClose(earlyEx.continuationValueArs, m2.preExDivEarlyExercise.continuationValueArs);
      expectClose(earlyEx.earlyExerciseNetValueArs, m2.preExDivEarlyExercise.earlyExerciseNetValueArs);
      expectClose(earlyEx.edgeArs, m2.preExDivEarlyExercise.edgeArs);
    });

    it('solves Mode A/B NORMAL_UNIQUE_ROOT, DUAL_ROOT_NEG_CORR and VIOLATION_BYMA_COMPRESSED', () => {
      const m2 = fx.motor2;
      const asOf = m2.bymaEvalInput.asOfUtcSec;
      const ewma = computeEwmaCorrelation(deepFreeze(m2.returnHistory), asOf);
      const har = computeHarRvForecast(deepFreeze(m2.cclReturnHistory), asOf);
      expectClose(ewma, m2.normalScenario.realizedCorrEwma);
      expectClose(har, m2.normalScenario.harRvCclPct / 100);

      const outNormal = evaluateCrossCurrencyVolTriangle(
        deepFreeze({
          asOfUtcSec: asOf,
          bymaEval: m2.bymaEvalInput,
          bymaOptions: m2.normalScenario.bymaOptions,
          opraSlices: m2.opraSlices,
          returnHistory: m2.returnHistory,
          cclReturnHistory: m2.cclReturnHistory,
        }),
      );
      expect(outNormal.boundaryRegime).toBe(m2.normalScenario.boundaryRegime);
      expect(outNormal.arbViolationsCount).toBe(m2.normalScenario.arbViolationsCount);
      expectClose(outNormal.bymaAtmIvPct, m2.normalScenario.bymaAtmIvPct, 1e-9);
      expectClose(outNormal.opraAdrAtmIvPct, m2.normalScenario.opraAdrAtmIvPct, 1e-11);
      expectClose(outNormal.impliedCclVolPct ?? Number.NaN, m2.normalScenario.impliedCclVolPct, 1e-9);
      expectClose(outNormal.impliedCorrelation ?? Number.NaN, m2.normalScenario.impliedCorrelation, 1e-9);
      expectClose(
        outNormal.skewMetrics.overwritingCompressionScore,
        m2.normalScenario.overwritingCompressionScore,
        1e-9,
      );

      const outDual = evaluateCrossCurrencyVolTriangle(
        deepFreeze({
          asOfUtcSec: asOf,
          bymaEval: m2.bymaEvalInput,
          bymaOptions: m2.dualRootScenario.bymaOptions,
          opraSlices: m2.opraSlices,
          realizedCorrEwmaOverride: m2.dualRootScenario.realizedCorrEwmaOverride,
          harRvCclAnnualOverride: m2.dualRootScenario.harRvCclAnnualOverride,
        }),
      );
      expect(outDual.boundaryRegime).toBe(m2.dualRootScenario.boundaryRegime);
      expectClose(outDual.impliedCclVolPct ?? Number.NaN, m2.dualRootScenario.impliedCclVolPct, 1e-9);
      expectClose(outDual.impliedCorrelation ?? Number.NaN, m2.dualRootScenario.impliedCorrelation, 1e-9);

      const outViol = evaluateCrossCurrencyVolTriangle(
        deepFreeze({
          asOfUtcSec: asOf,
          bymaEval: m2.bymaEvalInput,
          bymaOptions: m2.violationScenario.bymaOptions,
          opraSlices: m2.opraSlices,
          realizedCorrEwmaOverride: m2.violationScenario.realizedCorrEwmaOverride,
          harRvCclAnnualOverride: m2.violationScenario.harRvCclAnnualOverride,
        }),
      );
      expect(outViol.boundaryRegime).toBe(m2.violationScenario.boundaryRegime);
      expect(outViol.impliedCclVolPct).toBeNull();
      expectClose(outViol.impliedCorrelation ?? Number.NaN, m2.violationScenario.impliedCorrelation, 1e-9);
    });
  });

  describe('Motor 3 — Dual Probability Density P (USD/CER + t-Copula) vs. Q (SVI + BL)', () => {
    it('matches special functions (logGamma, Beta, Student-t, invNorm, Chi2) to < 1e-11', () => {
      const sp = fx.motor3.specialFunctions;
      expectClose(logGamma(5.5), sp.logGamma_5_5);
      expectClose(regularizedIncompleteBeta(0.35, 2.5, 4), sp.regIncBeta_035_25_40);
      expectClose(studentTCdf(1.75, 4), sp.studentTCdf_175_4);
      expectClose(studentTInvCdf(0.92, 4), sp.studentTInvCdf_092_4, 1e-10);
      expectClose(invNormCdf(0.975), sp.invNormCdf_0975, 1e-9);
      expectClose(chiSquareInvCdf(0.8, 5), sp.chi2InvCdf_080_5, 1e-9);
    });

    it('evaluates CER-deflated Student-t copula, Zeliade SVI, KL divergence and 10% tail dislocation', () => {
      const m3 = fx.motor3;
      const cfg = m3.baseConfig;

      const outAligned = evaluateDualProbabilityDensity(
        deepFreeze({
          asOfUtcSec: cfg.asOfUtcSec,
          expiryDate: cfg.expiryDate,
          dteCalendar: cfg.dteCalendar,
          spotByma24hArs: cfg.spotByma24hArs,
          spotAdrUsd: cfg.spotAdrUsd,
          expectedCerGrowthOverHorizon: cfg.expectedCerGrowthOverHorizon,
          historicalSeries: cfg.historicalSeries,
          copulaSampleCount: cfg.copulaSampleCount,
          gridSize: cfg.gridSize,
          bymaMarket: {
            forwardPrice: cfg.bymaForward,
            timeToExpiryYears: cfg.timeToExpiryYears,
            riskFreeContinuous: cfg.bymaRiskFree,
            timeToSettleYears: cfg.timeToSettleYearsByma,
            nodes: m3.bymaNodesAligned,
          },
          opraMarket: {
            forwardPrice: cfg.opraForward,
            timeToExpiryYears: cfg.timeToExpiryYears,
            riskFreeContinuous: cfg.opraRiskFree,
            timeToSettleYears: cfg.timeToExpiryYears,
            nodes: m3.opraNodesStd,
          },
        }),
      );

      expect(outAligned.physicalMetricsUsd.status).toBe('OK');
      expect(outAligned.tailDislocationSignal).toBe(m3.alignedResult.tailDislocationSignal);
      expect(outAligned.simulatedNodes).toHaveLength(m3.alignedResult.simulatedNodes.length);

      expectClose(
        outAligned.physicalMetricsUsd.expectedReturnPct,
        m3.alignedResult.physicalMetricsUsd.expectedReturnPct,
        1e-9,
      );
      expectClose(
        outAligned.physicalMetricsUsd.volatilityPct,
        m3.alignedResult.physicalMetricsUsd.volatilityPct,
        1e-9,
      );
      expectClose(
        outAligned.physicalMetricsUsd.cvar95UsdPct,
        m3.alignedResult.physicalMetricsUsd.cvar95UsdPct,
        1e-9,
      );
      expectClose(
        outAligned.physicalMetricsUsd.studentTCopulaDof,
        m3.alignedResult.physicalMetricsUsd.studentTCopulaDof,
        1e-9,
      );
      expectClose(
        outAligned.physicalMetricsUsd.studentTCopulaRho,
        m3.alignedResult.physicalMetricsUsd.studentTCopulaRho,
        1e-9,
      );

      expectClose(outAligned.riskNeutralBymaArs.impliedMeanArs, m3.alignedResult.riskNeutralBymaArs.impliedMean, 1e-8);
      expectClose(
        outAligned.riskNeutralBymaArs.impliedVolPct,
        m3.alignedResult.riskNeutralBymaArs.impliedVolPct,
        1e-9,
      );
      expectClose(
        outAligned.riskNeutralBymaArs.impliedSkewness,
        m3.alignedResult.riskNeutralBymaArs.impliedSkewness,
        1e-9,
      );
      expectClose(
        outAligned.riskNeutralBymaArs.klDivergencePvsQ,
        m3.alignedResult.riskNeutralBymaArs.klDivergencePvsQ,
        1e-9,
      );
      expectClose(
        outAligned.riskNeutralBymaArs.leftTail10PctProbDiff,
        m3.alignedResult.riskNeutralBymaArs.leftTail10PctProbDiff,
        1e-9,
      );
      expectClose(
        outAligned.riskNeutralOpraUsd.klDivergencePvsQ,
        m3.alignedResult.riskNeutralOpraUsd.klDivergencePvsQ,
        1e-9,
      );

      const outPanic = evaluateDualProbabilityDensity(
        deepFreeze({
          asOfUtcSec: cfg.asOfUtcSec,
          expiryDate: cfg.expiryDate,
          dteCalendar: cfg.dteCalendar,
          spotByma24hArs: cfg.spotByma24hArs,
          spotAdrUsd: cfg.spotAdrUsd,
          expectedCerGrowthOverHorizon: cfg.expectedCerGrowthOverHorizon,
          historicalSeries: cfg.historicalSeries,
          copulaSampleCount: cfg.copulaSampleCount,
          gridSize: cfg.gridSize,
          bymaMarket: {
            forwardPrice: cfg.bymaForward,
            timeToExpiryYears: cfg.timeToExpiryYears,
            riskFreeContinuous: cfg.bymaRiskFree,
            timeToSettleYears: cfg.timeToSettleYearsByma,
            nodes: m3.bymaNodesLeftPanic,
          },
          opraMarket: {
            forwardPrice: cfg.opraForward,
            timeToExpiryYears: cfg.timeToExpiryYears,
            riskFreeContinuous: cfg.opraRiskFree,
            timeToSettleYears: cfg.timeToExpiryYears,
            nodes: m3.opraNodesStd,
          },
        }),
      );
      expect(outPanic.tailDislocationSignal).toBe(m3.leftPanicResult.tailDislocationSignal);
      expectClose(
        outPanic.riskNeutralBymaArs.leftTail10PctProbDiff,
        m3.leftPanicResult.riskNeutralBymaArs.leftTail10PctProbDiff,
        1e-9,
      );

      const noDataOut = evaluateDualProbabilityDensity(
        deepFreeze({
          asOfUtcSec: cfg.asOfUtcSec,
          expiryDate: cfg.expiryDate,
          dteCalendar: cfg.dteCalendar,
          spotByma24hArs: cfg.spotByma24hArs,
          spotAdrUsd: cfg.spotAdrUsd,
          expectedCerGrowthOverHorizon: cfg.expectedCerGrowthOverHorizon,
          historicalSeries: cfg.historicalSeries.slice(0, 5),
          bymaMarket: {
            forwardPrice: cfg.bymaForward,
            timeToExpiryYears: cfg.timeToExpiryYears,
            riskFreeContinuous: cfg.bymaRiskFree,
            timeToSettleYears: cfg.timeToSettleYearsByma,
            nodes: m3.bymaNodesAligned,
          },
          opraMarket: {
            forwardPrice: cfg.opraForward,
            timeToExpiryYears: cfg.timeToExpiryYears,
            riskFreeContinuous: cfg.opraRiskFree,
            timeToSettleYears: cfg.timeToExpiryYears,
            nodes: m3.opraNodesStd,
          },
        }),
      );
      expect(noDataOut.physicalMetricsUsd.status).toBe('NO_DATA');
      expect(noDataOut.tailDislocationSignal).toBe('NO_DATA');
    });
  });

  describe('Motor 4 — Anexo B IAMC, Signed GEX/Vanna/Charm, Zero-Gamma & 15:30 ART Pinning', () => {
    it('detects PIN_LOCKED on expiry afternoon with Lee-Ready ADR + 20s BYMA snapshots', () => {
      const m4 = fx.motor4;
      expect(
        computeEffectiveAnexoBOi({
          coveredNom: 1000,
          uncoveredNom: 500,
          oppositeNom: 200,
          crossedNom: 100,
        }),
      ).toBe(1 * 500 + 0.75 * 100 + 0.35 * 200 + 0.025 * 1000);

      const out = evaluateStructureAndPinning(deepFreeze(m4.inputPinLocked));
      const exp = m4.pinLocked;

      expect(out.anexoBLagTradingDays).toBe(exp.anexoBLagTradingDays);
      expect(out.isExpiryDay).toBe(exp.isExpiryDay);
      expect(out.minutesTo1530Cutoff).toBe(exp.minutesTo1530Cutoff);
      expect(out.regime).toBe(exp.regime);
      expect(out.callWallArs).toBe(exp.callWallArs);
      expect(out.putWallArs).toBe(exp.putWallArs);
      expect(out.peakPinStrikeArs).toBe(exp.peakPinStrikeArs);

      expectClose(out.zeroGammaLevelArs, exp.zeroGammaLevelArs, 1e-9);
      expectClose(out.maxPinScore, exp.maxPinScore, 1e-11);
      expectClose(
        out.maxUncoveredCrossedConcentrationPct,
        exp.maxUncoveredCrossedConcentrationPct,
        1e-11,
      );
      expectClose(out.netEffectiveGexArsPer1Pct, exp.netEffectiveGexArsPer1Pct, 1e-10);
      // 2da derivada cruzada FD Put Vanna (1/(4*dS*dSig) ~ 2.5e7) amplifica ~1e-15 erfc Cody vs libm a ~4e-9 rel (ver tests/optionsAmerican.test.ts).
      expectClose(out.netVannaArsPerVolPt, exp.netVannaArsPerVolPt, 1e-7);
      expectClose(out.netCharmArsPerDay, exp.netCharmArsPerDay, 1e-9);
      expectClose(out.intradayFlow.bymaNetSignedArs, exp.bymaNetSignedArs);
      expectClose(out.intradayFlow.adrNetSignedUsd, exp.adrNetSignedUsd);
    });

    it('detects NEGATIVE_GAMMA_TRENDING outside expiry day and returns NO_DATA on empty strikes', () => {
      const m4 = fx.motor4;
      const negOut = evaluateStructureAndPinning(deepFreeze(m4.inputNegGamma));
      expect(negOut.isExpiryDay).toBe(m4.negGamma.isExpiryDay);
      expect(negOut.minutesTo1530Cutoff).toBeNull();
      expect(negOut.regime).toBe(m4.negGamma.regime);
      // En escenario dominado por Puts BS02, Gamma FD 2do orden (1/dS^2 ~ 1e8) amplifica ~7.7e-15 en precio a ~1.9e-8 rel.
      expectClose(negOut.netEffectiveGexArsPer1Pct, m4.negGamma.netEffectiveGexArsPer1Pct, 1e-7);

      const emptyOut = evaluateStructureAndPinning(
        deepFreeze({ ...m4.inputPinLocked, strikes: [] }),
      );
      expect(emptyOut.regime).toBe('NO_DATA');
      expect(Number.isNaN(emptyOut.zeroGammaLevelArs)).toBe(true);
    });
  });

  describe('Motor 5 — GGAL Specialist Strategy Selector (BYMA Bid/Ask + Costos vs. OPRA USD)', () => {
    it('evaluates all 6 families accurately vs Python reference and enforces OI / 1.5x round-trip thresholds', () => {
      const m5 = fx.motor5;

      // 1) Evaluación sin filtro para auditar las 6 familias completas contra referencia Python
      const allOut = evaluateStrategySelector(
        deepFreeze({
          ...m5.input,
          filterThresholds: { enforceThresholds: false },
        }),
      );
      expect(allOut.status).toBe('OK');

      const findById = (id: string) => {
        const found = allOut.rankedStrategies.find((s) => s.id === id);
        expect(found).toBeDefined();
        return found;
      };

      const bcs = findById(m5.spotChecks.bullCall_5000_5800.id);
      expect(bcs?.family).toBe('BULL_CALL_SPREAD');
      expectClose(bcs?.economics.expectedValueUnderP ?? Number.NaN, m5.spotChecks.bullCall_5000_5800.expectedValueUnderP);
      expectClose(bcs?.economics.netSharpeProxy ?? Number.NaN, m5.spotChecks.bullCall_5000_5800.netSharpeProxy);
      expectClose(
        bcs?.usdAlternativeComparison.opraEquivalentSharpe ?? Number.NaN,
        m5.spotChecks.bullCall_5000_5800.opraEquivalentSharpe,
      );
      expectClose(
        bcs?.usdAlternativeComparison.bymaAdvantageBps ?? Number.NaN,
        m5.spotChecks.bullCall_5000_5800.bymaAdvantageBps,
        1e-9,
      );

      const bps = findById(m5.spotChecks.bearPut_5800_5000.id);
      expect(bps?.family).toBe('BEAR_PUT_SPREAD');
      expectClose(bps?.economics.expectedValueUnderP ?? Number.NaN, m5.spotChecks.bearPut_5800_5000.expectedValueUnderP);
      expectClose(bps?.economics.netSharpeProxy ?? Number.NaN, m5.spotChecks.bearPut_5800_5000.netSharpeProxy);

      const bw = findById(m5.spotChecks.buyWrite_5800.id);
      expect(bw?.family).toBe('BUY_WRITE_T0');
      expectClose(bw?.economics.marginRequired ?? Number.NaN, m5.spotChecks.buyWrite_5800.marginRequired);
      expectClose(bw?.economics.tnaYieldPct ?? Number.NaN, m5.spotChecks.buyWrite_5800.tnaYieldPct);
      expectClose(bw?.economics.spreadOverLecapBps ?? Number.NaN, m5.spotChecks.buyWrite_5800.spreadOverLecapBps);
      expectClose(bw?.economics.expectedValueUnderP ?? Number.NaN, m5.spotChecks.buyWrite_5800.expectedValueUnderP);
      expectClose(bw?.economics.netSharpeProxy ?? Number.NaN, m5.spotChecks.buyWrite_5800.netSharpeProxy);
      expectClose(
        bw?.usdAlternativeComparison.opraEquivalentSharpe ?? Number.NaN,
        m5.spotChecks.buyWrite_5800.opraEquivalentSharpe,
      );
      expectClose(
        bw?.usdAlternativeComparison.bymaAdvantageBps ?? Number.NaN,
        m5.spotChecks.buyWrite_5800.bymaAdvantageBps,
        1e-9,
      );

      const cal = findById(m5.spotChecks.calendar_5800_di_fe.id);
      expect(cal?.family).toBe('CALENDAR_ROLL_2M');
      expectClose(cal?.economics.expectedValueUnderP ?? Number.NaN, m5.spotChecks.calendar_5800_di_fe.expectedValueUnderP);
      expectClose(cal?.economics.netSharpeProxy ?? Number.NaN, m5.spotChecks.calendar_5800_di_fe.netSharpeProxy);

      const r12 = findById(m5.spotChecks.ratio_1x2.id);
      expect(r12?.family).toBe('RATIO_1X2');
      expectClose(r12?.economics.marginRequired ?? Number.NaN, m5.spotChecks.ratio_1x2.marginRequired);
      expectClose(r12?.economics.expectedValueUnderP ?? Number.NaN, m5.spotChecks.ratio_1x2.expectedValueUnderP);
      expectClose(r12?.economics.netSharpeProxy ?? Number.NaN, m5.spotChecks.ratio_1x2.netSharpeProxy);

      const r13 = findById(m5.spotChecks.ratio_1x3.id);
      expect(r13?.family).toBe('RATIO_1X3');
      expectClose(r13?.economics.marginRequired ?? Number.NaN, m5.spotChecks.ratio_1x3.marginRequired);
      expectClose(r13?.economics.expectedValueUnderP ?? Number.NaN, m5.spotChecks.ratio_1x3.expectedValueUnderP);
      expectClose(r13?.economics.netSharpeProxy ?? Number.NaN, m5.spotChecks.ratio_1x3.netSharpeProxy);

      // 2) Evaluación con filtros institucionales por defecto: excluye strike ilíquido (<100,000 VN) y EV<=0
      const strictOut = evaluateStrategySelector(deepFreeze(m5.input));
      expect(strictOut.rankedStrategies.some((s) => s.id.includes('6600'))).toBe(false);
      expect(strictOut.rankedStrategies.every((s) => s.economics.expectedValueUnderP > 0)).toBe(true);
      // Verificar orden descendente por netSharpeProxy
      for (let i = 1; i < strictOut.rankedStrategies.length; i += 1) {
        const prev = strictOut.rankedStrategies[i - 1];
        const cur = strictOut.rankedStrategies[i];
        if (prev && cur) {
          expect(prev.economics.netSharpeProxy).toBeGreaterThanOrEqual(cur.economics.netSharpeProxy - 1e-12);
        }
      }
    });

    it('never silently falls back when Buy-Write spot ask is 0 or physicalNodes empty', () => {
      const badSpotAsk = evaluateStrategySelector(
        deepFreeze({
          ...fx.motor5.input,
          spotByma24hQuote: { bid: 5196, ask: 0 },
          filterThresholds: { enforceThresholds: false },
        }),
      );
      expect(badSpotAsk.rankedStrategies.some((s) => s.family === 'BUY_WRITE_T0')).toBe(false);

      const noNodes = evaluateStrategySelector(
        deepFreeze({
          ...fx.motor5.input,
          physicalNodes: [],
        }),
      );
      expect(noNodes.status).toBe('NO_DATA');
      expect(noNodes.rankedStrategies).toHaveLength(0);
    });
  });
});
