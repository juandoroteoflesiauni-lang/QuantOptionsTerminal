import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { priceBsm } from '../src/core/options/blackScholes.js';
import type { FetchFn } from '../src/data/types.js';
import { ArgentinaMarketRuntime, type ArHttpFn } from '../src/server/argentinaMarketLoader.js';
import {
  GgalSpecialistRuntime,
  type GgalMarginRiskResponse,
} from '../src/server/ggalSpecialistRuntime.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import {
  calibrateOvernightJumpDiffusionFromSeries,
  evaluateBymaClearingMargin,
  evaluateExecutionMicrostructure,
  evaluateTailStressAndSizing,
  type BymaClearingMarginInput,
  type ExecutionMicrostructureInput,
  type TailStressAndSizingInput,
} from '../src/core/ggal/marginRiskExecution.js';
import {
  BYMA_CLEARING_2026_RATES,
  BYMA_EQUITY_PPT_DM_RATE,
  BYMA_EQUITY_PPT_DM_RATE_WITH_IVA,
  BYMA_EXERCISE_DM_RATE,
  BYMA_EXERCISE_DM_RATE_WITH_IVA,
  BYMA_OPTION_PREMIUM_DM_RATE,
  BYMA_OPTION_PREMIUM_DM_RATE_WITH_IVA,
  BYMA_SHORT_LOAN_DM_RATE_WITH_IVA,
} from '../src/core/ggal/types.js';

const TOLERANCE = 1e-11;

type NumOrToken = number | '__NaN__' | '__Inf__' | '__-Inf__';

interface Motor6ReferenceFixture {
  readonly meta: {
    readonly generator: string;
    readonly pieza: number;
    readonly tolerance: number;
  };
  readonly marginCases: Readonly<
    Record<
      string,
      {
        readonly input: BymaClearingMarginInput;
        readonly output: Readonly<Record<string, unknown>>;
      }
    >
  >;
  readonly executionCases: Readonly<
    Record<
      string,
      {
        readonly input: ExecutionMicrostructureInput;
        readonly output: Readonly<Record<string, unknown>>;
      }
    >
  >;
  readonly tailStressCase: {
    readonly input: TailStressAndSizingInput;
    readonly output: Readonly<Record<string, unknown>>;
  };
}

