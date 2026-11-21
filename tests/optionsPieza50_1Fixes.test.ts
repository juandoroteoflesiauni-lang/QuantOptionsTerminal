import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { priceBsm } from '../src/core/options/blackScholes.js';
import {
  computeVerticalSpreadMetrics,
  type VerticalSpreadInput,
  type VerticalSpreadMetric,
} from '../src/core/options/verticalSpreads.js';
import { resolveParityItmRescueIv } from '../src/core/options/zeroDteFixes.js';
import {
  resolveContractChangePct,
  resolveOpraAlignedSpot,
  selectCuratedUsExpirations,
  MarketRuntime,
  type OpraAlignedSpotResult,
  type CuratedUsExpirationsResult,
} from '../src/server/marketRuntime.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import type { OptionContract } from '../src/data/optionsTypes.js';
import type { FetchFn } from '../src/data/types.js';

type JsonNumber = number | 'NaN';

interface CuratedExpirationCase {
  readonly name: string;
  readonly spot: number;
  readonly nowSec: number;
  readonly requested: string | null;
  readonly contracts: readonly {
    readonly ticker: string;
    readonly expirationDate: string;
    readonly expiryUtcSec: number;
    readonly strikePrice: number;
    readonly contractType: 'call' | 'put';
  }[];
  readonly expected: {
    readonly curatedExpirationDates: readonly string[];
    readonly reason: string | null;
  };
}

interface OpraAlignedSpotCase {
  readonly name: string;
  readonly expected: {
    readonly valuationSpot: JsonNumber;
    readonly headerSpot: JsonNumber;
    readonly source: OpraAlignedSpotResult['source'];
    readonly divergenceBps: JsonNumber;
  };
  readonly input: {
    readonly feedSpot: JsonNumber;
    readonly rthCloseSpot: JsonNumber;
    readonly parityImpliedSpot: JsonNumber;
    readonly marketClosed: boolean;
    readonly divergenceThresholdRel?: number;
  };
}

interface ChangePctCase {
  readonly name: string;
  readonly expected: number | null;
  readonly input: {
    readonly changePercent: JsonNumber;
    readonly previousClose: number;
    readonly referencePrice: JsonNumber;
  };
}

interface SpreadCase {
  readonly name: string;
  readonly input: VerticalSpreadInput;
  readonly expected: {
    readonly valid: boolean;
    readonly reason: string | null;
    readonly width: number;
    readonly longPrice: JsonNumber;
    readonly shortPrice: JsonNumber;
    readonly longUsesEodRef: boolean;
    readonly shortUsesEodRef: boolean;
    readonly debit: number | null;
    readonly maxProfit: number | null;
    readonly rewardRiskRatio: number | null;
    readonly breakeven: number | null;
    readonly breakevenDistPct: number | null;
    readonly probAtBreakevenPct: number | null;
    readonly edgePct: number | null;
    readonly bidAskPctOfMid: number | null;
    readonly liquiditySemaphore: VerticalSpreadMetric['liquiditySemaphore'];
    readonly eligibleForAutoRanking: boolean;
  };
}

interface ParityRescueCase {
  readonly name: string;
  readonly expected: { readonly iv: number | null; readonly source: string | null };
  readonly input: {
    readonly counterpartOtmIv: JsonNumber;
    readonly atmIv: JsonNumber;
    readonly moneynessAbs: number;
    readonly maxMoneynessAbs?: number;
  };
}

interface Pieza501Fixture {
  readonly meta: { readonly generator: string; readonly tolerance: number };
  readonly curatedExpirationCases: readonly CuratedExpirationCase[];
  readonly opraAlignedSpotCases: readonly OpraAlignedSpotCase[];
  readonly changePctCases: readonly ChangePctCase[];
  readonly spreadCases: readonly SpreadCase[];
  readonly parityRescueCases: readonly ParityRescueCase[];
}

const fixturePath = join(process.cwd(), 'fixtures', 'options_pieza50_1_reference.json');
const fixture: Pieza501Fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Pieza501Fixture;
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

function expectNullableClose(actual: number, expected: number | null): void {
  if (expected === null) {
    expect(Number.isNaN(actual)).toBe(true);
  } else {
    expect(Number.isFinite(actual)).toBe(true);
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOL);
  }
}

