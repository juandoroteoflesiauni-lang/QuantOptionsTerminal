import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  loadDividends,
  loadFundingConditions,
  loadOptionOpenInterest,
  loadTreasuryYields,
  loadUnifiedSnapshot,
} from '../src/data/macroLoader.js';
import type { TreasuryCurvePoint } from '../src/data/macroTypes.js';
import {
  extractTreasuryCurvePoints,
  interpolateTreasuryYield,
  normalizeDividends,
  normalizeFundingConditions,
  normalizeOptionOpenInterest,
  normalizeTreasuryYields,
  normalizeUnifiedSnapshot,
  percentToDecimalRate,
  TREASURY_TENORS,
} from '../src/data/normalizeMacro.js';
import type { FetchFn, FetchResponse } from '../src/data/types.js';

interface InterpolationFixtureCase {
  readonly name: string;
  readonly sourceKind: 'observation' | 'customPoints';
  readonly observationDate: string | null;
  readonly customPoints: readonly TreasuryCurvePoint[] | null;
  readonly tenorYears: number;
  readonly method: 'linear' | 'logLinear';
  readonly extrapolation: 'clamp' | 'nan';
  readonly allowMissingTenors: boolean;
  readonly overnightRate: number | 'NaN' | null;
  readonly expectedRate: number | 'NaN';
}

interface MacroFixtureFile {
  readonly schemaVersion: number;
  readonly testSecret: string;
  readonly treasury: {
    readonly raw: unknown;
    readonly expectedNormalized: {
      readonly observations: readonly Record<string, unknown>[];
      readonly report: Record<string, unknown>;
    };
    readonly interpolationCases: readonly InterpolationFixtureCase[];
  };
  readonly funding: {
    readonly raw: unknown;
    readonly expectedNormalized: {
      readonly observations: readonly Record<string, unknown>[];
      readonly report: Record<string, unknown>;
    };
  };
  readonly dividends: {
    readonly raw: unknown;
    readonly expectedNormalized: {
      readonly dividends: readonly Record<string, unknown>[];
      readonly report: Record<string, unknown>;
    };
  };
  readonly openInterest: {
    readonly raw: unknown;
    readonly expectedNormalized: {
      readonly records: readonly Record<string, unknown>[];
      readonly report: Record<string, unknown>;
    };
  };
  readonly unifiedSnapshot: {
    readonly raw: unknown;
    readonly expectedNormalized: {
      readonly stocks: readonly Record<string, unknown>[];
      readonly indices: readonly Record<string, unknown>[];
      readonly options: readonly Record<string, unknown>[];
      readonly other: readonly Record<string, unknown>[];
      readonly tickerErrors: readonly Record<string, unknown>[];
      readonly report: Record<string, unknown>;
    };
  };
  readonly loaderHelpers: {
    readonly mirrorNextUrlInput: string;
    readonly mirrorNextUrlExpected: string;
  };
}

