import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchResponse } from '../src/data/types.js';
import { ArgentinaMarketRuntime, buildCaucionesLiquidityCurve } from '../src/server/argentinaMarketLoader.js';
import { createHttpWsServer } from '../src/server/httpWsServer.js';
import {
  BmbBridgeClient,
  computeCaucionTeaEffectivePct,
  computeDlrContractMetrics,
  computeOrderBookL2Metrics,
  computeSpreadVsBadlarBps,
  PrimaryRofexClient,
  type OrderBookLevel,
  type PrimaryWsLike,
} from '../src/server/primaryRofexLoader.js';

interface DlrFixtureCase {
  readonly id: string;
  readonly input: {
    readonly asOfUtcSec: number;
    readonly maturityDate: string | null;
    readonly last: number | null;
    readonly bestBid: number | null;
    readonly bestAsk: number | null;
    readonly settlement: number | null;
    readonly close: number | null;
    readonly a3500: number | null;
    readonly dlrSpot: number | null;
  };
  readonly expected: {
    readonly priceBasis: 'LAST' | 'MID' | 'SETTLEMENT_EOD' | 'NONE';
    readonly referencePrice: number | null;
    readonly spotUsed: number | null;
    readonly spotSource: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE';
    readonly maturityUtcSec: number | null;
    readonly days: number | null;
    readonly devalDirectaPct: number | null;
    readonly tnaImplicitaPct: number | null;
    readonly teaImplicitaPct: number | null;
    readonly temImplicitaPct: number | null;
  };
}

interface L2FixtureCase {
  readonly id: string;
  readonly input: {
    readonly bids: readonly OrderBookLevel[];
    readonly asks: readonly OrderBookLevel[];
  };
  readonly expected: {
    readonly bestBid: number | null;
    readonly bestAsk: number | null;
    readonly mid: number | null;
    readonly spread: number | null;
    readonly spreadPct: number | null;
    readonly bidDepthSize: number | null;
    readonly askDepthSize: number | null;
    readonly bidDepthNotional: number | null;
    readonly askDepthNotional: number | null;
    readonly vwapBid5: number | null;
    readonly vwapAsk5: number | null;
    readonly vwapBook5: number | null;
    readonly obi5: number | null;
  };
}

interface CaucionFixtureCase {
  readonly id: string;
  readonly input: {
    readonly tnaPct: number;
    readonly termDays: number;
    readonly badlarTnaPct: number;
  };
  readonly expected: {
    readonly teaEffectivePct: number | null;
    readonly spreadVsBadlarBps: number | null;
  };
}

interface PrimaryBmbFixture {
  readonly schemaVersion: number;
  readonly dlrCases: readonly DlrFixtureCase[];
  readonly l2Cases: readonly L2FixtureCase[];
  readonly caucionCases: readonly CaucionFixtureCase[];
}

function loadReferenceFixture(): PrimaryBmbFixture {
  const raw = readFileSync(resolve(process.cwd(), 'fixtures/primary_bmb_reference.json'), 'utf8');
  return JSON.parse(raw) as PrimaryBmbFixture;
}

function expectCloseOrNaN(actual: number, expected: number | null, tol = 1e-9): void {
  if (expected === null) {
    expect(Number.isNaN(actual)).toBe(true);
    return;
  }
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

const TEST_ENV = {
  PRIMARY_API_URL: 'https://mock-primary.local',
  PRIMARY_WS_URL: 'wss://mock-primary.local/',
  PRIMARY_USERNAME: 'prim_user_secret_991',
  PRIMARY_PASSWORD: 'prim_pass_secret_882',
  PRIMARY_ACCOUNT: 'REM22710',
  BMB_BRIDGE_URL: 'http://127.0.0.1:18788',
  BMB_BROKER_ID: '153',
  BMB_DNI: '30999888',
  BMB_USERNAME: 'bmb_user_secret_773',
  BMB_PASSWORD: 'bmb_pass_secret_664',
  BMB_ACCOUNT: '266758',
} as const satisfies NodeJS.ProcessEnv;

const TEST_TOKEN = 'tok_live_secret_header_555';

function makeJsonResp(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  };
}

