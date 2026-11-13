import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../src/data/types.js';
import {
  loadUnusualTrades,
  normalizeUnusualTrades,
  parseSipNanosecondTimestamp,
  type UnusualTradeRecord,
  type UnusualTradeRootKind,
} from '../src/data/unusualTradesLoader.js';

interface FixtureTrade {
  readonly time: number;
  readonly subsecond: {
    readonly nanoseconds: number;
    readonly timestampNs: string;
  };
  readonly ticker: string;
  readonly underlyingTicker: string | null;
  readonly root: string;
  readonly rootKind: UnusualTradeRootKind;
  readonly price: number;
  readonly size: number;
  readonly sharesPerContract: number | null;
  readonly notional: number | null;
  readonly exchange: number | null;
  readonly conditions: readonly number[];
  readonly flags: {
    readonly blockPremium: boolean;
    readonly blockSize: boolean;
    readonly iso: boolean;
    readonly raw: readonly string[];
  };
  readonly sequenceNumber: number | null;
}

interface UnusualTradesFixture {
  readonly meta: {
    readonly precisionTolerance: number;
  };
  readonly unusualTrades: {
    readonly page1Rows: readonly unknown[];
    readonly page2Rows: readonly unknown[];
    readonly caseA_default100_unadjustedUnknown: {
      readonly trades: readonly FixtureTrade[];
      readonly knownNotionalSum: number;
      readonly validNotionalCount: number;
      readonly nanNotionalCount: number;
      readonly reordered: boolean;
      readonly discardCounts: Readonly<Record<string, number>>;
    };
    readonly caseB_withVerifiedGme1Lookup: {
      readonly sharesPerContractByTicker: Readonly<Record<string, number>>;
      readonly trades: readonly FixtureTrade[];
      readonly totalNotional: number;
      readonly validNotionalCount: number;
      readonly nanNotionalCount: number;
      readonly distinctRoots: readonly string[];
      readonly distinctUnderlyingTickers: readonly string[];
    };
    readonly caseC_spxwBlockPremiumIsoOnly: {
      readonly trades: readonly FixtureTrade[];
      readonly totalNotional: number;
    };
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../fixtures/unusual_trades_reference.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as UnusualTradesFixture;
const TOL = fixture.meta.precisionTolerance;

let maxObservedDiff = 0;

function expectClose(actual: number, expected: number, label: string): void {
  const diff = Math.abs(actual - expected);
  if (diff > maxObservedDiff) {
    maxObservedDiff = diff;
  }
  expect(diff, `${label}: actual=${String(actual)} expected=${String(expected)}`).toBeLessThanOrEqual(
    TOL,
  );
}

function expectTradeMatchesFixture(
  actual: UnusualTradeRecord,
  expected: FixtureTrade,
  label: string,
): void {
  expect(actual.time, `${label}.time`).toBe(expected.time);
  expect(actual.subsecond.timestampNs, `${label}.timestampNs`).toBe(expected.subsecond.timestampNs);
  expect(actual.subsecond.nanoseconds, `${label}.nanoseconds`).toBe(
    expected.subsecond.nanoseconds,
  );
  expect(actual.ticker, `${label}.ticker`).toBe(expected.ticker);
  expect(actual.underlyingTicker, `${label}.underlyingTicker`).toBe(expected.underlyingTicker);
  expect(actual.root, `${label}.root`).toBe(expected.root);
  expect(actual.rootKind, `${label}.rootKind`).toBe(expected.rootKind);
  expectClose(actual.price, expected.price, `${label}.price`);
  expectClose(actual.size, expected.size, `${label}.size`);

  if (expected.sharesPerContract === null) {
    expect(Number.isNaN(actual.sharesPerContract), `${label}.sharesPerContract must be NaN`).toBe(
      true,
    );
  } else {
    expectClose(actual.sharesPerContract, expected.sharesPerContract, `${label}.sharesPerContract`);
  }

  if (expected.notional === null) {
    expect(Number.isNaN(actual.notional), `${label}.notional must be NaN`).toBe(true);
  } else {
    expectClose(actual.notional, expected.notional, `${label}.notional`);
  }

  expect(actual.conditions, `${label}.conditions`).toEqual(expected.conditions);
  expect(actual.flags, `${label}.flags`).toEqual(expected.flags);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const prop = (value as Record<string, unknown>)[key];
      if (
        prop !== null &&
        (typeof prop === 'object' || typeof prop === 'function') &&
        !Object.isFrozen(prop)
      ) {
        deepFreeze(prop);
      }
    }
  }
  return value;
}