const fixturePath = resolve(process.cwd(), 'fixtures/macro_data_reference.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as MacroFixtureFile;

const diffStats = {
  maxAbsDiff: 0,
  maxRelDiff: 0,
  numericComparisons: 0,
};

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function assertMatchesFixtureValue(
  actual: unknown,
  expected: unknown,
  path: string,
): void {
  if (expected === 'NaN') {
    expect(typeof actual, `${path} should be number (NaN)`).toBe('number');
    expect(Number.isNaN(actual as number), `${path} should be NaN`).toBe(true);
    return;
  }
  if (expected === 'Infinity') {
    expect(actual, `${path} should be +Infinity`).toBe(Number.POSITIVE_INFINITY);
    return;
  }
  if (expected === '-Infinity') {
    expect(actual, `${path} should be -Infinity`).toBe(Number.NEGATIVE_INFINITY);
    return;
  }
  if (typeof expected === 'number') {
    expect(typeof actual, `${path} should be number`).toBe('number');
    const numActual = actual as number;
    expect(Number.isFinite(numActual), `${path} should be finite`).toBe(true);
    const absDiff = Math.abs(numActual - expected);
    const scale = Math.max(Math.abs(expected), 1);
    const relDiff = absDiff / scale;
    if (absDiff > diffStats.maxAbsDiff) {
      diffStats.maxAbsDiff = absDiff;
    }
    if (relDiff > diffStats.maxRelDiff) {
      diffStats.maxRelDiff = relDiff;
    }
    diffStats.numericComparisons += 1;
    expect(absDiff, `${path} absDiff`).toBeLessThanOrEqual(1e-12);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} should be array`).toBe(true);
    const arrActual = actual as readonly unknown[];
    expect(arrActual.length, `${path}.length`).toBe(expected.length);
    for (let i = 0; i < expected.length; i += 1) {
      assertMatchesFixtureValue(arrActual[i], expected[i], `${path}[${String(i)}]`);
    }
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    expect(
      actual !== null && typeof actual === 'object' && !Array.isArray(actual),
      `${path} should be plain object`,
    ).toBe(true);
    const expRecord = expected as Record<string, unknown>;
    const actRecord = actual as Record<string, unknown>;
    expect(Object.keys(actRecord).sort(), `${path} keys`).toEqual(
      Object.keys(expRecord).sort(),
    );
    for (const key of Object.keys(expRecord)) {
      assertMatchesFixtureValue(actRecord[key], expRecord[key], `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

interface QueuedResponseSpec {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly retryAfterSeconds?: number | null;
}

function createMockFetch(
  responses: readonly QueuedResponseSpec[],
  recordedUrls: string[],
): FetchFn {
  return (url: string): Promise<FetchResponse> => {
    recordedUrls.push(url);
    const spec = responses[recordedUrls.length - 1];
    if (spec === undefined) {
      return Promise.reject(new Error(`Unexpected fetch #${String(recordedUrls.length)}`));
    }
    const text = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    return Promise.resolve({
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      text,
      ...(spec.headers === undefined ? {} : { headers: spec.headers }),
      ...(spec.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: spec.retryAfterSeconds }),
    });
  };
}

afterAll(() => {
  if (diffStats.numericComparisons > 0) {
    console.info(
      `[Pieza 4 macroData] ${String(diffStats.numericComparisons)} numeric comparisons vs Python reference: maxAbsDiff=${diffStats.maxAbsDiff.toExponential(3)}, maxRelDiff=${diffStats.maxRelDiff.toExponential(3)}`,
    );
  }
});

describe('Pieza 4: Normalizadores macro, SOFR, dividendos, OI y Unified Snapshot vs referencia Python', () => {
  it('TREASURY_TENORS expone exactamente los 11 tenores ordenados en fracciones de año', () => {
    expect(TREASURY_TENORS.length).toBe(11);
    expect(TREASURY_TENORS[0]?.label).toBe('1M');
    expect(TREASURY_TENORS[0]?.years).toBeCloseTo(1 / 12, 15);
    expect(TREASURY_TENORS[10]?.label).toBe('30Y');
    expect(TREASURY_TENORS[10]?.years).toBe(30);
    expect(percentToDecimalRate(4.31)).toBeCloseTo(0.0431, 15);
    expect(Number.isNaN(percentToDecimalRate(null))).toBe(true);
    expect(Number.isNaN(percentToDecimalRate(Number.POSITIVE_INFINITY))).toBe(true);
  });

  it('normalizeTreasuryYields coincide exactamente con la referencia Python (pre-1970 + NaN parciales)', () => {
    const rawFrozen = deepFreeze(structuredClone(fixture.treasury.raw));
    const actual = normalizeTreasuryYields(rawFrozen);
    assertMatchesFixtureValue(actual, fixture.treasury.expectedNormalized, 'treasury');
  });

  it('interpolateTreasuryYield (lineal y logLinear sobre P(T)=exp(-rT)) coincide exactamente con Python', () => {
    const rawFrozen = deepFreeze(structuredClone(fixture.treasury.raw));
    const normalized = normalizeTreasuryYields(rawFrozen);
    const byDate = new Map(normalized.observations.map((obs) => [obs.date, obs]));

    for (const c of fixture.treasury.interpolationCases) {
      const overnightRate =
        c.overnightRate === 'NaN'
          ? Number.NaN
          : c.overnightRate === null
            ? undefined
            : c.overnightRate;

      let actualRate: number;
      if (c.sourceKind === 'customPoints') {
        const pts = deepFreeze(structuredClone(c.customPoints ?? []));
        actualRate = interpolateTreasuryYield(pts, c.tenorYears, {
          method: c.method,
          extrapolation: c.extrapolation,
          allowMissingTenors: c.allowMissingTenors,
        });
      } else {
        const obs = c.observationDate === null ? undefined : byDate.get(c.observationDate);
        expect(obs, `missing observation ${String(c.observationDate)}`).toBeDefined();
        if (obs === undefined) {
          continue;
        }
        actualRate = interpolateTreasuryYield(obs, c.tenorYears, {
          method: c.method,
          extrapolation: c.extrapolation,
          allowMissingTenors: c.allowMissingTenors,
          ...(overnightRate === undefined ? {} : { overnightRate }),
        });
      }

      assertMatchesFixtureValue(actualRate, c.expectedRate, `interp.${c.name}`);
    }

    const fullObs = normalized.observations[1];
    expect(fullObs).toBeDefined();
    if (fullObs !== undefined) {
      const strictPts = extractTreasuryCurvePoints(fullObs);
      expect(strictPts.length).toBe(11);
      const withSofr = extractTreasuryCurvePoints(fullObs, { overnightRate: 0.0433 });
      expect(withSofr[0]?.tenorLabel).toBe('ON');
      expect(withSofr[0]?.tenorYears).toBeCloseTo(1 / 365, 15);
    }

    // Rechazos puros de entradas inválidas en interpolación
    expect(
      Number.isNaN(
        interpolateTreasuryYield(
          [
            { tenorYears: 0, tenorLabel: 'ZERO', rate: 0.04 },
            { tenorYears: 1, tenorLabel: '1Y', rate: 0.041 },
          ],
          0.5,
        ),
      ),
    ).toBe(true);
    expect(
      Number.isNaN(
        interpolateTreasuryYield(
          [
            { tenorYears: 1, tenorLabel: '1Y-A', rate: 0.041 },
            { tenorYears: 1, tenorLabel: '1Y-B', rate: 0.042 },
          ],
          1,
        ),
      ),
    ).toBe(true);
    expect(Number.isNaN(interpolateTreasuryYield([], Number.NaN))).toBe(true);
  });

  it('normalizeFundingConditions coincide exactamente con Python (% -> decimal + SOFR + volúmenes)', () => {
    const rawFrozen = deepFreeze(structuredClone(fixture.funding.raw));
    const actual = normalizeFundingConditions(rawFrozen);
    assertMatchesFixtureValue(actual, fixture.funding.expectedNormalized, 'funding');
  });

  it('normalizeDividends coincide exactamente con Python (DST 09:30 ET + NaN explícito en faltantes)', () => {
    const rawFrozen = deepFreeze(structuredClone(fixture.dividends.raw));
    const actual = normalizeDividends(rawFrozen);
    assertMatchesFixtureValue(actual, fixture.dividends.expectedNormalized, 'dividends');
  });

  it('normalizeOptionOpenInterest coincide exactamente con Python (preserva open_interest=0 y valida campos)', () => {
    const rawFrozen = deepFreeze(structuredClone(fixture.openInterest.raw));
    const actual = normalizeOptionOpenInterest(rawFrozen);
    assertMatchesFixtureValue(actual, fixture.openInterest.expectedNormalized, 'openInterest');
  });

  it('normalizeUnifiedSnapshot separa activos, preserva early_trading sin OHLC, overnight_trading y tickerErrors sin abortar', () => {
    const rawFrozen = deepFreeze(structuredClone(fixture.unifiedSnapshot.raw));
    const actual = normalizeUnifiedSnapshot(rawFrozen);
    assertMatchesFixtureValue(
      actual,
      fixture.unifiedSnapshot.expectedNormalized,
      'unifiedSnapshot',
    );
  });

  it('normalizadores devuelven malformedResponse o providerError limpio si la envolvente es inválida o status != OK', () => {
    const badEnvelope = normalizeTreasuryYields('no-es-objeto');
    expect(badEnvelope.observations).toEqual([]);
    expect(badEnvelope.report.malformedResponse).toBe(true);

    const errEnvelope = normalizeFundingConditions({
      status: 'ERROR',
      error: 'Plan upgrade required at https://api.massive.com/fed/v1/funding-conditions?apikey=secret999',
    });
    expect(errEnvelope.observations).toEqual([]);
    expect(errEnvelope.report.providerError?.code).toBe(0);
    expect(errEnvelope.report.providerError?.message).not.toContain('secret999');
    expect(errEnvelope.report.providerError?.message).toContain('<redacted>');
  });
});

describe('Pieza 4: Cargadores REST paginados con FetchFn inyectado', () => {
  it('loadTreasuryYields pagina con espejo polygon->massive, construye filtros y tolera HTTP 403/401 sin filtrar secretos', async () => {
    const treasuryResults = (fixture.treasury.raw as { results: unknown[] }).results;
    const calls: string[] = [];

    const okResult = await loadTreasuryYields({
      apiKey: fixture.testSecret,
      dateGte: '2026-01-01',
      dateLte: '2026-04-02',
      sort: 'date',
      order: 'asc',
      limit: 500,
      fetchFn: createMockFetch(
        [
          {
            status: 200,
            body: {
              status: 'OK',
              results: [treasuryResults[0]],
              next_url: fixture.loaderHelpers.mirrorNextUrlInput,
            },
          },
          {
            status: 200,
            body: {
              status: 'OK',
              results: [treasuryResults[1]],
            },
          },
        ],
        calls,
      ),
    });

    expect(calls.length).toBe(2);
    const req1 = new URL(calls[0] ?? '');
    expect(req1.origin).toBe('https://api.massive.com');
    expect(req1.pathname).toBe('/fed/v1/treasury-yields');
    expect(req1.searchParams.get('date.gte')).toBe('2026-01-01');
    expect(req1.searchParams.get('date.lte')).toBe('2026-04-02');
    expect(req1.searchParams.get('limit')).toBe('500');
    expect(req1.searchParams.get('apikey')).toBe(fixture.testSecret);
    expect(calls[1]).toBe(fixture.loaderHelpers.mirrorNextUrlExpected);

    expect(okResult.report.pages).toBe(2);
    expect(okResult.report.stoppedReason).toBe('noMorePages');
    expect(okResult.report.reordered).toBe(true);
    expect(okResult.observations.map((o) => o.date)).toEqual(['1962-01-02', '2026-04-02']);

    // HTTP 403 / 401 debe devolverse como providerError limpio sin lanzar ni filtrar el secreto
    for (const status of [401, 403] as const) {
      const errCalls: string[] = [];
      const errRes = await loadTreasuryYields({
        apiKey: fixture.testSecret,
        fetchFn: createMockFetch(
          [
            {
              status,
              body: {
                status: 'NOT_AUTHORIZED',
                error: `Access denied for key ${fixture.testSecret} at https://api.massive.com/fed/v1/treasury-yields?apikey=${fixture.testSecret}`,
              },
            },
          ],
          errCalls,
        ),
      });

      expect(errRes.observations).toEqual([]);
      expect(errRes.report.stoppedReason).toBe('providerError');
      expect(errRes.report.providerError?.code).toBe(status);
      expect(errRes.report.providerError?.message).not.toContain(fixture.testSecret);
      expect(errRes.report.providerError?.message).toContain('<redacted>');
    }
  });

  it('loadFundingConditions tolera 403 y normaliza SOFR/IORB/volúmenes en respuesta válida', async () => {
    const calls: string[] = [];
    const okRes = await loadFundingConditions({
      apiKey: fixture.testSecret,
      dateGte: '1954-07-01',
      fetchFn: createMockFetch([{ status: 200, body: fixture.funding.raw }], calls),
    });

    expect(new URL(calls[0] ?? '').pathname).toBe('/fed/v1/funding-conditions');
    expect(new URL(calls[0] ?? '').searchParams.get('date.gte')).toBe('1954-07-01');
    assertMatchesFixtureValue(
      { observations: okRes.observations, report: { ...okRes.report, pages: undefined, stoppedReason: undefined } },
      {
        observations: fixture.funding.expectedNormalized.observations,
        report: {
          ...fixture.funding.expectedNormalized.report,
          pages: undefined,
          stoppedReason: undefined,
        },
      },
      'loadFundingConditions',
    );
    expect(okRes.report.stoppedReason).toBe('noMorePages');
    expect(okRes.report.pages).toBe(1);

    const errRes = await loadFundingConditions({
      apiKey: fixture.testSecret,
      fetchFn: createMockFetch(
        [{ status: 403, body: `Forbidden for ${fixture.testSecret}` }],
        [],
      ),
    });
    expect(errRes.report.stoppedReason).toBe('providerError');
    expect(errRes.report.providerError?.code).toBe(403);
    expect(errRes.report.providerError?.message).not.toContain(fixture.testSecret);
  });

  it('loadDividends envía filtros correctos, normaliza DST y rechaza límites/frecuencias inválidos', async () => {
    const calls: string[] = [];
    const res = await loadDividends({
      apiKey: fixture.testSecret,
      ticker: 'SPY',
      exDividendDateGte: '2025-01-01',
      exDividendDateLte: '2025-12-31',
      distributionType: 'recurring',
      frequency: 4,
      order: 'asc',
      limit: 5000,
      fetchFn: createMockFetch([{ status: 200, body: fixture.dividends.raw }], calls),
    });

    const url = new URL(calls[0] ?? '');
    expect(url.pathname).toBe('/stocks/v1/dividends');
    expect(url.searchParams.get('ticker')).toBe('SPY');
    expect(url.searchParams.get('ex_dividend_date.gte')).toBe('2025-01-01');
    expect(url.searchParams.get('ex_dividend_date.lte')).toBe('2025-12-31');
    expect(url.searchParams.get('distribution_type')).toBe('recurring');
    expect(url.searchParams.get('frequency')).toBe('4');
    expect(url.searchParams.get('limit')).toBe('5000');
    expect(res.dividends.length).toBe(2);

    await expect(
      loadDividends({
        apiKey: fixture.testSecret,
        limit: 5001,
        fetchFn: createMockFetch([], []),
      }),
    ).rejects.toThrow(/limit/);
  });

  it('loadOptionOpenInterest serializa filtros completos y acepta limit=50000', async () => {
    const calls: string[] = [];
    const res = await loadOptionOpenInterest({
      apiKey: fixture.testSecret,
      root: 'SPXW',
      underlyingTicker: 'SPX',
      dateGte: '2022-09-01',
      expirationDateGte: '2026-05-01',
      expirationDateLte: '2026-05-31',
      contractType: 'put',
      strikePriceGte: 5000,
      strikePriceLte: 6000,
      fetchFn: createMockFetch([{ status: 200, body: fixture.openInterest.raw }], calls),
    });

    const url = new URL(calls[0] ?? '');
    expect(url.pathname).toBe('/options/v1/open-interest');
    expect(url.searchParams.get('root')).toBe('SPXW');
    expect(url.searchParams.get('underlying_ticker')).toBe('SPX');
    expect(url.searchParams.get('date.gte')).toBe('2022-09-01');
    expect(url.searchParams.get('expiration_date.gte')).toBe('2026-05-01');
    expect(url.searchParams.get('contract_type')).toBe('put');
    expect(url.searchParams.get('strike_price.gte')).toBe('5000');
    expect(url.searchParams.get('limit')).toBe('50000');
    expect(res.records.length).toBe(2);
    expect(res.records[0]?.openInterest).toBe(0);
  });

  it('loadUnifiedSnapshot deduplica tickers, redacta errores parciales, soporta >1 página y valida máximo 250 tickers', async () => {
    const allRows = (fixture.unifiedSnapshot.raw as { results: unknown[] }).results;
    const calls: string[] = [];
    const res = await loadUnifiedSnapshot({
      apiKey: fixture.testSecret,
      tickers: [' TSLA ', 'AAPL', 'I:VIX', 'I:SPX', 'I:SKEW', 'I:NDX', 'TSLA'],
      limit: 250,
      fetchFn: createMockFetch(
        [
          {
            status: 200,
            body: {
              status: 'OK',
              results: allRows.slice(0, 5),
              next_url: 'https://api.polygon.io/v3/snapshot?cursor=p2',
            },
          },
          {
            status: 200,
            body: {
              status: 'OK',
              results: allRows.slice(5),
            },
          },
        ],
        calls,
      ),
    });

    expect(calls.length).toBe(2);
    const req1 = new URL(calls[0] ?? '');
    expect(req1.pathname).toBe('/v3/snapshot');
    expect(req1.searchParams.get('ticker.any_of')).toBe(
      'TSLA,AAPL,I:VIX,I:SPX,I:SKEW,I:NDX',
    );
    expect(res.report.requestedTickers).toEqual([
      'TSLA',
      'AAPL',
      'I:VIX',
      'I:SPX',
      'I:SKEW',
      'I:NDX',
    ]);
    expect(res.report.pages).toBe(2);
    expect(res.stocks.length).toBe(2);
    expect(res.indices.length).toBe(4);
    expect(res.options.length).toBe(1);
    expect(res.other.length).toBe(1);
    expect(res.tickerErrors.length).toBe(2);
    expect(res.tickerErrors[0]?.error).toBe('NOT_ENTITLED');
    expect(res.tickerErrors[0]?.message).not.toContain(fixture.testSecret);
    expect(res.tickerErrors[0]?.message).toContain('<redacted>');
    expect(res.report.earlyTradingWithoutOhlc).toBe(1);
    expect(res.report.overnightTradingCount).toBe(1);

    const tooManyTickers = Array.from({ length: 251 }, (_, i) => `T${String(i)}`);
    await expect(
      loadUnifiedSnapshot({
        apiKey: fixture.testSecret,
        tickers: tooManyTickers,
        fetchFn: createMockFetch([], []),
      }),
    ).rejects.toThrow(/250/);

    await expect(
      loadUnifiedSnapshot({
        apiKey: fixture.testSecret,
        tickers: [],
        fetchFn: createMockFetch([], []),
      }),
    ).rejects.toThrow(/at least one/);
  });

  it('bloquea next_url externo malicioso, respeta maxPages, throttling y reintento 429 opt-in', async () => {
    // 1. next_url externo malicioso: nunca hace fetch al dominio atacante
    const evilCalls: string[] = [];
    const evilRes = await loadTreasuryYields({
      apiKey: fixture.testSecret,
      fetchFn: createMockFetch(
        [
          {
            status: 200,
            body: {
              status: 'OK',
              results: [],
              next_url: 'https://evil.example.com/steal-key?cursor=1',
            },
          },
        ],
        evilCalls,
      ),
    });
    expect(evilCalls.length).toBe(1);
    expect(evilRes.report.stoppedReason).toBe('malformedResponse');
    expect(evilRes.report.malformedResponse).toBe(true);

    // 2. maxPages + minRequestIntervalMs
    const sleeps: number[] = [];
    const maxPagesCalls: string[] = [];
    const maxPagesRes = await loadTreasuryYields({
      apiKey: fixture.testSecret,
      maxPages: 2,
      minRequestIntervalMs: 125,
      sleepFn: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      fetchFn: createMockFetch(
        [
          {
            status: 200,
            body: { status: 'OK', results: [], next_url: 'https://api.massive.com/fed/v1/treasury-yields?cursor=2' },
          },
          {
            status: 200,
            body: { status: 'OK', results: [], next_url: 'https://api.massive.com/fed/v1/treasury-yields?cursor=3' },
          },
        ],
        maxPagesCalls,
      ),
    });
    expect(maxPagesCalls.length).toBe(2);
    expect(maxPagesRes.report.stoppedReason).toBe('maxPages');
    expect(sleeps).toEqual([125]);

    // 3. Reintento 429: opt-in por defecto (0 intentos adicionales) vs habilitado
    const noRetryRes = await loadTreasuryYields({
      apiKey: fixture.testSecret,
      fetchFn: createMockFetch([{ status: 429, body: { error: 'rate limit' } }], []),
    });
    expect(noRetryRes.report.stoppedReason).toBe('providerError');
    expect(noRetryRes.report.providerError?.code).toBe(429);

    const retrySleeps: number[] = [];
    const retryCalls: string[] = [];
    const retryRes = await loadTreasuryYields({
      apiKey: fixture.testSecret,
      retry429MaxAttempts: 2,
      retry429BaseDelayMs: 500,
      retry429MaxDelayMs: 5000,
      sleepFn: (ms) => {
        retrySleeps.push(ms);
        return Promise.resolve();
      },
      fetchFn: createMockFetch(
        [
          { status: 429, body: { error: 'rate limit 1' }, headers: { 'retry-after': '2' } },
          { status: 429, body: { error: 'rate limit 2' } },
          { status: 200, body: { status: 'OK', results: [{ date: '2026-04-02', yield_10_year: 4.31 }] } },
        ],
        retryCalls,
      ),
    });
    expect(retryCalls.length).toBe(3);
    expect(retrySleeps).toEqual([2000, 1000]);
    expect(retryRes.report.stoppedReason).toBe('noMorePages');
    expect(retryRes.observations[0]?.yield10Year).toBeCloseTo(0.0431, 15);
  });

  it('rechaza configuración insegura (baseUrl http://, credenciales en URL, apiKey vacía)', async () => {
    await expect(
      loadTreasuryYields({
        apiKey: '  ',
        fetchFn: createMockFetch([], []),
      }),
    ).rejects.toThrow(/apiKey/);

    await expect(
      loadTreasuryYields({
        apiKey: fixture.testSecret,
        baseUrl: 'http://api.massive.com',
        fetchFn: createMockFetch([], []),
      }),
    ).rejects.toThrow(/https:/);

    await expect(
      loadTreasuryYields({
        apiKey: fixture.testSecret,
        baseUrl: 'https://user:pass@api.massive.com',
        fetchFn: createMockFetch([], []),
      }),
    ).rejects.toThrow(/credentials/);
  });
});
