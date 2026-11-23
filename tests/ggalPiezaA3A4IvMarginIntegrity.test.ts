import { describe, expect, it, vi } from 'vitest';
import reference from '../fixtures/ggal_pieza_a3_a4_reference.json' with { type: 'json' };
import motor from '../fixtures/ggal_motor6_reference.json' with { type: 'json' };
import { solveImpliedVolAmericanDetailed, greeksAmericanFiniteDiffOrAnalytical } from '../src/core/options/american.js';
import {
  classifyAndValidateMarginStructure, evaluateBymaClearingMargin,
  type BymaClearingMarginInput, type BymaMarginLegInput,
} from '../src/core/ggal/marginRiskExecution.js';
import { ArgentinaMarketRuntime } from '../src/server/argentinaMarketLoader.js';
import { GgalSpecialistRuntime } from '../src/server/ggalSpecialistRuntime.js';
import { createHttpWsServer } from '../src/server/httpWsServer.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import { buildOptionExpiryGroupsFromArOptions } from '../web/src/data/marketData.js';
import type { ArOptionsResponse as WebArOptionsResponse } from '../web/src/data/liveTypes.js';

vi.mock('../src/server/envBootstrap.js', () => ({}));

const asOfUtcSec = Date.UTC(2026, 10, 16, 16) / 1_000;
const side = (value: string): 'call' | 'put' => value === 'call' ? 'call' : 'put';
const ivInput = (sample: { spot: number; strike: number; seconds: number; last: number; contractType: string }) => ({
  ...sample, contractType: side(sample.contractType), asOfUtcSec, expiryUtcSec: asOfUtcSec + sample.seconds,
  instrumentId: 'REFERENCE', rate: 0.35, dividendYield: 0,
});
const near = (actual: number, expected: number) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-9, Math.abs(expected) * 1e-12));
};

describe('A3 · American implied volatility', () => {
  it.each(reference.ivCases)('$name', (sample) => {
    const result = solveImpliedVolAmericanDetailed({
      ...ivInput(sample), ...(sample.maxIterations !== undefined ? { maxIterations: sample.maxIterations } : {}),
    });
    expect(result).toMatchObject({ modelStatus: sample.status, reasonCode: sample.reason, impliedVol: null,
      observedQuote: { last: sample.last, referencePrice: sample.last } });
    if (sample.seconds > 0) {
      for (const [key, value] of Object.entries(sample.bounds)) {
        near(result.bounds[key as keyof typeof result.bounds] ?? Number.NaN, value);
      }
    }
  });

  it('keeps an underpriced observed mid and isolates the opt-in European diagnostic', () => {
    const input = { ...ivInput({ spot: 5005, strike: 6000, seconds: 60 * 86400, last: 990, contractType: 'put' }),
      bid: 960, ask: 987 };
    const regular = solveImpliedVolAmericanDetailed(input);
    expect(regular).toMatchObject({ modelStatus: 'BELOW_INTRINSIC', impliedVol: null,
      observedQuote: { bid: 960, ask: 987, mid: 973.5, referenceBasis: 'MID' } });
    expect(regular).not.toHaveProperty('diagnosticProxy');
    const optIn = solveImpliedVolAmericanDetailed({ ...input, includeDiagnosticEuropeanProxy: true });
    expect(optIn).toMatchObject({ modelStatus: 'BELOW_INTRINSIC', impliedVol: null, diagnosticProxy: {
      pricingModel: 'EUROPEAN_BSM_DIAGNOSTIC', disclaimer: 'DIAGNOSTIC_ONLY_NOT_AMERICAN_IV',
    } });
    if (optIn.modelStatus === 'SOLVED_AMERICAN') throw new Error('Expected a diagnostic only');
    near(optIn.diagnosticProxy?.iv ?? Number.NaN, reference.europeanProxy.iv);
    expect(Math.abs((optIn.diagnosticProxy?.repricingAmericanPrice ?? Number.NaN)
      - reference.europeanProxy.repricingAmericanPrice)).toBeLessThan(1e-6);
  });

  it('rejects stale and crossed quotes, with a separate EOD exception', () => {
    const input = ivInput({ spot: 5005, strike: 5000, seconds: 60 * 86400, last: 503, contractType: 'put' });
    const stale = { ...input, quoteAsOfUtcSec: asOfUtcSec - 120, maxQuoteAgeSec: 30 };
    expect(solveImpliedVolAmericanDetailed(stale)).toMatchObject({ modelStatus: 'STALE_INPUT', reasonCode: 'QUOTE_STALE' });
    expect(solveImpliedVolAmericanDetailed({ ...stale, quoteAsOfUtcSec: asOfUtcSec + 31 })).toMatchObject({
      modelStatus: 'STALE_INPUT', reasonCode: 'FUTURE_TIMESTAMP',
    });
    expect(solveImpliedVolAmericanDetailed({ ...stale, bypassStaleness: true }).modelStatus).toBe('SOLVED_AMERICAN');
    expect(solveImpliedVolAmericanDetailed({ ...input, bid: 520, ask: 500 })).toMatchObject({
      modelStatus: 'INVALID_INPUT', reasonCode: 'CROSSED_BOOK', observedQuote: { bid: 520, ask: 500, mid: null },
    });
  });

  it.each(reference.roundTrips)('inverts the independent BS02 $contractType premium at $seconds s', (sample) => {
    const input = ivInput(sample);
    const result = solveImpliedVolAmericanDetailed(input);
    expect(result.modelStatus).toBe('SOLVED_AMERICAN');
    near(result.impliedVol ?? Number.NaN, sample.iv);
    near(result.repricingError ?? Number.NaN, 0);
    expect(Math.abs(sample.last - sample.crr1000)).toBeLessThanOrEqual(Math.max(0.025, 0.0015 * sample.spot));
    const greeks = greeksAmericanFiniteDiffOrAnalytical({
      ...input, timeToExpiry: sample.seconds / 31_536_000, volatility: result.impliedVol ?? Number.NaN,
    });
    expect(Number.isFinite(greeks.gamma)).toBe(true);
  });
});