describe('normalizeUnusualTrades & loadUnusualTrades (Pieza 8)', () => {
  it('matches Python fixture across paginated load, ns->s conversion, SPXW/GME1 roots, and NaN adjusted multiplier hygiene', async () => {
    const requestedUrls: string[] = [];
    const frozenPage1 = deepFreeze(structuredClone(fixture.unusualTrades.page1Rows));
    const frozenPage2 = deepFreeze(structuredClone(fixture.unusualTrades.page2Rows));

    const fetchFn: FetchFn = (url) => {
      requestedUrls.push(url);
      if (!url.includes('cursor=page2')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'OK',
            results: frozenPage1,
            next_url: 'https://api.polygon.io/options/v1/unusual-trades?cursor=page2',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: frozenPage2,
        }),
      });
    };

    // Case A: defaultSharesPerContract=100 (GME1 adjusted keeps NaN without blind fallback)
    const caseA = fixture.unusualTrades.caseA_default100_unadjustedUnknown;
    const resA = await loadUnusualTrades({
      apiKey: 'SECRET_UNUSUAL_KEY',
      fetchFn,
      underlyingTicker: 'SPX',
      sipTimestampGteSec: 1_794_580_600,
      flags: ['block_premium', 'iso'],
      minPremium: 100_000,
      limit: 50_000,
      defaultSharesPerContract: 100,
    });
    // Wait: Case A normalized directly over all raw rows to validate multi-ticker handling & discards too
    const directA = normalizeUnusualTrades(
      { status: 'OK', results: [...frozenPage1, ...frozenPage2] },
      { defaultSharesPerContract: 100 },
    );

    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain('underlying_ticker=SPX');
    expect(requestedUrls[0]).toContain('sip_timestamp.gte=1794580600000000000');
    expect(requestedUrls[0]).toContain('flags=block_premium%2Ciso');
    expect(requestedUrls[0]).toContain('min_premium=100000');
    expect(requestedUrls[0]).toContain('limit=50000');
    expect(requestedUrls[1]).toContain('cursor=page2');
    expect(resA.report.pages).toBe(2);
    expect(resA.report.stoppedReason).toBe('noMorePages');

    expect(directA.report.reordered).toBe(caseA.reordered);
    expect(directA.report.discardCounts).toEqual(caseA.discardCounts);
    expect(directA.report.validNotionalCount).toBe(caseA.validNotionalCount);
    expect(directA.report.nanNotionalCount).toBe(caseA.nanNotionalCount);
    expect(Number.isNaN(directA.report.totalNotional)).toBe(true);
    expectClose(directA.report.knownNotionalSum, caseA.knownNotionalSum, 'caseA.knownNotionalSum');

    expect(directA.trades).toHaveLength(caseA.trades.length);
    for (let i = 0; i < caseA.trades.length; i += 1) {
      const act = directA.trades[i];
      const exp = caseA.trades[i];
      if (act !== undefined && exp !== undefined) {
        expectTradeMatchesFixture(act, exp, `caseA.trades[${String(i)}]`);
      }
    }

    // Case B: enriched GME1 multiplier -> every notional finite
    const caseB = fixture.unusualTrades.caseB_withVerifiedGme1Lookup;
    const directB = normalizeUnusualTrades(
      { status: 'OK', results: [...frozenPage1, ...frozenPage2] },
      {
        sharesPerContractByTicker: caseB.sharesPerContractByTicker,
        defaultSharesPerContract: 100,
      },
    );
    expect(directB.report.validNotionalCount).toBe(caseB.validNotionalCount);
    expect(directB.report.nanNotionalCount).toBe(caseB.nanNotionalCount);
    expect(directB.report.distinctRoots).toEqual(caseB.distinctRoots);
    expect(directB.report.distinctUnderlyingTickers).toEqual(caseB.distinctUnderlyingTickers);
    expectClose(directB.report.totalNotional, caseB.totalNotional, 'caseB.totalNotional');

    for (let i = 0; i < caseB.trades.length; i += 1) {
      const act = directB.trades[i];
      const exp = caseB.trades[i];
      if (act !== undefined && exp !== undefined) {
        expectTradeMatchesFixture(act, exp, `caseB.trades[${String(i)}]`);
      }
    }

    // Case C: isolate root SPXW + flags [block_premium, iso] match=all
    const caseC = fixture.unusualTrades.caseC_spxwBlockPremiumIsoOnly;
    const directC = normalizeUnusualTrades(
      { status: 'OK', results: [...frozenPage1, ...frozenPage2] },
      {
        roots: ['SPXW'],
        requiredFlags: ['block_premium', 'iso'],
        flagMatchMode: 'all',
        defaultSharesPerContract: 100,
      },
    );
    expect(directC.trades).toHaveLength(caseC.trades.length);
    expectClose(directC.report.totalNotional, caseC.totalNotional, 'caseC.totalNotional');
    if (directC.trades[0] !== undefined && caseC.trades[0] !== undefined) {
      expectTradeMatchesFixture(directC.trades[0], caseC.trades[0], 'caseC.trades[0]');
    }

    expect(maxObservedDiff).toBeLessThanOrEqual(TOL);
    console.info(
      `[unusualTrades.test] maxAbsDiff vs Python fixture = ${maxObservedDiff.toExponential(3)}`,
    );
  });

  it('supports excludeAdjustedRoots, minNotional, and rejects missing/bad shares_per_contract without NaN fallback', () => {
    const rawRows = [
      {
        ticker: 'O:SPY261218C00600000',
        underlying_ticker: 'SPY',
        root: 'SPY',
        price: 2.0,
        size: 500,
        sip_timestamp: '1794580680000000001',
        flags: ['block_premium'],
      },
      {
        ticker: 'O:GME1261218C00025000',
        underlying_ticker: 'GME',
        root: 'GME1',
        price: 3.0,
        size: 400,
        shares_per_contract: 100,
        sip_timestamp: '1794580680000000002',
        flags: ['block_premium'],
      },
      {
        ticker: 'O:QQQ261218C00500000',
        underlying_ticker: 'QQQ',
        root: 'QQQ',
        price: 1.0,
        size: 200,
        shares_per_contract: -10, // invalid negative multiplier -> discarded
        sip_timestamp: '1794580680000000003',
        flags: ['iso'],
      },
    ];

    // Without defaultSharesPerContract, SPY gets NaN notional and minNotional filters it out
    const res = normalizeUnusualTrades(
      { status: 'OK', results: rawRows },
      { excludeAdjustedRoots: true, minNotional: 10_000 },
    );
    expect(res.trades).toHaveLength(0);
    expect(res.report.discardCounts.invalidSharesPerContract).toBe(1);
    expect(res.report.discardCounts.filteredOut).toBe(2);

    // Without minNotional filter, SPY retains explicit NaN notional (never ?? 100)
    const noFallback = normalizeUnusualTrades({ status: 'OK', results: [rawRows[0]] });
    expect(noFallback.trades).toHaveLength(1);
    expect(Number.isNaN(noFallback.trades[0]?.sharesPerContract)).toBe(true);
    expect(Number.isNaN(noFallback.trades[0]?.notional)).toBe(true);
    expect(Number.isNaN(noFallback.report.totalNotional)).toBe(true);

    // Exact nanosecond parser rejections (seconds, milliseconds, negative, fractional)
    expect(parseSipNanosecondTimestamp(1_794_580_680)).toBeNull();
    expect(parseSipNanosecondTimestamp(1_794_580_680_000)).toBeNull();
    expect(parseSipNanosecondTimestamp(-1_794_580_680_000_000_000)).toBeNull();
    expect(parseSipNanosecondTimestamp('1794580680123456789')).toEqual({
      time: 1_794_580_680,
      subsecond: {
        nanoseconds: 123_456_789,
        timestampNs: '1794580680123456789',
      },
    });
  });

  it('blocks unsafe next_url origins, redacts apiKey on 401/403/network errors, and handles opt-in 429 retries cleanly', async () => {
    const secret = 'TOP_SECRET_MASSIVE_TOKEN_777';

    // Untrusted next_url
    const unsafeRes = await loadUnusualTrades({
      apiKey: secret,
      fetchFn: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'OK',
            results: [],
            next_url: 'https://evil.attacker.example/options/v1/unusual-trades?cursor=x',
          }),
        }),
    });
    expect(unsafeRes.report.stoppedReason).toBe('malformedResponse');
    expect(unsafeRes.report.malformedResponse).toBe(true);

    // HTTP 403 error leaking apiKey in provider response body -> clean redacted ProviderError
    const authRes = await loadUnusualTrades({
      apiKey: secret,
      fetchFn: () =>
        Promise.resolve({
          ok: false,
          status: 403,
          text: JSON.stringify({
            status: 'ERROR',
            error: `Forbidden for apikey=${secret}`,
          }),
        }),
    });
    expect(authRes.trades).toHaveLength(0);
    expect(authRes.report.stoppedReason).toBe('providerError');
    expect(authRes.report.providerError?.code).toBe(403);
    expect(authRes.report.providerError?.message).not.toContain(secret);
    expect(authRes.report.providerError?.message).toContain('<redacted>');

    // 429 default (retry429MaxAttempts = 0) stops immediately vs opt-in retry = 2
    let attemptsDefault = 0;
    const noRetry = await loadUnusualTrades({
      apiKey: secret,
      fetchFn: () => {
        attemptsDefault += 1;
        return Promise.resolve({ ok: false, status: 429, text: 'rate limit' });
      },
    });
    expect(attemptsDefault).toBe(1);
    expect(noRetry.report.providerError?.code).toBe(429);

    let attemptsOptIn = 0;
    const sleeps: number[] = [];
    const withRetry = await loadUnusualTrades({
      apiKey: secret,
      retry429MaxAttempts: 2,
      retry429BaseDelayMs: 500,
      sleepFn: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      fetchFn: () => {
        attemptsOptIn += 1;
        if (attemptsOptIn === 1) {
          return Promise.resolve({
            ok: false,
            status: 429,
            retryAfterSeconds: 2,
            text: 'rate limit',
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({ status: 'OK', results: [] }),
        });
      },
    });
    expect(attemptsOptIn).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect(withRetry.report.providerError).toBeNull();
    expect(withRetry.report.stoppedReason).toBe('noMorePages');

    // Validation bounds
    await expect(
      loadUnusualTrades({
        apiKey: secret,
        limit: 50_001,
        fetchFn: () => Promise.resolve({ ok: true, status: 200, text: '{}' }),
      }),
    ).rejects.toThrow(/50000/);
  });

  it('adds OCC ticker.gte/ticker.lt range for underlyingTicker/root unless explicit ticker is provided', async () => {
    const requestedUrls: string[] = [];
    const fetchWithUrls = (rows: readonly unknown[]): FetchFn => {
      return (url) => {
        requestedUrls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({ status: 'OK', results: rows }),
        });
      };
    };

    const spxRes = await loadUnusualTrades({
      apiKey: 'TEST_OCC_RANGE_KEY',
      underlyingTicker: 'SPX',
      defaultSharesPerContract: 100,
      fetchFn: fetchWithUrls([
        {
          ticker: 'O:SPX261218C07500000',
          underlying_ticker: 'SPX',
          root: 'SPX',
          price: 50,
          size: 20,
          sip_timestamp: '1794580680000000001',
          flags: ['block_premium'],
        },
        {
          ticker: 'O:SPXW261120P07500000',
          underlying_ticker: 'SPX',
          root: 'SPXW',
          price: 12,
          size: 30,
          sip_timestamp: '1794580680000000002',
          flags: ['iso'],
        },
        {
          ticker: 'O:SPX1261120C07000000',
          underlying_ticker: 'SPX',
          root: 'SPX1',
          price: 40,
          size: 10,
          shares_per_contract: 100,
          sip_timestamp: '1794580680000000003',
          flags: ['block_size'],
        },
        {
          ticker: 'O:SPXY261120C00100000',
          underlying_ticker: 'SPXY',
          root: 'SPXY',
          price: 2,
          size: 10,
          sip_timestamp: '1794580680000000004',
          flags: ['iso'],
        },
      ]),
    });

    const spxParams = new URL(requestedUrls[0] ?? '').searchParams;
    expect(spxParams.get('underlying_ticker')).toBe('SPX');
    expect(spxParams.get('ticker.gte')).toBe('O:SPX');
    expect(spxParams.get('ticker.lt')).toBe('O:SPY');
    expect(spxParams.has('ticker')).toBe(false);
    expect(spxRes.trades.map((t) => t.root)).toEqual(['SPX', 'SPXW', 'SPX1']);
    expect(spxRes.report.discardCounts.filteredOut).toBe(1);

    await loadUnusualTrades({
      apiKey: 'TEST_OCC_RANGE_KEY',
      underlyingTicker: 'SPY',
      fetchFn: fetchWithUrls([]),
    });
    const spyParams = new URL(requestedUrls[1] ?? '').searchParams;
    expect(spyParams.get('ticker.gte')).toBe('O:SPY');
    expect(spyParams.get('ticker.lt')).toBe('O:SPZ');

    await loadUnusualTrades({
      apiKey: 'TEST_OCC_RANGE_KEY',
      underlyingTicker: 'SPX',
      root: 'SPXW',
      fetchFn: fetchWithUrls([]),
    });
    const rootParams = new URL(requestedUrls[2] ?? '').searchParams;
    expect(rootParams.get('underlying_ticker')).toBe('SPX');
    expect(rootParams.get('root')).toBe('SPXW');
    expect(rootParams.get('ticker.gte')).toBe('O:SPXW');
    expect(rootParams.get('ticker.lt')).toBe('O:SPXX');

    await loadUnusualTrades({
      apiKey: 'TEST_OCC_RANGE_KEY',
      ticker: 'O:SPX261218C07500000',
      underlyingTicker: 'SPX',
      root: 'SPXW',
      fetchFn: fetchWithUrls([]),
    });
    const explicitParams = new URL(requestedUrls[3] ?? '').searchParams;
    expect(explicitParams.get('ticker')).toBe('O:SPX261218C07500000');
    expect(explicitParams.get('underlying_ticker')).toBe('SPX');
    expect(explicitParams.get('root')).toBe('SPXW');
    expect(explicitParams.has('ticker.gte')).toBe(false);
    expect(explicitParams.has('ticker.lt')).toBe(false);
  });
});
