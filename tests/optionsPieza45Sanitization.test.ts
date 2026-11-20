import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractRiskNeutralDistributionQ,
  extractSmoothedRiskNeutralDistributionQ,
} from '../src/core/options/probabilisticDivergence.js';
import {
  computeSyntheticImpliedRates,
  type SyntheticStrikePairInput,
} from '../src/core/options/syntheticRates.js';
import {
  computeVerticalSpreadMetrics,
  isValidButterflyStrikes,
  isValidCalendarSpread,
  resolveOptionsMarketCurrencyConfig,
  type VerticalSpreadLegQuote,
} from '../src/core/options/verticalSpreads.js';
import {
  computeActiveExpiryVrpAndRegime,
  computeParityAndSyntheticRatesByStrike,
  computeRatiosAndStructureCosts,
} from '../src/core/options/volAnalyticsSuite.js';
import {
  optimizeOptionStructures,
  type OptimizerOptionContractInput,
} from '../src/core/terminal/structureOptimizer.js';

interface Pieza45Fixture {
  readonly vrpCases: readonly {
    readonly name: string;
    readonly input: {
      readonly expiryCode: string | null;
      readonly daysToExpiry: number | null;
      readonly ivAtmActiveExpiryPct: number | null;
      readonly sameExpiryFallbackIvAtmPct: number | null;
      readonly rvReferencePct: number | null;
      readonly rvReferenceLabel: string;
      readonly historicalRvSeriesPct: readonly number[];
    };
    readonly expected: {
      readonly status: 'OK' | 'NO_DATA';
      readonly expiryCode: string | null;
      readonly daysToExpiry: number | null;
      readonly ivAtmActiveExpiryPct: number | null;
      readonly ivSource: 'INTERPOLATED_ATM' | 'SAME_EXPIRY_FALLBACK' | 'NO_DATA';
      readonly rvReferencePct: number | null;
      readonly rvReferenceLabel: string;
      readonly vrpActiveExpiryPts: number | null;
      readonly ivRankActiveExpiry: number | null;
      readonly ivPercentileActiveExpiry: number | null;
      readonly operativeRegime: {
        readonly code:
          | 'VENTA_PRIMA_CUBIERTA'
          | 'COMPRA_CONVEXIDAD_CALENDAR'
          | 'NEUTRAL_SELECTIVO'
          | 'NO_DATA';
        readonly label: string;
      };
    };
  }[];
  readonly dteGateSynthCases: readonly {
    readonly name: string;
    readonly input: {
      readonly spot: number;
      readonly riskFreeRate: number;
      readonly dividendYield: number;
      readonly timeToExpiry: number;
      readonly dte: number;
      readonly pairs: readonly SyntheticStrikePairInput[];
    };
    readonly expected: {
      readonly status: 'OK' | 'NO_DATA';
      readonly impliedRateStatus: 'OK' | 'BLOCKED_SHORT_DTE' | 'NO_DATA';
      readonly medianImpliedRate: number | null;
      readonly medianImpliedTna: number | null;
      readonly impliedBorrowRate: number | null;
      readonly htbAlert: boolean;
      readonly borrowRegime:
        | 'EASY_TO_BORROW'
        | 'MODERATE_SHORT_DEMAND'
        | 'HARD_TO_BORROW_SQUEEZE_ALERT'
        | 'NO_DATA';
      readonly strikes: readonly {
        readonly strike: number;
        readonly callMid: number;
        readonly putMid: number;
        readonly syntheticForward: number;
        readonly impliedRateContinuous: number | null;
        readonly impliedTna: number | null;
        readonly absLogMoneyness: number;
      }[];
    };
  }[];
  readonly dteGateParityCases: readonly {
    readonly name: string;
    readonly input: {
      readonly spotMid: number;
      readonly spotBid: number;
      readonly spotAsk: number;
      readonly daysToExpiry: number;
      readonly dividendYield: number;
      readonly benchmarkTeaPct: number;
      readonly pairs: readonly {
        readonly strike: number;
        readonly callBid: number | null;
        readonly callAsk: number | null;
        readonly callMid: number | null;
        readonly callIvPct: number | null;
        readonly putBid: number | null;
        readonly putAsk: number | null;
        readonly putMid: number | null;
        readonly putIvPct: number | null;
      }[];
    };
    readonly expected: {
      readonly status: 'OK' | 'NO_DATA';
      readonly impliedRateStatus: 'OK' | 'BLOCKED_SHORT_DTE' | 'NO_DATA';
      readonly daysToExpiry: number;
      readonly medianMidTeaPct: number | null;
      readonly medianTeaTomadoraPct: number | null;
      readonly medianTeaColocadoraPct: number | null;
      readonly bestColocadoraStrike: number | null;
      readonly bestColocadoraTeaPct: number | null;
      readonly bestTomadoraStrike: number | null;
      readonly bestTomadoraTeaPct: number | null;
      readonly strikes: readonly {
        readonly strike: number;
        readonly syntheticForwardMid: number;
        readonly midImpliedTeaPct: number | null;
        readonly teaTomadoraPct: number | null;
        readonly teaColocadoraPct: number | null;
      }[];
    };
  }[];
  readonly smoothedBlDensityCase: {
    readonly name: string;
    readonly input: {
      readonly spot: number;
      readonly rate: number;
      readonly dividendYield: number;
      readonly timeToExpiry: number;
      readonly uniformGridSteps: number;
      readonly nodes: readonly {
        readonly strike: number;
        readonly iv: number;
        readonly bid: number | null;
      }[];
    };
    readonly expected: {
      readonly rawArea: number;
      readonly normalizedArea: number;
      readonly meanQ: number;
      readonly varianceQ: number;
      readonly stdDevQ: number;
      readonly skewnessQ: number;
      readonly excessKurtosisQ: number;
      readonly nodes: readonly {
        readonly strike: number;
        readonly iv: number;
        readonly callPrice: number;
        readonly dCdK: number;
        readonly d2CdK2: number;
        readonly probAboveQ: number;
        readonly rawDensityQ: number;
        readonly densityQ: number;
      }[];
    };
  };
  readonly verticalSpreadCases: readonly {
    readonly name: string;
    readonly input: {
      readonly side: 'CALL' | 'PUT';
      readonly longLeg: VerticalSpreadLegQuote;
      readonly shortLeg: VerticalSpreadLegQuote;
      readonly spot: number;
      readonly daysToExpiry: number;
      readonly rateDec: number;
      readonly atmIvDec: number;
    };
    readonly expected: {
      readonly valid: boolean;
      readonly eligibleForAutoRanking: boolean;
      readonly reason: string | null;
      readonly width: number | null;
      readonly debit: number | null;
      readonly maxProfit: number | null;
      readonly rewardRiskRatio: number | null;
      readonly breakeven: number | null;
      readonly breakevenDistPct: number | null;
      readonly probAtBreakevenPct: number | null;
      readonly edgePct: number | null;
      readonly longBidAskPctOfMid: number | null;
      readonly shortBidAskPctOfMid: number | null;
      readonly bidAskPctOfMid: number | null;
      readonly liquiditySemaphore: 'GREEN' | 'YELLOW' | 'RED' | 'NO_DATA';
    };
  }[];
  readonly currencySizingCases: readonly {
    readonly name: string;
    readonly input: {
      readonly market: 'US' | 'AR';
      readonly premiumPerShare: number;
      readonly budget: number;
    };
    readonly expected: {
      readonly market: 'US' | 'AR';
      readonly currencyCode: 'USD' | 'ARS';
      readonly currencyPrefix: 'US$' | '$';
      readonly contractMultiplier: number;
      readonly budgetPresets: readonly number[];
      readonly defaultBudget: number;
      readonly costPerContract: number;
      readonly maxContractsForBudget: number;
    };
  }[];
  readonly butterflyCases: readonly {
    readonly k1: number;
    readonly k2: number;
    readonly k3: number;
    readonly requireSymmetry: boolean;
    readonly expected: boolean;
  }[];
}