function decodeNum(v: NumOrToken): number {
  if (v === '__NaN__') return Number.NaN;
  if (v === '__Inf__') return Number.POSITIVE_INFINITY;
  if (v === '__-Inf__') return Number.NEGATIVE_INFINITY;
  return v;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function expectClose(actual: number, expectedToken: NumOrToken, label: string): void {
  const expected = decodeNum(expectedToken);
  if (Number.isNaN(expected)) {
    expect(actual, label).toBeNaN();
    return;
  }
  if (!Number.isFinite(expected)) {
    expect(actual, label).toBe(expected);
    return;
  }
  const scale = Math.max(1, Math.abs(expected));
  expect(
    Math.abs(actual - expected),
    `${label}: actual=${String(actual)} vs expected=${String(expected)}`,
  ).toBeLessThanOrEqual(
    TOLERANCE * scale,
  );
}

const fixturePath = resolve(process.cwd(), 'fixtures', 'ggal_motor6_reference.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Motor6ReferenceFixture;

describe('Motor 6 GGAL Specialist — BYMA Clearing 2026, Microestructura L1-L2 y Kelly-CVaR', () => {
  it('expone las constantes exactas del tarifario oficial BYMA Ago-2026 DM+IVA', () => {
    expect(BYMA_OPTION_PREMIUM_DM_RATE).toBe(0.0020);
    expect(BYMA_OPTION_PREMIUM_DM_RATE_WITH_IVA).toBe(0.00242);
    expect(BYMA_EXERCISE_DM_RATE).toBe(0.0005);
    expect(BYMA_EXERCISE_DM_RATE_WITH_IVA).toBe(0.000605);
    expect(BYMA_EQUITY_PPT_DM_RATE).toBe(0.0005);
    expect(BYMA_EQUITY_PPT_DM_RATE_WITH_IVA).toBe(0.000605);
    expect(BYMA_SHORT_LOAN_DM_RATE_WITH_IVA).toBe(0.000242);
    expect(BYMA_CLEARING_2026_RATES.liquidBufferRate).toBe(0.10);
    expect(BYMA_CLEARING_2026_RATES.wrongWayRiskSurchargeRate).toBe(0.15);
    expect(BYMA_CLEARING_2026_RATES.circular3588WindowMinutes).toBe(60);
    expect(BYMA_CLEARING_2026_RATES.circular3588AtmBandPct).toBe(0.005);
  });

  it('valida todas las estrategias BYMA Clearing, aforos/WWR y Circular 3588 < 1e-11 sin mutar inputs', () => {
    for (const [caseName, entry] of Object.entries(fixture.marginCases)) {
      const frozenInput = deepFreeze(structuredClone(entry.input));
      const actual = evaluateBymaClearingMargin(frozenInput);
      const expected = entry.output as Record<string, unknown>;

      expect(actual.status, `${caseName}.status`).toBe(expected['status']);
      expect(actual.strategyKind, `${caseName}.strategyKind`).toBe(expected['strategyKind']);
      expect(actual.collateralStatus, `${caseName}.collateralStatus`).toBe(
        expected['collateralStatus'],
      );

      expectClose(
        actual.ccpRiskArrayLossArs,
        expected['ccpRiskArrayLossArs'] as NumOrToken,
        `${caseName}.ccpRiskArrayLossArs`,
      );
      expectClose(
        actual.steppedFloorArs,
        expected['steppedFloorArs'] as NumOrToken,
        `${caseName}.steppedFloorArs`,
      );
      expectClose(
        actual.baseRequiredMarginArs,
        expected['baseRequiredMarginArs'] as NumOrToken,
        `${caseName}.baseRequiredMarginArs`,
      );
      expectClose(
        actual.liquidBufferArs,
        expected['liquidBufferArs'] as NumOrToken,
        `${caseName}.liquidBufferArs`,
      );
      expectClose(
        actual.wrongWayRiskSurchargeArs,
        expected['wrongWayRiskSurchargeArs'] as NumOrToken,
        `${caseName}.wrongWayRiskSurchargeArs`,
      );
      expectClose(
        actual.totalRequiredWithBuffersArs,
        expected['totalRequiredWithBuffersArs'] as NumOrToken,
        `${caseName}.totalRequiredWithBuffersArs`,
      );
      expectClose(
        actual.totalCollateralMarketArs,
        expected['totalCollateralMarketArs'] as NumOrToken,
        `${caseName}.totalCollateralMarketArs`,
      );
      expectClose(
        actual.totalEffectiveCollateralArs,
        expected['totalEffectiveCollateralArs'] as NumOrToken,
        `${caseName}.totalEffectiveCollateralArs`,
      );
      expectClose(
        actual.localCorrelatedEffectiveArs,
        expected['localCorrelatedEffectiveArs'] as NumOrToken,
        `${caseName}.localCorrelatedEffectiveArs`,
      );
      expectClose(
        actual.nonCorrelatedEffectiveArs,
        expected['nonCorrelatedEffectiveArs'] as NumOrToken,
        `${caseName}.nonCorrelatedEffectiveArs`,
      );
      expectClose(
        actual.excessOrDeficitArs,
        expected['excessOrDeficitArs'] as NumOrToken,
        `${caseName}.excessOrDeficitArs`,
      );
      expectClose(
        actual.t0GrossPremiumCashflowArs,
        expected['t0GrossPremiumCashflowArs'] as NumOrToken,
        `${caseName}.t0GrossPremiumCashflowArs`,
      );
      expectClose(
        actual.t0OptionFeesDmIvaArs,
        expected['t0OptionFeesDmIvaArs'] as NumOrToken,
        `${caseName}.t0OptionFeesDmIvaArs`,
      );
      expectClose(
        actual.t0NetCashflowArs,
        expected['t0NetCashflowArs'] as NumOrToken,
        `${caseName}.t0NetCashflowArs`,
      );
      expectClose(
        actual.projectedT1ExerciseFeeDmIvaArs,
        expected['projectedT1ExerciseFeeDmIvaArs'] as NumOrToken,
        `${caseName}.projectedT1ExerciseFeeDmIvaArs`,
      );
      expectClose(
        actual.projectedSpotEquityFeeDmIvaArs,
        expected['projectedSpotEquityFeeDmIvaArs'] as NumOrToken,
        `${caseName}.projectedSpotEquityFeeDmIvaArs`,
      );
      expectClose(
        actual.dailyMarginCarryCostArs,
        expected['dailyMarginCarryCostArs'] as NumOrToken,
        `${caseName}.dailyMarginCarryCostArs`,
      );

      const expAlert = expected['circular3588Alert'] as Record<string, unknown>;
      expect(actual.circular3588Alert.active, `${caseName}.c3588.active`).toBe(expAlert['active']);
      expect(actual.circular3588Alert.isExpiryDay, `${caseName}.c3588.isExpiryDay`).toBe(
        expAlert['isExpiryDay'],
      );
      expectClose(
        actual.circular3588Alert.minutesToCutoff,
        expAlert['minutesToCutoff'] as NumOrToken,
        `${caseName}.c3588.minutesToCutoff`,
      );
      expect(actual.circular3588Alert.blockingAtmStrikes).toEqual(
        expAlert['blockingAtmStrikes'],
      );
    }
  });

  it('aplica los 3 escalones exactos de piso BYMA (1 % >5% OTM, 2.5 % 2.5-5%, 5 % <2.5%/ITM)', () => {
    const baseEntry = fixture.marginCases['uncovered_short_otm_gt5'];
    if (baseEntry === undefined) throw new Error('missing uncovered_short_otm_gt5');
    const base = baseEntry.input;
    const leg0 = base.legs[0];
    if (leg0 === undefined) throw new Error('missing leg0');
    // Spot = 7420: Strike 8000 -> OTM = 7.817% (>5%) => 1%
    const rGt5 = evaluateBymaClearingMargin(base);
    expect(rGt5.steppedFloorArs).toBeCloseTo(20 * 100 * 7420 * 0.01, 6);

    // Strike 7700 -> OTM = 3.77% (2.5%..5%) => 2.5%
    const rMid = evaluateBymaClearingMargin({
      ...base,
      legs: [{ ...leg0, strikeArs: 7700 }],
    });
    expect(rMid.steppedFloorArs).toBeCloseTo(20 * 100 * 7420 * 0.025, 6);

    // Strike 7500 -> OTM = 1.078% (<2.5%) => 5%
    const rTight = evaluateBymaClearingMargin({
      ...base,
      legs: [{ ...leg0, strikeArs: 7500 }],
    });
    expect(rTight.steppedFloorArs).toBeCloseTo(20 * 100 * 7420 * 0.05, 6);

    // Strike 7200 Call ITM -> 5%
    const rItm = evaluateBymaClearingMargin({
      ...base,
      legs: [{ ...leg0, strikeArs: 7200 }],
    });
    expect(rItm.steppedFloorArs).toBeCloseTo(20 * 100 * 7420 * 0.05, 6);
  });

  it('valida Hayashi-Yoshida, filtro 4 compuertas, fill Poisson L1-L2 y límite de orden < 1e-11', () => {
    for (const [caseName, entry] of Object.entries(fixture.executionCases)) {
      const frozenInput = deepFreeze(structuredClone(entry.input));
      const actual = evaluateExecutionMicrostructure(frozenInput);
      const expected = entry.output as Record<string, unknown>;

      expect(actual.status, `${caseName}.status`).toBe(expected['status']);
      expect(actual.decision, `${caseName}.decision`).toBe(expected['decision']);

      const expHy = expected['hayashiYoshida'] as Record<string, unknown>;
      expect(actual.hayashiYoshida.status, `${caseName}.hy.status`).toBe(expHy['status']);
      expect(actual.hayashiYoshida.leadLagSignal, `${caseName}.hy.signal`).toBe(
        expHy['leadLagSignal'],
      );
      expectClose(
        actual.hayashiYoshida.contemporaneousCorrelation,
        expHy['contemporaneousCorrelation'] as NumOrToken,
        `${caseName}.hy.corr0`,
      );
      expectClose(
        actual.hayashiYoshida.optimalCorrelation,
        expHy['optimalCorrelation'] as NumOrToken,
        `${caseName}.hy.optCorr`,
      );
      expect(actual.hayashiYoshida.optimalLagSec, `${caseName}.hy.optLag`).toBe(
        expHy['optimalLagSec'],
      );

      const expGates = expected['gates'] as Record<string, unknown>;
      expect(actual.gates.gate1FreshnessPassed).toBe(expGates['gate1FreshnessPassed']);
      expect(actual.gates.gate1Status).toBe(expGates['gate1Status']);
      expect(actual.gates.gate2SpreadPassed).toBe(expGates['gate2SpreadPassed']);
      expect(actual.gates.gate3DepthPassed).toBe(expGates['gate3DepthPassed']);
      expect(actual.gates.gate4TickConfirmPassed).toBe(expGates['gate4TickConfirmPassed']);
      expect(actual.gates.allGatesPassed).toBe(expGates['allGatesPassed']);

      expectClose(
        actual.fillProbPassiveL1,
        expected['fillProbPassiveL1'] as NumOrToken,
        `${caseName}.fillProbPassiveL1`,
      );
      expectClose(
        actual.fillProbImprove1Tick,
        expected['fillProbImprove1Tick'] as NumOrToken,
        `${caseName}.fillProbImprove1Tick`,
      );
      expectClose(
        actual.adverseSelectionCostArs,
        expected['adverseSelectionCostArs'] as NumOrToken,
        `${caseName}.adverseSelectionCostArs`,
      );
      expectClose(
        actual.esPassiveL1Ars,
        expected['esPassiveL1Ars'] as NumOrToken,
        `${caseName}.esPassiveL1Ars`,
      );
      expectClose(
        actual.esImprove1TickArs,
        expected['esImprove1TickArs'] as NumOrToken,
        `${caseName}.esImprove1TickArs`,
      );
      expectClose(
        actual.esCrossBookArs,
        expected['esCrossBookArs'] as NumOrToken,
        `${caseName}.esCrossBookArs`,
      );
      expectClose(
        actual.crossBookVwapSlippageArs,
        expected['crossBookVwapSlippageArs'] as NumOrToken,
        `${caseName}.crossBookVwapSlippageArs`,
      );
      expectClose(
        actual.sqrtImpactCapLots,
        expected['sqrtImpactCapLots'] as NumOrToken,
        `${caseName}.sqrtImpactCapLots`,
      );
      expectClose(
        actual.maxSingleOrderLots,
        expected['maxSingleOrderLots'] as NumOrToken,
        `${caseName}.maxSingleOrderLots`,
      );
    }
  });

  it('cumple Zero Silent Fallbacks en BYMA_L1_ONLY, modo EOD_CIERRE y rechazo de milisegundos', () => {
    const passiveEntry = fixture.executionCases['post_passive_l1'];
    if (passiveEntry === undefined) throw new Error('missing post_passive_l1');
    const base = passiveEntry.input;

    // Sin profundidad L2 real -> DEGRADED_L1_ONLY + ABORT_STALE + maxSingleOrderLots = NaN
    const l1Only = evaluateExecutionMicrostructure({
      ...base,
      depthSource: 'BYMA_L1_ONLY',
      bidsL1L2: [],
      asksL1L2: [],
    });
    expect(l1Only.status).toBe('DEGRADED_L1_ONLY');
    expect(l1Only.gates.gate3DepthPassed).toBe(false);
    expect(l1Only.decision).toBe('ABORT_STALE');
    expect(l1Only.maxSingleOrderLots).toBeNaN();

    // EOD_CIERRE bypass explícito de frescura Gate 1 conservando evaluación L2
    const eodBypass = evaluateExecutionMicrostructure({
      ...base,
      telemetryMode: 'EOD_CIERRE',
      quoteAsOfUtcSec: base.asOfUtcSec - 14_400,
    });
    expect(eodBypass.gates.gate1FreshnessPassed).toBe(true);
    expect(eodBypass.gates.gate1Status).toBe('BYPASSED_EOD');
    expect(eodBypass.decision).toBe('POST_PASSIVE_L1');

    // Timestamps en milisegundos deben ser rechazados limpiamente
    const msEntry = fixture.marginCases['uncovered_short_otm_gt5'];
    if (msEntry === undefined) throw new Error('missing uncovered_short_otm_gt5');
    const msMargin = evaluateBymaClearingMargin({
      ...msEntry.input,
      asOfUtcSec: 1775833200_000,
    });
    expect(msMargin.status).toBe('NO_DATA');
    expect(msMargin.baseRequiredMarginArs).toBeNaN();
  });

  it('valida los 5 escenarios de estrés ADR+CCL+LECAP, grilla Merton 18h y sizing Kelly-CVaR < 1e-11', () => {
    const frozenInput = deepFreeze(structuredClone(fixture.tailStressCase.input));
    const actual = evaluateTailStressAndSizing(frozenInput);
    const expected = fixture.tailStressCase.output as Record<string, unknown>;

    expect(actual.status).toBe(expected['status']);
    expect(actual.worstScenarioId).toBe(expected['worstScenarioId']);
    expect(actual.overnightNodesCount).toBe(expected['overnightNodesCount']);
    expect(actual.overnightNodesCount).toBe(135);

    expectClose(
      actual.worstUnitLossArs,
      expected['worstUnitLossArs'] as NumOrToken,
      'tailStress.worstUnitLossArs',
    );
    expectClose(
      actual.overnightExpectedPnlPerUnitArs,
      expected['overnightExpectedPnlPerUnitArs'] as NumOrToken,
      'tailStress.overnightExpectedPnlPerUnitArs',
    );
    expectClose(
      actual.overnightStdDevPerUnitArs,
      expected['overnightStdDevPerUnitArs'] as NumOrToken,
      'tailStress.overnightStdDevPerUnitArs',
    );
    expectClose(
      actual.overnightMaxLossPerUnitArs,
      expected['overnightMaxLossPerUnitArs'] as NumOrToken,
      'tailStress.overnightMaxLossPerUnitArs',
    );
    expectClose(
      actual.overnightVar99PerUnitArs,
      expected['overnightVar99PerUnitArs'] as NumOrToken,
      'tailStress.overnightVar99PerUnitArs',
    );
    expectClose(
      actual.overnightCvar99PerUnitArs,
      expected['overnightCvar99PerUnitArs'] as NumOrToken,
      'tailStress.overnightCvar99PerUnitArs',
    );

    const expScenarios = expected['scenarioResults'] as readonly Record<string, unknown>[];
    expect(actual.scenarioResults.length).toBe(5);
    actual.scenarioResults.forEach((sc, idx) => {
      const expSc = expScenarios[idx];
      if (expSc === undefined) throw new Error(`missing scenario at ${String(idx)}`);
      expect(sc.id).toBe(expSc['id']);
      expectClose(sc.shockedAdrUsd, expSc['shockedAdrUsd'] as NumOrToken, `${sc.id}.adr`);
      expectClose(sc.shockedCclArs, expSc['shockedCclArs'] as NumOrToken, `${sc.id}.ccl`);
      expectClose(sc.shockedSpotArs, expSc['shockedSpotArs'] as NumOrToken, `${sc.id}.spot`);
      expectClose(
        sc.portfolioPnlPerUnitArs,
        expSc['portfolioPnlPerUnitArs'] as NumOrToken,
        `${sc.id}.pnl`,
      );
      expectClose(
        sc.collateralRateImpactArs,
        expSc['collateralRateImpactArs'] as NumOrToken,
        `${sc.id}.collImpact`,
      );
      expectClose(
        sc.stressedEffectiveCollateralArs,
        expSc['stressedEffectiveCollateralArs'] as NumOrToken,
        `${sc.id}.stressedColl`,
      );
    });

    const expSizing = expected['sizingBreakdown'] as Record<string, unknown>;
    expect(actual.sizingBreakdown.bindingConstraint).toBe(expSizing['bindingConstraint']);
    expectClose(
      actual.sizingBreakdown.fullKellyLots,
      expSizing['fullKellyLots'] as NumOrToken,
      'sizing.fullKellyLots',
    );
    expectClose(
      actual.sizingBreakdown.quarterKellyLots,
      expSizing['quarterKellyLots'] as NumOrToken,
      'sizing.quarterKellyLots',
    );
    expectClose(
      actual.sizingBreakdown.noRuinCapLots,
      expSizing['noRuinCapLots'] as NumOrToken,
      'sizing.noRuinCapLots',
    );
    expectClose(
      actual.sizingBreakdown.cvar99CapLots,
      expSizing['cvar99CapLots'] as NumOrToken,
      'sizing.cvar99CapLots',
    );
    expectClose(
      actual.sizingBreakdown.drawdownCapLots,
      expSizing['drawdownCapLots'] as NumOrToken,
      'sizing.drawdownCapLots',
    );
    expectClose(
      actual.sizingBreakdown.collateralMarginCapLots,
      expSizing['collateralMarginCapLots'] as NumOrToken,
      'sizing.collateralMarginCapLots',
    );

    expect(actual.recommendedBymaLots).toBe(expected['recommendedBymaLots']);
    expectClose(
      actual.recommendedOpraContractsExact,
      expected['recommendedOpraContractsExact'] as NumOrToken,
      'sizing.recommendedOpraContractsExact',
    );
    expect(actual.recommendedOpraContractsFloored).toBe(expected['recommendedOpraContractsFloored']);
  });

  it('calibra parámetros Merton Jump-Diffusion desde series históricas alineadas y rechaza < 15 ruedas', () => {
    expect(calibrateOvernightJumpDiffusionFromSeries([])).toBeNull();
    expect(
      calibrateOvernightJumpDiffusionFromSeries([
        { adrCloseUsd: 50, cclGgal: 1200 },
        { adrCloseUsd: 51, cclGgal: 1210 },
      ]),
    ).toBeNull();

    const synth: { adrCloseUsd: number; cclGgal: number }[] = [];
    let adr = 50.0;
    let ccl = 1180.0;
    for (let i = 0; i < 45; i++) {
      if (i === 18) {
        adr *= 0.88; // salto bajista ADR -12%
        ccl *= 1.07; // co-salto CCL +7%
      } else if (i === 32) {
        adr *= 1.09; // salto alcista ADR +9%
        ccl *= 0.96;
      } else {
        adr *= 1 + 0.002 + 0.008 * Math.sin(i * 0.7);
        ccl *= 1 + 0.001 - 0.004 * Math.sin(i * 0.5);
      }
      synth.push({ adrCloseUsd: adr, cclGgal: ccl });
    }
    const frozenSynth = deepFreeze(synth);
    const calibrated = calibrateOvernightJumpDiffusionFromSeries(frozenSynth);
    expect(calibrated).not.toBeNull();
    if (calibrated === null) throw new Error('expected non-null calibrated overnight params');
    expect(calibrated.sigmaAdrDiffAnnual).toBeGreaterThan(0);
    expect(calibrated.sigmaCclDiffAnnual).toBeGreaterThan(0);
    expect(calibrated.lambdaJumpAdrAnnual).toBeGreaterThan(0);
    expect(Math.abs(calibrated.rhoDiffAdrCcl)).toBeLessThanOrEqual(0.99);
  });
});

describe('Motor 6 GGAL Specialist — Integración HTTP Offline (/api/ar/ggal-specialist/margin-risk)', () => {
  const handles: HttpWsServerHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const h = handles.pop();
      if (h) {
        await h.stop();
      }
    }
  });

  it('sirve GET /api/ar/ggal-specialist/margin-risk, degrada L1_ONLY/MISSING_AFORO sin fallbacks y valida 400/405', async () => {
    const asOfUtcSec = Math.floor(Date.UTC(2026, 9, 15, 15, 30, 0) / 1_000);
    const ggalSpotArs = 6400;
    const ggalAdrUsd = 53.0;
    const arsContRate = 0.295;
    const usdContRate = 0.043;
    const frontExpiryDate = '2026-11-20';
    const frontExpSec = Math.floor(Date.UTC(2026, 10, 20, 18, 30, 0) / 1_000);
    const tFront = Math.max(0.05, (frontExpSec - asOfUtcSec) / (365 * 86_400));

    interface MockDailyRow {
      readonly date: string;
      readonly o: number;
      readonly h: number;
      readonly l: number;
      readonly c: number;
      readonly v: number;
    }
    const buildBars = (
      count: number,
      startClose: number,
      drift: number,
      amp: number,
      freq: number,
    ): MockDailyRow[] => {
      const endDayMs = Math.floor(asOfUtcSec / 86_400) * 86_400_000;
      const rows: MockDailyRow[] = [];
      for (let i = count - 1; i >= 0; i -= 1) {
        const idx = count - 1 - i;
        const d = new Date(endDayMs - (i + 1) * 86_400_000);
        const close = Number((startClose + idx * drift + Math.sin(idx * freq) * amp).toFixed(4));
        rows.push({
          date: d.toISOString().slice(0, 10),
          o: close * 0.996,
          h: close * 1.008,
          l: close * 0.992,
          c: close,
          v: 900_000 + idx * 1_000,
        });
      }
      return rows;
    };

    const arByDate: MockDailyRow[] = buildBars(60, 5_950, 7.2, 60, 0.24).map((row, idx) => {
      const mult = (idx >= 20 ? 0.86 : 1) * (idx >= 42 ? 1.14 : 1);
      return {
        ...row,
        o: row.o * mult,
        h: row.h * mult,
        l: row.l * mult,
        c: row.c * mult,
      };
    });
    const adrByDate: MockDailyRow[] = buildBars(60, 49.2, 0.06, 0.4, 0.21).map((row, idx) => {
      const mult = (idx >= 20 ? 0.82 : 1) * (idx >= 42 ? 1.16 : 1);
      return {
        ...row,
        o: row.o * mult,
        h: row.h * mult,
        l: row.l * mult,
        c: row.c * mult,
      };
    });
    const al30ByDate = buildBars(60, 75_500, 45, 420, 0.19);
    const al30cByDate = buildBars(60, 63.0, 0.032, 0.35, 0.2);
    const gd30ByDate = buildBars(60, 80_200, 48, 450, 0.18);
    const gd30cByDate = buildBars(60, 66.8, 0.035, 0.38, 0.17);
    const cerSeries = Array.from({ length: 60 }, (_, idx) => {
      const d = new Date(Math.floor(asOfUtcSec / 86_400) * 86_400_000 - (60 - idx) * 86_400_000);
      return { fecha: d.toISOString().slice(0, 10), valor: Number((540 * Math.exp(0.0008 * idx)).toFixed(4)) };
    });

    const strikes = [5800, 6000, 6200, 6400, 6600, 6800, 7200];
    const argOptionsRows: Record<string, unknown>[] = [];
    for (const strike of strikes) {
      for (const ct of ['call', 'put'] as const) {
        const fair = priceBsm({
          spot: ggalSpotArs,
          strike,
          timeToExpiry: tFront,
          rate: arsContRate,
          dividendYield: 0,
          volatility: 0.54,
          contractType: ct,
        });
        const px = Number(Math.max(12, fair).toFixed(2));
        argOptionsRows.push({
          symbol: `GFG${ct === 'call' ? 'C' : 'V'}${String(strike)}NO`,
          c: px,
          px_bid: Number((px * 0.985).toFixed(2)),
          px_ask: Number((px * 1.015).toFixed(2)),
          v: 180_000,
          v_ars: 180_000 * px,
          open_interest: 180_000,
        });
      }
    }

    const jsonRes = (payload: unknown, status = 200) =>
      Promise.resolve({ ok: status >= 200 && status < 300, status, text: JSON.stringify(payload), headers: {} });

    const arFetch: ArHttpFn = (url: string) => {
      const { hostname, pathname } = new URL(url);
      if (hostname.includes('data912')) {
        if (pathname === '/live/mep') return jsonRes([{ symbol: 'AL30', mark: 1185, ars_bid: 77025, usd_ask: 65 }]);
        if (pathname === '/live/ccl') return jsonRes([{ symbol: 'AL30', mark: 1205, ars_bid: 77025, usd_ask: 63.9 }]);
        if (pathname === '/live/arg_stocks') {
          return jsonRes([{ symbol: 'GGAL', c: ggalSpotArs, px_bid: 6396, px_ask: 6404, prev_close: 6320, v: 1_450_000, v_ars: 9_280_000_000 }]);
        }
        if (pathname === '/live/usa_adrs') return jsonRes([{ symbol: 'GGAL', c: ggalAdrUsd, prev_close: 52.35 }]);
        if (pathname === '/live/arg_cedears' || pathname === '/live/usa_stocks' || pathname === '/live/arg_corp') return jsonRes([]);
        if (pathname === '/live/arg_bonds') {
          return jsonRes([
            { symbol: 'AL30', c: 77_000, px_bid: 76_950, px_ask: 77_050, prev_close: 76_500, v: 18_000_000, v_ars: 14_000_000_000 },
            { symbol: 'AL30C', c: 63.9, px_bid: 63.8, px_ask: 64.0, prev_close: 63.5, v: 5_000_000 },
            { symbol: 'GD30', c: 82_200, px_bid: 82_120, px_ask: 82_280, prev_close: 81_700, v: 10_000_000, v_ars: 8_200_000_000 },
            { symbol: 'GD30C', c: 68.2, px_bid: 68.1, px_ask: 68.3, prev_close: 67.8, v: 3_000_000 },
          ]);
        }
        if (pathname === '/live/arg_notes') return jsonRes([{ symbol: 'S31O6', c: 125.5, px_bid: 125.4, px_ask: 125.6, prev_close: 125.1, tna: 34.2, v_ars: 4_000_000_000 }]);
        if (pathname === '/live/cauciones') return jsonRes([{ symbol: 'PESOS 1D', days: 1, tna: 32.8, c: 32.8, v_ars: 90_000_000_000 }]);
        if (pathname === '/live/arg_options') return jsonRes(argOptionsRows);
        if (pathname === '/historical/bonds/AL30') return jsonRes(al30ByDate);
        if (pathname === '/historical/bonds/AL30C' || pathname === '/historical/bonds/AL30D') return jsonRes(al30cByDate);
        if (pathname === '/historical/bonds/GD30') return jsonRes(gd30ByDate);
        if (pathname === '/historical/bonds/GD30C' || pathname === '/historical/bonds/GD30D') return jsonRes(gd30cByDate);
        if (pathname.startsWith('/historical/')) return jsonRes(arByDate);
      }
      if (hostname.includes('open.bymadata')) return jsonRes({ data: [] });
      if (hostname.includes('bcra.gob.ar')) {
        if (pathname === '/estadisticas/v4.0/Monetarias/30') return jsonRes({ results: cerSeries });
        return jsonRes({
          results: [
            { idVariable: 6, valor: 30.0, fecha: '2026-10-15' },
            { idVariable: 30, valor: 582.4, fecha: '2026-10-15' },
          ],
        });
      }
      if (hostname.includes('argentinadatos.com')) {
        if (pathname.includes('/cotizaciones/dolares')) {
          return jsonRes([
            { casa: 'oficial', compra: 1080, venta: 1120, fechaActualizacion: '2026-10-15T15:00:00Z' },
            { casa: 'bolsa', compra: 1183, venta: 1187, fechaActualizacion: '2026-10-15T15:00:00Z' },
            { casa: 'contadoconliqui', compra: 1204, venta: 1210, fechaActualizacion: '2026-10-15T15:00:00Z' },
          ]);
        }
        if (pathname.includes('/indices/inflacion')) return jsonRes([{ fecha: '2026-09-30', valor: 2.3 }]);
        if (pathname.includes('/indices/riesgo-pais')) return jsonRes([{ fecha: '2026-10-15', valor: 680 }]);
        return jsonRes([]);
      }
      if (hostname.includes('newyorkfed.org')) {
        return jsonRes({ refRates: [{ percentRate: 4.3, effectiveDate: '2026-10-15' }] });
      }
      return jsonRes({}, 404);
    };

    const usFetch: FetchFn = (url: string) => {
      const path = new URL(url).pathname;
      if (path.startsWith('/v2/aggs/ticker/')) {
        const segs = path.split('/');
        const ticker = decodeURIComponent(segs[4] ?? 'GGAL');
        const span = segs[7] ?? 'day';
        if (span === 'day' && ticker === 'GGAL') {
          const results = adrByDate.map((r) => ({
            t: Date.parse(`${r['date']}T04:00:00Z`),
            o: r['o'], h: r['h'], l: r['l'], c: r['c'], v: r['v'], vw: r['c'],
          }));
          return jsonRes({ status: 'OK', ticker, resultsCount: results.length, results });
        }
        const barSec = span === 'hour' ? 3_600 : 300;
        const results = Array.from({ length: 120 }, (_, i) => ({
          t: (asOfUtcSec - (120 - i) * barSec) * 1_000,
          o: ggalAdrUsd, h: ggalAdrUsd * 1.003, l: ggalAdrUsd * 0.997, c: ggalAdrUsd, v: 40_000, vw: ggalAdrUsd,
        }));
        return jsonRes({ status: 'OK', ticker, resultsCount: results.length, results });
      }
      if (path === '/v3/snapshot') {
        return jsonRes({
          status: 'OK',
          results: [{
            ticker: 'GGAL',
            type: 'stocks',
            market_status: 'open',
            session: { price: ggalAdrUsd, close: ggalAdrUsd, previous_close: 52.35, volume: 1_900_000 },
            last_trade: { price: ggalAdrUsd, size: 100, sip_timestamp: String(asOfUtcSec * 1_000_000_000) },
            last_quote: { bid: 52.96, ask: 53.04, midpoint: ggalAdrUsd },
          }],
        });
      }
      if (path === '/fed/v1/treasury-yields') {
        return jsonRes({ status: 'OK', results: [{ date: '2026-10-15', yield_3_month: usdContRate * 100, yield_1_year: usdContRate * 100 }] });
      }
      if (path === '/fed/v1/funding-conditions') {
        return jsonRes({ status: 'OK', results: [{ date: '2026-10-15', effective_fed_funds_rate: 4.3, sofr: 4.3 }] });
      }
      if (path === '/v3/reference/options/contracts') {
        return jsonRes({
          status: 'OK',
          results: [{ ticker: 'O:GGAL261120C00055000', underlying_ticker: 'GGAL', contract_type: 'call', strike_price: 55, expiration_date: frontExpiryDate, shares_per_contract: 100 }],
        });
      }
      if (path.startsWith('/v3/snapshot/options/')) {
        return jsonRes({ status: 'OK', results: [] });
      }
      return jsonRes({ status: 'NOT_FOUND' }, 404);
    };

    const dataNowMs = asOfUtcSec * 1_000;
    const runtime = new MarketRuntime({ apiKey: 'TEST_KEY', secrets: ['TEST_KEY'], fetchFn: usFetch, nowMsFn: () => dataNowMs });
    const arRuntime = new ArgentinaMarketRuntime({ fetchFn: arFetch, secrets: ['TEST_KEY'], nowMsFn: () => dataNowMs, minData912IntervalMs: 0 });
    const ggalRuntime = new GgalSpecialistRuntime({ runtime, arRuntime, fetchFn: arFetch, secrets: ['TEST_KEY'], nowMsFn: () => dataNowMs });
    const server = createHttpWsServer({ runtime, arRuntime, ggalRuntime, secrets: ['TEST_KEY'], port: 0 });
    handles.push(server);
    const addr = await server.start();
    const baseUrl = `http://${addr.host}:${String(addr.port)}`;

    // 1) Consulta por defecto: matriz 8 estrategias, estrés 5 escenarios y 135 nodos Merton sin NaN en JSON
    const res1 = await fetch(`${baseUrl}/api/ar/ggal-specialist/margin-risk`);
    expect(res1.status).toBe(200);
    const raw1 = await res1.text();
    expect(/(?<=[:,[])\s*(?:NaN|-?Infinity|undefined)\b/.test(raw1)).toBe(false);
    const data1 = JSON.parse(raw1) as GgalMarginRiskResponse;
    expect(data1.marginRisk).not.toBeNull();
    expect(data1.executionMicrostructure).not.toBeNull();
    expect(data1.tailStress).not.toBeNull();
    if (!data1.marginRisk || !data1.executionMicrostructure || !data1.tailStress) {
      throw new Error('expected non-null Motor 6 sections in data1');
    }
    expect(data1.marginRisk.strategyReferenceMatrix.length).toBe(8);
    expect(data1.executionBookDiagnostics.bookSource).toBe('BYMA_L1_ONLY');
    expect(data1.executionMicrostructure.status).toBe('DEGRADED_L1_ONLY');
    expect(data1.executionMicrostructure.maxSingleOrderLots).toBeNull();
    expect(data1.tailStress.scenarioResults.length).toBe(5);
    expect(data1.tailStress.overnightNodesCount).toBe(135);

    // 2) Zero Silent Fallbacks: LECAP sin collateralAforo => MISSING_EXPLICIT_AFORO y null en colateral efectivo
    const res2 = await fetch(
      `${baseUrl}/api/ar/ggal-specialist/margin-risk?strategyKind=RATIO_SPREAD_1X2&collateralKind=LECAP&collateralValueArs=4000000`,
    );
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as GgalMarginRiskResponse;
    expect(data2.marginRisk).not.toBeNull();
    if (!data2.marginRisk) throw new Error('missing data2.marginRisk');
    expect(data2.marginRisk.collateralStatus).toBe('MISSING_EXPLICIT_AFORO');
    expect(data2.marginRisk.totalEffectiveCollateralArs).toBeNull();
    expect(data2.tailStress).toBeNull();

    // 3) LECAP con aforo explícito + COVERED_CALL => OK con 0 margen requerido
    const res3 = await fetch(
      `${baseUrl}/api/ar/ggal-specialist/margin-risk?strategyKind=COVERED_CALL&collateralKind=LECAP&collateralValueArs=4000000&collateralAforo=0.88`,
    );
    expect(res3.status).toBe(200);
    const data3 = (await res3.json()) as GgalMarginRiskResponse;
    expect(data3.marginRisk).not.toBeNull();
    if (!data3.marginRisk) throw new Error('missing data3.marginRisk');
    expect(data3.marginRisk.collateralStatus).toBe('OK');
    expect(data3.marginRisk.baseRequiredMarginArs).toBe(0);
    expect(data3.marginRisk.wrongWayRiskSurchargeArs).toBe(0);

    // 4) Validaciones estrictas 400 / 405
    const badStrategy = await fetch(`${baseUrl}/api/ar/ggal-specialist/margin-risk?strategyKind=INVALID_STRAT`);
    expect(badStrategy.status).toBe(400);
    const badMethod = await fetch(`${baseUrl}/api/ar/ggal-specialist/margin-risk`, { method: 'POST' });
    expect(badMethod.status).toBe(405);
  });
});
