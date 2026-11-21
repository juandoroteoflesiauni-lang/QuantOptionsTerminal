/**
 * Pieza 50.2 — Catálogo 100 % de vencimientos US/OPRA, carga on-demand por vencimiento,
 * tope estricto de 1.000 suscripciones WS y binding de TIR/régimen al vencimiento activo.
 *
 * Referencia independiente: fixtures/options_pieza50_2_reference.json generada por
 * tools/generate_pieza50_2_reference.py (tolerancia 1e-9).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { priceBsm } from '../src/core/options/blackScholes.js';
import type { OperativeRegimeCode } from '../src/core/options/volAnalyticsSuite.js';
import {
  MarketRuntime,
  US_EXPIRY_CATALOG_TTL_MS,
  extractUsExpiryCatalog,
  mergeUsOptionExpiryCatalog,
  selectAnchorUsExpirations,
  type TerminalSnapshotResponse,
  type UsOptionExpiryChainResponse,
} from '../src/server/marketRuntime.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import type { OptionContract } from '../src/data/optionsTypes.js';
import type { FetchFn } from '../src/data/types.js';
import type { MassiveWsClientOptions } from '../src/data/wsTypes.js';
import type { WsClientSnapshot } from '../src/data/wsTypes.js';
import type { MassiveWsClientLike } from '../src/server/marketRuntime.js';
import {
  evaluateActiveExpiryHeaderTir,
  evaluateActiveExpiryRegimeAndBreaker,
} from '../web/src/components/options/activeExpiryBinding.js';
import {
  buildExpirySelectorEntries,
  mapUsSnapshotToArOptions,
  mergeUsExpiryChainIntoOptions,
} from '../web/src/data/expiryChainMerge.js';
import type {
  ArOptionContractDto,
  ArOptionsResponse,
  UsOptionContractRowDto,
  UsOptionExpiryChainResponseDto,
  UsSnapshotResponseDto,
} from '../web/src/data/liveTypes.js';

type JsonNumber = number | 'NaN';

interface CatalogEntryJson {
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  readonly nearAtmContracts: number;
}

interface LoadedExpiryJson {
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  readonly validCallCount: number;
  readonly validPutCount: number;
  readonly nearAtmLiquidity: number;
  readonly inDefaultWindow: boolean;
  readonly hasCompleteAtmChain: boolean;
}

interface ExpiryCatalogCase {
  readonly name: string;
  readonly spot: JsonNumber;
  readonly nowSec: number;
  readonly contracts: readonly {
    readonly ticker: string;
    readonly contractType: 'call' | 'put';
    readonly expirationDate: string;
    readonly expiryUtcSec: number;
    readonly strikePrice: number;
  }[];
  readonly expected: readonly CatalogEntryJson[];
}

interface AnchorSelectionCase {
  readonly name: string;
  readonly catalog: readonly CatalogEntryJson[];
  readonly requested: string | null;
  readonly expected: readonly string[];
}

interface ExpiryCatalogMergeCase {
  readonly name: string;
  readonly catalog: readonly CatalogEntryJson[];
  readonly loaded: readonly LoadedExpiryJson[];
  readonly expected: readonly (LoadedExpiryJson & { readonly loaded: boolean })[];
}

interface ActiveExpiryTirCase {
  readonly name: string;
  readonly input: {
    readonly activeDte: JsonNumber;
    readonly activeExpiryId: string | null;
    readonly activeParity: {
      readonly expiryCode?: string | null;
      readonly medianMidTeaPct?: JsonNumber | null;
      readonly impliedRateStatus?: string | null;
    } | null;
    readonly activeExpirySyntheticRates: {
      readonly medianImpliedTna?: JsonNumber | null;
      readonly impliedRateStatus?: string | null;
    } | null;
  };
  readonly expected: { readonly blockedShortDte: boolean; readonly tirPct: JsonNumber };
}

interface ActiveExpiryRegimeCase {
  readonly name: string;
  readonly input: {
    readonly activeDte: JsonNumber;
    readonly activeExpiryId: string | null;
    readonly spot: number;
    readonly activeExposureSummary: {
      readonly putWallStrike: number | null;
      readonly netGex: JsonNumber | null;
    };
    readonly precomputedRegimeForActiveExpiry: string | null;
    readonly fallbackRegimeInput: {
      readonly ivAtmActiveExpiryPct: JsonNumber | null;
      readonly rvReferencePct: JsonNumber | null;
      readonly rvReferenceLabel: string;
    };
  };
  readonly expected: {
    readonly blocked: boolean;
    readonly autoSelectCreditMode: boolean;
    readonly baseRegimeCode: string;
    readonly activeRegimeCode: string;
  };
}

interface Pieza502Fixture {
  readonly meta: { readonly generator: string; readonly tolerance: number; readonly nowSec: number; readonly todayEt: string };
  readonly expiryCatalogCases: readonly ExpiryCatalogCase[];
  readonly anchorSelectionCases: readonly AnchorSelectionCase[];
  readonly expiryCatalogMergeCases: readonly ExpiryCatalogMergeCase[];
  readonly activeExpiryTirCases: readonly ActiveExpiryTirCase[];
  readonly activeExpiryRegimeCases: readonly ActiveExpiryRegimeCase[];
}

const fixturePath = join(process.cwd(), 'fixtures', 'options_pieza50_2_reference.json');
const fixture: Pieza502Fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Pieza502Fixture;
const TOL = fixture.meta.tolerance;

function decodeJsonNumber(value: JsonNumber | null | undefined): number {
  if (value === null || value === undefined) return Number.NaN;
  return value === 'NaN' ? Number.NaN : value;
}

function expectNumberOrNaN(actual: number, expected: JsonNumber): void {
  if (expected === 'NaN') {
    expect(Number.isNaN(actual)).toBe(true);
  } else {
    expect(Number.isFinite(actual)).toBe(true);
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOL);
  }
}

function asOperativeRegimeCode(value: string | null): OperativeRegimeCode | null {
  const allowed: readonly OperativeRegimeCode[] = [
    'VENTA_PRIMA_CUBIERTA',
    'COMPRA_CONVEXIDAD_CALENDAR',
    'NEUTRAL_SELECTIVO',
    'NO_SHORT_PREMIUM_RISK',
    'NO_DATA',
  ];
  return allowed.find((code) => code === value) ?? null;
}

// ---------------------------------------------------------------------------
// Mock REST Massive offline (catálogo 0DTE→LEAPS con paginación + cadenas)
// ---------------------------------------------------------------------------

const NOW_SEC = fixture.meta.nowSec; // 2026-01-05 15:30 ET
const SPOT = 600;
const CATALOG_DATES: readonly { readonly date: string; readonly dte: number }[] = [
  { date: '2026-01-05', dte: 0 },
  { date: '2026-01-06', dte: 1 },
  { date: '2026-01-07', dte: 2 },
  { date: '2026-01-08', dte: 3 },
  { date: '2026-01-12', dte: 7 },
  { date: '2026-01-13', dte: 8 },
  { date: '2026-01-16', dte: 11 },
  { date: '2026-01-20', dte: 15 },
  { date: '2026-01-23', dte: 18 },
  { date: '2026-01-30', dte: 25 },
  { date: '2026-02-04', dte: 30 },
  { date: '2026-02-06', dte: 32 },
  { date: '2026-02-13', dte: 39 },
  { date: '2026-02-20', dte: 46 },
  { date: '2026-02-27', dte: 53 },
  { date: '2026-03-06', dte: 60 },
  { date: '2026-03-13', dte: 67 },
  { date: '2026-03-20', dte: 74 },
  { date: '2026-03-27', dte: 81 },
  { date: '2026-04-06', dte: 91 },
  { date: '2026-04-17', dte: 102 },
  { date: '2026-05-15', dte: 130 },
  { date: '2026-06-19', dte: 165 },
  { date: '2026-07-17', dte: 193 },
  { date: '2026-08-21', dte: 228 },
  { date: '2026-09-18', dte: 256 },
  { date: '2026-12-18', dte: 347 },
  { date: '2027-01-15', dte: 375 },
  { date: '2027-03-19', dte: 438 },
  { date: '2027-06-17', dte: 528 },
  { date: '2027-12-17', dte: 711 },
  { date: '2028-01-21', dte: 746 },
];

const EXPECTED_ANCHORS: readonly string[] = [
  '2026-01-05',
  '2026-01-12',
  '2026-02-04',
  '2026-03-06',
  '2026-04-06',
  '2026-07-17',
];

const CATALOG_NEAR_STRIKES: readonly number[] = [594, 596, 598, 600, 602, 604, 606];
// Banda amplia (±45 % del spot ≈ 330–870): cubre los strikes 25Δ de LEAPS a 746 DTE.
const CHAIN_STRIKES: readonly number[] = Array.from({ length: 44 }, (_, i) => 440 + i * 10);
const MASSIVE_VOLUME = 650;
const MASSIVE_OPEN_INTEREST = 8000;
const TRADIER_CACHE_TOKEN = 'pieza502-tradier-token';

function occTicker(date: string, type: 'call' | 'put', strike: number): string {
  const compact = date.replaceAll('-', '').slice(2);
  const padded = String(Math.round(strike * 1_000)).padStart(8, '0');
  return `O:SPY${compact}${type === 'call' ? 'C' : 'P'}${padded}`;
}

function buildCatalogRows(dates: readonly { readonly date: string; readonly dte: number }[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const { date } of dates) {
    for (const strike of CATALOG_NEAR_STRIKES) {
      for (const type of ['call', 'put'] as const) {
        rows.push({
          ticker: occTicker(date, type, strike),
          underlying_ticker: 'SPY',
          contract_type: type,
          strike_price: strike,
          expiration_date: date,
          shares_per_contract: 100,
        });
      }
    }
    // Binaria explícita: debe quedar fuera con `excludeBinary: true`.
    rows.push({
      ticker: `O:B1SPY${date.replaceAll('-', '').slice(2)}C00600000`,
      underlying_ticker: 'SPY',
      contract_type: 'call',
      type: 'binary',
      strike_price: 600,
      expiration_date: date,
      shares_per_contract: 100,
    });
  }
  return rows;
}

function buildChainRows(date: string, dte: number, strikes: readonly number[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const tYears = Math.max(dte, 0.5) / 365;
  for (const strike of strikes) {
    for (const type of ['call', 'put'] as const) {
      const moneyness = (SPOT - strike) / SPOT;
      // Skew moderado: garantiza que los strikes 25Δ caigan dentro de la banda ±45 %.
      const sigma = 0.22 + Math.abs(moneyness) * 0.06;
      const fair = priceBsm({
        spot: SPOT,
        strike,
        timeToExpiry: tYears,
        rate: 0.043,
        dividendYield: 0.012,
        volatility: sigma,
        contractType: type,
      });
      const bid = Number(Math.max(0.05, fair * 0.995).toFixed(4));
      const ask = Number((Math.max(0.05, fair * 1.005) + 0.02).toFixed(4));
      const mid = Number((0.5 * (bid + ask)).toFixed(4));
      rows.push({
        details: {
          ticker: occTicker(date, type, strike),
          contract_type: type,
          strike_price: strike,
          expiration_date: date,
          shares_per_contract: 100,
        },
        day: { volume: MASSIVE_VOLUME, close: mid, previousClose: mid, change: 0 },
        open_interest: MASSIVE_OPEN_INTEREST,
        implied_volatility: Number(sigma.toFixed(6)),
        last_quote: { bid, ask, midpoint: mid },
        last_trade: { price: mid, sip_timestamp: String(NOW_SEC * 1_000_000_000) },
        underlying_asset: { ticker: 'SPY', price: SPOT },
      });
    }
  }
  return rows;
}

interface MockFetchControl {
  readonly urls: string[];
  readonly catalogPageRequests: () => number;
  readonly chainRequestsForDate: (date: string) => number;
}

function createMockFetch(params: {
  readonly chainStrikes?: readonly number[];
  readonly chainDates?: readonly { readonly date: string; readonly dte: number }[];
}): { readonly fetchFn: FetchFn; readonly control: MockFetchControl } {
  const urls: string[] = [];
  const chainDates = params.chainDates ?? CATALOG_DATES;
  const chainStrikes = params.chainStrikes ?? CHAIN_STRIKES;
  const chainRowsForDate = (date: string): Record<string, unknown>[] => {
    const spec = chainDates.find((entry) => entry.date === date);
    if (spec === undefined) return [];
    return buildChainRows(date, spec.dte, chainStrikes);
  };

  const respond = (payload: unknown): Promise<{ ok: boolean; status: number; text: string; headers: Record<string, string> }> =>
    Promise.resolve({ ok: true, status: 200, text: JSON.stringify(payload), headers: {} });

  const fetchFn: FetchFn = (url: string) => {
    urls.push(url);
    const parsed = new URL(url);
    const path = parsed.pathname;

    if (path.startsWith('/v2/aggs/ticker/')) {
      const segments = path.split('/');
      const ticker = decodeURIComponent(segments[4] ?? 'SPY');
      const timespan = segments[7] ?? 'minute';
      const barSec = timespan === 'day' ? 86_400 : timespan === 'hour' ? 3_600 : Number(segments[6] ?? '5') * 60;
      const count = timespan === 'day' ? 300 : 200;
      const results: Record<string, unknown>[] = [];
      for (let i = count - 1; i >= 0; i -= 1) {
        const t = Math.floor(NOW_SEC / barSec) * barSec - i * barSec;
        const close = ticker === 'SPY' ? SPOT : SPOT * 0.85;
        results.push({ t: t * 1_000, o: close, h: close + 0.4, l: close - 0.4, c: close, v: 120_000, vw: close });
      }
      return respond({ status: 'OK', ticker, resultsCount: results.length, results });
    }
    if (path === '/fed/v1/treasury-yields') {
      return respond({
        status: 'OK',
        results: [
          {
            date: '2026-01-02',
            yield_1_month: 4.31,
            yield_3_month: 4.3,
            yield_6_month: 4.25,
            yield_1_year: 4.15,
            yield_2_year: 4.02,
            yield_3_year: 4.04,
            yield_5_year: 4.1,
            yield_7_year: 4.18,
            yield_10_year: 4.26,
            yield_20_year: 4.5,
            yield_30_year: 4.56,
          },
        ],
      });
    }
    if (path === '/fed/v1/funding-conditions') {
      return respond({
        status: 'OK',
        results: [
          {
            date: '2026-01-02',
            effective_fed_funds_rate: 4.33,
            effective_fed_funds_volume: 95_000_000_000,
            sofr: 4.31,
            sofr_volume: 2_100_000_000_000,
          },
        ],
      });
    }
    if (path === '/v3/snapshot') {
      return respond({
        status: 'OK',
        results: [
          {
            ticker: 'SPY',
            type: 'stocks',
            market_status: 'open',
            last_quote: { P: SPOT - 0.02, p: SPOT + 0.02, midpoint: SPOT },
            last_trade: { p: SPOT, sip_timestamp: String(NOW_SEC * 1_000_000_000) },
            session: { price: SPOT, previous_close: 598.5, change: 1.5, change_percent: 0.25 },
            day: { c: SPOT, v: 40_000_000, o: 598, h: 601, l: 597.5 },
          },
          {
            ticker: 'I:SPX',
            type: 'indices',
            market_status: 'open',
            value: 6000.5,
            session: { price: 6000.5, previous_close: 5975.0, change: 25.5, change_percent: 0.43 },
          },
          {
            ticker: 'I:VIX',
            type: 'indices',
            market_status: 'open',
            value: 16.4,
            session: { price: 16.4, previous_close: 16.9, change: -0.5, change_percent: -2.96 },
          },
          {
            ticker: 'I:SKEW',
            type: 'indices',
            market_status: 'open',
            value: 138.2,
            session: { price: 138.2, previous_close: 137.0, change: 1.2, change_percent: 0.87 },
          },
        ],
      });
    }
    if (path === '/v2/snapshot/locale/us/markets/stocks/tickers') {
      return respond({
        status: 'OK',
        tickers: [
          {
            ticker: 'SPY',
            day: { c: SPOT, v: 40_000_000 },
            prevDay: { c: 598.5 },
            lastTrade: { p: SPOT },
            lastQuote: { P: SPOT - 0.02, p: SPOT + 0.02 },
            market_status: 'open',
          },
        ],
      });
    }
    if (path === '/v3/reference/options/contracts') {
      const exactDate = parsed.searchParams.get('expiration_date');
      if (exactDate !== null) {
        return respond({ status: 'OK', results: buildCatalogRows([{ date: exactDate, dte: 0 }]) });
      }
      if (parsed.searchParams.get('cursor') === 'page2') {
        return respond({ status: 'OK', results: buildCatalogRows(CATALOG_DATES.slice(16)) });
      }
      return respond({
        status: 'OK',
        results: buildCatalogRows(CATALOG_DATES.slice(0, 16)),
        next_url: 'https://api.massive.com/v3/reference/options/contracts?cursor=page2',
      });
    }
    if (path.startsWith('/v3/snapshot/options/')) {
      const exactDate = parsed.searchParams.get('expiration_date');
      const date = exactDate ?? chainDates[0]?.date ?? '2026-01-05';
      return respond({ status: 'OK', results: chainRowsForDate(date) });
    }
    if (path === '/stocks/v1/dividends') {
      return respond({ status: 'OK', results: [] });
    }
    if (path === '/options/v1/unusual-trades') {
      return respond({ status: 'OK', results: [] });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      text: JSON.stringify({ status: 'NOT_FOUND', error: `Unexpected test URL ${path}` }),
      headers: {},
    });
  };

  return {
    fetchFn,
    control: {
      urls,
      catalogPageRequests: () =>
        urls.filter(
          (url) =>
            url.includes('/v3/reference/options/contracts') &&
            (url.includes('cursor=page2') || url.includes('expiration_date.gte')),
        ).length,
      chainRequestsForDate: (date: string) =>
        urls.filter(
          (url) =>
            url.includes('/v3/snapshot/options/SPY') &&
            url.includes(`expiration_date=${date}`),
        ).length,
    },
  };
}

const activeServers: HttpWsServerHandle[] = [];
afterEach(async () => {
  for (const server of activeServers.splice(0, activeServers.length)) {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 1) Catálogo 100 % + anclas + caché TTL 12 min
// ---------------------------------------------------------------------------

describe('Pieza 50.2 — Catálogo 100 % de vencimientos US/OPRA con anclas y caché TTL 12 min', () => {
  it('expone 32 vencimientos (0DTE→LEAPS 746 DTE) con 6 anclas loaded:true y sirve el catálogo desde caché', async () => {
    const { fetchFn, control } = createMockFetch({});
    const runtime = new MarketRuntime({
      apiKey: 'pieza502-test-key',
      secrets: ['pieza502-test-key'],
      nowMsFn: () => NOW_SEC * 1_000,
      enableWs: false,
      fetchFn,
    });

    const snap: TerminalSnapshotResponse = await runtime.getSnapshot('SPY');
    const available = snap.optionsChain?.availableExpirations ?? [];
    expect(available).toHaveLength(32);
    expect(available.map((entry) => entry.expirationDate)).toEqual(CATALOG_DATES.map((entry) => entry.date));
    const loadedDates = available.filter((entry) => entry.loaded).map((entry) => entry.expirationDate);
    expect(loadedDates).toEqual(EXPECTED_ANCHORS);
    const pending = available.filter((entry) => !entry.loaded);
    expect(pending).toHaveLength(26);
    for (const entry of pending) {
      expect(entry.validCallCount).toBe(0);
      expect(entry.validPutCount).toBe(0);
      expect(entry.nearAtmLiquidity).toBe(0);
      expect(entry.hasCompleteAtmChain).toBe(false);
    }
    for (const anchor of EXPECTED_ANCHORS) {
      const entry = available.find((candidate) => candidate.expirationDate === anchor);
      expect(entry?.loaded, anchor).toBe(true);
      expect(entry?.validCallCount ?? 0, anchor).toBeGreaterThan(0);
    }
    // Cada ancla llega al payload serializado con su cadena cargada.
    const serializedDates = new Set((snap.volSurfaceSummary?.contracts ?? []).map((c) => c.expirationDate));
    for (const anchor of EXPECTED_ANCHORS) {
      expect(serializedDates.has(anchor), anchor).toBe(true);
    }
    expect((snap.volSurfaceSummary?.slices ?? []).length).toBeGreaterThanOrEqual(4);
    const ivAtmByDate = new Map(
      (snap.volSurfaceSummary?.slices ?? []).map((slice) => [slice.expirationDate, slice.ivAtm]),
    );
    for (const anchor of EXPECTED_ANCHORS.slice(1)) {
      const ivAtm = ivAtmByDate.get(anchor) ?? null;
      expect(ivAtm !== null && Number.isFinite(ivAtm) && ivAtm > 0, anchor).toBe(true);
    }
    expect(US_EXPIRY_CATALOG_TTL_MS).toBe(12 * 60 * 1_000);
    // Descubrimiento liviano: 2 páginas del catálogo (no miles de strikes).
    expect(control.catalogPageRequests()).toBe(2);
    const catalogUrls = control.urls.filter(
      (url) =>
        url.includes('/v3/reference/options/contracts') &&
        (url.includes('cursor=page2') || url.includes('expiration_date.gte')),
    );
    expect(new URL(catalogUrls[0] ?? '').searchParams.get('contract_type')).toBe('call');
    expect(new URL(catalogUrls[0] ?? '').searchParams.get('limit')).toBe('1000');
    expect(new URL(catalogUrls[0] ?? '').searchParams.get('strike_price.lte')).not.toBeNull();

    // Segunda pasada con forceRefresh del snapshot (dentro de los 12 min de TTL del
    // catálogo): el descubrimiento de fechas NO se repite contra Massive.
    await runtime.getSnapshot('SPY', { forceRefresh: true });
    expect(control.catalogPageRequests()).toBe(2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2) Carga on-demand + caché por fecha + Tradier acotado + fusión frontend
// ---------------------------------------------------------------------------

describe('Pieza 50.2 — Carga on-demand por vencimiento (`/api/options/expiry`)', () => {
  it('carga LEAPS 2028-01-21 sin recalcular barras/MTF/macro, cachea 15s y acota Tradier a esa fecha', async () => {
    const { fetchFn, control } = createMockFetch({});
    const tradierCalls: { readonly symbol: string; readonly expiration: string }[] = [];
    const runtime = new MarketRuntime({
      apiKey: 'pieza502-test-key',
      secrets: ['pieza502-test-key'],
      nowMsFn: () => NOW_SEC * 1_000,
      enableWs: false,
      fetchFn,
      tradierConfig: {
        accessToken: TRADIER_CACHE_TOKEN,
        tokenEnvName: 'TRADIER_ACCESS_TOKEN',
        apiEnv: 'prod',
        restBaseUrl: 'https://api.tradier.com/v1',
        wsBaseUrl: 'wss://ws.tradier.com/v1/markets/events',
        configured: true,
        tokenIsGeneric: false,
        sandboxFallbackAllowed: false,
      },
      tradierChainFetchFn: (symbol, expiration) => {
        tradierCalls.push({ symbol, expiration });
        if (expiration !== '2028-01-21') {
          return Promise.resolve({
            contracts: [],
            provenance: {
              provider: 'TRADIER' as const,
              endpoint: 'REST_OPTION_CHAIN' as const,
              requestedAtUtcSec: NOW_SEC,
              httpStatus: 200,
              rows: 0,
              parseDiscarded: 0,
              lastError: null,
            },
          });
        }
        const tradierRow = (strike: number, type: 'call' | 'put', bid: number, ask: number) => ({
          occSymbol: `SPY280121${type === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1_000)).padStart(8, '0')}`,
          underlying: 'SPY',
          contractType: type,
          strike,
          expirationDate: expiration,
          expirationTime: Math.floor(Date.UTC(2028, 0, 21, 21) / 1_000),
          bid,
          bidSize: 12,
          ask,
          askSize: 14,
          volume: 0,
          openInterest: 0,
          last: (bid + ask) / 2,
          close: (bid + ask) / 2,
          greeks: {
            delta: type === 'call' ? 0.5 : -0.5,
            gamma: 0.01,
            theta: -0.02,
            vega: 0.1,
            rho: 0,
            phi: 0,
            bidIv: 0.22,
            midIv: 0.22,
            askIv: 0.23,
            smvVol: 0.22,
            updatedAtUtcSec: NOW_SEC,
          },
          asOfUtcSec: NOW_SEC,
          provider: 'TRADIER' as const,
          sharesPerContract: 100 as const,
        });
        return Promise.resolve({
          contracts: [tradierRow(590, 'call', 40.5, 41.5), tradierRow(600, 'call', 38.0, 39.0)],
          provenance: {
            provider: 'TRADIER' as const,
            endpoint: 'REST_OPTION_CHAIN' as const,
            requestedAtUtcSec: NOW_SEC,
            httpStatus: 200,
            rows: 2,
            parseDiscarded: 0,
            lastError: null,
          },
        });
      },
    });

    const server = createHttpWsServer({
      runtime,
      host: '127.0.0.1',
      port: 0,
      secrets: ['pieza502-test-key'],
      startRuntimeWs: false,
    });
    activeServers.push(server);
    const { host, port } = await server.start();
    const base = `http://${host}:${String(port)}`;

    const snapRes = await fetch(`${base}/api/snapshot?symbol=SPY`);
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as TerminalSnapshotResponse;
    const leapsPending = (snap.optionsChain?.availableExpirations ?? []).find(
      (entry) => entry.expirationDate === '2028-01-21',
    );
    expect(leapsPending?.loaded).toBe(false);
    tradierCalls.length = 0;
    const marker = control.urls.length;
    const chainCallsBefore = control.chainRequestsForDate('2028-01-21');

    const res = await fetch(`${base}/api/options/expiry?symbol=SPY&expiration=2028-01-21`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsOptionExpiryChainResponse;
    expect(body.symbol).toBe('SPY');
    expect(body.expirationDate).toBe('2028-01-21');
    expect(body.daysToExpiry).toBe(746);
    expect(body.expiryMeta.loaded).toBe(true);
    expect(body.expiryMeta.validCallCount).toBeGreaterThan(0);
    expect(body.expiryMeta.hasCompleteAtmChain).toBe(true);
    expect(body.contracts.length).toBeGreaterThan(0);
    const ownIvRows = body.contracts.filter((row) => row.ownIv !== null);
    expect(ownIvRows.length).toBeGreaterThan(0);
    const greekRows = body.contracts.filter(
      (row) => row.delta !== null && row.gamma !== null && row.vegaPer1Pct !== null,
    );
    expect(greekRows.length).toBeGreaterThan(0);
    expect(body.slice).not.toBeNull();
    expect(Number.isFinite(body.slice?.ivAtm ?? Number.NaN)).toBe(true);
    expect((body.slice?.ivAtm ?? 0) > 0).toBe(true);
    expect(Number.isFinite(body.slice?.riskReversal25 ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(body.slice?.butterfly25 ?? Number.NaN)).toBe(true);
    expect(body.exposureSummary).not.toBeNull();
    expect(Number.isFinite(body.exposureSummary?.netGex ?? Number.NaN)).toBe(true);
    expect(body.syntheticRates).not.toBeNull();
    expect(body.volAnalyticsExpiry).not.toBeNull();
    expect(body.volAnalyticsExpiry?.expiryCode).toBe('2028-01-21');
    expect(body.volAnalyticsExpiry?.daysToExpiry).toBe(746);
    expect(body.dataQuality.parityExpiries).toBe(1);

    // Tradier se consulta únicamente para la fecha pedida y no pisa volumen/OI de Massive.
    expect(tradierCalls).toEqual([{ symbol: 'SPY', expiration: '2028-01-21' }]);
    const overlaidCall = body.contracts.find(
      (row) => row.strike === 590 && row.contractType === 'call',
    );
    expect(overlaidCall?.volume).toBe(MASSIVE_VOLUME);
    expect(overlaidCall?.openInterest).toBe(MASSIVE_OPEN_INTEREST);
    expect(overlaidCall?.bid).toBeCloseTo(40.5, 9);

    // Sin barras intradía/MTF/macro recalculados: solo la barra 1D mínima de contexto.
    const onDemandUrls = control.urls.slice(marker);
    const aggsUrls = onDemandUrls.filter((url) => url.includes('/v2/aggs/ticker/'));
    expect(aggsUrls.length).toBeGreaterThan(0);
    for (const url of aggsUrls) {
      expect(url.includes('/range/1/day/')).toBe(true);
    }
    expect(onDemandUrls.some((url) => url.includes('/v3/reference/options/contracts'))).toBe(true);
    expect(onDemandUrls.some((url) => url.includes('/v3/snapshot/options/SPY'))).toBe(true);
    expect(onDemandUrls.some((url) => url.includes('expiration_date=2028-01-21'))).toBe(true);

    // Segunda llamada inmediata: pega en `usExpiryChainCache` (cero llamadas nuevas).
    const cachedRes = await fetch(`${base}/api/options/expiry?symbol=SPY&expiration=2028-01-21`);
    expect(cachedRes.status).toBe(200);
    expect(control.chainRequestsForDate('2028-01-21')).toBe(chainCallsBefore + 1);
    expect(tradierCalls).toHaveLength(1);

    // Validación estricta de parámetros.
    const missingExp = await fetch(`${base}/api/options/expiry?symbol=SPY`);
    expect(missingExp.status).toBe(400);
    const missingExpBody = (await missingExp.json()) as { readonly reason: string };
    expect(missingExpBody.reason).toBe('INVALID_PARAMETER');
    const malformed = await fetch(`${base}/api/options/expiry?symbol=SPY&expiration=2028/01/21`);
    expect(malformed.status).toBe(400);
    const missingSymbol = await fetch(`${base}/api/options/expiry?expiration=2028-01-21`);
    expect(missingSymbol.status).toBe(400);

    // Fusión frontend pura: stub reemplazado por la cadena real, estructura temporal y
    // forward IV recalculados sin reiniciar el resto del estado.
    const previous = buildPreviousArOptions();
    const merged = mergeUsExpiryChainIntoOptions(
      previous,
      body as unknown as UsOptionExpiryChainResponseDto,
    );
    const preserved = merged.expiries.find((expiry) => expiry.expiryCode === '2026-02-04');
    expect(preserved?.calls).toHaveLength(1);
    expect(preserved?.loaded).toBe(true);
    const leaps = merged.expiries.find((expiry) => expiry.expiryCode === '2028-01-21');
    expect(leaps?.loaded).toBe(true);
    expect((leaps?.calls.length ?? 0) > 0).toBe(true);
    expect((leaps?.puts.length ?? 0) > 0).toBe(true);
    expect(leaps?.ivAtm ?? null).not.toBeNull();
    expect(merged.expiries.map((expiry) => expiry.days)).toEqual(
      [...merged.expiries.map((expiry) => expiry.days)].sort((a, b) => a - b),
    );
    const mergedTermCodes = merged.termStructure.map((point) => point.expiryCode);
    expect(mergedTermCodes).toContain('2028-01-21');
    expect(merged.termStructure.map((point) => point.days)).toEqual(
      [...merged.termStructure.map((point) => point.days)].sort((a, b) => a - b),
    );
    const farSegment = merged.forwardIvSegments?.find(
      (segment) => segment.farExpiryCode === '2028-01-21',
    );
    expect(farSegment).toBeDefined();
    expect(merged.exposureSummaryByExpiry?.['2028-01-21']).toBeDefined();
    expect(merged.quantEnginesByExpiry?.['2028-01-21']).toBeDefined();
    expect(merged.quantEnginesByExpiry?.['2028-01-21']?.syntheticRates).not.toBeNull();
  }, 60_000);
});

function buildPreviousArOptions(): ArOptionsResponse {
  const baseContract = (strike: number, type: 'call' | 'put'): ArOptionContractDto => ({
    symbol: `O:SPY260204${type === 'call' ? 'C' : 'P'}${String(strike * 1_000).padStart(8, '0')}`,
    underlying: 'SPY',
    contractType: type,
    strike,
    expiryCode: '2026-02-04',
    expirationDate: '2026-02-04',
    expiryUtcSec: Math.floor(Date.UTC(2026, 1, 4, 21) / 1_000),
    daysToExpiry: 30,
    bid: 5,
    ask: 5.2,
    last: 5.1,
    mark: 5.1,
    volume: 100,
    openInterest: 1000,
    iv: 0.22,
    delta: 0.5,
    gamma: 0.01,
    thetaDaily: -0.02,
    vegaPer1Pct: 0.1,
    rho: null,
    vanna: 0,
    charm: 0,
    intrinsic: 0,
    extrinsic: 5.1,
    previousClose: 5,
    changePct: 2,
    source: 'DATA912' as const,
  });
  const emptyEngines: NonNullable<ArOptionsResponse['quantEngines']> = {
    orderFlowArs: null,
    netDirectionalPremiumUsdCcl: null,
    callNetPremiumCvdUsdCcl: null,
    putNetPremiumCvdUsdCcl: null,
    volOiAnomalies: null,
    flowAdjustedGex: null,
    gexCharmPin: null,
    qDistribution: null,
    pDistribution: null,
    pqDivergence: null,
    volCone: null,
    syntheticRates: null,
    conversionReversal: null,
    buyWrite: null,
    calendarRoll: null,
    structureOptimizerBullish: null,
    structureOptimizerBearish: null,
    structureCostPercentile: null,
    confluenceClusters: null,
  };
  return {
    asOfUtcSec: NOW_SEC,
    feedStatus: 'LIVE',
    underlying: 'SPY',
    market: 'US',
    spot: SPOT,
    rateTna: 4.4,
    continuousRate: 0.043,
    dividendYield: 0.012,
    lotSize: 100,
    settlement: 'T+0',
    exerciseCutoffArt: '15:30 ART',
    realizedVol20d: 18,
    realizedVol60d: 19,
    histMedianIv: 0.22,
    vrpSpread: 0.04,
    historicalCloses: [],
    termStructure: [
      { days: 30, label: '2026-02-04', expiryCode: '2026-02-04', atm: 0.22 },
    ],
    expiries: [
      {
        expiryCode: '2026-02-04',
        expiryLabel: '2026-02-04 (30d)',
        expirationDate: '2026-02-04',
        expiryUtcSec: Math.floor(Date.UTC(2026, 1, 4, 21) / 1_000),
        days: 30,
        ivAtm: 0.22,
        riskReversal25: -0.01,
        butterfly25: 0.005,
        butterflyArbitrageFree: true,
        strikes: [600],
        calls: [baseContract(600, 'call')],
        puts: [baseContract(600, 'put')],
        loaded: true,
      },
      {
        expiryCode: '2028-01-21',
        expiryLabel: '2028-01-21 (746d)',
        expirationDate: '2028-01-21',
        expiryUtcSec: Math.floor(Date.UTC(2028, 0, 21, 21) / 1_000),
        days: 746,
        ivAtm: null,
        riskReversal25: null,
        butterfly25: null,
        butterflyArbitrageFree: false,
        strikes: [],
        calls: [],
        puts: [],
        loaded: false,
      },
    ],
    exposureSummary: null,
    costSchedule: {
      rvMarketFeeRate: 0.002,
      optionsFeeRate: 0.002,
      shortLoanFeeRate: 0,
      vatRate: 0,
      bondsVatExempt: true,
    },
    primaryLiquidExpiryCode: '2026-02-04',
    forwardIvSegments: [],
    quantEngines: emptyEngines,
    providerErrors: [],
  };
}

// ---------------------------------------------------------------------------
// 3) Priorización y tope estricto de 1.000 suscripciones WS
// ---------------------------------------------------------------------------

describe('Pieza 50.2 — Tope estricto de 1.000 suscripciones WS con evicción LRU', () => {
  it('navega 30 vencimientos (30×40 contratos) sin superar 1.000 y suscribe los 40 ATM del activo', async () => {
    const dates = Array.from({ length: 30 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 0, 6 + i));
      const date = day.toISOString().slice(0, 10);
      const dte = Math.round((day.getTime() - Date.UTC(2026, 0, 5)) / 86_400_000);
      return { date, dte };
    });
    const { fetchFn } = createMockFetch({ chainDates: dates });
    const subscribedTickers: string[] = [];
    const subscribeCalls: string[][] = [];
    const unsubscribeCalls: string[][] = [];
    const createWsClientFn = (options: MassiveWsClientOptions): MassiveWsClientLike => {
      const initial =
        options.initialSubscriptions === undefined
          ? []
          : typeof options.initialSubscriptions === 'string'
            ? [options.initialSubscriptions]
            : [...options.initialSubscriptions];
      subscribeCalls.push(initial);
      for (const channel of initial) {
        if (channel.startsWith('Q.')) subscribedTickers.push(channel.slice(2));
      }
      const snapshot: WsClientSnapshot = {
        cluster: 'options',
        url: 'wss://socket.massive.com/options',
        state: 'ready',
        subscriptions: initial,
        activeQuoteSubscriptionCount: initial.filter((channel) => channel.startsWith('Q.')).length,
        queueDepth: 0,
        droppedQueueMessages: 0,
        reconnectAttempts: 0,
        totalMessagesReceived: 0,
        discardedPayloads: 0,
        lastError: null,
      };
      return {
        connect: () => Promise.resolve(),
        subscribe: (channels) => {
          const list = typeof channels === 'string' ? [channels] : [...channels];
          subscribeCalls.push(list);
          for (const channel of list) {
            if (channel.startsWith('Q.')) subscribedTickers.push(channel.slice(2));
          }
        },
        unsubscribe: (channels) => {
          const list = typeof channels === 'string' ? [channels] : [...channels];
          unsubscribeCalls.push(list);
          for (const channel of list) {
            if (channel.startsWith('Q.')) {
              const ticker = channel.slice(2);
              const idx = subscribedTickers.indexOf(ticker);
              if (idx >= 0) subscribedTickers.splice(idx, 1);
            }
          }
        },
        close: () => undefined,
        getSnapshot: () => snapshot,
      };
    };
    const runtime = new MarketRuntime({
      apiKey: 'pieza502-test-key',
      secrets: ['pieza502-test-key'],
      nowMsFn: () => NOW_SEC * 1_000,
      enableWs: true,
      fetchFn,
      createWsClientFn,
    });

    for (const { date } of dates) {
      const response = await runtime.getUsOptionExpiryChain('SPY', date);
      expect(response.expiryMeta.loaded).toBe(true);
      expect(new Set(subscribedTickers).size).toBe(subscribedTickers.length);
      expect(subscribedTickers.length).toBeLessThanOrEqual(1000);
      expect(runtime.getHealth().ws.subscribedOptionQuotes).toBeLessThanOrEqual(1000);
      expect(runtime.getHealth().ws.subscribedOptionQuotes).toBe(subscribedTickers.length);
    }

    // 25 vencimientos × 40 = 1.000 exactos; los 5 restantes obligan a evictar 40 LRU
    // (80 canales `T./Q.`) y suscribir los 40 ATM del vencimiento activo en cada paso.
    expect(subscribedTickers.length).toBe(1000);
    const evictedChannels = unsubscribeCalls.flat();
    expect(evictedChannels.length).toBe(5 * 40 * 2);
    const lastDate = dates[29]?.date ?? '';
    // Orden del servidor: distancia al spot (asc) con desempate de liquidez; en el mock
    // toda la liquidez es uniforme → sort estable conserva el orden call/put por strike.
    const expectedLastTickers = [...CHAIN_STRIKES]
      .flatMap((strike) => [occTicker(lastDate, 'call', strike), occTicker(lastDate, 'put', strike)])
      .sort((a, b) => {
        const strikeOf = (ticker: string): number => Number(ticker.slice(-8)) / 1_000;
        return Math.abs(strikeOf(a) - SPOT) - Math.abs(strikeOf(b) - SPOT);
      })
      .slice(0, 40);
    for (const ticker of expectedLastTickers) {
      expect(subscribedTickers, ticker).toContain(ticker);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 4) Referencia Python + TIR/régimen estricto sobre el vencimiento activo
// ---------------------------------------------------------------------------

describe('Pieza 50.2 — TIR y régimen 0DTE/Short Gamma sobre el vencimiento activo (referencia Python ≤ 1e-9)', () => {
  it('valida catálogo, anclas y fusión contra la referencia Python', () => {
    for (const testCase of fixture.expiryCatalogCases) {
      const contracts = testCase.contracts.map(
        (c): OptionContract => ({
          ticker: c.ticker,
          underlyingTicker: 'SPY',
          contractType: c.contractType,
          exerciseStyle: null,
          expirationDate: c.expirationDate,
          expirationTime: c.expiryUtcSec,
          strikePrice: c.strikePrice,
          sharesPerContract: 100,
          primaryExchange: null,
          cfi: null,
          correction: null,
          kind: null,
          underlyingType: null,
          additionalUnderlyings: [],
          isBinary: false,
          isAdjusted: false,
          isNonStandard: false,
        }),
      );
      const result = extractUsExpiryCatalog(
        contracts,
        decodeJsonNumber(testCase.spot),
        testCase.nowSec,
      );
      expect(result.length, testCase.name).toBe(testCase.expected.length);
      for (let i = 0; i < testCase.expected.length; i += 1) {
        const expected = testCase.expected[i];
        const actual = result[i];
        if (expected === undefined || actual === undefined) throw new Error('desalineado');
        expect(actual.expirationDate, testCase.name).toBe(expected.expirationDate);
        expect(Number.isFinite(actual.daysToExpiry)).toBe(true);
        expect(Math.abs(actual.daysToExpiry - expected.daysToExpiry)).toBeLessThanOrEqual(TOL);
        expect(actual.nearAtmContracts, testCase.name).toBe(expected.nearAtmContracts);
      }
      const sorted = [...result.map((entry) => entry.expirationDate)].sort((a, b) => a.localeCompare(b));
      expect(result.map((entry) => entry.expirationDate)).toEqual(sorted);
      expect(new Set(result.map((entry) => entry.expirationDate)).size).toBe(result.length);
    }

    for (const testCase of fixture.anchorSelectionCases) {
      const result = selectAnchorUsExpirations(
        testCase.catalog,
        testCase.requested ?? undefined,
      );
      expect(result, testCase.name).toEqual(testCase.expected);
      expect(result.length).toBeLessThanOrEqual(6);
    }

    for (const testCase of fixture.expiryCatalogMergeCases) {
      const loaded = testCase.loaded.map((entry) => ({ ...entry, loaded: true }));
      const result = mergeUsOptionExpiryCatalog(testCase.catalog, loaded);
      expect(result, testCase.name).toEqual(testCase.expected);
      const sorted = [...result.map((entry) => entry.expirationDate)].sort((a, b) => a.localeCompare(b));
      expect(result.map((entry) => entry.expirationDate)).toEqual(sorted);
    }
  });

  it('bloquea TIR solo por DTE del vencimiento activo y jamás hereda la paridad del front', () => {
    for (const testCase of fixture.activeExpiryTirCases) {
      const result = evaluateActiveExpiryHeaderTir({
        activeDte: decodeJsonNumber(testCase.input.activeDte),
        activeExpiryId: testCase.input.activeExpiryId,
        activeParity:
          testCase.input.activeParity === null
            ? null
            : {
                expiryCode: testCase.input.activeParity.expiryCode ?? null,
                medianMidTeaPct: decodeJsonNumber(testCase.input.activeParity.medianMidTeaPct),
                impliedRateStatus: testCase.input.activeParity.impliedRateStatus ?? null,
              },
        activeExpirySyntheticRates:
          testCase.input.activeExpirySyntheticRates === null
            ? null
            : {
                medianImpliedTna: decodeJsonNumber(
                  testCase.input.activeExpirySyntheticRates.medianImpliedTna,
                ),
                impliedRateStatus:
                  testCase.input.activeExpirySyntheticRates.impliedRateStatus ?? null,
              },
      });
      expect(result.blockedShortDte, testCase.name).toBe(testCase.expected.blockedShortDte);
      expectNumberOrNaN(result.tirPct, testCase.expected.tirPct);
    }
  });

  it('dispara el banner 0DTE/Short Gamma solo por el vencimiento activo (matriz Python)', () => {
    for (const testCase of fixture.activeExpiryRegimeCases) {
      const result = evaluateActiveExpiryRegimeAndBreaker({
        activeDte: decodeJsonNumber(testCase.input.activeDte),
        activeExpiryId: testCase.input.activeExpiryId,
        spot: testCase.input.spot,
        activeExposureSummary: {
          putWallStrike: testCase.input.activeExposureSummary.putWallStrike,
          netGex: decodeJsonNumber(testCase.input.activeExposureSummary.netGex),
        },
        precomputedRegimeForActiveExpiry: asOperativeRegimeCode(
          testCase.input.precomputedRegimeForActiveExpiry,
        ),
        fallbackRegimeInput: {
          ivAtmActiveExpiryPct: decodeJsonNumber(
            testCase.input.fallbackRegimeInput.ivAtmActiveExpiryPct,
          ),
          rvReferencePct: decodeJsonNumber(testCase.input.fallbackRegimeInput.rvReferencePct),
          rvReferenceLabel: testCase.input.fallbackRegimeInput.rvReferenceLabel,
        },
      });
      expect(result.blocked, testCase.name).toBe(testCase.expected.blocked);
      expect(result.autoSelectCreditMode, testCase.name).toBe(
        testCase.expected.autoSelectCreditMode,
      );
      expect(result.baseRegimeCode, testCase.name).toBe(testCase.expected.baseRegimeCode);
      expect(result.activeRegimeCode, testCase.name).toBe(testCase.expected.activeRegimeCode);
    }
  });

  it('escenario real: front 0DTE bloqueado + activo 30DTE muestra TIR y desactiva el banner', () => {
    // Front 0DTE: tasa bloqueada por DTE (<3) y régimen NO_SHORT_PREMIUM_RISK.
    const frontDte = 0;
    const frontState = evaluateActiveExpiryHeaderTir({
      activeDte: frontDte,
      activeExpiryId: '2026-01-05',
      activeParity: {
        expiryCode: '2026-01-05',
        medianMidTeaPct: 4.4,
        impliedRateStatus: 'BLOCKED_SHORT_DTE',
      },
      activeExpirySyntheticRates: null,
    });
    expect(frontState.blockedShortDte).toBe(true);
    expect(Number.isNaN(frontState.tirPct)).toBe(true);

    // Activo 30DTE del MISMO snapshot: TIR real visible y sin bloqueo heredado.
    const activeState = evaluateActiveExpiryHeaderTir({
      activeDte: 30,
      activeExpiryId: '2026-02-04',
      activeParity: {
        expiryCode: '2026-02-04',
        medianMidTeaPct: 4.35,
        impliedRateStatus: 'OK',
      },
      activeExpirySyntheticRates: { medianImpliedTna: 0.0425, impliedRateStatus: 'OK' },
    });
    expect(activeState.blockedShortDte).toBe(false);
    expect(Math.abs(activeState.tirPct - 4.35)).toBeLessThanOrEqual(TOL);

    const regime = evaluateActiveExpiryRegimeAndBreaker({
      activeDte: 30,
      activeExpiryId: '2026-02-04',
      spot: 600,
      activeExposureSummary: { putWallStrike: 570, netGex: 1200 },
      precomputedRegimeForActiveExpiry: 'VENTA_PRIMA_CUBIERTA',
      fallbackRegimeInput: {
        ivAtmActiveExpiryPct: 25,
        rvReferencePct: 18,
        rvReferenceLabel: 'RV23d',
      },
    });
    expect(regime.blocked).toBe(false);
    expect(regime.activeRegimeCode).not.toBe('NO_SHORT_PREMIUM_RISK');
    expect(regime.activeRegimeCode).toBe('VENTA_PRIMA_CUBIERTA');

    // El stub NO_SHORT_PREMIUM_RISK heredado del front se recalcula sobre el activo.
    const staleFrontRegime = evaluateActiveExpiryRegimeAndBreaker({
      activeDte: 30,
      activeExpiryId: '2026-02-04',
      spot: 600,
      activeExposureSummary: { putWallStrike: 570, netGex: 500 },
      precomputedRegimeForActiveExpiry: 'NO_SHORT_PREMIUM_RISK',
      fallbackRegimeInput: {
        ivAtmActiveExpiryPct: 25,
        rvReferencePct: 18,
        rvReferenceLabel: 'RV23d',
      },
    });
    expect(staleFrontRegime.blocked).toBe(false);
    expect(staleFrontRegime.activeRegimeCode).toBe('VENTA_PRIMA_CUBIERTA');
  });
});

// ---------------------------------------------------------------------------
// 5) Pieza 50.2.1 — El selector preserva el 100 % de optionsChain.availableExpirations
// ---------------------------------------------------------------------------

describe('Pieza 50.2.1 — El selector de vencimientos preserva el 100 % del catálogo', () => {
  const asOfUtcSec = Math.floor(Date.UTC(2026, 10, 21, 21, 0, 0) / 1_000); // sábado 2026-11-21 16:00 ET
  const LOADED_DATES = [
    '2026-11-23',
    '2026-11-27',
    '2026-12-11',
    '2027-01-15',
    '2027-02-19',
    '2027-05-21',
  ] as const;
  const PENDING_DATES: readonly string[] = (() => {
    const list: string[] = [];
    let t = Date.UTC(2027, 5, 4);
    while (list.length < 23) {
      list.push(new Date(t).toISOString().slice(0, 10));
      t += 7 * 86_400_000;
    }
    list.push('2029-01-19'); // LEAPS 790d
    return list;
  })();
  const ALL_DATES: readonly string[] = [...LOADED_DATES, ...PENDING_DATES].sort((a, b) =>
    a.localeCompare(b),
  );

  function snapshotContractRow(
    date: string,
    strike: number,
    type: 'call' | 'put',
  ): UsOptionContractRowDto {
    return {
      ticker: `O:SPY${date.slice(2).replaceAll('-', '')}${type === 'call' ? 'C' : 'P'}${String(strike * 1_000).padStart(8, '0')}`,
      contractType: type,
      strike,
      expirationDate: date,
      expiryUtcSec: Math.floor(Date.parse(`${date}T21:00:00Z`) / 1_000),
      bid: 5,
      ask: 5.2,
      mid: 5.1,
      lastPrice: 5.1,
      openInterest: 1_000,
      volume: 100,
      previousClose: 5,
      changePct: 2,
      ownIv: 0.22,
      providerIv: 0.22,
      ivSource: 'OWN',
      delta: 0.5,
      gamma: 0.01,
      thetaDaily: -0.02,
      vegaPer1Pct: 0.1,
      vanna: 0,
      charm: 0,
    };
  }

  function buildRealisticSnapshotPayload(): UsSnapshotResponseDto {
    const contracts: UsOptionContractRowDto[] = LOADED_DATES.flatMap((date) =>
      [690, 700].flatMap((strike) =>
        (['call', 'put'] as const).map((type) => snapshotContractRow(date, strike, type)),
      ),
    );
    const availableExpirations = ALL_DATES.map((date) => {
      const days = Math.round(
        (Date.parse(`${date}T22:00:00Z`) / 1_000 - asOfUtcSec) / 86_400,
      );
      const loaded = (LOADED_DATES as readonly string[]).includes(date);
      return {
        expirationDate: date,
        daysToExpiry: days,
        loaded,
        validCallCount: loaded ? 40 : 0,
        validPutCount: loaded ? 40 : 0,
        nearAtmLiquidity: loaded ? 120_000 : 0,
        inDefaultWindow: days >= 14 && days <= 45,
        hasCompleteAtmChain: loaded,
      };
    });
    return {
      status: 'PARTIAL',
      feedMode: 'LIVE',
      quoteMode: 'LIVE_NBBO',
      symbol: 'SPY',
      isIndex: false,
      asOfUtcSec,
      envelope: { snapshot: { metrics: { spot: 690 } } },
      marketContext: {
        unifiedQuotes: [
          {
            ticker: 'SPY',
            assetType: 'stock',
            price: 690,
            change: 1,
            changePct: 0.15,
            previousClose: 689,
            dayLow: 688.5,
            dayHigh: 691,
            dayRangePos: 0.6,
            volumeM: 40,
            iv30d: 0.22,
            marketStatus: 'open',
            volume: 40_000_000,
          },
        ],
      },
      volSurfaceSummary: { iv30d: 0.22, frontSlice: null, slices: [], contracts },
      optionsChain: {
        selectedExpirationDate: '2026-12-11',
        selectionReason: 'DEFAULT_LIQUID_14_45_DTE',
        prefetchExpirationDates: ['2026-12-11'],
        availableExpirations,
      },
    };
  }

  it('mapea las 30 fechas (6 loaded:true + 24 pendientes hasta LEAPS 2029) sin recortarlas', () => {
    const payload = buildRealisticSnapshotPayload();
    expect(payload.optionsChain?.availableExpirations).toHaveLength(30);

    const mapped = mapUsSnapshotToArOptions('SPY', payload);
    // El mapeo del bridge conserva el catálogo COMPLETO: 6 anclas + 24 pendientes.
    expect(mapped.expiries).toHaveLength(30);
    expect(mapped.expiries.map((e) => e.expiryCode)).toEqual([...ALL_DATES]);
    const loaded = mapped.expiries.filter((e) => e.loaded === true);
    expect(loaded).toHaveLength(6);
    for (const exp of loaded) {
      expect(exp.calls.length + exp.puts.length, exp.expiryCode).toBeGreaterThan(0);
      expect(exp.ivAtm, exp.expiryCode).not.toBeNull();
      expect(Number.isFinite(exp.ivAtm ?? Number.NaN), exp.expiryCode).toBe(true);
    }
    const pending = mapped.expiries.filter((e) => e.loaded === false);
    expect(pending).toHaveLength(24);
    for (const exp of pending) {
      expect(exp.calls).toHaveLength(0);
      expect(exp.puts).toHaveLength(0);
      expect(exp.strikes).toHaveLength(0);
      expect(exp.ivAtm).toBeNull();
    }
    const days = mapped.expiries.map((e) => e.days);
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(new Set(mapped.expiries.map((e) => e.expiryCode)).size).toBe(30);
    expect(days[days.length - 1]).toBe(790);

    // El selector se alimenta del estado del subyacente seleccionado: 30 filas, 6 con
    // IV ATM (decimal del DTO → %) y Fwd IV, 24 clicables `DTE · Cargar`.
    const entries = buildExpirySelectorEntries(mapped.expiries);
    expect(entries).toHaveLength(30);
    expect(entries.map((e) => e.expiryDate)).toEqual([...ALL_DATES]);
    const loadedEntries = entries.filter((e) => e.isLoaded);
    expect(loadedEntries).toHaveLength(6);
    for (const entry of loadedEntries) {
      expect(Number.isFinite(entry.atmIvPct), entry.id).toBe(true);
      expect(entry.atmIvPct).toBeGreaterThan(0);
    }
    const pendingEntries = entries.filter((e) => !e.isLoaded);
    expect(pendingEntries).toHaveLength(24);
    for (const entry of pendingEntries) {
      expect(Number.isNaN(entry.atmIvPct), entry.id).toBe(true);
      expect(entry.expiryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(entries[entries.length - 1]?.expiryDate).toBe('2029-01-19');

    // Regresión del bug real: el array global compartido AR/US puede quedar pisado por
    // GGAL BYMA (2 vencimientos); el selector del subyacente seleccionado NO se recorta.
    const bymaLike = buildExpirySelectorEntries([
      { expiryCode: '2026-12-18', expiryLabel: '2026-12-18', expirationDate: '2026-12-18', expiryUtcSec: 0, days: 27, ivAtm: 0.55, riskReversal25: null, butterfly25: null, butterflyArbitrageFree: true, strikes: [], calls: [], puts: [], loaded: true },
      { expiryCode: '2027-02-19', expiryLabel: '2027-02-19', expirationDate: '2027-02-19', expiryUtcSec: 0, days: 90, ivAtm: 0.56, riskReversal25: null, butterfly25: null, butterflyArbitrageFree: true, strikes: [], calls: [], puts: [], loaded: true },
    ]);
    expect(bymaLike).toHaveLength(2);
    expect(entries).toHaveLength(30);
    expect(mapped.expiries).toHaveLength(30);
  });
});
