/**
 * Pieza 50.5 (Bloque 1) — Ventana histórica REST FMP/Tradier.
 *
 * Referencia independiente: `tools/gen_rest_historical_window_fixture.py`
 * (calendario de prueba explícito con feriados, DST y sesiones reducidas;
 * densidad y cobertura por enumeración de sesiones y buckets).
 *
 * Los tests de runtime usan `fetch` simulados que responden SOLO dentro de las
 * fechas pedidas: la ventana anterior (`visibleBars * barSeconds + 14 días`)
 * no alcanzaba las 1.250 diarias y fallaría estos casos.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { etWallTimeToUtc } from '../src/data/alignment.js';
import { emaWarmupWeight } from '../src/core/ema.js';
import { resampleDailyToWeekly } from '../src/core/resampleWeekly.js';
import type { Bar } from '../src/core/types.js';
import { computeEmaSeriesPure } from '../web/src/components/stock-detail/stockDetailMath.js';
import {
  barsPerSessionForRestProvider,
  restHistoricalFromUtcSec,
  restHistoricalLookbackDays,
  type RestHistoricalProvider,
} from '../src/data/restHistoricalWindow.js';
import type { FetchResponse, Timeframe } from '../src/data/types.js';
import { fmpEtDateKey } from '../src/server/fmpClient.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import { getMarketParts, isRth } from '../src/core/sessions.js';
import type { TradierConfig } from '../src/server/tradierAdapter.js';

interface WindowFixtureCase {
  readonly name: string;
  readonly provider: RestHistoricalProvider;
  readonly timeframe: Timeframe;
  readonly includeExtended: boolean;
  readonly targetBars: number;
  readonly toUtcSec: number;
  readonly barsPerSession: number;
  readonly sessionsNeeded: number;
  readonly calendarDays: number;
  readonly fromUtcSec: number;
  readonly coverage: {
    readonly sessionsInWindow: number;
    readonly bucketsInWindow: number;
  };
}

interface DensityRow {
  readonly provider: RestHistoricalProvider;
  readonly timeframe: Timeframe;
  readonly includeExtended: boolean;
  readonly barsPerSession: number;
}

interface RestWindowFixture {
  readonly version: number;
  readonly generator: string;
  readonly targetMargin: number;
  readonly sessionsPerCalendarYear: number;
  readonly density: readonly DensityRow[];
  readonly windowCases: readonly WindowFixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '..', 'fixtures', 'rest_historical_window_reference.json'),
    'utf-8',
  ),
) as RestWindowFixture;

function fixtureCase(name: string): WindowFixtureCase {
  const found = fixture.windowCases.find((item) => item.name === name);
  if (found === undefined) throw new Error(`Fixture case not found: ${name}`);
  return found;
}

describe('Pieza 50.5 — Ventana REST: referencia independiente Python', () => {
  it('deriva la densidad por sesión de cada adaptador y marco (incluye bordes 1h y 4h)', () => {
    for (const row of fixture.density) {
      expect(
        barsPerSessionForRestProvider(row.provider, row.timeframe, row.includeExtended),
        `${row.provider} ${row.timeframe} ${String(row.includeExtended)}`,
      ).toBe(row.barsPerSession);
    }
    expect(barsPerSessionForRestProvider('FMP_ENTERPRISE_REST', '1h', true)).toBe(16);
    expect(barsPerSessionForRestProvider('FMP_ENTERPRISE_REST', '1h', false)).toBe(7);
    expect(barsPerSessionForRestProvider('TRADIER_REST', '4h', true)).toBe(4);
    expect(barsPerSessionForRestProvider('TRADIER_REST', '4h', false)).toBe(2);
    expect(barsPerSessionForRestProvider('TRADIER_REST', '1D', false)).toBe(1);
  });

  it('coincide con el inicio, los días calendario y la cobertura de cada caso enumerado', () => {
    expect(fixture.version).toBe(1);
    expect(fixture.windowCases.length).toBeGreaterThanOrEqual(30);
    for (const item of fixture.windowCases) {
      expect(
        barsPerSessionForRestProvider(item.provider, item.timeframe, item.includeExtended),
        item.name,
      ).toBe(item.barsPerSession);
      expect(
        restHistoricalLookbackDays(item.targetBars, item.barsPerSession),
        item.name,
      ).toBe(item.calendarDays);
      expect(
        restHistoricalFromUtcSec({
          toUtcSec: item.toUtcSec,
          provider: item.provider,
          timeframe: item.timeframe,
          includeExtended: item.includeExtended,
          targetBars: item.targetBars,
        }),
        item.name,
      ).toBe(item.fromUtcSec);
      expect(
        restHistoricalFromUtcSec({
          toUtcSec: item.toUtcSec,
          provider: item.provider,
          timeframe: item.timeframe,
          includeExtended: item.includeExtended,
          targetBars: item.targetBars,
        }),
        item.name,
      ).toBe(item.toUtcSec - item.calendarDays * 86_400);
      const expectedSessionsNeeded = (item.targetBars * fixture.targetMargin) / item.barsPerSession;
      expect(expectedSessionsNeeded, `${item.name} sessionsNeeded`).toBeCloseTo(
        item.sessionsNeeded,
        9,
      );
      // Enumeración Python: la ventana cubre el objetivo incluso con feriados,
      // DST y sesiones reducidas dentro del rango.
      expect(item.coverage.bucketsInWindow, `${item.name} cobertura`).toBeGreaterThanOrEqual(
        item.targetBars,
      );
      expect(item.coverage.sessionsInWindow, `${item.name} sesiones`).toBeGreaterThan(0);
    }
  });

  it('devuelve NaN ante entradas no calculables (sin valores de respaldo)', () => {
    expect(
      restHistoricalFromUtcSec({
        toUtcSec: Number.NaN,
        provider: 'FMP_ENTERPRISE_REST',
        timeframe: '5m',
        includeExtended: true,
        targetBars: 1_000,
      }),
    ).toBeNaN();
    expect(
      restHistoricalFromUtcSec({
        toUtcSec: 1_800_000_000.5,
        provider: 'FMP_ENTERPRISE_REST',
        timeframe: '5m',
        includeExtended: true,
        targetBars: 1_000,
      }),
    ).toBeNaN();
    expect(
      restHistoricalFromUtcSec({
        toUtcSec: -1,
        provider: 'FMP_ENTERPRISE_REST',
        timeframe: '5m',
        includeExtended: true,
        targetBars: 1_000,
      }),
    ).toBeNaN();
    expect(
      restHistoricalFromUtcSec({
        toUtcSec: 1_800_000_000,
        provider: 'NOT_A_PROVIDER' as RestHistoricalProvider,
        timeframe: '5m',
        includeExtended: true,
        targetBars: 1_000,
      }),
    ).toBeNaN();
    expect(
      restHistoricalFromUtcSec({
        toUtcSec: 1_800_000_000,
        provider: 'TRADIER_REST',
        timeframe: '2h' as Timeframe,
        includeExtended: true,
        targetBars: 1_000,
      }),
    ).toBeNaN();
    expect(
      restHistoricalFromUtcSec({
        toUtcSec: 1_800_000_000,
        provider: 'TRADIER_REST',
        timeframe: '5m',
        includeExtended: true,
        targetBars: 0,
      }),
    ).toBeNaN();
    expect(restHistoricalLookbackDays(10, Number.NaN)).toBeNaN();
    expect(restHistoricalLookbackDays(10, 0)).toBeNaN();
    expect(restHistoricalLookbackDays(-1, 1)).toBeNaN();
    expect(barsPerSessionForRestProvider('TRADIER_REST', '1D', false)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Runtime con fetch simulados limitados por las fechas pedidas
// ---------------------------------------------------------------------------

const NOW_MS = Date.UTC(2026, 10, 20, 21, 0, 0); // 2026-11-20T21:00:00Z
const NOW_SEC = Math.floor(NOW_MS / 1_000);
const DAY_MS = 86_400_000;

type FmpRow = Readonly<Record<string, string | number>>;

function marketDateKeys(startKey: string, endKey: string): string[] {
  const keys: string[] = [];
  const startMs = Date.parse(`${startKey}T00:00:00Z`);
  const endMs = Date.parse(`${endKey}T00:00:00Z`);
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const date = new Date(ms);
    const weekday = date.getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      keys.push(date.toISOString().slice(0, 10));
    }
  }
  return keys;
}

function makeOhlc(seed: number): {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
} {
  const base = 100 + Math.sin(seed / 11) * 5 + (seed % 211) * 0.01;
  return { open: base, high: base + 0.8, low: base - 0.8, close: base + 0.15 };
}

function buildDailyRows(symbol: string, startKey: string, endKey: string): FmpRow[] {
  return marketDateKeys(startKey, endKey).map((date, index) => ({
    symbol,
    date,
    ...makeOhlc(index),
    volume: 1_000 + (index % 500),
  }));
}

function minuteGrid(startMinutes: number, closeMinutes: number, stepMinutes: number): number[] {
  const grid: number[] = [];
  for (let minutes = startMinutes; minutes < closeMinutes; minutes += stepMinutes) {
    grid.push(minutes);
  }
  return grid;
}

function wallLabel(dateKey: string, minutesOfDay: number): string {
  const hh = String(Math.floor(minutesOfDay / 60)).padStart(2, '0');
  const mm = String(minutesOfDay % 60).padStart(2, '0');
  return `${dateKey} ${hh}:${mm}:00`;
}

function buildIntradayRows(
  startKey: string,
  endKey: string,
  openMinutes: readonly number[],
): FmpRow[] {
  const rows: FmpRow[] = [];
  let seed = 0;
  for (const dateKey of marketDateKeys(startKey, endKey)) {
    for (const minutes of openMinutes) {
      rows.push({ date: wallLabel(dateKey, minutes), ...makeOhlc(seed), volume: 300 + (seed % 90) });
      seed += 1;
    }
  }
  return rows;
}

const FMP_CONFIG = {
  apiKey: 'fmp-rest-window-key',
  quotesApiKey: null,
  marketApiKey: null,
  etfApiKey: null,
  macroApiKey: null,
  calendarsApiKey: null,
  configured: true,
  baseUrl: 'https://financialmodelingprep.com',
} as const;

const TRADIER_CONFIG: TradierConfig = {
  accessToken: 'tradier-rest-window-token',
  tokenEnvName: 'TRADIER_TOKEN',
  apiEnv: 'prod',
  restBaseUrl: 'https://api.tradier.com/v1',
  wsBaseUrl: 'wss://ws.tradier.com/v1/markets/events',
  configured: true,
  tokenIsGeneric: true,
  sandboxFallbackAllowed: false,
};

function okJson(body: unknown): FetchResponse {
  return { ok: true, status: 200, headers: {}, text: JSON.stringify(body) };
}

interface FmpRouterState {
  readonly requests: string[];
  readonly chartRequests: string[];
  readonly legacyRequests: string[];
  eodRowsServed: number;
  chartRowsServed: number;
}

function filterByDateKeys(rows: readonly FmpRow[], from: string, to: string): FmpRow[] {
  return rows.filter((row) => {
    const key = String(row['date']).slice(0, 10);
    return key >= from && key <= to;
  });
}

function makeFmpRouter(options: {
  readonly dailyRows: readonly FmpRow[];
  readonly intradayRows: readonly FmpRow[];
  readonly stableChartFails?: boolean;
  readonly legacyIgnoresRange?: boolean;
  readonly describeDescending?: boolean;
}): { readonly state: FmpRouterState; readonly fetchFn: (url: string) => Promise<FetchResponse> } {
  const state: FmpRouterState = {
    requests: [],
    chartRequests: [],
    legacyRequests: [],
    eodRowsServed: 0,
    chartRowsServed: 0,
  };
  const fetchFn = (url: string): Promise<FetchResponse> => {
    state.requests.push(url);
    if (url.includes('/stable/historical-price-eod/full')) {
      const query = new URL(url).searchParams;
      const rows = filterByDateKeys(
        options.dailyRows,
        query.get('from') ?? '0000-01-01',
        query.get('to') ?? '9999-12-31',
      );
      state.eodRowsServed = rows.length;
      return Promise.resolve(okJson(rows));
    }
    if (url.includes('/stable/historical-chart/')) {
      state.chartRequests.push(url);
      if (options.stableChartFails === true) {
        return Promise.resolve({ ok: false, status: 500, text: '' });
      }
      const query = new URL(url).searchParams;
      const rows = filterByDateKeys(
        options.intradayRows,
        query.get('from') ?? '0000-01-01',
        query.get('to') ?? '9999-12-31',
      );
      state.chartRowsServed = rows.length;
      const ordered = options.describeDescending === true ? [...rows].reverse() : rows;
      return Promise.resolve(okJson(ordered));
    }
    if (url.includes('/api/v3/historical-chart/')) {
      state.legacyRequests.push(url);
      // Legacy no lleva `from`/`to`: responde la serie completa.
      const rows = options.legacyIgnoresRange === true ? [...options.intradayRows] : [];
      return Promise.resolve(okJson(options.describeDescending === true ? rows.reverse() : rows));
    }
    return Promise.resolve({ ok: false, status: 404, text: '{}' });
  };
  return { state, fetchFn };
}

/** Menor `from` entre las ventanas pedidas: el inicio planificado del rango. */
function plannedWindowFromKey(requests: readonly string[]): string {
  let min = '';
  for (const url of requests) {
    const from = new URL(url).searchParams.get('from') ?? '';
    if (min === '' || from < min) min = from;
  }
  return min;
}