const fixturePath = join(process.cwd(), 'fixtures', 'options_pieza45_reference.json');
const fixture: Pieza45Fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Pieza45Fixture;
const TOL = 1e-9;

function expectCloseOrNullOrNaN(
  actual: number | null | undefined,
  expected: number | null,
  tol = TOL,
): void {
  if (expected === null) {
    const isNullOrNaN = actual === null || actual === undefined || Number.isNaN(actual);
    expect(isNullOrNaN).toBe(true);
  } else {
    expect(typeof actual).toBe('number');
    expect(Number.isFinite(actual as number)).toBe(true);
    expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tol);
  }
}

describe('Pieza 45 — Saneamiento Matemático, Liquidez y Fixes Críticos del Módulo de Opciones', () => {
  describe('1. VRP Alineado al Vencimiento Activo (computeActiveExpiryVrpAndRegime)', () => {
    it('coincide con la referencia Python (<= 1e-9) para QQQ 4d (+0.3 pts neutral), 30d (+10.3 pts venta prima), 45d (compra convexidad), fallback mismo vto y NO_DATA', () => {
      for (const testCase of fixture.vrpCases) {
        const res = computeActiveExpiryVrpAndRegime(testCase.input);

        expect(res.status).toBe(testCase.expected.status);
        expect(res.expiryCode).toBe(testCase.expected.expiryCode);
        expect(res.daysToExpiry).toBe(testCase.expected.daysToExpiry);
        expect(res.ivSource).toBe(testCase.expected.ivSource);
        expect(res.rvReferenceLabel).toBe(testCase.expected.rvReferenceLabel);
        expect(res.operativeRegime.code).toBe(testCase.expected.operativeRegime.code);
        expect(res.operativeRegime.label).toBe(testCase.expected.operativeRegime.label);

        expectCloseOrNullOrNaN(res.ivAtmActiveExpiryPct, testCase.expected.ivAtmActiveExpiryPct);
        expectCloseOrNullOrNaN(res.rvReferencePct, testCase.expected.rvReferencePct);
        expectCloseOrNullOrNaN(res.vrpActiveExpiryPts, testCase.expected.vrpActiveExpiryPts);
        expectCloseOrNullOrNaN(res.ivRankActiveExpiry, testCase.expected.ivRankActiveExpiry);
        expectCloseOrNullOrNaN(
          res.ivPercentileActiveExpiry,
          testCase.expected.ivPercentileActiveExpiry,
        );
      }
    });
  });

  describe('2. Gate DTE < 3 en Paridad Put-Call, Tasas Sintéticas y HTB Squeeze Alert', () => {
    it('bloquea la anualización de tasa y HARD_TO_BORROW_SQUEEZE_ALERT cuando DTE < 3 (1DTE y 2DTE) y la habilita en DTE >= 3 (5DTE)', () => {
      for (const testCase of fixture.dteGateSynthCases) {
        const res = computeSyntheticImpliedRates(testCase.input);

        expect(res.status).toBe(testCase.expected.status);
        expect(res.impliedRateStatus).toBe(testCase.expected.impliedRateStatus);
        expect(res.htbAlert).toBe(testCase.expected.htbAlert);
        expect(res.borrowRegime).toBe(testCase.expected.borrowRegime);

        expectCloseOrNullOrNaN(res.medianImpliedRate, testCase.expected.medianImpliedRate);
        expectCloseOrNullOrNaN(res.medianImpliedTna, testCase.expected.medianImpliedTna);
        expectCloseOrNullOrNaN(res.impliedBorrowRate, testCase.expected.impliedBorrowRate);

        if (testCase.expected.impliedBorrowRate === null) {
          expect(res.impliedBorrowRateNullable).toBeNull();
        } else {
          expect(res.impliedBorrowRateNullable).not.toBeNull();
          expect(
            Math.abs((res.impliedBorrowRateNullable ?? 0) - testCase.expected.impliedBorrowRate),
          ).toBeLessThanOrEqual(TOL);
        }

        expect(res.strikes.length).toBe(testCase.expected.strikes.length);
        res.strikes.forEach((node, idx) => {
          const expNode = testCase.expected.strikes[idx];
          if (!expNode) throw new Error(`Missing expected strike at index ${String(idx)}`);
          expect(node.strike).toBe(expNode.strike);
          expectCloseOrNullOrNaN(node.callMid, expNode.callMid);
          expectCloseOrNullOrNaN(node.putMid, expNode.putMid);
          expectCloseOrNullOrNaN(node.syntheticForward, expNode.syntheticForward);
          expectCloseOrNullOrNaN(node.impliedRateContinuous, expNode.impliedRateContinuous);
          expectCloseOrNullOrNaN(node.impliedTna, expNode.impliedTna);
          expectCloseOrNullOrNaN(node.absLogMoneyness, expNode.absLogMoneyness);
        });
      }
    });

    it('suspende TEA sintética por strike en computeParityAndSyntheticRatesByStrike cuando daysToExpiry < 3 conservando syntheticForwardMid', () => {
      for (const testCase of fixture.dteGateParityCases) {
        const res = computeParityAndSyntheticRatesByStrike({
          ...testCase.input,
          benchmarkLabel: 'Benchmark',
        });

        expect(res.status).toBe(testCase.expected.status);
        expect(res.impliedRateStatus).toBe(testCase.expected.impliedRateStatus);
        expect(res.daysToExpiry).toBe(testCase.expected.daysToExpiry);

        expectCloseOrNullOrNaN(res.medianMidTeaPct, testCase.expected.medianMidTeaPct);
        expectCloseOrNullOrNaN(res.medianTeaTomadoraPct, testCase.expected.medianTeaTomadoraPct);
        expectCloseOrNullOrNaN(
          res.medianTeaColocadoraPct,
          testCase.expected.medianTeaColocadoraPct,
        );
        expectCloseOrNullOrNaN(res.bestColocadoraStrike, testCase.expected.bestColocadoraStrike);
        expectCloseOrNullOrNaN(res.bestColocadoraTeaPct, testCase.expected.bestColocadoraTeaPct);
        expectCloseOrNullOrNaN(res.bestTomadoraStrike, testCase.expected.bestTomadoraStrike);
        expectCloseOrNullOrNaN(res.bestTomadoraTeaPct, testCase.expected.bestTomadoraTeaPct);

        expect(res.strikes.length).toBe(testCase.expected.strikes.length);
        res.strikes.forEach((st, idx) => {
          const expSt = testCase.expected.strikes[idx];
          if (!expSt) throw new Error(`Missing expected parity strike at index ${String(idx)}`);
          expect(st.strike).toBe(expSt.strike);
          expectCloseOrNullOrNaN(st.syntheticForwardMid, expSt.syntheticForwardMid);
          expectCloseOrNullOrNaN(st.midImpliedTeaPct, expSt.midImpliedTeaPct);
          expectCloseOrNullOrNaN(st.teaTomadoraPct, expSt.teaTomadoraPct);
          expectCloseOrNullOrNaN(st.teaColocadoraPct, expSt.teaColocadoraPct);
        });
      }
    });
  });

  describe('3. Suavizado PCHIP de Varianza Total en Densidad Breeden-Litzenberger', () => {
    it('filtra strikes sin bid > 0, suaviza w(k) = iv^2 * T con PCHIP y normaliza area = 1.0 con tolerancia <= 1e-9 vs Python', () => {
      const testCase = fixture.smoothedBlDensityCase;
      const res = extractSmoothedRiskNeutralDistributionQ(testCase.input);

      expect(res.status).toBe('OK');
      expectCloseOrNullOrNaN(res.rawArea, testCase.expected.rawArea);
      expectCloseOrNullOrNaN(res.normalizedArea, testCase.expected.normalizedArea);
      expectCloseOrNullOrNaN(res.meanQ, testCase.expected.meanQ);
      expectCloseOrNullOrNaN(res.varianceQ, testCase.expected.varianceQ);
      expectCloseOrNullOrNaN(res.stdDevQ, testCase.expected.stdDevQ);
      expectCloseOrNullOrNaN(res.skewnessQ, testCase.expected.skewnessQ);
      expectCloseOrNullOrNaN(res.excessKurtosisQ, testCase.expected.excessKurtosisQ);

      expect(res.nodes.length).toBe(testCase.expected.nodes.length);
      for (let i = 0; i < res.nodes.length; i += 1) {
        const actualNode = res.nodes[i];
        const expNode = testCase.expected.nodes[i];
        if (!actualNode || !expNode) {
          throw new Error(`Missing BL density node at index ${String(i)}`);
        }
        expect(actualNode.densityQ).toBeGreaterThanOrEqual(0);
        expectCloseOrNullOrNaN(actualNode.strike, expNode.strike);
        expectCloseOrNullOrNaN(actualNode.iv, expNode.iv);
        expectCloseOrNullOrNaN(actualNode.callPrice, expNode.callPrice);
        expectCloseOrNullOrNaN(actualNode.dCdK, expNode.dCdK);
        expectCloseOrNullOrNaN(actualNode.d2CdK2, expNode.d2CdK2);
        expectCloseOrNullOrNaN(actualNode.probAboveQ, expNode.probAboveQ);
        expectCloseOrNullOrNaN(actualNode.rawDensityQ, expNode.rawDensityQ);
        expectCloseOrNullOrNaN(actualNode.densityQ, expNode.densityQ);
      }

      // Verificar que filtró los strikes ilíquidos (530 con bid=0 y 620 con bid=null)
      expect(res.nodes[0]?.strike).toBe(540);
      expect(res.nodes[res.nodes.length - 1]?.strike).toBe(610);
      // En la derivada cruda discreta sin suavizar, el ruido en K=575 produce un pozo densityQ=0 en pleno ATM;
      // la curva suavizada PCHIP mantiene densidad estrictamente positiva y continua en toda la grilla
      const rawUnfiltered = extractRiskNeutralDistributionQ({
        ...testCase.input,
        smoothTotalVariancePchip: false,
      });
      const rawAt575 = rawUnfiltered.nodes.find((n) => n.strike === 575);
      expect(rawAt575?.densityQ).toBe(0);
      expect(res.nodes.every((n) => n.densityQ > 0)).toBe(true);
    });
  });

  describe('4. Filtros de Liquidez, Semáforo Bid-Ask % del Mid, Presupuesto USD y Mariposas/Calendarios', () => {
    it('valida computeVerticalSpreadMetrics contra la referencia Python (<= 1e-9), filtrando debit < 0.10, bid <= 0 y slippage > 35%', () => {
      for (const testCase of fixture.verticalSpreadCases) {
        const res = computeVerticalSpreadMetrics(testCase.input);

        expect(res.valid).toBe(testCase.expected.valid);
        expect(res.eligibleForAutoRanking).toBe(testCase.expected.eligibleForAutoRanking);
        expect(res.reason).toBe(testCase.expected.reason);
        expect(res.liquiditySemaphore).toBe(testCase.expected.liquiditySemaphore);

        expectCloseOrNullOrNaN(res.width, testCase.expected.width);
        expectCloseOrNullOrNaN(res.debit, testCase.expected.debit);
        expectCloseOrNullOrNaN(res.maxProfit, testCase.expected.maxProfit);
        expectCloseOrNullOrNaN(res.rewardRiskRatio, testCase.expected.rewardRiskRatio);
        expectCloseOrNullOrNaN(res.breakeven, testCase.expected.breakeven);
        expectCloseOrNullOrNaN(res.breakevenDistPct, testCase.expected.breakevenDistPct);
        expectCloseOrNullOrNaN(res.probAtBreakevenPct, testCase.expected.probAtBreakevenPct);
        expectCloseOrNullOrNaN(res.edgePct, testCase.expected.edgePct);
        expectCloseOrNullOrNaN(res.longBidAskPctOfMid, testCase.expected.longBidAskPctOfMid);
        expectCloseOrNullOrNaN(res.shortBidAskPctOfMid, testCase.expected.shortBidAskPctOfMid);
        expectCloseOrNullOrNaN(res.bidAskPctOfMid, testCase.expected.bidAskPctOfMid);
      }
    });

    it('rechaza mariposas con strikes repetidos o desordenados (ej. 142/148/148) y garantiza K1 < K2 < K3 en computeRatiosAndStructureCosts y structureOptimizer', () => {
      for (const item of fixture.butterflyCases) {
        expect(isValidButterflyStrikes(item.k1, item.k2, item.k3, item.requireSymmetry)).toBe(
          item.expected,
        );
      }

      // Si solo hay strikes [142, 148] sin tercer ala distinta K3 > K2, BUTTERFLY_SYM no debe armar 142/148/148
      const degenerateChain = computeRatiosAndStructureCosts({
        spot: 148,
        daysToExpiry: 21,
        rate: 0.045,
        dividendYield: 0,
        strikes: [
          {
            strike: 142,
            callBid: 7.4,
            callAsk: 7.6,
            callMid: 7.5,
            putBid: 1.4,
            putAsk: 1.6,
            putMid: 1.5,
          },
          {
            strike: 148,
            callBid: 3.4,
            callAsk: 3.6,
            callMid: 3.5,
            putBid: 3.4,
            putAsk: 3.6,
            putMid: 3.5,
          },
        ],
      });
      const bfCost = degenerateChain.structures.find((s) => s.id === 'BUTTERFLY_SYM');
      expect(bfCost).toBeUndefined();
    });

    it('separa estrictamente Calendar Spreads (2 vencimientos distintos) de Mariposas (1 vencimiento con K1 < K2 < K3)', () => {
      expect(
        isValidCalendarSpread({
          nearExpiryCode: '2026-06-19',
          farExpiryCode: '2026-07-17',
          nearDays: 21,
          farDays: 49,
          nearStrike: 145,
          farStrike: 145,
          nearBid: 4.0,
          nearAsk: 4.2,
          farBid: 6.1,
          farAsk: 6.3,
        }),
      ).toBe(true);
      expect(
        isValidCalendarSpread({
          nearExpiryCode: '2026-06-19',
          farExpiryCode: '2026-06-19',
          nearDays: 21,
          farDays: 21,
          nearStrike: 145,
          farStrike: 145,
          nearBid: 4.0,
          nearAsk: 4.2,
          farBid: 4.0,
          farAsk: 4.2,
        }),
      ).toBe(false);

      const contracts: OptimizerOptionContractInput[] = [135, 140, 145, 150, 155].flatMap(
        (strike) => [
          {
            strike,
            contractType: 'call' as const,
            bid: Math.max(0.5, 145 - strike + 4.0),
            ask: Math.max(0.6, 145 - strike + 4.2),
            delta: strike <= 145 ? 0.55 : 0.3,
            iv: 0.35,
          },
          {
            strike,
            contractType: 'put' as const,
            bid: Math.max(0.5, strike - 145 + 3.8),
            ask: Math.max(0.6, strike - 145 + 4.0),
            delta: strike >= 145 ? -0.55 : -0.3,
            iv: 0.35,
          },
        ],
      );

      const optimized = optimizeOptionStructures({
        spot: 145,
        targetPrice: 150,
        direction: 'BULLISH',
        dte: 21,
        lotSize: 100,
        contracts,
        terminalPrices: [130, 135, 140, 145, 150, 155, 160],
        empiricalProbs: [0.05, 0.1, 0.2, 0.25, 0.2, 0.12, 0.08],
        feeRate: 0.002,
        vatRate: 0.21,
      });

      expect(optimized.candidates.length).toBeGreaterThan(0);
      for (const s of optimized.candidates) {
        expect(Number.isFinite(s.bidAskPctOfMid)).toBe(true);
        expect(['GREEN', 'YELLOW', 'RED']).toContain(s.liquiditySemaphore);
        if (s.kind === 'CALL_BUTTERFLY' || s.kind === 'PUT_BUTTERFLY') {
          expect(s.legs.length).toBe(3);
          const leg0 = s.legs[0];
          const leg1 = s.legs[1];
          const leg2 = s.legs[2];
          if (!leg0 || !leg1 || !leg2) {
            throw new Error('Missing butterfly legs');
          }
          expect(isValidButterflyStrikes(leg0.strike, leg1.strike, leg2.strike)).toBe(true);
        }
      }
    });

    it('dimensiona presupuestos en USD (multiplicador 100, US$500..US$10,000) para mercado US vs ARS para BYMA', () => {
      for (const testCase of fixture.currencySizingCases) {
        const cfg = resolveOptionsMarketCurrencyConfig(testCase.input);
        expect(cfg.market).toBe(testCase.expected.market);
        expect(cfg.currencyCode).toBe(testCase.expected.currencyCode);
        expect(cfg.currencyPrefix).toBe(testCase.expected.currencyPrefix);
        expect(cfg.contractMultiplier).toBe(testCase.expected.contractMultiplier);
        expect(cfg.budgetPresets).toEqual(testCase.expected.budgetPresets);
        expect(cfg.defaultBudget).toBe(testCase.expected.defaultBudget);
        expectCloseOrNullOrNaN(cfg.costPerContract, testCase.expected.costPerContract);
        expect(cfg.maxContractsForBudget).toBe(testCase.expected.maxContractsForBudget);
      }
    });
  });
});