describe('Pieza 50.1 — Fixes US/OPRA: vencimientos, escalera EOD, spot alineado y var% (referencia Python <= 1e-9)', () => {
  describe('1. Selección curada de vencimientos US', () => {
    it('valida front, 2 semanales, mensual 14–45, siguiente ≤60 y requested explícito', () => {
      for (const testCase of fixture.curatedExpirationCases) {
        const contracts = testCase.contracts.map(
          (c) =>
            ({
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
            }) satisfies OptionContract,
        );
        const result: CuratedUsExpirationsResult = selectCuratedUsExpirations(
          contracts,
          testCase.spot,
          testCase.nowSec,
          testCase.requested ?? undefined,
        );
        expect(result.curatedExpirationDates, testCase.name).toEqual(
          testCase.expected.curatedExpirationDates,
        );
        expect(result.reason, testCase.name).toBe(testCase.expected.reason);
        // Orden ascendente estricto y sin duplicados.
        const sorted = [...result.curatedExpirationDates].sort((a, b) => a.localeCompare(b));
        expect(result.curatedExpirationDates).toEqual(sorted);
        expect(new Set(result.curatedExpirationDates).size).toBe(
          result.curatedExpirationDates.length,
        );
        expect(result.curatedExpirationDates.length).toBeLessThanOrEqual(6);
      }
    });
  });

  describe('2. Alineación del spot de valuación OPRA', () => {
    it('elige paridad/cierre RTH en mercado cerrado y conserva el feed informativo en encabezado', () => {
      for (const testCase of fixture.opraAlignedSpotCases) {
        const input: Parameters<typeof resolveOpraAlignedSpot>[0] = {
          feedSpot: decodeJsonNumber(testCase.input.feedSpot),
          rthCloseSpot: decodeJsonNumber(testCase.input.rthCloseSpot),
          parityImpliedSpot: decodeJsonNumber(testCase.input.parityImpliedSpot),
          marketClosed: testCase.input.marketClosed,
          ...(testCase.input.divergenceThresholdRel !== undefined
            ? { divergenceThresholdRel: testCase.input.divergenceThresholdRel }
            : {}),
        };
        const snapshot = JSON.stringify(testCase.input);
        const result = resolveOpraAlignedSpot(input);
        expect(JSON.stringify(testCase.input), `${testCase.name} no debe mutar el input`).toBe(
          snapshot,
        );
        expectNumberOrNaN(result.valuationSpot, testCase.expected.valuationSpot);
        expectNumberOrNaN(result.headerSpot, testCase.expected.headerSpot);
        expect(result.source, testCase.name).toBe(testCase.expected.source);
        expectNumberOrNaN(result.divergenceBps, testCase.expected.divergenceBps);
      }

      // Escenario exacto reportado: quote AH 689.81 vs cierre RTH 693.15 vs paridad 693.20.
      const blueprint = resolveOpraAlignedSpot({
        feedSpot: 689.81,
        rthCloseSpot: 693.15,
        parityImpliedSpot: 693.2,
        marketClosed: true,
      });
      expect(blueprint.valuationSpot).toBe(693.2);
      expect(blueprint.headerSpot).toBe(689.81);
      expect(blueprint.source).toBe('PARITY_IMPLIED');
    });
  });

  describe('3. Variación % diaria de contratos (var%)', () => {
    it('prioriza change_percent, deriva de previous_close y degrada a NaN sin datos', () => {
      for (const testCase of fixture.changePctCases) {
        const actual = resolveContractChangePct(
          decodeJsonNumber(testCase.input.changePercent),
          testCase.input.previousClose,
          decodeJsonNumber(testCase.input.referencePrice),
        );
        if (testCase.expected === null) {
          expect(actual, testCase.name).toBeNull();
        } else {
          expect(actual, testCase.name).not.toBeNull();
          expect(Math.abs((actual as number) - testCase.expected)).toBeLessThanOrEqual(TOL);
        }
      }
    });
  });

  describe('4. Escalera de spreads EOD_MID vs LIVE_CROSS', () => {
    it('valida 1..4 bases CALL/PUT en EOD_MID y preserva LIVE_CROSS intacto', () => {
      for (const testCase of fixture.spreadCases) {
        const input: VerticalSpreadInput = {
          ...testCase.input,
          ...(testCase.input.pricingMode !== undefined
            ? { pricingMode: testCase.input.pricingMode }
            : {}),
        };
        const snapshot = JSON.stringify(input);
        const result = computeVerticalSpreadMetrics(input);
        expect(JSON.stringify(input), `${testCase.name} no debe mutar el input`).toBe(snapshot);

        expect(result.valid, testCase.name).toBe(testCase.expected.valid);
        expect(result.reason, testCase.name).toBe(testCase.expected.reason);
        expect(result.longUsesEodRef, testCase.name).toBe(testCase.expected.longUsesEodRef);
        expect(result.shortUsesEodRef, testCase.name).toBe(testCase.expected.shortUsesEodRef);
        expect(result.liquiditySemaphore, testCase.name).toBe(
          testCase.expected.liquiditySemaphore,
        );
        expect(result.eligibleForAutoRanking, testCase.name).toBe(
          testCase.expected.eligibleForAutoRanking,
        );
        expectNumberOrNaN(result.width, testCase.expected.width);
        expectNumberOrNaN(result.longPrice, testCase.expected.longPrice);
        expectNumberOrNaN(result.shortPrice, testCase.expected.shortPrice);
        expectNullableClose(result.debit, testCase.expected.debit);
        expectNullableClose(result.maxProfit, testCase.expected.maxProfit);
        expectNullableClose(result.rewardRiskRatio, testCase.expected.rewardRiskRatio);
        expectNullableClose(result.breakeven, testCase.expected.breakeven);
        expectNullableClose(result.breakevenDistPct, testCase.expected.breakevenDistPct);
        expectNullableClose(result.probAtBreakevenPct, testCase.expected.probAtBreakevenPct);
        expectNullableClose(result.edgePct, testCase.expected.edgePct);
        expectNullableClose(result.bidAskPctOfMid, testCase.expected.bidAskPctOfMid);
      }
    });

    it('sin `pricingMode` explícito el default LIVE_CROSS conserva el comportamiento previo', () => {
      const legacyCase = fixture.spreadCases.find((c) => c.name === 'eod_call_1_base_live_cross');
      if (!legacyCase) throw new Error('Falta el caso legacy LIVE_CROSS');
      const legacyInput: VerticalSpreadInput = {
        side: legacyCase.input.side,
        longLeg: legacyCase.input.longLeg,
        shortLeg: legacyCase.input.shortLeg,
        spot: legacyCase.input.spot,
        daysToExpiry: legacyCase.input.daysToExpiry,
        rateDec: legacyCase.input.rateDec,
        atmIvDec: legacyCase.input.atmIvDec,
      };
      const result = computeVerticalSpreadMetrics(legacyInput);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('DEBIT_NOT_LESS_THAN_WIDTH');
    });
  });

  describe('5. Rescate de IV ITM por contraparte OTM / IV ATM', () => {
    it('resuelve PARITY_OTM, ATM_RESCUE y null honesto contra referencia Python', () => {
      for (const testCase of fixture.parityRescueCases) {
        const result = resolveParityItmRescueIv({
          counterpartOtmIv: decodeJsonNumber(testCase.input.counterpartOtmIv),
          atmIv: decodeJsonNumber(testCase.input.atmIv),
          moneynessAbs: testCase.input.moneynessAbs,
          ...(testCase.input.maxMoneynessAbs !== undefined
            ? { maxMoneynessAbs: testCase.input.maxMoneynessAbs }
            : {}),
        });
        if (testCase.expected.iv === null) {
          expect(result.iv, testCase.name).toBeNull();
        } else {
          expect(result.iv, testCase.name).not.toBeNull();
          expect(Math.abs((result.iv as number) - testCase.expected.iv)).toBeLessThanOrEqual(TOL);
        }
        expect(result.source, testCase.name).toBe(testCase.expected.source);
      }
    });
  });

  describe('6. Integración offline: multi-vencimiento, ?expiration=, spot alineado y var% (MarketRuntime)', () => {
    const activeServers: HttpWsServerHandle[] = [];
    afterEach(async () => {
      for (const server of activeServers.splice(0, activeServers.length)) {
        await server.stop();
      }
    });

    const asOfSec = Math.floor(Date.UTC(2025, 2, 15, 16, 0, 0) / 1_000); // sábado 2025-03-15 12:00 ET
    const feedSpot = 689.81;
    const paritySpot = 693.2;
    const rthClose = 693.15;
    const expiryDefs: readonly { readonly date: string; readonly utcSec: number; readonly atmCount: number }[] = [
      { date: '2025-03-21', utcSec: Math.floor(Date.UTC(2025, 2, 21, 20, 0, 0) / 1_000), atmCount: 40 },
      { date: '2025-03-28', utcSec: Math.floor(Date.UTC(2025, 2, 28, 20, 0, 0) / 1_000), atmCount: 35 },
      { date: '2025-04-04', utcSec: Math.floor(Date.UTC(2025, 3, 4, 20, 0, 0) / 1_000), atmCount: 30 },
      { date: '2025-04-17', utcSec: Math.floor(Date.UTC(2025, 3, 17, 20, 0, 0) / 1_000), atmCount: 55 },
    ];
    const strikesPerExpiry = 76;

    function occTicker(date: string, type: 'call' | 'put', strike: number): string {
      const compact = date.replaceAll('-', '').slice(2);
      const padded = String(Math.round(strike * 1_000)).padStart(8, '0');
      return `O:SPY${compact}${type === 'call' ? 'C' : 'P'}${padded}`;
    }

    function buildBarsPayload(multiplier: number, timespan: string): string {
      const barSec = timespan === 'day' ? 86_400 : 300;
      const count = timespan === 'day' ? 40 : 80;
      const results: Record<string, unknown>[] = [];
      for (let i = count - 1; i >= 0; i -= 1) {
        const t = asOfSec - i * barSec;
        const close = rthClose;
        results.push({ t: t * 1_000, o: close, h: close + 0.4, l: close - 0.4, c: close, v: 120_000, vw: close });
      }
      return JSON.stringify({ status: 'OK', ticker: 'SPY', resultsCount: results.length, results });
    }

    const fetchFn: FetchFn = (url: string) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const respond = (payload: unknown): Promise<{ ok: boolean; status: number; text: string; headers: Record<string, string> }> =>
        Promise.resolve({ ok: true, status: 200, text: JSON.stringify(payload), headers: {} });

      if (path.startsWith('/v2/aggs/ticker/')) {
        const segments = path.split('/');
        const multiplier = Number(segments[6] ?? '5') || 5;
        const timespan = segments[7] ?? 'minute';
        return Promise.resolve({
          ok: true,
          status: 200,
          text: buildBarsPayload(multiplier, timespan),
          headers: {},
        });
      }
      if (path === '/fed/v1/treasury-yields') {
        return respond({
          status: 'OK',
          results: [
            {
              date: '2025-03-14',
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
              date: '2025-03-14',
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
              market_status: 'closed',
              last_quote: { P: feedSpot - 0.02, p: feedSpot + 0.02 },
              last_trade: { p: feedSpot },
              session: { price: feedSpot, previous_close: 688.5, change: 1.31, change_percent: 0.19 },
              day: { c: feedSpot, v: 40_000_000, o: 688.0, h: 690.5, l: 687.5 },
            },
            {
              ticker: 'I:SPX',
              type: 'indices',
              market_status: 'closed',
              value: 5950.5,
              session: { price: 5950.5, previous_close: 5925.0, change: 25.5, change_percent: 0.43 },
            },
            {
              ticker: 'I:VIX',
              type: 'indices',
              market_status: 'closed',
              value: 16.4,
              session: { price: 16.4, previous_close: 16.9, change: -0.5, change_percent: -2.96 },
            },
            {
              ticker: 'I:SKEW',
              type: 'indices',
              market_status: 'closed',
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
              day: { c: feedSpot, v: 40_000_000 },
              prevDay: { c: 688.5 },
              lastTrade: { p: feedSpot },
              lastQuote: { P: feedSpot - 0.02, p: feedSpot + 0.02 },
              market_status: 'closed',
            },
          ],
        });
      }
      if (path === '/v3/reference/options/contracts') {
        const results: Record<string, unknown>[] = [];
        for (const exp of expiryDefs) {
          for (let i = 0; i < strikesPerExpiry; i += 1) {
            const strike = Number((640 + i * 0.8).toFixed(2));
            for (const type of ['call', 'put'] as const) {
              results.push({
                ticker: occTicker(exp.date, type, strike),
                underlying_ticker: 'SPY',
                contract_type: type,
                strike_price: strike,
                expiration_date: exp.date,
                shares_per_contract: 100,
              });
            }
          }
        }
        return respond({ status: 'OK', results });
      }
      if (path.startsWith('/v3/snapshot/options/')) {
        const results: Record<string, unknown>[] = [];
        for (const exp of expiryDefs) {
          const tYears = Math.max(1, Math.round((exp.utcSec - asOfSec) / 86_400)) / 365;
          for (let i = 0; i < strikesPerExpiry; i += 1) {
            const strike = Number((640 + i * 0.8).toFixed(2));
            for (const type of ['call', 'put'] as const) {
              const moneyness = (paritySpot - strike) / paritySpot;
              const sigma = 0.2 + Math.abs(moneyness) * 0.12;
              const isItmCallEntry = exp.date === '2025-04-04' && type === 'call' && strike === 668;
              const isOtmPutEntry = exp.date === '2025-04-04' && type === 'put' && strike === 668;
              const isChangePctDirect = exp.date === '2025-03-21' && type === 'call' && strike === 695.2;
              const isChangePctDerived = exp.date === '2025-03-21' && type === 'call' && strike === 699.2;
              const effectiveSigma = isOtmPutEntry ? 0.422 : sigma;
              const fair = priceBsm({
                spot: paritySpot,
                strike,
                timeToExpiry: tYears,
                rate: 0.043,
                dividendYield: 0.012,
                volatility: effectiveSigma,
                contractType: type,
              });
              let mid = Number((0.5 * (fair * 0.995 + fair * 1.005 + 0.02)).toFixed(4));
              let bid = Number((fair * 0.995).toFixed(4));
              let ask = Number((fair * 1.005 + 0.02).toFixed(4));
              let providerIv: number = effectiveSigma;
              if (isItmCallEntry) {
                // Punta ancha + IV capada en el Call ITM: ownIv no resoluble, IV no confiable;
                // el rescate debe venir de la contraparte Put OTM del mismo strike.
                bid = 1.0;
                ask = 40.0;
                mid = 20.5;
                providerIv = 9.99;
              }
              const day: Record<string, unknown> = { volume: 650 };
              if (isChangePctDerived) {
                day['close'] = 11.5;
                day['previous_close'] = 10.0;
              } else if (!isChangePctDirect) {
                day['close'] = mid;
              }
              if (isChangePctDirect) {
                day['change_percent'] = 12.4;
              }
              results.push({
                details: {
                  ticker: occTicker(exp.date, type, strike),
                  contract_type: type,
                  strike_price: strike,
                  expiration_date: exp.date,
                  shares_per_contract: 100,
                },
                day,
                open_interest: 8_000,
                implied_volatility: providerIv,
                last_quote: { bid, ask, midpoint: mid },
                last_trade: { price: mid, sip_timestamp: String(asOfSec * 1_000_000_000) },
                underlying_asset: { ticker: 'SPY', price: feedSpot },
              });
            }
          }
        }
        return respond({ status: 'OK', results });
      }
      if (path === '/stocks/v1/dividends') {
        return respond({ status: 'OK', results: [] });
      }
      if (path === '/options/v1/unusual-trades') {
        return respond({ status: 'OK', results: [] });
      }
      return respond({ status: 'OK', results: [] });
    };

    it('carga los vencimientos curados (no solo los 2 primeros) y ?expiration= devuelve el pedido', async () => {
      const runtime = new MarketRuntime({
        apiKey: 'pieza501-test-key',
        secrets: ['pieza501-test-key'],
        nowMsFn: () => asOfSec * 1_000,
        enableWs: false,
        fetchFn,
      });
      const server = createHttpWsServer({
        runtime,
        host: '127.0.0.1',
        port: 0,
        secrets: ['pieza501-test-key'],
        startRuntimeWs: false,
      });
      activeServers.push(server);
      const { host, port } = await server.start();
      const base = `http://${host}:${String(port)}`;

      const snapRes = await fetch(`${base}/api/snapshot?symbol=SPY`);
      expect(snapRes.status).toBe(200);
      const snap = (await snapRes.json()) as {
        optionsChain?: { availableExpirations?: readonly { expirationDate: string }[]; selectedExpirationDate: string | null };
        volSurfaceSummary?: { contracts?: readonly { expirationDate: string }[] };
        envelope?: { snapshot?: { metrics?: { spot?: number } } };
      };

      const serializedDates = new Set(
        (snap.volSurfaceSummary?.contracts ?? []).map((c) => c.expirationDate),
      );
      // Bug 1: deben llegar vencimientos más allá de los 2 primeros (curados).
      expect([...serializedDates].sort()).toEqual([
        '2025-03-21',
        '2025-03-28',
        '2025-04-04',
        '2025-04-17',
      ]);
      const totalContracts = snap.volSurfaceSummary?.contracts?.length ?? 0;
      expect(totalContracts).toBeLessThanOrEqual(360);
      const primaryCount = (snap.volSurfaceSummary?.contracts ?? []).filter(
        (c) => c.expirationDate === '2025-04-04',
      ).length;
      expect(primaryCount).toBe(120);
      const secondaryCount = (snap.volSurfaceSummary?.contracts ?? []).filter(
        (c) => c.expirationDate === '2025-03-28',
      ).length;
      expect(secondaryCount).toBe(48);
      const availableDates = new Set(
        (snap.optionsChain?.availableExpirations ?? []).map((c) => c.expirationDate),
      );
      for (const curated of ['2025-03-21', '2025-03-28', '2025-04-04', '2025-04-17']) {
        expect(availableDates.has(curated), curated).toBe(true);
      }

      // Bug 3: el spot de valuación se alinea con la paridad/cierre RTH, no con el AH.
      const alignedSpot = snap.envelope?.snapshot?.metrics?.spot ?? Number.NaN;
      expect(Number.isFinite(alignedSpot)).toBe(true);
      expect(Math.abs(alignedSpot - feedSpot)).toBeGreaterThan(2);
      expect(Math.abs(alignedSpot - 693.1)).toBeLessThan(1);

      // Bug 4: var% directa (change_percent 12.4) y derivada (close 11.5 / prev 10.0 -> 15%).
      const rows = (snap.volSurfaceSummary?.contracts ?? []) as readonly {
        readonly expirationDate: string;
        readonly strike: number;
        readonly contractType: string;
        readonly changePct: number | null;
        readonly previousClose: number | null;
        readonly ivSource: string;
        readonly delta: number | null;
      }[];
      const directRow = rows.find(
        (c) => c.expirationDate === '2025-03-21' && c.strike === 695.2 && c.contractType === 'call',
      );
      expect(directRow?.changePct).toBe(12.4);
      const derivedRow = rows.find(
        (c) => c.expirationDate === '2025-03-21' && c.strike === 699.2 && c.contractType === 'call',
      );
      expect(Math.abs((derivedRow?.changePct ?? Number.NaN) - 15)).toBeLessThanOrEqual(TOL);
      expect(derivedRow?.previousClose).toBe(10.0);
      const noDataRow = rows.find(
        (c) => c.expirationDate === '2025-03-28' && c.strike === 700.0 && c.contractType === 'call',
      );
      expect(noDataRow?.changePct ?? null).toBeNull();

      // Bug 3.2: el Call ITM a -3.6% del vencimiento primario se rescata vía Put OTM
      // del mismo strike (IV ~42.2%) y no colapsa a Delta = 1.00.
      const itmCall = rows.find(
        (c) => c.expirationDate === '2025-04-04' && c.strike === 668 && c.contractType === 'call',
      );
      expect(itmCall?.ivSource).toBe('PARITY_OTM');
      expect(itmCall?.delta ?? Number.NaN).toBeLessThan(0.95);
      expect(itmCall?.delta ?? Number.NaN).toBeGreaterThan(0.6);
      const otmPut = rows.find(
        (c) => c.expirationDate === '2025-04-04' && c.strike === 668 && c.contractType === 'put',
      );
      expect(otmPut?.delta ?? Number.NaN).toBeLessThan(-0.2);
      // Paridad de deltas put-call del mismo strike: Δ_call − Δ_put ≈ e^{-qT} ≈ 1.
      expect(
        Math.abs(1 + (otmPut?.delta ?? Number.NaN) - (itmCall?.delta ?? Number.NaN)),
      ).toBeLessThan(0.1);

      // Bug 1.3: `?expiration=` respeta el vencimiento pedido con su cadena.
      const reqRes = await fetch(`${base}/api/snapshot?symbol=SPY&expiration=2025-04-17`);
      expect(reqRes.status).toBe(200);
      const reqSnap = (await reqRes.json()) as {
        optionsChain?: { selectedExpirationDate: string | null };
        volSurfaceSummary?: { contracts?: readonly { expirationDate: string; strike: number }[] };
      };
      expect(reqSnap.optionsChain?.selectedExpirationDate).toBe('2025-04-17');
      const requestedRows = (reqSnap.volSurfaceSummary?.contracts ?? []).filter(
        (c) => c.expirationDate === '2025-04-17',
      );
      expect(requestedRows.length).toBeGreaterThan(0);
    }, 30_000);
  });
});