function marginInput(caseName: keyof typeof motor.marginCases) {
  return structuredClone(motor.marginCases[caseName].input) as BymaClearingMarginInput;
}
const base = marginInput('uncovered_short_otm_gt5');
const leg = (contractType: 'call' | 'put', side: 'BUY' | 'SELL', strikeArs: number, lots = 10): BymaMarginLegInput => ({
  ticker: `${contractType}-${String(strikeArs)}`, contractType, side, strikeArs, lots, optionPriceArs: 420, ivDecimal: 0.48,
});
const [uncovered] = base.legs;
if (!uncovered) throw new Error('Missing uncovered reference leg');

describe('A4 · Clearing margin follows verified legs', () => {
  it('charges full uncovered margin when a debit spread label supplies no hedge', () => {
    const result = evaluateBymaClearingMargin({ ...base, strategyKind: 'VERTICAL_DEBIT_SPREAD',
      collateralAssets: base.collateralAssets.map((asset) => asset.kind === 'US_TREASURY_BILL'
        ? { ...asset, explicitAforo: 0.98 } : asset),
    });
    expect(result).toMatchObject({ riskStatus: 'VALID_MODEL_MARGIN', strategyValidation: {
      matchesLegs: false, effectiveStrategyKind: 'UNCOVERED_SHORT', code: 'STRATEGY_MISMATCH_UNCOVERED_SHORT_DETECTED',
    } });
    near(result.baseRequiredMarginArs, reference.margin.uncovered.margin);
    near(result.steppedFloorArs, reference.margin.uncovered.floor);
    expect(evaluateBymaClearingMargin(base).riskStatus).toBe('ESTIMATED_WITH_ASSUMPTIONS');
  });

  it('pairs protective options only when the long expires at or after the short', () => {
    const input = marginInput('vertical_debit_spread');
    const structure = classifyAndValidateMarginStructure(input);
    expect(structure.debitCoveredPairs).toHaveLength(1);
    expect(evaluateBymaClearingMargin(input).baseRequiredMarginArs).toBe(0);
    const inverted = { ...input, legs: input.legs.map((item) => item.side === 'BUY'
      ? { ...item, expiryDateKey: '2026-05-15' } : item) };
    expect(classifyAndValidateMarginStructure(inverted).uncoveredShortLegs).toHaveLength(1);
    expect(evaluateBymaClearingMargin(inverted).baseRequiredMarginArs).toBeGreaterThan(0);
  });

  it('caps the individual credit pair and charges the excess put lots independently', () => {
    const input = { ...base, strategyKind: 'VERTICAL_CREDIT_SPREAD' as const,
      legs: [leg('put', 'SELL', 7200, 20), leg('put', 'BUY', 6800)] };
    const structure = classifyAndValidateMarginStructure(input);
    expect(structure.uncoveredShortLegs[0]?.lots).toBe(10);
    expect(structure.creditSpreadPairs[0]?.[0].lots).toBe(10);
    const result = evaluateBymaClearingMargin(input);
    near(result.baseRequiredMarginArs, reference.margin.creditSplit.margin);
    expect(result.baseRequiredMarginArs).toBeGreaterThan(reference.margin.creditSplit.cap);
  });

  it('covers only short calls with shares and marks incompatible matrix rows', () => {
    const input = { ...base, strategyKind: 'COVERED_CALL' as const, underlyingSharesHeld: 1000,
      legs: [leg('call', 'SELL', 7800), leg('put', 'SELL', 7000)] };
    const result = evaluateBymaClearingMargin(input);
    const uncoveredPut = evaluateBymaClearingMargin({ ...input, legs: [leg('put', 'SELL', 7000)],
      strategyKind: 'UNCOVERED_SHORT' });
    near(result.baseRequiredMarginArs, uncoveredPut.baseRequiredMarginArs);
    const noHolding = evaluateBymaClearingMargin({ ...input, legs: [leg('call', 'SELL', 7800)], underlyingSharesHeld: 0 });
    expect(noHolding.baseRequiredMarginArs).toBeGreaterThan(0);
    expect(noHolding.strategyReferenceMatrix.find((row) => row.strategyKind === 'COVERED_CALL')).toMatchObject({
      applicableToCurrentLegs: false, requiredMarginArs: Number.NaN,
    });
  });

  it('requires a verified cross offset and actual opposite P&L', () => {
    const input = marginInput('cross_collateral_strategy');
    const result = evaluateBymaClearingMargin(input);
    near(result.baseRequiredMarginArs, reference.margin.cross.margin);
    expect(result.appliedCrossOffsetRatio).toBe(reference.margin.cross.offset);
    const verified = { verifiedByClearingRule: true, offsetRatio: 0.1, maxOffsetRatio: 0.05 };
    expect(evaluateBymaClearingMargin({ ...input, crossCollateralEligibility: verified }).appliedCrossOffsetRatio).toBe(0);
    const offset = evaluateBymaClearingMargin({ ...input, crossCollateralEligibility: verified,
      legs: [leg('call', 'SELL', 7800, 20), leg('call', 'BUY', 8000)] });
    expect(offset.appliedCrossOffsetRatio).toBe(0.05);
  });

  it('rejects a zero opposite mark and preserves a verified multiplier exactly once', () => {
    const bad = evaluateBymaClearingMargin({ ...base, strategyKind: 'SHORT_STRADDLE_STRANGLE',
      legs: [leg('call', 'SELL', 7800), { ...leg('put', 'SELL', 7000), optionPriceArs: 0 }] });
    expect(bad.riskStatus).toBe('INDETERMINATE_MARGIN');
    const alternate = evaluateBymaClearingMargin({ ...base, legs: [
      { ...uncovered, contractMultiplier: 10, multiplierSource: 'EXCHANGE_CONTRACT_SPEC' },
    ] });
    near(alternate.projectedT1ExerciseFeeDmIvaArs, reference.margin.fees.stockMultiplierTen);
    for (const incompatible of [
      [{ ...uncovered, underlying: 'GGAL' }, { ...uncovered, underlying: 'YPFD' }],
      [{ ...uncovered, currency: 'USD' as const }],
      [{ ...uncovered, multiplierSource: 'UNVERIFIED' as const }],
    ]) {
      expect(evaluateBymaClearingMargin({ ...base, legs: incompatible })).toMatchObject({
        riskStatus: 'INDETERMINATE_MARGIN', status: 'NO_DATA', baseRequiredMarginArs: Number.NaN,
      });
    }
  });

  it('keeps short IV failures indeterminate and treats invalid long protection conservatively', () => {
    const bad = evaluateBymaClearingMargin({ ...base, legs: [
      { ...uncovered, strikeArs: 7400, ivStatus: 'BELOW_INTRINSIC' },
    ] });
    expect(bad).toMatchObject({ status: 'NO_DATA', riskStatus: 'INDETERMINATE_MARGIN', baseRequiredMarginArs: Number.NaN,
      conservativeIntrinsicFloorBasis: 'LOWER_BOUND_DIAGNOSTIC_ONLY', degradedLegs: [{ side: 'SELL', reason: 'BELOW_INTRINSIC' }] });
    near(bad.conservativeIntrinsicFloorArs, reference.margin.intrinsicOnly);
    const partial = evaluateBymaClearingMargin({ ...base, strategyKind: 'VERTICAL_DEBIT_SPREAD',
      legs: [uncovered, { ...leg('call', 'BUY', 7400, 20), ivStatus: 'STALE_INPUT' }] });
    expect(partial.riskStatus).toBe('PARTIAL_COVERAGE_CONSERVATIVE');
    near(partial.baseRequiredMarginArs, reference.margin.uncovered.margin);
  });
});