function makeFmpRuntime(fetchFn: (url: string) => Promise<FetchResponse>): MarketRuntime {
  return new MarketRuntime({
    apiKey: 'rest-window-fmp-harness',
    enableWs: false,
    nowMsFn: () => NOW_MS,
    fetchFn,
    fmpConfig: FMP_CONFIG,
  });
}

function makeTradierRuntime(fetchFn: (url: string) => Promise<FetchResponse>): MarketRuntime {
  return new MarketRuntime({
    apiKey: 'rest-window-tradier-harness',
    enableWs: false,
    nowMsFn: () => NOW_MS,
    fetchFn,
    tradierConfig: TRADIER_CONFIG,
    tradierHistoricalBars: true,
  });
}

function makeFmpAndTradierRuntime(
  fetchFn: (url: string) => Promise<FetchResponse>,
): MarketRuntime {
  return new MarketRuntime({
    apiKey: 'rest-window-fallback-harness',
    enableWs: false,
    nowMsFn: () => NOW_MS,
    fetchFn,
    fmpConfig: FMP_CONFIG,
    tradierConfig: TRADIER_CONFIG,
    tradierHistoricalBars: true,
  });
}

interface TradierDailyRow {
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

function buildTradierDailyRows(startKey: string, endKey: string): TradierDailyRow[] {
  return marketDateKeys(startKey, endKey).map((date, index) => ({
    date,
    ...makeOhlc(index),
    volume: 1_000 + (index % 500),
  }));
}

function stubTradierFetch(options: {
  readonly dailyRows: readonly TradierDailyRow[];
  readonly requests: string[];
}): void {
  vi.stubGlobal('fetch', (rawUrl: unknown) => {
    const url = String(rawUrl);
    options.requests.push(url);
    if (url.includes('/markets/history')) {
      const query = new URL(url).searchParams;
      const start = query.get('start') ?? '0000-01-01';
      const end = query.get('end') ?? '9999-12-31';
      const rows = options.dailyRows.filter((row) => row.date >= start && row.date <= end);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ history: { day: rows } })),
      });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{}'),
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Pieza 50.5 — Runtime REST: 1D con respuestas limitadas por fechas', () => {
  it('FMP entrega 1.250 diarias de un histórico suficiente con una sola consulta EOD', async () => {
    const dailyRows = buildDailyRows('RTWX', '2015-01-01', '2026-11-20');
    const router = makeFmpRouter({ dailyRows, intradayRows: [] });
    const res = await makeFmpRuntime(router.fetchFn).getBars('RTWX', '1D', { visibleBars: 1_250 });

    expect(res.bars).toHaveLength(1_250);
    expect(res.visibleStartIndex).toBe(0);
    expect(res.barsProvider).toBe('FMP_ENTERPRISE_REST');
    expect(res.status).toBe('OK');
    const eodUrls = router.state.requests.filter((url) =>
      url.includes('/stable/historical-price-eod/full'),
    );
    expect(eodUrls).toHaveLength(1);
    // Bloque 2: el objetivo interno es `visibleBars + 1.000` (SPEC.md:4) y el
    // `from` coincide con la referencia Python del caso de calentamiento.
    const warmupCase = fixtureCase('fmp-1D-rth-2250-warmup');
    expect(new URL(eodUrls[0] ?? '').searchParams.get('from')).toBe(
      fmpEtDateKey(warmupCase.fromUtcSec),
    );
    expect(eodUrls[0]).toContain('to=2026-11-20');
    // El proveedor respondió limitado por fechas: la ventana cubre el objetivo
    // y no pide todo el dataset simulado.
    expect(router.state.eodRowsServed).toBeGreaterThanOrEqual(1_250 + 1_000);
    expect(router.state.eodRowsServed).toBeLessThan(dailyRows.length);
    const times = res.bars.map((bar) => bar.time);
    expect(times.every((time, index) => index === 0 || time > (times[index - 1] ?? 0))).toBe(true);
  });

  it('la carga interna de 400 diarias usa una ventana más corta que la de 1.250', async () => {
    const dailyRows = buildDailyRows('RTWX', '2018-01-01', '2026-11-20');
    const router400 = makeFmpRouter({ dailyRows, intradayRows: [] });
    const res400 = await makeFmpRuntime(router400.fetchFn).getBars('RTWX', '1D', {
      visibleBars: 400,
    });
    expect(res400.bars).toHaveLength(400);
    expect(res400.visibleStartIndex).toBe(0);
    expect(router400.state.eodRowsServed).toBeGreaterThanOrEqual(400);

    const router1250 = makeFmpRouter({ dailyRows, intradayRows: [] });
    await makeFmpRuntime(router1250.fetchFn).getBars('RTWX', '1D', { visibleBars: 1_250 });

    const fromKey = (urls: readonly string[]): string => {
      const url = new URL(urls[0] ?? '');
      return url.searchParams.get('from') ?? '';
    };
    expect(fromKey(router400.state.requests)).toBeTruthy();
    expect(fromKey(router400.state.requests) > fromKey(router1250.state.requests)).toBe(true);
  });

  it('Tradier entrega 1.250 diarias con una sola consulta `history` acotada por fechas', async () => {
    const dailyRows = buildTradierDailyRows('2015-01-01', '2026-11-20');
    const tradierRequests: string[] = [];
    stubTradierFetch({ dailyRows, requests: tradierRequests });
    const router = makeFmpRouter({ dailyRows: [], intradayRows: [] });
    const res = await makeTradierRuntime(router.fetchFn).getBars('RTWX', '1D', {
      visibleBars: 1_250,
    });

    expect(res.bars).toHaveLength(1_250);
    expect(res.visibleStartIndex).toBe(0);
    expect(res.barsProvider).toBe('TRADIER_REST');
    const historyUrls = tradierRequests.filter((url) => url.includes('/markets/history'));
    expect(historyUrls).toHaveLength(1);
    const query = new URL(historyUrls[0] ?? '').searchParams;
    expect(query.get('end')).toBe('2026-11-20');
    expect(query.get('start')).toBe(
      fmpEtDateKey(fixtureCase('tradier-1D-rth-2250-warmup').fromUtcSec),
    );
    const times = res.bars.map((bar) => bar.time);
    expect(times.every((time, index) => index === 0 || time > (times[index - 1] ?? 0))).toBe(true);
  });

  it('un símbolo reciente devuelve solo las barras reales disponibles, sin inventar', async () => {
    const dailyRows = buildDailyRows('RTWX', '2026-03-02', '2026-11-20');
    const router = makeFmpRouter({ dailyRows, intradayRows: [] });
    const res = await makeFmpRuntime(router.fetchFn).getBars('RTWX', '1D', { visibleBars: 1_250 });
    expect(dailyRows.length).toBeLessThan(1_250);
    expect(res.bars).toHaveLength(dailyRows.length);
    expect(res.visibleStartIndex).toBe(0);
    expect(res.status).toBe('OK');
    // Con menos de 200 observaciones no hay semilla SMA: EMA 200 null, sin NaN.
    const recentEma200 = res.overlays.ema200 ?? [];
    expect(recentEma200).toHaveLength(dailyRows.length);
    expect(recentEma200.every((value) => value === null)).toBe(true);
  });
});