describe('Primary ROFEX / BMB HomeBroker Connectors & Pure Math Parity', () => {
  const serversToStop: { stop(): Promise<void> }[] = [];

  afterEach(async () => {
    while (serversToStop.length > 0) {
      const srv = serversToStop.pop();
      if (srv !== undefined) {
        await srv.stop();
      }
    }
  });

  it('valida paridad matemática exacta (< 1e-9) contra fixtures/primary_bmb_reference.json sin mutar entradas', () => {
    const fixture = loadReferenceFixture();

    for (const c of fixture.dlrCases) {
      const inputSnapshot = JSON.stringify(c.input);
      const actual = computeDlrContractMetrics(c.input);
      expect(JSON.stringify(c.input)).toBe(inputSnapshot);

      expect(actual.priceBasis).toBe(c.expected.priceBasis);
      expect(actual.spotSource).toBe(c.expected.spotSource);
      expectCloseOrNaN(actual.referencePrice, c.expected.referencePrice);
      expectCloseOrNaN(actual.spotUsed, c.expected.spotUsed);
      expectCloseOrNaN(actual.maturityUtcSec, c.expected.maturityUtcSec, 0);
      expectCloseOrNaN(actual.days, c.expected.days, 0);
      expectCloseOrNaN(actual.devalDirectaPct, c.expected.devalDirectaPct);
      expectCloseOrNaN(actual.tnaImplicitaPct, c.expected.tnaImplicitaPct);
      expectCloseOrNaN(actual.teaImplicitaPct, c.expected.teaImplicitaPct);
      expectCloseOrNaN(actual.temImplicitaPct, c.expected.temImplicitaPct);
    }

    for (const c of fixture.l2Cases) {
      const bidsSnapshot = JSON.stringify(c.input.bids);
      const asksSnapshot = JSON.stringify(c.input.asks);
      const actual = computeOrderBookL2Metrics(c.input.bids, c.input.asks);
      expect(JSON.stringify(c.input.bids)).toBe(bidsSnapshot);
      expect(JSON.stringify(c.input.asks)).toBe(asksSnapshot);

      expectCloseOrNaN(actual.bestBid, c.expected.bestBid);
      expectCloseOrNaN(actual.bestAsk, c.expected.bestAsk);
      expectCloseOrNaN(actual.mid, c.expected.mid);
      expectCloseOrNaN(actual.spread, c.expected.spread);
      expectCloseOrNaN(actual.spreadPct, c.expected.spreadPct);
      expectCloseOrNaN(actual.bidDepthSize, c.expected.bidDepthSize);
      expectCloseOrNaN(actual.askDepthSize, c.expected.askDepthSize);
      expectCloseOrNaN(actual.bidDepthNotional, c.expected.bidDepthNotional);
      expectCloseOrNaN(actual.askDepthNotional, c.expected.askDepthNotional);
      expectCloseOrNaN(actual.vwapBid5, c.expected.vwapBid5);
      expectCloseOrNaN(actual.vwapAsk5, c.expected.vwapAsk5);
      expectCloseOrNaN(actual.vwapBook5, c.expected.vwapBook5);
      expectCloseOrNaN(actual.obi5, c.expected.obi5);
    }

    for (const c of fixture.caucionCases) {
      const tea = computeCaucionTeaEffectivePct(c.input.tnaPct, c.input.termDays);
      const spreadBps = computeSpreadVsBadlarBps(c.input.tnaPct, c.input.badlarTnaPct);
      expectCloseOrNaN(tea, c.expected.teaEffectivePct);
      expectCloseOrNaN(spreadBps, c.expected.spreadVsBadlarBps);
    }
  });

  it('autentica POST /auth/getToken, renueva < 24h, descarga DLR/*, MERV depth=5, getPositions, accountReport y redime en 401', async () => {
    let nowMs = Date.UTC(2026, 10, 14, 21, 0, 0);
    let authCalls = 0;
    let firstCfi401Done = false;

    const client = new PrimaryRofexClient({
      env: TEST_ENV,
      nowMsFn: () => nowMs,
      fetchFn: async (url, init) => {
        await Promise.resolve();
        if (url.endsWith('/auth/getToken')) {
          authCalls += 1;
          expect(init?.method).toBe('POST');
          expect(init?.headers?.['X-Username']).toBe(TEST_ENV.PRIMARY_USERNAME);
          expect(init?.headers?.['X-Password']).toBe(TEST_ENV.PRIMARY_PASSWORD);
          return makeJsonResp(
            { status: 'OK' },
            200,
            { 'x-auth-token': `${TEST_TOKEN}_${String(authCalls)}` },
          );
        }

        const tokenHeader = init?.headers?.['X-Auth-Token'] ?? '';
        expect(tokenHeader.startsWith(TEST_TOKEN)).toBe(true);

        if (url.includes('/rest/instruments/byCFICode?CFICode=FXXXSX')) {
          if (!firstCfi401Done) {
            firstCfi401Done = true;
            return makeJsonResp({ status: 'ERROR', description: 'Expired' }, 401);
          }
          return makeJsonResp({
            status: 'OK',
            instruments: [
              { marketId: 'ROFX', symbol: 'DLR/NOV26' },
              { marketId: 'ROFX', symbol: 'DLR/ABR27' },
              { marketId: 'ROFX', symbol: 'DLR/DIC26M' },
            ],
          });
        }

        if (url.includes('/rest/instruments/bySegment?MarketSegmentID=DDF&MarketID=ROFX')) {
          return makeJsonResp({
            status: 'OK',
            instruments: [
              { marketId: 'ROFX', symbol: 'DLR/NOV26' },
              { marketId: 'ROFX', symbol: 'DLR/SPOT' },
              { marketId: 'ROFX', symbol: 'DLR/NOV26 1570 C' },
            ],
          });
        }

        if (url.includes('/rest/instruments/bySegment?MarketSegmentID=MERV&MarketID=ROFX')) {
          return makeJsonResp({
            status: 'OK',
            instruments: [
              { marketId: 'ROFX', symbol: 'MERV - XMEV - GGAL - 24hs' },
              { marketId: 'ROFX', symbol: 'MERV - XMEV - SUPV- 24hs' },
            ],
          });
        }

        if (url.includes('/rest/instruments/detail')) {
          if (url.includes('DLR%2FNOV26')) {
            return makeJsonResp({
              status: 'OK',
              instrument: {
                instrumentId: { marketId: 'ROFX', symbol: 'DLR/NOV26' },
                maturityDate: '20261130',
                contractMultiplier: 1000.0,
                minPriceIncrement: 0.5,
              },
            });
          }
          if (url.includes('DLR%2FABR27')) {
            return makeJsonResp({
              status: 'OK',
              instrument: {
                instrumentId: { marketId: 'ROFX', symbol: 'DLR/ABR27' },
                maturityDate: '20270429',
                contractMultiplier: 1000.0,
                minPriceIncrement: 0.5,
              },
            });
          }
          return makeJsonResp({ status: 'OK', instrument: { maturityDate: '20261230', contractMultiplier: 100.0 } });
        }

        if (url.includes('/rest/marketdata/get')) {
          if (url.includes('DLR%2FNOV26%201570%20C')) {
            return makeJsonResp({
              status: 'OK',
              marketData: { BI: [], OF: [], LA: null, SE: { price: 18.5, date: 1794528000000 }, OI: { size: 420 }, NV: 15 },
              depth: 5,
            });
          }
          if (url.includes('DLR%2FNOV26')) {
            return makeJsonResp({
              status: 'OK',
              marketData: {
                BI: [],
                OF: [],
                LA: null,
                SE: { price: 1562.5, size: null, date: 1794528000000 },
                OI: { size: 184500 },
                NV: 0,
              },
              depth: 5,
            });
          }
          if (url.includes('DLR%2FABR27')) {
            return makeJsonResp({
              status: 'OK',
              marketData: {
                BI: [{ price: 1718.0, size: 120 }],
                OF: [{ price: 1722.0, size: 80 }],
                LA: null,
                SE: { price: 1720.0, date: 1794528000000 },
                OI: { size: 22100 },
                NV: 430,
              },
              depth: 5,
            });
          }
          if (url.includes('DLR%2FSPOT')) {
            return makeJsonResp({
              status: 'OK',
              marketData: { LA: { price: 1445.0, size: 10, date: 1794528000000 }, BI: [], OF: [], SE: { price: 1445.0 } },
              depth: 5,
            });
          }
          if (url.includes('GGAL')) {
            return makeJsonResp({
              status: 'OK',
              marketData: {
                BI: [
                  { price: 7190, size: 1200 },
                  { price: 7175, size: 850 },
                  { price: 7160, size: 400 },
                  { price: 7150, size: 500 },
                  { price: 7120, size: 2500 },
                ],
                OF: [
                  { price: 7205, size: 600 },
                  { price: 7210, size: 700 },
                  { price: 7220, size: 900 },
                  { price: 7240, size: 1500 },
                  { price: 7260, size: 300 },
                ],
                LA: { price: 7195, size: 100, date: 1794690000000 },
                NV: 54000,
              },
              depth: 5,
            });
          }
          return makeJsonResp({ status: 'OK', marketData: { BI: [], OF: [], LA: null, SE: null, NV: 0 }, depth: 5 });
        }

        if (url.includes('/rest/risk/position/getPositions/REM22710')) {
          return makeJsonResp({
            status: 'OK',
            positions: [
              {
                instrument: { marketId: 'ROFX', symbol: 'DLR/NOV26' },
                tradingSymbol: 'DLR/NOV26',
                buySize: 10,
                sellSize: 0,
                originalBuyPrice: 1540.0,
                originalSellPrice: null,
                totalDailyDiff: 22500.0,
                totalDiff: 22500.0,
              },
            ],
          });
        }

        if (url.includes('/rest/risk/accountReport/REM22710')) {
          return makeJsonResp({
            status: 'OK',
            accountData: {
              accountName: 'REM22710',
              marketMember: 'PrimaryVenture',
              collateral: 0,
              margin: 1500000,
              availableToCollateral: 158500000,
              lastCalculation: 1794700000000,
              detailedAccountReports: {
                '0': {
                  currencyBalance: {
                    detailedCurrencyBalance: {
                      ARS: { consumed: 1500000.0, available: 158500000.0 },
                      'USD D': { consumed: 0.0, available: 2500.0 },
                    },
                  },
                  availableToOperate: {
                    cash: { totalCash: 160000000.0, detailedCash: { ARS: 160000000.0 } },
                    pendingMovements: 0.0,
                  },
                },
              },
            },
          });
        }

        return makeJsonResp({ status: 'ERROR', description: `Unhandled ${url}` }, 404);
      },
    });

    const dlrRes = await client.getDlrFuturesAndDerivatives({
      asOfUtcSec: Math.floor(nowMs / 1_000),
      a3500: 1445.0,
      forceRefresh: true,
    });
    expect(authCalls).toBe(2); // 1 inicial + 1 retry ante 401
    expect(dlrRes.error).toBeNull();
    expect(dlrRes.spotSource).toBe('A3500_BCRA');

    const nov = dlrRes.contracts.find((c) => c.contract === 'DLR/NOV26');
    expect(nov?.category).toBe('OUTRIGHT');
    expect(nov?.priceBasis).toBe('SETTLEMENT_EOD');
    expect(nov?.price).toBe(1562.5);
    expect(nov?.openInterest).toBe(184500);
    expect(nov?.devalDirectaPct).not.toBeNull();

    const abr = dlrRes.contracts.find((c) => c.contract === 'DLR/ABR27');
    expect(abr?.priceBasis).toBe('MID');
    expect(abr?.price).toBe(1720.0);

    // Token < 24h reuse then proactive refresh after 23h
    await client.getAuthToken(false);
    expect(authCalls).toBe(2);
    nowMs += 23 * 60 * 60 * 1_000 + 1;
    await client.getAuthToken(false);
    expect(authCalls).toBe(3);

    // MERV 5-level book parsing (including GGAL 5 levels and SUPV- quirks)
    const ggalBook = await client.getMervOrderBook5Levels('GGAL', true);
    expect(ggalBook?.source).toBe('PRIMARY_MERV');
    expect(ggalBook?.marketState).toBe('LIVE');
    expect(ggalBook?.bids.length).toBe(5);
    expect(ggalBook?.asks.length).toBe(5);
    expect(ggalBook?.bestBid).toBe(7190);
    expect(ggalBook?.bestAsk).toBe(7205);
    expect(ggalBook?.spreadArs).toBe(15);

    const supvBook = await client.getMervOrderBook5Levels('SUPV', true);
    expect(supvBook?.marketSymbol).toBe('MERV - XMEV - SUPV- 24hs');
    expect(supvBook?.marketState).toBe('WEEKEND_CLOSED');

    // Account positions & report
    const acct = await client.getAccountPositionsAndReport();
    expect(acct.summary.status).toBe('OK');
    expect(acct.summary.accountLabel).toBe('REM22710');
    expect(acct.summary.cashTotalArs).toBe(160000000);
    expect(acct.positions.length).toBe(1);
    expect(acct.positions[0]?.symbol).toBe('DLR/NOV26');
    expect(acct.positions[0]?.netSize).toBe(10);

    // Safe health NEVER exposes secrets/token
    const healthJson = JSON.stringify(client.getSafeHealthStatus());
    expect(healthJson).not.toContain(TEST_ENV.PRIMARY_PASSWORD);
    expect(healthJson).not.toContain(TEST_ENV.PRIMARY_USERNAME);
    expect(healthJson).not.toContain(TEST_TOKEN);
  });

  it('envía suscripción WS type="smd" con depth=5 e ingiere ticks L2 en vivo sin exponer X-Auth-Token', async () => {
    const sentPayloads: string[] = [];
    const messageHandlers: ((data: unknown) => void)[] = [];
    let capturedHeaders: Readonly<Record<string, string>> = {};

    const mockWsFactory = (_url: string, headers: Readonly<Record<string, string>>): PrimaryWsLike => {
      capturedHeaders = headers;
      const closeHandlers: (() => void)[] = [];
      const onFn = ((
        event: 'open' | 'message' | 'error' | 'close',
        listener: (...args: unknown[]) => void,
      ) => {
        if (event === 'open') {
          queueMicrotask(() => {
            listener();
          });
        } else if (event === 'message') {
          messageHandlers.push(listener);
        } else if (event === 'close') {
          closeHandlers.push(listener);
        }
        return sock;
      }) as PrimaryWsLike['on'];
      const sock: PrimaryWsLike = {
        readyState: 1,
        send(data: string) {
          sentPayloads.push(data);
        },
        close() {
          for (const cb of closeHandlers) {
            cb();
          }
        },
        on: onFn,
      };
      return sock;
    };

    const client = new PrimaryRofexClient({
      env: TEST_ENV,
      wsFactory: mockWsFactory,
      fetchFn: (url) => {
        if (url.endsWith('/auth/getToken')) {
          return Promise.resolve(makeJsonResp({ status: 'OK' }, 200, { 'x-auth-token': TEST_TOKEN }));
        }
        return Promise.resolve(makeJsonResp({ status: 'OK', marketData: { BI: [], OF: [] } }));
      },
    });

    await client.connectAndSubscribeWs([{ marketId: 'ROFX', symbol: 'DLR/NOV26' }], 5);
    expect(capturedHeaders['X-Auth-Token']).toBe(TEST_TOKEN);
    expect(sentPayloads.length).toBe(1);
    const firstPayload = sentPayloads[0];
    expect(firstPayload).toBeDefined();
    const subMsg = JSON.parse(firstPayload ?? '{}') as { type: string; depth: number; entries: string[] };
    expect(subMsg.type).toBe('smd');
    expect(subMsg.depth).toBe(5);
    expect(subMsg.entries).toContain('BI');
    expect(subMsg.entries).toContain('OF');

    expect(messageHandlers.length).toBeGreaterThan(0);
    for (const h of messageHandlers) {
      h(
        JSON.stringify({
          type: 'Md',
          timestamp: 1794695000000,
          instrumentId: { marketId: 'ROFX', symbol: 'DLR/NOV26' },
          marketData: {
            BI: [{ price: 1561.0, size: 50 }],
            OF: [{ price: 1563.5, size: 30 }],
            LA: { price: 1562.0, size: 5, date: 1794695000000 },
          },
        }),
      );
    }

    const md = await client.getMarketData('DLR/NOV26', 'ROFX', 5, true);
    expect(md?.last).toBe(1562.0);
    expect(md?.bids[0]).toEqual({ price: 1561.0, size: 50 });
    expect(client.getSafeHealthStatus().wsConnected).toBe(true);
    client.closeWebSocket();
    expect(client.getSafeHealthStatus().wsConnected).toBe(false);
  });

  it('degrada explícitamente BMB Bridge y herramientas Python cuando falta pyhomebroker o BMB_PASSWORD, y usa curva BMB cuando está READY', async () => {
    // 1) Sin BMB_PASSWORD -> DISABLED_NO_PASSWORD sin tocar red
    let networkCalled = false;
    const noPassClient = new BmbBridgeClient({
      env: { ...TEST_ENV, BMB_PASSWORD: '' },
      fetchFn: () => {
        networkCalled = true;
        return Promise.resolve(makeJsonResp({}));
      },
    });
    const noPassSnap = await noPassClient.getSnapshot();
    expect(networkCalled).toBe(false);
    expect(noPassSnap.health.status).toBe('DISABLED_NO_PASSWORD');

    // 2) Puente respondiendo MISSING_DEPENDENCY -> fallback BCRA/Lecap sin puntas falsas
    const missingDepClient = new BmbBridgeClient({
      env: TEST_ENV,
      fetchFn: () =>
        Promise.resolve(
          makeJsonResp({
            status: 'MISSING_DEPENDENCY',
            pyhomebrokerInstalled: false,
            passwordConfigured: true,
            error: 'pyhomebroker no instalado',
            cauciones: [],
            orderBooksBySymbol: {},
            options: [],
          }),
        ),
    });
    const missingSnap = await missingDepClient.getSnapshot(undefined, 34.0);
    expect(missingSnap.health.status).toBe('MISSING_DEPENDENCY');
    expect(missingSnap.health.pyhomebrokerInstalled).toBe(false);

    const fallbackCurve = buildCaucionesLiquidityCurve({
      bmbSnapshot: missingSnap,
      tpmTna: 32.0,
      badlarTna: 34.5,
      tamarTna: 35.2,
      plazoFijoTna: 33.0,
      notes: [
        {
          ticker: 'S30N6',
          name: 'Letra/Bono S30N6',
          kind: 'LECAP_BONCAP',
          price: 104.2,
          bid: null,
          ask: null,
          deltaPct: null,
          volumeM: null,
          source: 'DATA912',
        },
      ],
      nowSec: 1794695000,
    });
    expect(fallbackCurve.status).toBe('REFERENCE_BCRA_LECAP');
    expect(fallbackCurve.rows.length).toBe(8);
    expect(fallbackCurve.rows[0]?.bidTna).toBeNull();
    expect(fallbackCurve.rows[0]?.askTna).toBeNull();
    expect(fallbackCurve.rows[0]?.volumeArs).toBeNull();
    expect(fallbackCurve.rows[0]?.source).toBe('BCRA_LECAP_REF');

    // 3) Puente READY con cauciones vivas -> prioriza BMB_HOMEBROKER
    const readyClient = new BmbBridgeClient({
      env: TEST_ENV,
      fetchFn: () =>
        Promise.resolve(
          makeJsonResp({
            status: 'READY',
            brokerId: 153,
            accountLabel: 'BMB 266758',
            pyhomebrokerInstalled: true,
            passwordConfigured: true,
            asOfUtcSec: 1794695000,
            cauciones: [
              {
                symbol: 'PESOS 1D',
                termDays: 1,
                currency: 'ARS',
                tnaWeighted: 32.5,
                bidTna: 32.2,
                askTna: 32.8,
                turnoverArs: 8500000000,
              },
            ],
            orderBooksBySymbol: {},
            options: [],
          }),
        ),
    });
    const liveSnap = await readyClient.getSnapshot(undefined, 34.5);
    const liveCurve = buildCaucionesLiquidityCurve({
      bmbSnapshot: liveSnap,
      tpmTna: 32.0,
      badlarTna: 34.5,
      tamarTna: 35.2,
      plazoFijoTna: 33.0,
      notes: [],
      nowSec: 1794695000,
    });
    expect(liveCurve.status).toBe('LIVE_BMB');
    expect(liveCurve.rows[0]?.bidTna).toBe(32.2);
    expect(liveCurve.rows[0]?.askTna).toBe(32.8);
    expect(liveCurve.rows[0]?.volumeArs).toBe(8500000000);

    // 4) Ejecuta el script Python real bmb_homebroker_bridge.py --check-status sin filtrar secretos
    const pyCheck = spawnSync('python', ['tools/bmb_homebroker_bridge.py', '--check-status'], {
      cwd: process.cwd(),
      env: { ...process.env, ...TEST_ENV },
      encoding: 'utf8',
    });
    expect(pyCheck.status).toBe(0);
    expect(pyCheck.stdout).not.toContain(TEST_ENV.BMB_PASSWORD);
    expect(pyCheck.stdout).not.toContain(TEST_ENV.BMB_DNI);
    const pyStatus = JSON.parse(pyCheck.stdout) as { brokerId: number; status: string };
    expect(pyStatus.brokerId).toBe(153);
    expect(['MISSING_DEPENDENCY', 'DISCONNECTED']).toContain(pyStatus.status);
  });

  it('expone /api/ar/positions y estado redactado en /api/health sin filtrar nunca credenciales ni X-Auth-Token aunque el proveedor las devuelva en un error', async () => {
    const arRuntime = new ArgentinaMarketRuntime({
      env: TEST_ENV,
      minData912IntervalMs: 0,
      fetchFn: (url) => {
        if (url.endsWith('/auth/getToken')) {
          return Promise.resolve(makeJsonResp({ status: 'OK' }, 200, { 'x-auth-token': TEST_TOKEN }));
        }
        // Simulamos un error upstream que maliciosamente refleja credenciales y token
        if (url.includes('/rest/risk/')) {
          return Promise.resolve(
            makeJsonResp(
              {
                status: 'ERROR',
                description: `Failed auth user=${TEST_ENV.PRIMARY_USERNAME} pass=${TEST_ENV.PRIMARY_PASSWORD} tok=${TEST_TOKEN} dni=${TEST_ENV.BMB_DNI} bmb=${TEST_ENV.BMB_PASSWORD}`,
              },
              500,
            ),
          );
        }
        if (url.startsWith('http://127.0.0.1:18788')) {
          return Promise.reject(
            new Error(`ECONNREFUSED with bmb=${TEST_ENV.BMB_PASSWORD} dni=${TEST_ENV.BMB_DNI}`),
          );
        }
        return Promise.resolve(makeJsonResp([], 200));
      },
    });

    const srv = createHttpWsServer({
      host: '127.0.0.1',
      port: 0,
      env: TEST_ENV,
      arRuntime,
      startRuntimeWs: false,
      enableBackgroundWarmup: false,
    });
    serversToStop.push(srv);
    const addr = await srv.start();
    const baseUrl = `http://${addr.host}:${String(addr.port)}`;

    const posRes = await fetch(`${baseUrl}/api/ar/positions`);
    expect(posRes.status).toBe(200);
    const posText = await posRes.text();
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthText = await healthRes.text();

    for (const secretValue of [
      TEST_ENV.PRIMARY_PASSWORD,
      TEST_ENV.PRIMARY_USERNAME,
      TEST_ENV.BMB_PASSWORD,
      TEST_ENV.BMB_DNI,
      TEST_ENV.BMB_USERNAME,
      TEST_TOKEN,
    ]) {
      expect(posText).not.toContain(secretValue);
      expect(healthText).not.toContain(secretValue);
    }

    const parsedHealth = JSON.parse(healthText) as {
      ok: boolean;
      connectors: {
        primaryRofex: { configured: boolean; authenticated: boolean; accountLabel: string };
        bullMarket: { status: string; accountLabel: string };
      };
    };
    expect(parsedHealth.ok).toBe(true);
    expect(parsedHealth.connectors.primaryRofex.configured).toBe(true);
    expect(parsedHealth.connectors.primaryRofex.authenticated).toBe(true);
    expect(parsedHealth.connectors.primaryRofex.accountLabel).toBe('REM22710');
    expect(parsedHealth.connectors.bullMarket.status).toBe('OFFLINE');
    expect(parsedHealth.connectors.bullMarket.accountLabel).toBe('BMB 266758');
  });
});