it('propagates failed IV through the AR chain, GEX coverage, web mapping and Motor 6 HTTP JSON', async () => {
  const quotes = [
    { symbol: 'GFGC4000DI', px_bid: 90, px_ask: 110, c: 100, open_interest: 125 },
    { symbol: 'GFGV6000DI', px_bid: 960, px_ask: 987, c: 973.5, open_interest: 125 },
    ...[4800, 4900, 5000, 5100].map((strike) => ({
      symbol: `GFGV${String(strike)}DI`, px_bid: 290, px_ask: 310, c: 300, open_interest: 125,
    })),
  ];
  const nowMsFn = () => asOfUtcSec * 1000;
  const fetchFn = (url: string) => {
    const { hostname, pathname } = new URL(url);
    let payload: unknown = [];
    if (pathname === '/live/arg_options') payload = quotes;
    if (pathname === '/live/arg_stocks') {
      payload = [{ symbol: 'GGAL', c: 5005, px_bid: 5004, px_ask: 5006, v: 1200 }];
    }
    if (hostname.includes('bcra.gob.ar')) {
      payload = { results: [{ idVariable: 7, descripcion: 'BADLAR Bancos Privados TNA', valor: 32, fecha: '2026-11-16' }] };
    }
    return Promise.resolve({ ok: true, status: 200, text: JSON.stringify(payload), headers: {} });
  };
  const arRuntime = new ArgentinaMarketRuntime({ env: {}, nowMsFn, fetchFn, minData912IntervalMs: 0 });
  const runtime = new MarketRuntime({ nowMsFn, fetchFn });
  const ggalRuntime = new GgalSpecialistRuntime({ runtime, arRuntime, nowMsFn, fetchFn });
  const chain = await arRuntime.getOptionsChain();
  const illiquid = chain.expiries[0]?.puts.find((put) => put.strike === 6000);
  expect(illiquid).toMatchObject({ ivStatus: 'BELOW_INTRINSIC', iv: null, gamma: null, mark: 973.5 });
  expect(chain.exposureSummary).toMatchObject({ gexStatus: 'PARTIAL_COVERAGE',
    trace: { ivStatusCounts: { BELOW_INTRINSIC: 2 }, directOiInputs: 4 } });
  const nearExpiry = new ArgentinaMarketRuntime({
    env: {}, fetchFn, nowMsFn: () => Date.UTC(2026, 11, 18, 18, 29), minData912IntervalMs: 0,
  });
  const expiring = await nearExpiry.getOptionsChain();
  expect(expiring.expiries[0]?.puts.find(({ strike }) => strike === 5000)).toMatchObject({
    ivStatus: 'UNIDENTIFIABLE_AMERICAN_IV', iv: null,
    ivResolution: { reasonCode: 'NEAR_EXPIRY_DEGENERATE' },
  });
  const wireChain = JSON.parse(JSON.stringify(chain)) as WebArOptionsResponse;
  const row = buildOptionExpiryGroupsFromArOptions(wireChain)[0]?.rows.find(({ strike }) => strike === 6000);
  expect(row).toMatchObject({ putIvStatus: 'BELOW_INTRINSIC', putIV: Number.NaN, putGamma: Number.NaN });
  const server = createHttpWsServer({ runtime, arRuntime, ggalRuntime, port: 0 });
  try {
    const address = await server.start();
    const uri = `http://${address.host}:${String(address.port)}/api/ar/ggal-specialist/margin-risk`;
    const response = await fetch(`${uri}?strategyKind=COVERED_CALL&underlyingSharesHeld=0`);
    expect(response.status).toBe(200);
    const payload = await response.text();
    expect(payload).not.toMatch(/(?<=[:,[])\s*(?:NaN|-?Infinity|undefined)\b/);
    expect(JSON.parse(payload)).toMatchObject({
      marginRiskStatus: 'INDETERMINATE_MARGIN', tailStress: null, requestResolved: { underlyingSharesHeld: 0 },
      marginRisk: { baseRequiredMarginArs: null, totalRequiredWithBuffersArs: null },
      selectedLegs: [{ side: 'SELL', ivStatus: 'BELOW_INTRINSIC', ivPct: null }],
    });
    expect((await fetch(`${uri}?underlyingSharesHeld=-1`)).status).toBe(400);
  } finally {
    await server.stop();
  }
});