describe('Pieza 50.5 — Runtime REST: intradía RTH/extendido y paginación FMP', () => {
  const extended5m = minuteGrid(4 * 60, 20 * 60, 5);
  const rth5m = minuteGrid(9 * 60 + 30, 16 * 60, 5);

  it('5m extendido usa el paginador FMP dentro del rango planificado y conserva Pre/After', async () => {
    const router = makeFmpRouter({
      dailyRows: buildDailyRows('RTWX', '2018-01-01', '2026-11-20'),
      intradayRows: buildIntradayRows('2026-10-01', '2026-11-20', extended5m),
    });
    const res = await makeFmpRuntime(router.fetchFn).getBars('RTWX', '5m', { visibleBars: 1_000 });

    expect(res.bars).toHaveLength(1_000);
    expect(res.visibleStartIndex).toBe(0);
    expect(res.rthOnly).toBe(false);
    expect(router.state.chartRequests.length).toBeGreaterThanOrEqual(2);
    for (const url of router.state.chartRequests) {
      expect(url).toContain('from=');
      expect(url).toContain('to=');
      expect(url).toContain('extended=true');
    }
    // Bloque 2: el rango planificado es el del objetivo con calentamiento.
    expect(plannedWindowFromKey(router.state.chartRequests)).toBe(
      fmpEtDateKey(fixtureCase('fmp-5m-ext-2000-warmup').fromUtcSec),
    );
    // La última rueda entra parcial (la ventana termina en `now`): hay barras
    // visibles con apertura fuera de RTH.
    const hasExtendedBar = res.bars.some(
      (bar) => getMarketParts(bar.time, 'EQUITY').minutesOfDay < 9 * 60 + 30,
    );
    expect(hasExtendedBar).toBe(true);
    const times = res.bars.map((bar) => bar.time);
    expect(times.every((time, index) => index === 0 || time > (times[index - 1] ?? 0))).toBe(true);
  });

  it('5m RTH no pide `extended=true`, filtra RTH y la ventana escala por densidad (30 vs 18 días)', async () => {
    const extendedRouter = makeFmpRouter({
      dailyRows: buildDailyRows('RTWX', '2018-01-01', '2026-11-20'),
      intradayRows: buildIntradayRows('2026-10-01', '2026-11-20', extended5m),
    });
    await makeFmpRuntime(extendedRouter.fetchFn).getBars('RTWX', '5m', { visibleBars: 1_000 });
    const extendedFrom = plannedWindowFromKey(extendedRouter.state.chartRequests);

    const rthRouter = makeFmpRouter({
      dailyRows: buildDailyRows('RTWX', '2018-01-01', '2026-11-20'),
      intradayRows: buildIntradayRows('2026-08-01', '2026-11-20', rth5m),
    });
    const res = await makeFmpRuntime(rthRouter.fetchFn).getBars('RTWX', '5m', {
      visibleBars: 1_000,
      rthOnly: true,
    });

    expect(res.bars).toHaveLength(1_000);
    expect(res.rthOnly).toBe(true);
    expect(res.bars.every((bar) => isRth(bar.time))).toBe(true);
    for (const url of rthRouter.state.chartRequests) {
      expect(url).not.toContain('extended=true');
      expect(url).toContain('from=');
      expect(url).toContain('to=');
    }
    // 5m RTH (78/sesión) exige una ventana calendario mayor que 5m extendido
    // (192/sesión): 49 vs 26 días en la referencia (objetivo 2.000, Bloque 2).
    const rthFrom = plannedWindowFromKey(rthRouter.state.chartRequests);
    expect(extendedFrom).toBeTruthy();
    expect(rthFrom).toBeTruthy();
    expect(rthFrom < extendedFrom).toBe(true);
  });

  it('1h RTH usa 7 ventanas por sesión y 1h extendido 16, manteniendo el rango suficiente', async () => {
    const hourExtended = minuteGrid(4 * 60, 20 * 60, 60);
    const hourRth = minuteGrid(9 * 60 + 30, 16 * 60, 60);

    const extendedRouter = makeFmpRouter({
      dailyRows: buildDailyRows('RTWX', '2015-01-01', '2026-11-20'),
      intradayRows: buildIntradayRows('2026-04-01', '2026-11-20', hourExtended),
    });
    const extendedRes = await makeFmpRuntime(extendedRouter.fetchFn).getBars('RTWX', '1h', {
      visibleBars: 1_000,
    });
    expect(extendedRes.bars).toHaveLength(1_000);
    expect(extendedRes.bars.some((bar) => getMarketParts(bar.time, 'EQUITY').minutesOfDay === 4 * 60)).toBe(
      true,
    );

    const rthRouter = makeFmpRouter({
      dailyRows: buildDailyRows('RTWX', '2015-01-01', '2026-11-20'),
      intradayRows: buildIntradayRows('2025-08-01', '2026-11-20', hourRth),
    });
    const rthRes = await makeFmpRuntime(rthRouter.fetchFn).getBars('RTWX', '1h', {
      visibleBars: 1_000,
      rthOnly: true,
    });
    expect(rthRes.bars).toHaveLength(1_000);
    expect(rthRes.bars.every((bar) => isRth(bar.time))).toBe(true);

    const extendedFrom = plannedWindowFromKey(extendedRouter.state.chartRequests);
    const rthFrom = plannedWindowFromKey(rthRouter.state.chartRequests);
    expect(extendedFrom).toBeTruthy();
    expect(rthFrom).toBeTruthy();
    expect(rthFrom < extendedFrom).toBe(true);
    // Rango RTH del Bloque 2 (2.000 objetivo) según la referencia Python.
    expect(rthFrom).toBe(fmpEtDateKey(fixtureCase('fmp-1h-rth-2000-warmup').fromUtcSec));
  });

  it('4h conserva sesión extendida aunque se pida rthOnly (getBars lo desactiva)', async () => {
    const router = makeFmpRouter({
      dailyRows: buildDailyRows('RTWX', '2015-01-01', '2026-11-20'),
      intradayRows: buildIntradayRows('2024-10-01', '2026-11-20', [240, 480, 720, 960]),
    });
    const res = await makeFmpRuntime(router.fetchFn).getBars('RTWX', '4h', {
      visibleBars: 1_000,
      rthOnly: true,
    });
    expect(res.bars).toHaveLength(1_000);
    expect(res.rthOnly).toBe(false);
    expect(res.bars.some((bar) => getMarketParts(bar.time, 'EQUITY').minutesOfDay === 4 * 60)).toBe(
      true,
    );
    for (const url of router.state.chartRequests) {
      expect(url).toContain('extended=true');
    }
    // Rango extendido del Bloque 2 (2.000 objetivo) según la referencia Python.
    expect(plannedWindowFromKey(router.state.chartRequests)).toBe(
      fmpEtDateKey(fixtureCase('fmp-4h-ext-2000-warmup').fromUtcSec),
    );
  });

  it('ordena y deduplica la combinación de ventanas solapadas del paginador FMP', async () => {
    const router = makeFmpRouter({
      dailyRows: buildDailyRows('RTWX', '2018-01-01', '2026-11-20'),
      intradayRows: buildIntradayRows('2026-10-01', '2026-11-20', extended5m),
      describeDescending: true,
    });
    const res = await makeFmpRuntime(router.fetchFn).getBars('RTWX', '5m', { visibleBars: 1_000 });
    const times = res.bars.map((bar) => bar.time);
    expect(times).toHaveLength(1_000);
    expect(new Set(times).size).toBe(times.length);
    expect(times.every((time, index) => index === 0 || time > (times[index - 1] ?? 0))).toBe(true);
  });

  it('ante 5xx stable cae a legacy sin rango y el merge acota al rango planificado', async () => {
    const router = makeFmpRouter({
      dailyRows: buildDailyRows('RTWX', '2018-01-01', '2026-11-20'),
      intradayRows: buildIntradayRows('2026-08-01', '2026-11-20', extended5m),
      stableChartFails: true,
      legacyIgnoresRange: true,
      describeDescending: true,
    });
    const res = await makeFmpRuntime(router.fetchFn).getBars('RTWX', '5m', { visibleBars: 1_000 });

    expect(res.bars).toHaveLength(1_000);
    // La respuesta legacy no lleva rango: su barra más antigua ya cae fuera del
    // inicio planificado, así que el corte `earliestSeen <= from` detiene el
    // paginador tras la primera ventana (el merge acota al rango pedido).
    expect(router.state.legacyRequests).toHaveLength(1);
    const expectedDays = fixtureCase('fmp-5m-ext-2000-warmup').calendarDays;
    const earliestAllowed = NOW_SEC - expectedDays * 86_400;
    const times = res.bars.map((bar) => bar.time);
    expect(times.every((time, index) => index === 0 || time > (times[index - 1] ?? 0))).toBe(true);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(earliestAllowed);
    expect(Math.max(...times)).toBeLessThanOrEqual(NOW_SEC);
  });

  it('ante FMP vacío reconsulta Tradier con la densidad de Tradier', async () => {
    const dailyRows = buildTradierDailyRows('2015-01-01', '2026-11-20');
    const tradierRequests: string[] = [];
    stubTradierFetch({ dailyRows, requests: tradierRequests });
    const router = makeFmpRouter({ dailyRows: [], intradayRows: [] });
    const res = await makeFmpAndTradierRuntime(router.fetchFn).getBars('RTWX', '1D', {
      visibleBars: 1_250,
    });

    expect(res.bars).toHaveLength(1_250);
    expect(res.barsProvider).toBe('TRADIER_REST');
    expect(res.barsProviderFallbackUsed).toContain('FMP_ENTERPRISE_REST');
    const historyUrls = tradierRequests.filter((url) => url.includes('/markets/history'));
    expect(historyUrls).toHaveLength(1);
    const query = new URL(historyUrls[0] ?? '').searchParams;
    expect(query.get('start')).toBe(
      fmpEtDateKey(fixtureCase('tradier-1D-rth-2250-warmup').fromUtcSec),
    );
  });

  it('coincide con el timestamp ET de las barras sintéticas usadas (control de unidades)', () => {
    expect(etWallTimeToUtc(2026, 11, 20, 0)).toBe(Date.parse('2026-11-20T05:00:00Z') / 1_000);
    expect(etWallTimeToUtc(2026, 7, 15, 4 * 60)).toBe(Date.parse('2026-07-15T08:00:00Z') / 1_000);
    expect(Date.parse('2026-07-15T08:00:00Z') / 1_000).toBe(1784102400);
  });
});

