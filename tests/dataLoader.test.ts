import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../src/core/types.js';
import { loadBars } from '../src/data/loader.js';
import type {
  DataProvider,
  FetchFn,
  FetchResponse,
  LoadBarsOptions,
  LoadBarsResult,
  Timeframe,
} from '../src/data/types.js';

const FIXTURE_API_KEY = 'fixture-api-key';

interface FixtureLoaderOptions {
  provider: DataProvider;
  symbol: string;
  timeframe: Timeframe;
  visibleBars: number;
  warmupBars?: number;
  now?: number;
  maxPages?: number;
  apiKey?: string;
  baseUrl?: string;
}

interface FixtureResponse {
  status?: number;
  ok?: boolean;
  text?: string;
  throws?: string;
}

interface FixtureRequest {
  url: string;
  authParam: 'apiKey' | 'apikey' | null;
  authValue: string | null;
}

interface FixtureLoaderCase {
  description: string;
  options: FixtureLoaderOptions;
  responses: readonly FixtureResponse[];
  expected: {
    bars: readonly Bar[];
    visibleStart: number;
    report: unknown;
    requests: readonly FixtureRequest[];
  };
}

interface FixtureValidationCase {
  description: string;
  options: Record<string, unknown>;
  expectedError: string;
}

interface FixtureFile {
  loaders: {
    massive: { cases: Record<string, FixtureLoaderCase> };
    bingx: { cases: Record<string, FixtureLoaderCase> };
    validation: { cases: Record<string, FixtureValidationCase> };
  };
}

interface SamplePage {
  body: unknown;
}

interface SampleScenario {
  pages: readonly SamplePage[];
}

interface SampleFile {
  scenarios: Record<string, SampleScenario>;
}

interface FetchLog {
  readonly requests: string[];
}

const fixturePath = resolve(
  process.cwd(),
  'fixtures/data_layer_reference.json',
);
const fixture = JSON.parse(
  readFileSync(fixturePath, 'utf-8'),
) as FixtureFile;

const AUTH_PARAM_NAMES = ['apiKey', 'apikey', 'api_key', 'api-key'];

function createFetchFn(
  responses: readonly FixtureResponse[],
  log: FetchLog,
): FetchFn {
  return (url: string): Promise<FetchResponse> => {
    log.requests.push(url);
    const response = responses[log.requests.length - 1];
    if (response === undefined) {
      return Promise.reject(new Error('unexpected request'));
    }
    if (response.throws !== undefined) {
      return Promise.reject(new Error(response.throws));
    }
    return Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: response.text ?? '',
    });
  };
}

function toLoadOptions(
  fixtureOptions: FixtureLoaderOptions,
  fetchFn: FetchFn,
): LoadBarsOptions {
  return {
    provider: fixtureOptions.provider,
    symbol: fixtureOptions.symbol,
    timeframe: fixtureOptions.timeframe,
    visibleBars: fixtureOptions.visibleBars,
    fetchFn,
    ...(fixtureOptions.warmupBars === undefined
      ? {}
      : { warmupBars: fixtureOptions.warmupBars }),
    ...(fixtureOptions.now === undefined
      ? {}
      : { now: fixtureOptions.now }),
    ...(fixtureOptions.maxPages === undefined
      ? {}
      : { maxPages: fixtureOptions.maxPages }),
    ...(fixtureOptions.apiKey === undefined
      ? {}
      : { apiKey: fixtureOptions.apiKey }),
    ...(fixtureOptions.baseUrl === undefined
      ? {}
      : { baseUrl: fixtureOptions.baseUrl }),
  };
}

function withoutAuthParams(url: URL): URLSearchParams {
  const params = new URLSearchParams(url.search);
  for (const name of AUTH_PARAM_NAMES) {
    params.delete(name);
  }
  return params;
}

