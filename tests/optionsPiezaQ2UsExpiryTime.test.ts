import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { greeksBsm, resolveContractualTimeToExpiryYears, timeToExpiryYears } from '../src/core/options/blackScholes.js';
import { computeContractExposure, computeDealerExposure } from '../src/core/options/exposure.js';
import type { OptionGreeksResult } from '../src/core/options/types.js';
import { normalizeOptionChainSnapshot } from '../src/data/normalizeOptions.js';
import type { FetchFn } from '../src/data/types.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';

interface ReferenceCase {
  expiry: number;
  remaining: number;
  t: number | null;
  strike: number;
  vol: number;
  rate: number;
  dividendYield: number;
  side: 'call' | 'put';
  greeks: OptionGreeksResult | null;
  gex: number | null;
}

const { now, cases } = JSON.parse(readFileSync(
  new URL('../fixtures/options_pieza_q2_reference.json', import.meta.url), 'utf8',
)) as { now: number; cases: ReferenceCase[] };

it('rechaza milisegundos y entradas inválidas y conserva T=0 en la función histórica', () => {
  expect(resolveContractualTimeToExpiryYears(now * 1000, (now + 300) * 1000, 60)).toBeNaN();
  expect(resolveContractualTimeToExpiryYears(NaN, now + 300, 60)).toBeNaN();
  expect(resolveContractualTimeToExpiryYears(now, now + 300, -1)).toBeNaN();
  expect(timeToExpiryYears(now, now)).toBe(0);
});

it.each(cases)('valora $side K=$strike a $remaining segundos del vencimiento', (item) => {
  const { expiry, t, strike, vol, rate, dividendYield, side, greeks, gex } = item;
  const exact = resolveContractualTimeToExpiryYears(now, expiry, 60);
  const market = { spot: 100, rate, dividendYield, nowUtcSec: now };
  const contract = { contractType: side, strike, expiryUtcSec: expiry, iv: vol, openInterest: 10, sharesPerContract: 100 };
  const options = { minTimeToExpirySec: 60, ivResolutionMode: 'ivOnly' } as const;
  if (t === null || greeks === null || gex === null) {
    expect(exact).toBeNaN();
    expect(computeContractExposure(contract, market, options).skipReason).toBe('expired');
    return;
  }
  expect(exact).toBe(t);
  const actual = greeksBsm({ ...market, strike, timeToExpiry: exact, volatility: vol, contractType: side });
  for (const key of Object.keys(greeks) as (keyof OptionGreeksResult)[]) {
    expect(Math.abs(actual[key] - greeks[key])).toBeLessThanOrEqual(1e-9);
  }
  const precomputed = { ...greeks, gamma: greeks.gamma / 2 };
  const exposure = computeContractExposure({ ...contract, precomputedGreeks: precomputed }, market, options);
  expect(exposure.greeks.gamma).toBe(precomputed.gamma);
  const signedGex = (side === 'call' ? 1 : -1) * gex / 2;
  expect(Math.abs(exposure.dollarGex - signedGex)).toBeLessThanOrEqual(1e-9);
  const chain = computeDealerExposure(
    [{ ...contract, precomputedGreeks: precomputed }, { ...contract, expiryUtcSec: now + 60, precomputedGreeks: precomputed }],
    market, options,
  );
  expect(chain.quality.countsByReason.expired).toBe(1);
  expect(Math.abs(chain.netGex - signedGex)).toBeLessThanOrEqual(1e-9);
});

it.each([true, false])('la fila US y exposición comparten las griegas (índice: %s)', (isIndex) => {
  const ticker = 'O:SPXW261218C00100000';
  const { contracts } = normalizeOptionChainSnapshot({ results: [{
    details: {
      ticker, expiration_date: '2026-12-18', contract_type: 'call',
      exercise_style: 'european', strike_price: 100, shares_per_contract: 100,
    },
    implied_volatility: 0.2, open_interest: 100, last_quote: { bid: 0.02, ask: 0.03 },
  }] });
  const contract = contracts[0];
  if (contract === undefined) throw new Error('Cadena de referencia vacía');
  const expiry = contract.expirationTime;
  for (const item of cases.filter(c => c.strike === 100 && c.side === 'call')) {
    const parity = {
      expirySec: expiry, expirationDate: '2026-12-18', timeToExpiry: item.t ?? NaN,
      rate: 0, forward: 100, dividendYield: 0,
    };
    const params = {
      spot: 100, nowSec: expiry - item.remaining, isIndex, fallbackParity: parity,
      expiryParityMap: new Map([[expiry, parity]]), contractOwnIvMap: new Map<string, number>(),
      expiryAtmIvMap: new Map([[expiry, 0.2]]), otmIvByExpiryStrike: new Map<string, number>(),
    };
    const runtime = MarketRuntime.prototype;
    const { inputs, valuationsByTicker } = runtime['buildExposureInputs']({ contracts, valuationParams: params });
    const [row] = runtime['serializeExpiryContractRows']({ ...params, selected: contracts, valuationsByTicker });
    if (item.greeks === null) {
      expect(inputs).toHaveLength(0);
      expect(row).toMatchObject({ delta: null, gamma: null, thetaDaily: null, vegaPer1Pct: null, vanna: null, charm: null });
      continue;
    }
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.iv).toBe(row?.providerIv);
    expect(row?.gamma).toBe(inputs[0]?.precomputedGreeks?.gamma);
    expect(Math.abs((row?.gamma ?? NaN) - item.greeks.gamma)).toBeLessThanOrEqual(1e-9);
  }
});

