import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadOptionChain,
  loadOptionContracts,
  toReferenceUnderlyingTicker,
  toSnapshotUnderlyingAsset,
} from '../src/data/optionsLoader.js';
import {
  computeCalendarDte,
  normalizeOptionChainSnapshot,
  normalizeOptionContracts,
  parseExpirationDate,
  parseProviderTimestampSeconds,
} from '../src/data/normalizeOptions.js';
import type {
  AdditionalUnderlying,
  LoadOptionChainOptions,
  NormalizeOptionChainOptions,
  NormalizeOptionContractsOptions,
  OptionContract,
  OptionSnapshotContract,
  OptionUnderlyingSnapshot,
} from '../src/data/optionsTypes.js';
import type { FetchFn, FetchResponse } from '../src/data/types.js';

interface FixtureResponse {
  readonly status?: number;
  readonly ok?: boolean;
  readonly text: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly retryAfterSeconds?: number | null;
}

interface FixtureContractsCase {
  readonly description: string;
  readonly raw: unknown;
  readonly options: NormalizeOptionContractsOptions;
  readonly expected: {
    readonly contracts: readonly Record<string, unknown>[];
    readonly report: Record<string, unknown>;
  };
}

interface FixtureSnapshotCase {
  readonly description: string;
  readonly raw: unknown;
  readonly referenceRaw: unknown;
  readonly options: NormalizeOptionChainOptions;
  readonly expected: {
    readonly contracts: readonly Record<string, unknown>[];
    readonly underlying: Record<string, unknown> | null;
    readonly report: Record<string, unknown>;
  };
}

interface FixtureLoaderCase {
  readonly description: string;
  readonly options: {
    readonly underlying: string;
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly includeReferenceMetadata?: boolean;
  };
  readonly responses: readonly FixtureResponse[];
  readonly expected: {
    readonly requests: readonly string[];
    readonly contracts?: readonly Record<string, unknown>[];
    readonly underlying?: Record<string, unknown> | null;
    readonly report?: Record<string, unknown>;
    readonly stoppedReason?: string;
    readonly providerError?: { readonly code: number; readonly message: string };
  };
}

interface OptionsFixtureFile {
  readonly contracts_cases: Record<string, FixtureContractsCase>;
  readonly snapshot_cases: Record<string, FixtureSnapshotCase>;
  readonly loader_cases: Record<string, FixtureLoaderCase>;
}