function assertRequests(
  actual: readonly string[],
  expected: readonly FixtureRequest[],
): void {
  expect(actual).toHaveLength(expected.length);

  expected.forEach((expectedRequest, index) => {
    const actualUrl = actual[index];
    expect(actualUrl).toBeDefined();
    if (actualUrl === undefined) {
      return;
    }

    const actualParsed = new URL(actualUrl);
    const expectedParsed = new URL(expectedRequest.url);

    expect(actualParsed.origin).toBe(expectedParsed.origin);
    expect(actualParsed.pathname).toBe(expectedParsed.pathname);
    expect([...withoutAuthParams(actualParsed).entries()].sort()).toEqual(
      [...withoutAuthParams(expectedParsed).entries()].sort(),
    );

    const lowerAuthNames = new Set(
      AUTH_PARAM_NAMES.map((name) => name.toLowerCase()),
    );
    const authKeys = [...actualParsed.searchParams.keys()].filter((key) =>
      lowerAuthNames.has(key.toLowerCase()),
    );

    if (expectedRequest.authParam === null) {
      expect(authKeys).toEqual([]);
      return;
    }

    expect(authKeys.map((key) => key.toLowerCase())).toEqual([
      expectedRequest.authParam.toLowerCase(),
    ]);
    expect(
      actualParsed.searchParams.get(expectedRequest.authParam),
    ).toBe(expectedRequest.authValue);
  });
}

async function runCase(
  testCase: FixtureLoaderCase,
): Promise<{ result: LoadBarsResult; requests: string[] }> {
  const log: FetchLog = { requests: [] };
  const fetchFn = createFetchFn(testCase.responses, log);
  const result = await loadBars(toLoadOptions(testCase.options, fetchFn));
  return { result, requests: log.requests };
}

function loadSample(name: string): SampleFile {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'fixtures/samples', name), 'utf-8'),
  ) as SampleFile;
}

function getScenario(sample: SampleFile, name: string): SampleScenario {
  const scenario = sample.scenarios[name];
  if (scenario === undefined) {
    throw new Error(`missing scenario ${name}`);
  }
  return scenario;
}

function sampleFetchFn(pages: readonly unknown[]): {
  fetchFn: FetchFn;
  requests: string[];
} {
  const requests: string[] = [];
  const fetchFn: FetchFn = (url: string): Promise<FetchResponse> => {
    requests.push(url);
    const body = pages[requests.length - 1];
    if (body === undefined) {
      return Promise.reject(new Error('unexpected request'));
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: JSON.stringify(body),
    });
  };
  return { fetchFn, requests };
}

describe('loadBars: referencia independiente del cargador', () => {
  for (const provider of ['massive', 'bingx'] as const) {
    describe(provider, () => {
      for (const [name, testCase] of Object.entries(
        fixture.loaders[provider].cases,
      )) {
        it(name, async () => {
          const { result, requests } = await runCase(testCase);

          expect(result.bars).toEqual(testCase.expected.bars);
          expect(result.visibleStart).toBe(testCase.expected.visibleStart);
          expect(result.report).toEqual(testCase.expected.report);
          assertRequests(requests, testCase.expected.requests);

          const reportText = JSON.stringify(result.report);
          expect(reportText).not.toContain(FIXTURE_API_KEY);
          const authToken = ['api', 'Key='].join('');
          expect(reportText.toLowerCase()).not.toContain(
            authToken.toLowerCase(),
          );
        });
      }
    });
  }
});

describe('loadBars: validación de opciones', () => {
  for (const [name, testCase] of Object.entries(
    fixture.loaders.validation.cases,
  )) {
    it(name, async () => {
      let fetched = false;
      const fetchFn: FetchFn = () => {
        fetched = true;
        return Promise.resolve({ ok: true, status: 200, text: '' });
      };
      const options = {
        ...testCase.options,
        fetchFn,
      } as unknown as LoadBarsOptions;

      await expect(loadBars(options)).rejects.toThrow(
        testCase.expectedError,
      );
      expect(fetched).toBe(false);
    });
  }
});