it.each([
  ['SPY', 300], ['SPY', 61], ['SPY', 60], ['SPY', 59], ['SPY', 0],
  ['I:SPX', 300], ['I:SPX', 61], ['I:SPX', 60],
] as const)('los dos endpoints US publican y agregan %s a %s segundos', async (symbol, remaining) => {
  const date = '2026-01-05';
  const nowMs = Date.UTC(2026, 0, 5, 21) - remaining * 1000;
  const isIndex = symbol === 'I:SPX';
  const root = isIndex ? 'SPXW' : 'SPY';
  const details = {
    ticker: `O:${root}260105C00100000`, expiration_date: date, contract_type: 'call',
    exercise_style: isIndex ? 'european' : 'american', strike_price: 100, shares_per_contract: 100,
  };
  const fetchFn: FetchFn = (url) => {
    const { pathname } = new URL(url);
    let results: unknown[] = [];
    if (pathname === '/v3/snapshot') {
      results = [{
        ticker: symbol, type: isIndex ? 'indices' : 'stocks', market_status: 'open', value: 100,
        session: { price: 100, previous_close: 100 },
      }];
    } else if (pathname.startsWith('/v3/snapshot/options/')) {
      results = [{
        details, implied_volatility: 0.2, open_interest: 100,
        last_quote: { bid: 0.02, ask: 0.03, midpoint: 0.025 },
        underlying_asset: { ticker: symbol, price: 100, timeframe: 'REAL-TIME' },
      }];
    } else if (pathname === '/v3/reference/options/contracts') {
      results = [{ ...details, underlying_ticker: isIndex ? 'SPX' : 'SPY' }];
    } else if (pathname === '/fed/v1/treasury-yields') {
      results = [{
        date: '2026-01-02', yield_1_month: 4, yield_3_month: 4, yield_6_month: 4,
        yield_1_year: 4, yield_2_year: 4, yield_3_year: 4, yield_5_year: 4,
        yield_7_year: 4, yield_10_year: 4, yield_20_year: 4, yield_30_year: 4,
      }];
    } else if (pathname === '/fed/v1/funding-conditions') {
      results = [{ date: '2026-01-02', sofr: 4 }];
    }
    return Promise.resolve({ ok: true, status: 200, headers: {}, text: JSON.stringify({ status: 'OK', results }) });
  };
  const runtime = new MarketRuntime({ apiKey: 'offline-q2', enableWs: false, nowMsFn: () => nowMs, fetchFn });
  const snapshot = await runtime.getSnapshot(symbol, { expiration: date, prefetch: false });
  const chain = await runtime.getUsOptionExpiryChain(symbol, date);
  const baseRow = snapshot.volSurfaceSummary?.contracts.find(row => row.ticker === details.ticker);
  const pointRow = chain.contracts.find(row => row.ticker === details.ticker);
  if (remaining <= 60) {
    expect(baseRow).toBeUndefined();
    expect(pointRow).toBeUndefined();
    expect(snapshot.exposureSummary).toBeNull();
    expect(chain.exposureSummary).toBeNull();
    return;
  }
  expect(baseRow?.gamma).toBeGreaterThan(0);
  expect(pointRow).toEqual(baseRow);
  const nominal = 100 * 100;
  const spot = 100;
  for (const summary of [snapshot.exposureSummary, chain.exposureSummary]) {
    const strike = summary?.byStrike.find(row => row.strike === 100);
    const expected = {
      callGex: nominal * (baseRow?.gamma ?? NaN) * spot ** 2 / 100,
      putGex: 0,
      netDex: nominal * (baseRow?.delta ?? NaN) * spot,
      netVannaExposure: nominal * (baseRow?.vanna ?? NaN) * spot / 100,
      netCharmExposure: nominal * ((baseRow?.charm ?? NaN) / 365) * spot,
    };
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      expect(Math.abs((strike?.[key] ?? NaN) - expected[key])).toBeLessThanOrEqual(1e-9);
    }
  }
});