describe('Pieza 50.5 — Bloque 2: warm-up de EMA 200 y suficiencia semanal', () => {
  it('1D: 1.000 velas previas alimentan la EMA 200 en la primera barra visible', async () => {
    const dailyRows = buildDailyRows('RTWX', '2015-01-01', '2026-11-20');
    const router = makeFmpRouter({ dailyRows, intradayRows: [] });
    const res = await makeFmpRuntime(router.fetchFn).getBars('RTWX', '1D', { visibleBars: 1_250 });

    expect(res.bars).toHaveLength(1_250);
    const warmupBars = router.state.eodRowsServed - res.bars.length;
    expect(warmupBars).toBeGreaterThanOrEqual(1_000);
    // EMA 200 alineada con la primera visible: sin null al inicio y con peso
    // residual de la semilla SMA por debajo de 1e-3 tras el calentamiento.
    const ema200 = res.overlays.ema200 ?? [];
    expect(ema200).toHaveLength(1_250);
    expect(ema200[0]).not.toBeNull();
    expect(ema200[1_249]).not.toBeNull();
    expect(emaWarmupWeight(200, warmupBars - 199)).toBeLessThan(1e-3);
  });

  it('EMA 200 con cierres constantes: semilla SMA propagada sin NaN en el tramo visible', async () => {
    const keys = marketDateKeys('2021-01-01', '2026-11-20').slice(-1_500);
    const dailyRows = keys.map((date, index) => ({
      symbol: 'RTWX',
      date,
      open: 100,
      high: 100.6,
      low: 99.4,
      close: 100.5,
      volume: 1_000 + index,
    }));
    const router = makeFmpRouter({ dailyRows, intradayRows: [] });
    const res = await makeFmpRuntime(router.fetchFn).getBars('RTWX', '1D', { visibleBars: 1_250 });

    expect(res.bars).toHaveLength(1_250);
    expect(router.state.eodRowsServed).toBe(1_500);
    for (const value of res.overlays.ema200 ?? []) {
      expect(value).not.toBeNull();
      expect(value ?? Number.NaN).toBeCloseTo(100.5, 9);
    }
  });

  it('umbral 199/200/201: null exacto cuando faltan 200 observaciones', async () => {
    const allRows = buildDailyRows('RTWX', '2015-01-01', '2026-11-20');

    const shortRouter = makeFmpRouter({ dailyRows: allRows.slice(-250), intradayRows: [] });
    const shortRes = await makeFmpRuntime(shortRouter.fetchFn).getBars('RTWX', '1D', {
      visibleBars: 1_250,
    });
    expect(shortRes.bars).toHaveLength(250);
    const shortEma = shortRes.overlays.ema200 ?? [];
    expect(shortEma.slice(0, 199).every((value) => value === null)).toBe(true);
    expect(shortEma[199]).not.toBeNull();

    const midRouter = makeFmpRouter({ dailyRows: allRows.slice(-1_350), intradayRows: [] });
    const midRes = await makeFmpRuntime(midRouter.fetchFn).getBars('RTWX', '1D', {
      visibleBars: 1_250,
    });
    expect(midRes.bars).toHaveLength(1_250);
    // 1.350 barras con 1.250 visibles → 100 de calentamiento: el primer valor
    // válido (índice 199 de la serie completa) cae en el índice visible 99.
    const midEma = midRes.overlays.ema200 ?? [];
    expect(midEma.slice(0, 99).every((value) => value === null)).toBe(true);
    expect(midEma[99]).not.toBeNull();
  });

  it('1W derivado del 1D recuperado: semilla en la semana 200 y coherencia 1D/1W', async () => {
    const dailyRows = buildDailyRows('RTWX', '2015-01-01', '2026-11-20');
    const router = makeFmpRouter({ dailyRows, intradayRows: [] });
    const res = await makeFmpRuntime(router.fetchFn).getBars('RTWX', '1D', { visibleBars: 1_250 });
    const recoveredDaily: Bar[] = res.bars.map((bar) => ({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const weekly = resampleDailyToWeekly(recoveredDaily);
    expect(weekly.length).toBe(250);

    // Coherencia 1D/1W: la última vela semanal cierra con el último cierre
    // diario y su `time` es la apertura real de la primera rueda de la semana.
    const lastDaily = recoveredDaily[recoveredDaily.length - 1];
    const lastWeek = weekly[weekly.length - 1];
    expect(lastWeek?.close).toBe(lastDaily?.close);
    expect(lastWeek?.time).toBeLessThanOrEqual(lastDaily?.time ?? 0);
    const lastWeekHigh = Math.max(...recoveredDaily.slice(-5).map((bar) => bar.high));
    expect(lastWeek?.high).toBeCloseTo(lastWeekHigh, 9);
    const lastWeekVolume = recoveredDaily
      .slice(-5)
      .reduce((sum, bar) => sum + bar.volume, 0);
    expect(lastWeek?.volume).toBeCloseTo(lastWeekVolume, 9);

    const weeklyEma200 = computeEmaSeriesPure(
      weekly.map((bar) => bar.close),
      200,
    ).map((value) => (Number.isFinite(value) ? value : null));
    expect(weeklyEma200[198]).toBeNull();
    expect(weeklyEma200[199]).not.toBeNull();
    // La semilla semanal aún pesa en el gráfico (250 semanas ≈ 51 posteriores
    // a la semilla): limitación documentada, sin convergencia plena en 1W.
    expect(emaWarmupWeight(200, weekly.length - 200)).toBeGreaterThan(0.1);
  });
});