describe('loadBars: seguridad', () => {
  it('redacta la clave y el parámetro de autenticación en errores de red', async () => {
    const apiKey = 'secret-value';
    const authToken = ['api', 'Key='].join('');
    const message = `fallo en https://api.polygon.io/x?${authToken}${apiKey}`;
    const fetchFn: FetchFn = () => Promise.reject(new Error(message));

    const result = await loadBars({
      provider: 'massive',
      symbol: 'SPY',
      timeframe: '1m',
      visibleBars: 1,
      warmupBars: 1,
      now: 1_794_099_600,
      apiKey,
      fetchFn,
    });

    const reportText = JSON.stringify(result.report);
    expect(reportText).not.toContain(apiKey);
    expect(reportText).not.toContain(`${authToken}${apiKey}`);
    expect(result.report.providerError?.message).toContain('<redacted>');
  });

  it('no sigue un next_url de otro host ni le envía la clave', async () => {
    const apiKey = 'secret-value';
    const requests: string[] = [];
    const fetchFn: FetchFn = (url: string): Promise<FetchResponse> => {
      requests.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: [
            { t: 1_793_955_660_000, o: 100, h: 101, l: 99, c: 100, v: 1, vw: 100 },
            { t: 1_793_955_600_000, o: 99, h: 100, l: 98, c: 99, v: 1, vw: 99 },
          ],
          next_url: 'https://evil.example/steal?cursor=abc123',
        }),
      });
    };

    const result = await loadBars({
      provider: 'massive',
      symbol: 'SPY',
      timeframe: '1m',
      visibleBars: 2,
      warmupBars: 2,
      now: 1_794_099_600,
      maxPages: 5,
      apiKey,
      fetchFn,
    });

    expect(requests).toHaveLength(1);
    const firstRequest = requests[0];
    if (firstRequest === undefined) {
      throw new Error('missing request');
    }
    const firstUrl = new URL(firstRequest);
    expect(firstUrl.host).toBe('api.polygon.io');
    expect(firstUrl.searchParams.get('apiKey')).toBe(apiKey);

    expect(result.report.stoppedReason).toBe('malformedResponse');
    expect(result.report.malformedResponse).toBe(true);
    expect(result.report.providerError).toBeNull();
    expect(result.bars).toHaveLength(2);
    expect(result.report.pages).toBe(1);
    expect(JSON.stringify(result)).not.toContain('evil.example');
  });
});

