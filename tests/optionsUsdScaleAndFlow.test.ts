/**
 * Pieza 36: escala USD exacta, verticales US, fusión de flujo Massive/Tradier,
 * selección de vencimientos líquidos y desacoplamiento ORATS de la cadena base.
 *
 * Referencia independiente: fixtures/options_usd_scale_flow_reference.json
 * generada por tools/gen_options_usd_scale_flow_fixture.py (math.erf).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeVerticalSpreadMetrics } from '../src/core/options/verticalSpreads.js';
import {
  createHttpWsServer,
  type HttpWsServerHandle,
} from '../src/server/httpWsServer.js';
import {
  MarketRuntime,
  OPTIONS_UNDERLYING_UNIVERSE,
  selectUsOptionExpirations,
  type TerminalSnapshotResponse,
  type UsVolSurfaceResponse,
} from '../src/server/marketRuntime.js';
import {
  fetchTradierOptionChain,
  parseOccEncodedStrike,
  overlayTradierChainOnCanonicalContracts,
  type TradierConfig,
  type TradierOptionChainResult,
} from '../src/server/tradierAdapter.js';
import { OratsHybridClient } from '../src/server/oratsHybridClient.js';
import type { FetchFn } from '../src/data/types.js';
import type {
  OptionDaySummary,
  OptionGreeks,
  OptionLastQuote,
  OptionLastTrade,
  OptionSnapshotContract,
} from '../src/data/optionsTypes.js';

interface VerticalFixture {
  readonly valid: boolean;
  readonly width: number;
  readonly long_price: number;
  readonly short_price: number;
  readonly long_uses_eod_ref: boolean;
  readonly short_uses_eod_ref: boolean;
  readonly debit: number;
  readonly max_profit: number;
  readonly reward_risk_ratio: number;
  readonly breakeven: number;
  readonly breakeven_dist_pct: number;
  readonly prob_at_breakeven_pct: number;
  readonly edge_pct: number;
}

interface SelectionFixture {
  readonly default_expiration_date: string | null;
  readonly prefetch_expiration_dates: readonly string[];
  readonly reason: string;
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures', 'options_usd_scale_flow_reference.json'), 'utf-8'),
) as {
  readonly qqq: {
    readonly spot: number;
    readonly occ_contract_multiplier: number;
    readonly expected_strikes_usd_1x: readonly number[];
    readonly atm_iv_dec: number;
    readonly days_to_expiry: number;
    readonly rate_dec: number;
    readonly bull_call_spread: VerticalFixture;
    readonly bear_put_spread: VerticalFixture;
  };
  readonly flow_fusion: {
    readonly massive_volume: number;
    readonly massive_open_interest: number;
    readonly tradier_volume: number;
    readonly tradier_open_interest: number;
    readonly expected_volume: number;
    readonly expected_open_interest: number;
    readonly larger_tradier_volume: number;
    readonly expected_volume_after_larger_tradier: number;
  };
  readonly occ_strike_validation: readonly {
    readonly occ_symbol: string;
    readonly raw_strike: number;
    readonly accepted: boolean;
  }[];
  readonly expiry_selection: {
    readonly qqq: SelectionFixture;
    readonly prefetch: SelectionFixture;
    readonly requested_missing: SelectionFixture;
  };
  readonly orats_ivrank: {
    readonly row: Record<string, string | number>;
  };
};

function etDateTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  isEdt = false,
): number {
  const offsetHours = isEdt ? 4 : 5;
  return Date.UTC(year, month - 1, day, hour + offsetHours, minute, 0);
}

function expectClose(actual: number, expected: number, label: string): void {
  expect(actual, label).not.toBeNaN();
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(1e-9);
}

describe('Pieza 36 — escala USD, spreads y flujo', () => {
  it('calcula Bull Call y Bear Put de QQQ en USD 1x con la referencia Python', () => {
    const bull = computeVerticalSpreadMetrics({
      side: 'CALL',
      longLeg: { strike: 660, bid: 8.0, ask: 8.2, last: 8.1 },
      shortLeg: { strike: 665, bid: 4.1, ask: 4.3, last: 4.2 },
      spot: fixture.qqq.spot,
      daysToExpiry: fixture.qqq.days_to_expiry,
      rateDec: fixture.qqq.rate_dec,
      atmIvDec: fixture.qqq.atm_iv_dec,
    });
    const bear = computeVerticalSpreadMetrics({
      side: 'PUT',
      longLeg: { strike: 665, bid: 1.9, ask: 2.1, last: 2.0 },
      shortLeg: { strike: 660, bid: 0.35, ask: 0.55, last: 0.45 },
      spot: fixture.qqq.spot,
      daysToExpiry: fixture.qqq.days_to_expiry,
      rateDec: fixture.qqq.rate_dec,
      atmIvDec: fixture.qqq.atm_iv_dec,
    });

    expect(bull.valid).toBe(true);
    expect(bear.valid).toBe(true);
    expectClose(bull.debit, fixture.qqq.bull_call_spread.debit, 'bull.debit');
    expectClose(bull.maxProfit, fixture.qqq.bull_call_spread.max_profit, 'bull.maxProfit');
    expectClose(bull.breakeven, fixture.qqq.bull_call_spread.breakeven, 'bull.breakeven');
    expectClose(
      bull.probAtBreakevenPct,
      fixture.qqq.bull_call_spread.prob_at_breakeven_pct,
      'bull.prob',
    );
    expectClose(bull.edgePct, fixture.qqq.bull_call_spread.edge_pct, 'bull.edge');
    expectClose(bear.debit, fixture.qqq.bear_put_spread.debit, 'bear.debit');
    expectClose(bear.maxProfit, fixture.qqq.bear_put_spread.max_profit, 'bear.maxProfit');
    expectClose(bear.breakeven, fixture.qqq.bear_put_spread.breakeven, 'bear.breakeven');
    expectClose(
      bear.probAtBreakevenPct,
      fixture.qqq.bear_put_spread.prob_at_breakeven_pct,
      'bear.prob',
    );
    expectClose(bear.edgePct, fixture.qqq.bear_put_spread.edge_pct, 'bear.edge');
    expect(bull.width).toBe(5);
    expect(bear.width).toBe(5);
  });

  it('valida strikes OCC sin corregir escala y descarta inconsistencias', () => {
    for (const caseRow of fixture.occ_strike_validation) {
      const encoded = parseOccEncodedStrike(caseRow.occ_symbol);
      const accepted =
        Number.isFinite(encoded) && Math.abs(encoded - caseRow.raw_strike) <= 1e-6;
      expect(accepted, `${caseRow.occ_symbol}/${String(caseRow.raw_strike)}`).toBe(caseRow.accepted);
    }
  });

  it('fusiona volumen/OI sin pisar Massive con 0 o NaN de Tradier', () => {
    const nowSec = Math.floor(Date.UTC(2025, 2, 10, 18, 45) / 1_000);
    const massive = makeSnapshotContract({
      ticker: 'O:QQQ260331C00660000',
      contractType: 'call',
      strike: 660,
      expirationDate: '2025-03-31',
      nowSec,
      volume: fixture.flow_fusion.massive_volume,
      openInterest: fixture.flow_fusion.massive_open_interest,
      bid: 8.0,
      ask: 8.2,
    });
    const tradier = [
      {
        occSymbol: 'QQQ260331C00660000',
        underlying: 'QQQ',
        contractType: 'call' as const,
        strike: 660,
        expirationDate: '2025-03-31',
        expirationTime: massive.expirationTime,
        bid: 8.01,
        bidSize: 10,
        ask: 8.21,
        askSize: 12,
        volume: fixture.flow_fusion.tradier_volume,
        openInterest: fixture.flow_fusion.tradier_open_interest,
        last: 8.1,
        close: 8.1,
        greeks: { delta: 0.55, gamma: 0.01, theta: -0.03, vega: 0.12, rho: 0, phi: 0, bidIv: 0.2, midIv: 0.2, askIv: 0.21, smvVol: 0.2, updatedAtUtcSec: nowSec },
        asOfUtcSec: nowSec,
        provider: 'TRADIER' as const,
        sharesPerContract: 100 as const,
      },
    ];

    const first = overlayTradierChainOnCanonicalContracts([massive], tradier, { nowSec });
    expect(first.contracts[0]?.day.volume).toBe(fixture.flow_fusion.expected_volume);
    expect(first.contracts[0]?.openInterest).toBe(fixture.flow_fusion.expected_open_interest);
    expect(first.contracts[0]?.strikePrice).toBe(660);
    expect(first.summary.overlaidBidAsk).toBe(1);

    const tradierBase = tradier[0];
    if (tradierBase === undefined) {
      throw new Error('Tradier fixture contract missing');
    }
    const largerTradier = [{ ...tradierBase, volume: fixture.flow_fusion.larger_tradier_volume }];
    const second = overlayTradierChainOnCanonicalContracts([massive], largerTradier, { nowSec });
    expect(second.contracts[0]?.day.volume).toBe(
      fixture.flow_fusion.expected_volume_after_larger_tradier,
    );
  });

  it('selecciona 14–45 DTE completo y no cae en 0–4 DTE incompleto', () => {
    const qqqExpected = fixture.expiry_selection.qqq as {
      readonly default_expiration_date: string;
      readonly prefetch_expiration_dates: readonly string[];
      readonly reason: string;
    };
    const nowSec = Math.floor(Date.UTC(2025, 2, 10, 18, 45) / 1_000);
    const incomplete = makeSnapshotContract({
      ticker: 'O:QQQ250312C00663000',
      contractType: 'call',
      strike: 663,
      expirationDate: '2025-03-12',
      nowSec,
      bid: 2,
      ask: 2.2,
    });
    const selection = selectUsOptionExpirations([incomplete], fixture.qqq.spot, nowSec);
    expect(selection.defaultExpirationDate).toBeNull();
    expect(selection.reason).toBe('NO_COMPLETE_ATM_OPTION_EXPIRY');

    const full = buildSelectionContracts('2025-03-31', 21, nowSec, fixture.qqq.spot);
    const selectionFull = selectUsOptionExpirations(full, fixture.qqq.spot, nowSec);
    expect(selectionFull.defaultExpirationDate).toBe(qqqExpected.default_expiration_date);
    expect(selectionFull.reason).toBe(qqqExpected.reason);

    const prefetchCase = fixture.expiry_selection.prefetch as {
      readonly default_expiration_date: string;
      readonly prefetch_expiration_dates: readonly string[];
    };
    const threeExpiries = [
      ...buildSelectionContracts('2026-01-05', 3, nowSec, 100),
      ...buildSelectionContracts('2026-01-23', 21, nowSec, 100),
      ...buildSelectionContracts('2026-02-20', 49, nowSec, 100),
    ];
    const selectionPrefetch = selectUsOptionExpirations(threeExpiries, 100, nowSec);
    expect(selectionPrefetch.defaultExpirationDate).toBe(prefetchCase.default_expiration_date);
    expect(selectionPrefetch.prefetchExpirationDates).toEqual(prefetchCase.prefetch_expiration_dates);
  });

  it('normaliza la cadena Tradier manteniendo USD 1x y multiplicador OCC 100', async () => {
    const tradierConfig: TradierConfig = {
      accessToken: 'test-token',
      tokenEnvName: 'TRADIER_ACCESS_TOKEN',
      apiEnv: 'prod',
      restBaseUrl: 'https://api.tradier.com/v1',
      wsBaseUrl: 'wss://ws.tradier.com/v1/markets/events',
      configured: true,
    };
    const body = {
      options: {
        option: [
          {
            symbol: 'QQQ260331C00660000',
            option_type: 'call',
            strike: 660,
            root_symbols: 'QQQ',
            expiration_date: '2026-03-31',
            bid: 8.0,
            bid_size: 3,
            ask: 8.2,
            ask_size: 4,
            volume: 0,
            open_interest: 0,
            last: 8.1,
            close_price: 8.1,
            greeks: {
              delta: 0.55,
              gamma: 0.01,
              theta: -0.03,
              vega: 0.12,
              mid_iv: 0.2,
              smv_vol: 0.2,
              updated_at: '2026-03-10T14:45:00.000Z',
            },
          },
        ],
      },
    };
    const result: TradierOptionChainResult = await fetchTradierOptionChain(
      'QQQ',
      '2026-03-31',
      {
        config: tradierConfig,
        httpFn: () =>
          Promise.resolve({ ok: true, status: 200, text: JSON.stringify(body) }),
        nowMsFn: () => Date.UTC(2026, 2, 10, 18, 45),
        secrets: ['test-token'],
      },
    );
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]?.strike).toBe(660);
    expect(result.contracts[0]?.bid).toBe(8.0);
    expect(result.contracts[0]?.ask).toBe(8.2);
    expect(result.contracts[0]?.sharesPerContract).toBe(100);
  });
});

describe('Pieza 36 — /api/snapshot QQQ sin ORATS y /api/us/vol-surface on-demand', () => {
  const activeServers: HttpWsServerHandle[] = [];

  afterEach(async () => {
    for (const server of activeServers.splice(0, activeServers.length)) {
      await server.stop();
    }
  });

  it('sirve QQQ en escala USD 1x, no llama ORATS y expone vol surface solo on-demand', async () => {
    const fixedNowMs = etDateTimeToUtcMs(2025, 3, 10, 14, 45, true);
    const fixedNowSec = Math.floor(fixedNowMs / 1_000);
    const qqqSpot = fixture.qqq.spot;
    const qqqExpiry = '2025-03-31';
    const oratsUrls: string[] = [];

    const oratsClient = new OratsHybridClient({
      env: { ORATS_API_KEY: 'orats-test-key' },
      nowMsFn: () => fixedNowMs,
      cacheTtlMs: 600_000,
      secrets: ['orats-test-key'],
      fetchFn: (url) => {
        oratsUrls.push(url);
        if (url.includes('/cores')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: [
                  {
                    ticker: 'QQQ',
                    tradeDate: '2025-03-10',
                    stockPrice: qqqSpot,
                    smvVol: 0.22,
                    iv10d: 0.21,
                    iv20d: 0.215,
                    iv30d: 0.22,
                    iv60d: 0.225,
                    iv90d: 0.23,
                    iv6m: 0.235,
                    iv1y: 0.24,
                    exErnIv10d: 0.2,
                    exErnIv20d: 0.205,
                    exErnIv30d: 0.21,
                    exErnIv60d: 0.215,
                    exErnIv90d: 0.22,
                    fwd30_20: 0.22,
                    fwd60_30: 0.225,
                    fwd90_60: 0.23,
                    impliedMove: 0.035,
                    annIdiv: 1.2,
                    impliedNextDiv: 0.004,
                    borrow30: 0.002,
                    yieldRate: 0.005,
                  },
                ],
              }),
            text: () => Promise.resolve('{}'),
          });
        }
        if (url.includes('/strikes')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                data: fixture.qqq.expected_strikes_usd_1x.map((strike) => ({
                  strike,
                  expirDate: '2025-03-31',
                  dte: 21,
                  smvVol: 0.22,
                  callValue: 8,
                  putValue: 4,
                  callMidIv: 0.22,
                  putMidIv: 0.23,
                  delta: 0.4,
                  gamma: 0.01,
                  theta: -0.02,
                  vega: 0.1,
                })),
              }),
            text: () => Promise.resolve('{}'),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: [
                {
                  ticker: 'QQQ',
                  tradeDate: '2025-03-10',
                  iv: 22.0,
                  ivRank1m: 7.25,
                  ivPct1m: 9,
                  ivRank1y: 17.49,
                  ivPct1y: 12.75,
                  updatedAt: '2025-03-10T20:55:02Z',
                },
              ],
            }),
          text: () => Promise.resolve('{}'),
        });
      },
    });

    const runtime = new MarketRuntime({
      apiKey: 'massive-test-key',
      secrets: ['massive-test-key'],
      nowMsFn: () => fixedNowMs,
      enableWs: false,
      fetchFn: createOfflineMassiveFetch({ asOfUtcSec: fixedNowSec }),
      tradierConfig: {
        accessToken: 'tradier-test-token',
        tokenEnvName: 'TRADIER_ACCESS_TOKEN',
        apiEnv: 'prod',
        restBaseUrl: 'https://api.tradier.com/v1',
        wsBaseUrl: 'wss://ws.tradier.com/v1/markets/events',
        configured: true,
      },
      tradierChainFetchFn: (symbol, expiration) => {
        if (symbol !== 'QQQ' || expiration !== qqqExpiry) {
          return Promise.resolve({ contracts: [], provenance: emptyTradierProvenance(fixedNowSec) });
        }
        return Promise.resolve({
          contracts: [
            tradierNormalized('QQQ260331C00660000', 'call', 660, qqqExpiry, fixedNowSec, 8.0, 8.2),
            tradierNormalized('QQQ260331C00665000', 'call', 665, qqqExpiry, fixedNowSec, 4.1, 4.3),
            tradierNormalized('QQQ260331C00670000', 'call', 670, qqqExpiry, fixedNowSec, 1.5, 1.7),
            tradierNormalized('QQQ260331P00660000', 'put', 660, qqqExpiry, fixedNowSec, 0.35, 0.55),
            tradierNormalized('QQQ260331P00665000', 'put', 665, qqqExpiry, fixedNowSec, 1.9, 2.1),
            tradierNormalized('QQQ260331P00670000', 'put', 670, qqqExpiry, fixedNowSec, 4.8, 5.0),
          ],
          provenance: emptyTradierProvenance(fixedNowSec),
        });
      },
      oratsClient,
    });

    const server = createHttpWsServer({
      runtime,
      host: '127.0.0.1',
      port: 0,
      secrets: ['massive-test-key'],
      startRuntimeWs: false,
    });
    activeServers.push(server);
    const { host, port } = await server.start();
    const base = `http://${host}:${String(port)}`;

    const snapRes = await fetch(`${base}/api/snapshot?symbol=QQQ`);
    const snapText = await snapRes.text();
    expect(snapRes.status, snapText).toBe(200);
    expect(snapText).not.toContain('orats-test-key');
    const snap = JSON.parse(snapText) as TerminalSnapshotResponse;
    expect(snap.symbol).toBe('QQQ');
    expect(snap.optionsChain?.selectedExpirationDate).toBe(qqqExpiry);
    const serializedStrikes = [...new Set((snap.volSurfaceSummary?.contracts ?? []).map((c) => c.strike))];
    for (const expectedStrike of fixture.qqq.expected_strikes_usd_1x) {
      expect(serializedStrikes).toContain(expectedStrike);
      expect(serializedStrikes).not.toContain(expectedStrike * 10);
    }
    const call660 = snap.volSurfaceSummary?.contracts.find(
      (c) => c.contractType === 'call' && c.strike === 660,
    );
    expect(call660?.volume).toBe(fixture.flow_fusion.massive_volume);
    expect(call660?.openInterest).toBe(fixture.flow_fusion.massive_open_interest);

    const secondRes = await fetch(`${base}/api/snapshot?symbol=SPY`);
    expect(secondRes.status).toBe(200);
    expect(oratsUrls).toHaveLength(0);

    const volRes = await fetch(`${base}/api/us/vol-surface?symbol=QQQ`);
    const volText = await volRes.text();
    expect(volRes.status, volText).toBe(200);
    const vol = JSON.parse(volText) as UsVolSurfaceResponse;
    expect(vol.status).toBe('OK');
    expect(oratsUrls.filter((url) => url.includes('/cores')).length).toBe(1);
    expect(oratsUrls.filter((url) => url.includes('/strikes')).length).toBe(1);
    expect(oratsUrls.filter((url) => url.includes('/ivrank')).length).toBe(1);
    const ivRank = vol.ivRank;
    expect(ivRank.status).toBe('OPERATIONAL');
    if (ivRank.status === 'OPERATIONAL') {
      expect(ivRank.row.ivRank1y).toBe(17.49);
      expect(ivRank.row.ivPct1y).toBe(12.75);
    }

    const cachedRes = await fetch(`${base}/api/us/vol-surface?symbol=QQQ`);
    expect(cachedRes.status).toBe(200);
    const cached = (await cachedRes.json()) as UsVolSurfaceResponse;
    expect(cached.cacheState).toBe('HIT');
    expect(oratsUrls).toHaveLength(3);
  });

  it('expone el universo completo con GGAL dual y extensiones de Opciones', () => {
    const keys = OPTIONS_UNDERLYING_UNIVERSE.map((meta) => meta.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(164);
    expect(keys).toContain('GGAL');
    expect(keys).toContain('US:GGAL');
    expect(keys).toContain('PLTR');
    expect(keys).toContain('IBIT');
    expect(keys).not.toContain('COME');
    expect(keys).not.toContain('ALUA');
    expect(keys).not.toContain('TXAR');
    const ggalAr = OPTIONS_UNDERLYING_UNIVERSE.find((meta) => meta.key === 'GGAL');
    const ggalUs = OPTIONS_UNDERLYING_UNIVERSE.find((meta) => meta.key === 'US:GGAL');
    expect(ggalAr?.market).toBe('AR');
    expect(ggalAr?.currency).toBe('ARS');
    expect(ggalUs?.market).toBe('US');
    expect(ggalUs?.currency).toBe('USD');
  });
});

function emptyTradierProvenance(nowSec: number) {
  return {
    provider: 'TRADIER' as const,
    endpoint: 'REST_OPTION_CHAIN' as const,
    requestedAtUtcSec: nowSec,
    httpStatus: 200,
    rows: 0,
    parseDiscarded: 0,
    lastError: null,
  };
}

function tradierNormalized(
  occSymbol: string,
  contractType: 'call' | 'put',
  strike: number,
  expirationDate: string,
  nowSec: number,
  bid: number,
  ask: number,
) {
  return {
    occSymbol,
    underlying: 'QQQ',
    contractType,
    strike,
    expirationDate,
    expirationTime: Date.UTC(2025, 2, 31, 20) / 1_000,
    bid,
    bidSize: 10,
    ask,
    askSize: 12,
    volume: 0,
    openInterest: 0,
    last: (bid + ask) / 2,
    close: (bid + ask) / 2,
    greeks: {
      delta: contractType === 'call' ? 0.5 : -0.5,
      gamma: 0.01,
      theta: -0.02,
      vega: 0.1,
      rho: 0,
      phi: 0,
      bidIv: 0.2,
      midIv: 0.2,
      askIv: 0.21,
      smvVol: 0.2,
      updatedAtUtcSec: nowSec,
    },
    asOfUtcSec: nowSec,
    provider: 'TRADIER' as const,
    sharesPerContract: 100 as const,
  };
}

function makeSnapshotContract(input: {
  readonly ticker: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expirationDate: string;
  readonly expirationTime?: number;
  readonly nowSec: number;
  readonly bid: number;
  readonly ask: number;
  readonly volume?: number;
  readonly openInterest?: number;
}): OptionSnapshotContract {
  const nowSec = input.nowSec;
  const day: OptionDaySummary = {
    open: (input.bid + input.ask) / 2,
    high: input.ask,
    low: input.bid,
    close: (input.bid + input.ask) / 2,
    volume: input.volume ?? 500,
    vwap: (input.bid + input.ask) / 2,
    previousClose: (input.bid + input.ask) / 2,
    change: 0,
    changePercent: 0,
    updatedAt: nowSec,
  };
  const quote: OptionLastQuote = {
    bid: input.bid,
    ask: input.ask,
    midpoint: (input.bid + input.ask) / 2,
    bidSize: 10,
    askSize: 10,
    bidExchange: null,
    askExchange: null,
    updatedAt: nowSec,
    timeframe: null,
  };
  const trade: OptionLastTrade = {
    price: (input.bid + input.ask) / 2,
    size: 10,
    exchange: null,
    conditions: [],
    sipTimestamp: nowSec * 1_000_000_000,
    timeframe: null,
  };
  const greeks: OptionGreeks = { delta: 0.5, gamma: 0.01, theta: -0.02, vega: 0.1 };
  return {
    ticker: input.ticker,
    contractType: input.contractType,
    exerciseStyle: 'american',
    expirationDate: input.expirationDate,
    expirationTime: input.expirationTime ?? Date.parse(`${input.expirationDate}T20:00:00Z`) / 1_000,
    strikePrice: input.strike,
    sharesPerContract: 100,
    breakEvenPrice: Number.NaN,
    impliedVolatility: 0.22,
    openInterest: input.openInterest ?? 5000,
    greeks,
    greeksMissing: false,
    day,
    lastQuote: quote,
    lastTrade: trade,
    underlyingAsset: null,
    additionalUnderlyings: [],
    isBinary: false,
    isAdjusted: false,
    isNonStandard: false,
  };
}

function buildSelectionContracts(
  expirationDate: string,
  daysToExpiry: number,
  nowSec: number,
  spot: number,
): readonly OptionSnapshotContract[] {
  const strikes = [spot * 0.98, spot, spot * 1.02, spot * 1.04];
  const contracts: OptionSnapshotContract[] = [];
  const expirationTime = nowSec + daysToExpiry * 86_400;
  for (const [idx, strike] of strikes.entries()) {
    for (const type of ['call', 'put'] as const) {
      contracts.push(
        makeSnapshotContract({
          ticker: `O:TEST${type === 'call' ? 'C' : 'P'}${String(idx)}`,
          contractType: type,
          strike,
          expirationDate,
          expirationTime,
          nowSec,
          bid: 1 + idx * 0.1,
          ask: 1.2 + idx * 0.1,
          volume: daysToExpiry * 100 + idx,
          openInterest: daysToExpiry * 50 + idx,
        }),
      );
    }
  }
  return contracts;
}

function createOfflineMassiveFetch(params: { readonly asOfUtcSec: number }): FetchFn {
  const { asOfUtcSec } = params;
  const qqqSpot = fixture.qqq.spot;
  const spySpot = 595;
  const qqqExpiry = '2025-03-31';
  const incompleteExpiry = '2025-03-12';

  const buildBars = (symbol: string): Record<string, unknown> => {
    const base = symbol === 'QQQ' ? qqqSpot : symbol === 'SPY' ? spySpot : 100;
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < 260; i += 1) {
      const time = (Math.floor(asOfUtcSec / 300) - 260 + i) * 300;
      const close = base + Math.sin(i / 17) * 0.4;
      results.push({
        t: time * 1_000,
        o: close - 0.05,
        h: close + 0.2,
        l: close - 0.2,
        c: close,
        v: 100_000 + i,
        vw: close,
      });
    }
    return { status: 'OK', ticker: symbol, resultsCount: results.length, results };
  };

  return (url: string) => {
    const parsed = new URL(url);
    const path = parsed.pathname;

    if (path.startsWith('/v2/aggs/ticker/')) {
      const ticker = decodeURIComponent(path.split('/')[4] ?? 'SPY');
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify(buildBars(ticker)),
        headers: {},
      });
    }
    if (path === '/fed/v1/treasury-yields') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: [
            {
              date: '2025-03-10',
              yield_1_month: 4.31,
              yield_2_year: 4.02,
              yield_10_year: 4.26,
              yield_30_year: 4.56,
            },
          ],
        }),
        headers: {},
      });
    }
    if (path === '/fed/v1/funding-conditions') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: [{ date: '2025-03-10', sofr: 4.31, sofr_volume: 2_100_000_000_000 }],
        }),
        headers: {},
      });
    }
    if (path === '/v3/snapshot') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: [
            {
              ticker: 'QQQ',
              type: 'stocks',
              market_status: 'open',
              session: { price: qqqSpot, close: qqqSpot, previous_close: 660, volume: 28_000_000 },
              last_trade: { price: qqqSpot, sip_timestamp: String(asOfUtcSec * 1_000_000_000) },
              last_quote: { bid: qqqSpot - 0.02, ask: qqqSpot + 0.02, midpoint: qqqSpot },
            },
            {
              ticker: 'SPY',
              type: 'stocks',
              market_status: 'open',
              session: { price: spySpot, close: spySpot, previous_close: 592.5, volume: 42_000_000 },
              last_quote: { bid: spySpot - 0.02, ask: spySpot + 0.02, midpoint: spySpot },
            },
            {
              ticker: 'I:VIX',
              type: 'indices',
              market_status: 'open',
              value: 16.4,
              session: { price: 16.4, previous_close: 16.9 },
            },
            {
              ticker: 'I:SKEW',
              type: 'indices',
              market_status: 'open',
              value: 138.2,
              session: { price: 138.2, previous_close: 137 },
            },
          ],
        }),
        headers: {},
      });
    }
    if (path === '/v2/snapshot/locale/us/markets/stocks/tickers') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          tickers: [
            { ticker: 'QQQ', day: { c: qqqSpot, v: 28_000_000 }, prevDay: { c: 660 }, lastTrade: { p: qqqSpot }, lastQuote: { P: qqqSpot - 0.02, p: qqqSpot + 0.02 } },
            { ticker: 'SPY', day: { c: spySpot, v: 42_000_000 }, prevDay: { c: 592.5 }, lastTrade: { p: spySpot }, lastQuote: { P: spySpot - 0.02, p: spySpot + 0.02 } },
          ],
        }),
        headers: {},
      });
    }
    if (path === '/stocks/v1/dividends') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({ status: 'OK', results: [] }),
        headers: {},
      });
    }
    if (path === '/options/v1/unusual-trades') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({ status: 'OK', results: [] }),
        headers: {},
      });
    }
    if (path === '/v3/reference/options/contracts') {
      const ticker = decodeURIComponent(path.split('/')[4] ?? 'QQQ');
      const spot = ticker === 'QQQ' ? qqqSpot : spySpot;
      const results: Record<string, unknown>[] = [];
      const expiries = ticker === 'QQQ' ? [incompleteExpiry, qqqExpiry] : ['2025-03-31'];
      for (const expiry of expiries) {
        const compact = expiry.replaceAll('-', '').slice(2);
        const strikes =
          ticker === 'QQQ' && expiry === qqqExpiry
            ? [660, 665, 670]
            : [Math.round(spot), Math.round(spot) + 5, Math.round(spot) + 10];
        for (const strike of strikes) {
          for (const ct of ['call', 'put'] as const) {
            results.push({
              ticker: `O:${ticker}${compact}${ct === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1_000)).padStart(8, '0')}`,
              underlying_ticker: ticker,
              contract_type: ct,
              strike_price: strike,
              expiration_date: expiry,
              shares_per_contract: 100,
            });
          }
        }
        if (ticker === 'QQQ' && expiry === incompleteExpiry) {
          results.push({
            ticker: `O:QQQ250312C00663000`,
            underlying_ticker: 'QQQ',
            contract_type: 'call',
            strike_price: 663,
            expiration_date: expiry,
            shares_per_contract: 100,
          });
        }
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({ status: 'OK', results }),
        headers: {},
      });
    }
    if (path.startsWith('/v3/snapshot/options/')) {
      const ticker = decodeURIComponent(path.split('/')[4] ?? 'QQQ');
      const spot = ticker === 'QQQ' ? qqqSpot : spySpot;
      const results: Record<string, unknown>[] = [];
      const expiries = ticker === 'QQQ' ? [incompleteExpiry, qqqExpiry] : ['2025-03-31'];
      for (const expiry of expiries) {
        const compact = expiry.replaceAll('-', '').slice(2);
        const strikes =
          ticker === 'QQQ' && expiry === qqqExpiry
            ? [660, 665, 670]
            : [Math.round(spot), Math.round(spot) + 5, Math.round(spot) + 10];
        for (const strike of strikes) {
          for (const ct of ['call', 'put'] as const) {
            const offset = strike - Math.round(spot);
            const bid =
              ct === 'call'
                ? Math.max(0.05, 4 - offset * 0.6)
                : Math.max(0.05, 4 + offset * 0.6);
            const ask = bid + 0.2;
            results.push({
              details: {
                ticker: `O:${ticker}${compact}${ct === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1_000)).padStart(8, '0')}`,
                contract_type: ct,
                strike_price: strike,
                expiration_date: expiry,
                shares_per_contract: 100,
              },
              day:
                ticker === 'QQQ' && expiry === qqqExpiry
                  ? { volume: fixture.flow_fusion.massive_volume, close: (bid + ask) / 2, previousClose: (bid + ask) / 2, change: 0 }
                  : { volume: 650, close: (bid + ask) / 2, previousClose: (bid + ask) / 2, change: 0 },
              open_interest:
                ticker === 'QQQ' && expiry === qqqExpiry
                  ? fixture.flow_fusion.massive_open_interest
                  : 8_000,
              implied_volatility: 0.22,
              last_quote: { bid, ask, midpoint: (bid + ask) / 2 },
              last_trade: { price: (bid + ask) / 2, sip_timestamp: String(asOfUtcSec * 1_000_000_000) },
              underlying_asset: { ticker, price: spot },
            });
          }
        }
        if (ticker === 'QQQ' && expiry === incompleteExpiry) {
          results.push({
            details: {
              ticker: 'O:QQQ250312C00663000',
              contract_type: 'call',
              strike_price: 663,
              expiration_date: expiry,
              shares_per_contract: 100,
            },
            day: { volume: 100, close: 2, previousClose: 2, change: 0 },
            open_interest: 300,
            implied_volatility: 0.25,
            last_quote: { bid: 2, ask: 2.2, midpoint: 2.1 },
            last_trade: { price: 2.1, sip_timestamp: String(asOfUtcSec * 1_000_000_000) },
            underlying_asset: { ticker, price: spot },
          });
        }
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({ status: 'OK', results }),
        headers: {},
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
      text: JSON.stringify({ status: 'NOT_FOUND', error: `Unexpected test URL ${path}` }),
      headers: {},
    });
  };
}