const fixturePath = resolve(process.cwd(), 'fixtures/options_data_reference.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as OptionsFixtureFile;

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
  stats: { maxDiff: number },
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
    const diff = Math.abs(numActual - expected);
    if (diff > stats.maxDiff) {
      stats.maxDiff = diff;
    }
    expect(diff, `${path} diff`).toBeLessThanOrEqual(1e-12);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} should be array`).toBe(true);
    const arrActual = actual as readonly unknown[];
    expect(arrActual.length, `${path}.length`).toBe(expected.length);
    for (let i = 0; i < expected.length; i += 1) {
      assertMatchesFixtureValue(arrActual[i], expected[i], `${path}[${String(i)}]`, stats);
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
      assertMatchesFixtureValue(
        actRecord[key],
        expRecord[key],
        `${path}.${key}`,
        stats,
      );
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

function createQueuedFetch(
  responses: readonly FixtureResponse[],
  calls: string[],
): FetchFn {
  return (url: string): Promise<FetchResponse> => {
    calls.push(url);
    const entry = responses[calls.length - 1];
    if (entry === undefined) {
      return Promise.reject(new Error(`unexpected request: ${url}`));
    }
    return Promise.resolve({
      ok: entry.ok ?? true,
      status: entry.status ?? 200,
      text: entry.text,
      ...(entry.headers === undefined ? {} : { headers: entry.headers }),
      ...(entry.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: entry.retryAfterSeconds }),
    });
  };
}

function spySleep(sleeps: number[]): (ms: number) => Promise<void> {
  return (ms: number): Promise<void> => {
    sleeps.push(ms);
    return Promise.resolve();
  };
}

function collectSecretsCheck(obj: unknown, secret: string): boolean {
  const serialized = JSON.stringify(obj, (_key, val: unknown) =>
    typeof val === 'number' && Number.isNaN(val) ? '__NAN__' : val,
  );
  return (
    serialized.includes(secret) ||
    serialized.includes(encodeURIComponent(secret))
  );
}

describe('Capa de datos de Opciones (Pieza 1)', () => {
  describe('Referencia independiente: normalizeOptionContracts', () => {
    const diffStats = { maxDiff: 0 };

    for (const [caseName, caseData] of Object.entries(fixture.contracts_cases)) {
      it(`${caseName}: ${caseData.description}`, () => {
        const frozenRaw = deepFreeze(structuredClone(caseData.raw));
        const frozenOpts = deepFreeze(structuredClone(caseData.options));
        const actual = normalizeOptionContracts(frozenRaw, frozenOpts);

        assertMatchesFixtureValue(
          actual.contracts,
          caseData.expected.contracts,
          `${caseName}.contracts`,
          diffStats,
        );
        assertMatchesFixtureValue(
          actual.report,
          caseData.expected.report,
          `${caseName}.report`,
          diffStats,
        );
        expect(actual.report.received).toBe(
          actual.report.accepted + actual.report.discarded,
        );
      });
    }

    it('reporta diferencia numérica máxima <= 1e-12 en contratos', () => {
      console.log(
        `[Options Contracts Fixture] Max numeric difference: ${diffStats.maxDiff.toExponential(4)}`,
      );
      expect(diffStats.maxDiff).toBeLessThanOrEqual(1e-12);
    });
  });

  describe('Referencia independiente: normalizeOptionChainSnapshot', () => {
    const diffStats = { maxDiff: 0 };

    for (const [caseName, caseData] of Object.entries(fixture.snapshot_cases)) {
      it(`${caseName}: ${caseData.description}`, () => {
        const frozenRaw = deepFreeze(structuredClone(caseData.raw));
        let refContracts: readonly OptionContract[] | undefined;
        if (caseData.referenceRaw !== null) {
          const refFrozen = deepFreeze(structuredClone(caseData.referenceRaw));
          refContracts = deepFreeze([
            ...normalizeOptionContracts(refFrozen, {
              excludeBinary: false,
              excludeAdjusted: false,
            }).contracts,
          ]);
        }

        const opts: NormalizeOptionChainOptions = {
          ...caseData.options,
          ...(refContracts === undefined ? {} : { referenceContracts: refContracts }),
        };
        const actual = normalizeOptionChainSnapshot(frozenRaw, opts);

        assertMatchesFixtureValue(
          actual.contracts,
          caseData.expected.contracts,
          `${caseName}.contracts`,
          diffStats,
        );
        assertMatchesFixtureValue(
          actual.underlying,
          caseData.expected.underlying,
          `${caseName}.underlying`,
          diffStats,
        );
        assertMatchesFixtureValue(
          actual.report,
          caseData.expected.report,
          `${caseName}.report`,
          diffStats,
        );
        expect(actual.report.received).toBe(
          actual.report.accepted + actual.report.discarded,
        );
      });
    }

    it('reporta diferencia numérica máxima <= 1e-12 en snapshots', () => {
      console.log(
        `[Options Snapshot Fixture] Max numeric difference: ${diffStats.maxDiff.toExponential(4)}`,
      );
      expect(diffStats.maxDiff).toBeLessThanOrEqual(1e-12);
    });
  });

  describe('Referencia independiente: loadOptionChain', () => {
    const diffStats = { maxDiff: 0 };

    for (const [caseName, caseData] of Object.entries(fixture.loader_cases)) {
      it(`${caseName}: ${caseData.description}`, async () => {
        const calls: string[] = [];
        const fetchFn = createQueuedFetch(caseData.responses, calls);
        const loaderOpts: LoadOptionChainOptions = {
          underlying: caseData.options.underlying,
          apiKey: caseData.options.apiKey,
          baseUrl: caseData.options.baseUrl,
          fetchFn,
          ...(caseData.options.includeReferenceMetadata === undefined
            ? {}
            : { includeReferenceMetadata: caseData.options.includeReferenceMetadata }),
        };

        const actual = await loadOptionChain(loaderOpts);

        expect(calls).toEqual(caseData.expected.requests);
        expect(collectSecretsCheck(actual, caseData.options.apiKey)).toBe(false);

        if (caseData.expected.contracts !== undefined) {
          assertMatchesFixtureValue(
            actual.contracts,
            caseData.expected.contracts,
            `${caseName}.contracts`,
            diffStats,
          );
        }
        if (caseData.expected.underlying !== undefined) {
          assertMatchesFixtureValue(
            actual.underlying,
            caseData.expected.underlying,
            `${caseName}.underlying`,
            diffStats,
          );
        }
        if (caseData.expected.report !== undefined) {
          assertMatchesFixtureValue(
            actual.report,
            caseData.expected.report,
            `${caseName}.report`,
            diffStats,
          );
        }
        if (caseData.expected.stoppedReason !== undefined) {
          expect(actual.report.stoppedReason).toBe(caseData.expected.stoppedReason);
        }
        if (caseData.expected.providerError !== undefined) {
          expect(actual.report.providerError).toEqual(caseData.expected.providerError);
        }
      });
    }
  });

  describe('Asimetría de índices (I:), fechas, timestamps y seguridad', () => {
    it('convierte prefijo I: distinto para reference contracts vs snapshot', () => {
      expect(toReferenceUnderlyingTicker('I:SPX')).toBe('SPX');
      expect(toReferenceUnderlyingTicker('i:VIX')).toBe('VIX');
      expect(toReferenceUnderlyingTicker('SPY')).toBe('SPY');

      expect(toSnapshotUnderlyingAsset('I:SPX')).toBe('I:SPX');
      expect(toSnapshotUnderlyingAsset('SPX', true)).toBe('I:SPX');
      expect(toSnapshotUnderlyingAsset('SPY')).toBe('SPY');
      expect(() => toSnapshotUnderlyingAsset('I:SPX', false)).toThrow(
        'Conflicting isIndex=false',
      );
      expect(() => toReferenceUnderlyingTicker('I:')).toThrow(
        'underlying must not be empty after I: prefix',
      );
    });

    it('parseExpirationDate respeta EDT (20:00Z) y EST (21:00Z) al cierre 16:00 ET', () => {
      const summer = parseExpirationDate('2026-07-17');
      expect(summer?.date).toBe('2026-07-17');
      expect(summer?.time).toBe(Date.UTC(2026, 6, 17, 20, 0, 0) / 1_000);

      const winter = parseExpirationDate('2026-11-13');
      expect(winter?.date).toBe('2026-11-13');
      expect(winter?.time).toBe(Date.UTC(2026, 10, 13, 21, 0, 0) / 1_000);

      expect(parseExpirationDate('2026-02-30')).toBeNull();
      expect(parseExpirationDate('2026-13-01')).toBeNull();
    });

    it('computeCalendarDte usa calendario ET cuando UTC ya cambió de día', () => {
      // 2026-11-14T01:00:00Z equivale a 2026-11-13 20:00 EST -> mismo día ET!
      const nowUtc = Date.UTC(2026, 10, 14, 1, 0, 0) / 1_000;
      expect(computeCalendarDte('2026-11-13', nowUtc)).toBe(0);
      expect(computeCalendarDte('2026-11-20', nowUtc)).toBe(7);
    });

    it('parseProviderTimestampSeconds convierte ns y ms a s UTC y rechaza segundos crudos o no finitos', () => {
      const fromNs = parseProviderTimestampSeconds(
        1_794_580_645 * 1_000_000_000 + 839_102_810,
      );
      expect(fromNs.hadInvalidInput).toBe(false);
      expect(fromNs.value).toBe(1_794_580_645);

      const fromMs = parseProviderTimestampSeconds(1_794_580_645_123);
      expect(fromMs.hadInvalidInput).toBe(false);
      expect(fromMs.value).toBe(1_794_580_645);

      const rawSec = parseProviderTimestampSeconds(1_794_580_645);
      expect(rawSec.hadInvalidInput).toBe(true);
      expect(Number.isNaN(rawSec.value)).toBe(true);

      const missing = parseProviderTimestampSeconds(undefined);
      expect(missing.hadInvalidInput).toBe(false);
      expect(Number.isNaN(missing.value)).toBe(true);

      const nonFinite = parseProviderTimestampSeconds(Number.POSITIVE_INFINITY);
      expect(nonFinite.hadInvalidInput).toBe(true);
      expect(Number.isNaN(nonFinite.value)).toBe(true);
    });

    it('loadOptionContracts envía query params filtrados sin prefijo I: y pagina', async () => {
      const calls: string[] = [];
      const page1 = JSON.stringify({
        status: 'OK',
        results: [
          {
            ticker: 'O:SPXW261120C07600000',
            underlying_ticker: 'SPX',
            contract_type: 'call',
            exercise_style: 'european',
            expiration_date: '2026-11-20',
            strike_price: 7600,
            shares_per_contract: 100,
          },
        ],
        next_url: 'https://api.polygon.io/v3/reference/options/contracts?cursor=next',
      });
      const page2 = JSON.stringify({
        status: 'OK',
        results: [
          {
            ticker: 'O:SPXW261120P07500000',
            underlying_ticker: 'SPX',
            contract_type: 'put',
            exercise_style: 'european',
            expiration_date: '2026-11-20',
            strike_price: 7500,
            shares_per_contract: 100,
          },
        ],
      });

      const res = await loadOptionContracts({
        underlying: 'I:SPX',
        apiKey: 'secret-key-99',
        baseUrl: 'https://api.massive.com',
        now: Date.UTC(2026, 10, 13, 15, 0, 0) / 1_000,
        minDte: 1,
        maxDte: 14,
        minStrike: 7400,
        maxStrike: 7700,
        limit: 500,
        fetchFn: createQueuedFetch([{ text: page1 }, { text: page2 }], calls),
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('underlying_ticker=SPX');
      expect(calls[0]).not.toContain('I%3A');
      expect(calls[0]).not.toContain('I:SPX');
      expect(calls[0]).toContain('expiration_date.gte=2026-11-14');
      expect(calls[0]).toContain('expiration_date.lte=2026-11-27');
      expect(calls[0]).toContain('strike_price.gte=7400');
      expect(calls[0]).toContain('strike_price.lte=7700');
      expect(calls[1]).toBe(
        'https://api.massive.com/v3/reference/options/contracts?cursor=next&apikey=secret-key-99',
      );
      expect(res.contracts).toHaveLength(2);
      expect(res.report.pages).toBe(2);
      expect(res.report.stoppedReason).toBe('noMorePages');
      expect(collectSecretsCheck(res, 'secret-key-99')).toBe(false);
    });

    it('aborta loadOptionChain sin pedir snapshot si falla la consulta de contratos de referencia', async () => {
      const calls: string[] = [];
      const res = await loadOptionChain({
        underlying: 'SPY',
        apiKey: 'secret-ref-fail',
        fetchFn: createQueuedFetch(
          [
            {
              ok: false,
              status: 500,
              text: JSON.stringify({ error: 'boom secret-ref-fail' }),
            },
          ],
          calls,
        ),
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('/v3/reference/options/contracts');
      expect(res.contracts).toEqual([]);
      expect(res.report.stoppedReason).toBe('providerError');
      expect(res.report.snapshotPages).toBe(0);
      expect(res.report.referencePages).toBe(1);
      expect(res.report.providerError?.code).toBe(500);
      expect(res.report.providerError?.message).toBe('boom <redacted>');
      expect(collectSecretsCheck(res, 'secret-ref-fail')).toBe(false);
    });

    it('soporta reintento 429 opt-in en loadOptionChain (0 por defecto)', async () => {
      const callsDefault: string[] = [];
      const sleepsDefault: number[] = [];
      const resDefault = await loadOptionChain({
        underlying: 'SPY',
        apiKey: 'k-429',
        includeReferenceMetadata: false,
        sleepFn: spySleep(sleepsDefault),
        fetchFn: createQueuedFetch(
          [{ ok: false, status: 429, text: JSON.stringify({ error: 'rate limit' }) }],
          callsDefault,
        ),
      });
      expect(callsDefault).toHaveLength(1);
      expect(sleepsDefault).toEqual([]);
      expect(resDefault.report.stoppedReason).toBe('providerError');
      expect(resDefault.report.providerError?.code).toBe(429);

      const callsOptIn: string[] = [];
      const sleepsOptIn: number[] = [];
      const resOptIn = await loadOptionChain({
        underlying: 'SPY',
        apiKey: 'k-429',
        includeReferenceMetadata: false,
        retry429MaxAttempts: 1,
        sleepFn: spySleep(sleepsOptIn),
        fetchFn: createQueuedFetch(
          [
            {
              ok: false,
              status: 429,
              text: JSON.stringify({ error: 'rate limit' }),
              retryAfterSeconds: 2,
            },
            { text: JSON.stringify({ status: 'OK', results: [] }) },
          ],
          callsOptIn,
        ),
      });
      expect(callsOptIn).toHaveLength(2);
      expect(sleepsOptIn).toEqual([2_000]);
      expect(resOptIn.report.stoppedReason).toBe('noMorePages');
    });

    it('valida opciones inválidas antes de tocar fetchFn', async () => {
      const neverFetch: FetchFn = () => Promise.reject(new Error('should not fetch'));
      await expect(
        loadOptionChain({
          underlying: 'SPY',
          apiKey: '',
          fetchFn: neverFetch,
        }),
      ).rejects.toThrow('apiKey is required');

      await expect(
        loadOptionChain({
          underlying: 'SPY',
          apiKey: 'k',
          snapshotLimit: 251,
          fetchFn: neverFetch,
        }),
      ).rejects.toThrow('snapshotLimit must be an integer between 1 and 250');

      await expect(
        loadOptionContracts({
          underlying: 'SPY',
          apiKey: 'k',
          limit: 1_001,
          fetchFn: neverFetch,
        }),
      ).rejects.toThrow('limit must be an integer between 1 and 1000');

      await expect(
        loadOptionChain({
          underlying: 'SPY',
          apiKey: 'k',
          baseUrl: 'http://api.massive.com',
          fetchFn: neverFetch,
        }),
      ).rejects.toThrow('baseUrl must be an absolute https URL');

      expect(() =>
        normalizeOptionContracts({ status: 'OK', results: [] }, { minDte: 0 }),
      ).toThrow('now is required when minDte or maxDte is specified');

      expect(() =>
        normalizeOptionChainSnapshot(
          { status: 'OK', results: [] },
          { minStrike: 100, maxStrike: 50 },
        ),
      ).toThrow('minStrike (100) must be <= maxStrike (50)');
    });

    it('mantiene inmutables contratos y arrays de entrada en snapshot', () => {
      const refContract: OptionContract = {
        ticker: 'O:SPY261113C00760000',
        underlyingTicker: 'SPY',
        contractType: 'call',
        exerciseStyle: 'american',
        expirationDate: '2026-11-13',
        expirationTime: 1794603600,
        strikePrice: 760,
        sharesPerContract: 100,
        primaryExchange: 'BATO',
        cfi: 'OCASPS',
        correction: null,
        kind: 'standard',
        underlyingType: null,
        additionalUnderlyings: [] as readonly AdditionalUnderlying[],
        isBinary: false,
        isAdjusted: false,
        isNonStandard: false,
      };
      const rawSnap = deepFreeze({
        status: 'OK',
        results: [
          {
            details: {
              contract_type: 'call',
              expiration_date: '2026-11-13',
              shares_per_contract: 100,
              strike_price: 760,
              ticker: 'O:SPY261113C00760000',
            },
            greeks: {},
          },
        ],
      });
      const refs = deepFreeze([refContract]);
      const result = normalizeOptionChainSnapshot(rawSnap, {
        referenceContracts: refs,
      });
      const first: OptionSnapshotContract | undefined = result.contracts[0];
      const ua: OptionUnderlyingSnapshot | null = result.underlying;
      expect(first?.greeksMissing).toBe(true);
      expect(Number.isNaN(first?.greeks.delta ?? 0)).toBe(true);
      expect(ua).toBeNull();
    });
  });
});