describe('loadBars: timestamp del servidor BingX', () => {
  const base = 1_794_033_600; // 2026-11-07 12:00:00 UTC
  const fakeNowSeconds = base + 570;
  const expectedBars = [
    {
      time: base + 480,
      open: 99,
      high: 100,
      low: 98,
      close: 99,
      volume: 1,
    },
  ];
  const expectedRequests = [
    'https://open-api.bingx.com/openApi/spot/v2/market/kline?' +
      'symbol=BTC-USDT&interval=1m&limit=1000' +
      `&startTime=${String((fakeNowSeconds - 172_800) * 1000)}` +
      `&endTime=${String(fakeNowSeconds * 1000)}`,
    'https://open-api.bingx.com/openApi/spot/v2/market/kline?' +
      'symbol=BTC-USDT&interval=1m&limit=1000' +
      `&startTime=${String((fakeNowSeconds - 172_800) * 1000)}` +
      `&endTime=${String((base + 480) * 1000 - 1)}`,
  ];
  const expectedFormingBar = {
    time: base + 540,
    reason: 'closeTimeContainsServerTime',
  } as const;

  function bingxResponses(timestamp: number): readonly FixtureResponse[] {
    return [
      {
        status: 200,
        ok: true,
        text: JSON.stringify({
          code: 0,
          timestamp,
          data: [
            [
              (base + 540) * 1000,
              100,
              101,
              99,
              100,
              1,
              (base + 599) * 1000 + 999,
            ],
            [(base + 480) * 1000, 99, 100, 98, 99, 1],
          ],
        }),
      },
      { status: 200, ok: true, text: JSON.stringify({ code: 0, data: [] }) },
    ];
  }

  function timestampCase(
    timestamp: number,
    description: string,
  ): FixtureLoaderCase {
    return {
      description,
      options: {
        provider: 'bingx',
        symbol: 'BTC-USDT',
        timeframe: '1m',
        visibleBars: 1,
        warmupBars: 1,
        maxPages: 5,
      },
      responses: bingxResponses(timestamp),
      expected: { bars: [], visibleStart: 0, report: {}, requests: [] },
    };
  }

  it('ignora un timestamp en segundos y acepta ms con precisión sub-second', async () => {
    vi.useFakeTimers({
      now: new Date(fakeNowSeconds * 1_000),
      toFake: ['Date'],
    });
    try {
      // Un timestamp en segundos (~1.8e9) no es ms plausibles: se ignora y
      // `now` cae al reloj de la petición (simulado), no a 1970.
      const secondsRun = await runCase(
        timestampCase(fakeNowSeconds, 'timestamp en segundos'),
      );
      expect(secondsRun.requests).toEqual(expectedRequests);
      expect(secondsRun.result.bars).toEqual(expectedBars);
      expect(secondsRun.result.visibleStart).toBe(0);
      expect(secondsRun.result.report.stoppedReason).toBe('noMorePages');
      expect(secondsRun.result.report.formingBar).toEqual(
        expectedFormingBar,
      );
      expect(secondsRun.result.report.formingExcluded).toBe(true);
      expect(secondsRun.result.report.pages).toBe(2);

      // Un timestamp en ms con precisión sub-second sí es plausible y fija
      // `now` (floor a segundos) con el mismo resultado.
      const msRun = await runCase(
        timestampCase(
          fakeNowSeconds * 1_000 + 250,
          'timestamp en ms con precisión',
        ),
      );
      expect(msRun.requests).toEqual(expectedRequests);
      expect(msRun.result.bars).toEqual(expectedBars);
      expect(msRun.result.report.formingBar).toEqual(expectedFormingBar);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('loadBars: integración con muestras reales', () => {
  it('Massive: carga el día real de SPY 1m y respeta el buffer', async () => {
    const sample = loadSample('SPY_1m_2026-11-06.json');
    const pages = getScenario(sample, 'day').pages.map((page) => page.body);
    const { fetchFn, requests } = sampleFetchFn(pages);

    const result = await loadBars({
      provider: 'massive',
      symbol: 'SPY',
      timeframe: '1m',
      visibleBars: 10,
      warmupBars: 1000,
      now: Date.UTC(2026, 10, 7, 12, 0, 0) / 1000,
      apiKey: FIXTURE_API_KEY,
      fetchFn,
    });

    expect(requests).toHaveLength(1);
    expect(result.bars).toHaveLength(922);
    expect(result.visibleStart).toBe(912);
    expect(result.report.received).toBe(922);
    expect(result.report.accepted).toBe(922);
    expect(result.report.discarded).toBe(0);
    expect(result.report.pages).toBe(1);
    expect(result.report.stoppedReason).toBe('noMorePages');
    expect(result.report.normalizedBars).toBe(922);
    expect(result.report.trimmedBars).toBe(0);
    expect(result.report.gaps).toHaveLength(23);
    expect(result.report.gapDetection).toBe('performed');

    if (result.report.provider !== 'massive') {
      throw new Error('expected massive report');
    }
    expect(result.report.vwOutsideRange).toBe(104);

    const rawResults = (
      pages[0] as { results: Array<{ t: number }> }
    ).results;
    const times = rawResults
      .map((row) => row.t / 1000)
      .sort((left, right) => left - right);
    expect(result.report.firstTime).toBe(times[0]);
    expect(result.report.lastTime).toBe(times.at(-1));
    expect(JSON.stringify(result.report)).not.toContain(FIXTURE_API_KEY);
  });

  it('BingX: carga el día real de BTC-USDT 1m con paginación', async () => {
    const sample = loadSample('BTC-USDT_1m_2026-11-06.json');
    const pages = getScenario(sample, 'day').pages.map((page) => page.body);
    const { fetchFn, requests } = sampleFetchFn(pages);

    const result = await loadBars({
      provider: 'bingx',
      symbol: 'BTC-USDT',
      timeframe: '1m',
      visibleBars: 10,
      warmupBars: 1000,
      now: Date.UTC(2026, 10, 7, 12, 0, 0) / 1000,
      fetchFn,
    });

    expect(requests).toHaveLength(2);
    expect(result.bars).toHaveLength(1010);
    expect(result.visibleStart).toBe(1000);
    expect(result.report.received).toBe(1440);
    expect(result.report.accepted).toBe(1440);
    expect(result.report.discarded).toBe(0);
    expect(result.report.pages).toBe(2);
    expect(result.report.stoppedReason).toBe('targetReached');
    expect(result.report.normalizedBars).toBe(1440);
    expect(result.report.trimmedBars).toBe(430);
    expect(result.report.reordered).toBe(true);

    if (result.report.provider !== 'bingx') {
      throw new Error('expected bingx report');
    }
    expect(result.report.vwExposed).toBe(false);
    expect(result.report.vwCandidateOutsideRange).toBe(10);

    const rawRows = pages.flatMap(
      (page) => (page as { data: Array<[number, ...unknown[]]> }).data,
    );
    const times = rawRows
      .map((row) => row[0] / 1000)
      .sort((left, right) => left - right);
    expect(result.report.firstTime).toBe(times.at(-1010));
    expect(result.report.lastTime).toBe(times.at(-1));
  });
});
