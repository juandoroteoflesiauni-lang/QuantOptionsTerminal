/**
 * Suite Vitest 100% offline para Stock Detail unificado (`/acciones/:ticker`):
 *  - Verifica todas las funciones matemáticas puras de `web/src/components/stock-detail/stockDetailMath.ts`
 *    contra referencia independiente en Python (`fixtures/stock_detail_reference.json`, tol < 1e-9).
 *  - Verifica política Zero Silent Fallbacks (`NaN` ante faltantes/divisores inválidos).
 *  - Verifica las extensiones de DTO en `MarketRuntime` (`ema9/50/200`, NBBO, `benchmarkBars1d`)
 *    y `ArgentinaMarketRuntime` (`benchmarkBars1d`, `nextExpiry`, `adrBars`, `byStrike`).
 */

import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Bar } from '../src/core/types.js';
import type { FetchFn } from '../src/data/types.js';
import { ArgentinaMarketRuntime } from '../src/server/argentinaMarketLoader.js';
import { MarketRuntime, US_PANEL_TICKERS } from '../src/server/marketRuntime.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import { extractInvalidTradierSymbol } from '../src/server/tradierAdapter.js';
import {
  alignSessionVwapOverlayByTime,
  computeAnchoredVwapPure,
  computeAtrPositionSize,
  computeCi24hImpliedCarry,
  computeEmaSeriesPure,
  computeExpectedMoveBounds,
  computeLeeReadyBarFlow,
  computeRelativeStrengthSeries,
  computeRollingRvSeries,
  computeSessionVwapPure,
  computeSpatialProximityList,
  computeWilderAtrPure,
  resolveAvwapAnchorIndex,
  thirdFridayUtcSec,
  type MinimalOhlcvBar,
} from '../web/src/components/stock-detail/stockDetailMath.js';

interface StockDetailFixture {
  readonly dailyBars: readonly MinimalOhlcvBar[];
  readonly benchmarkBars: readonly MinimalOhlcvBar[];
  readonly intradayBars: readonly MinimalOhlcvBar[];
  readonly ema9: readonly (number | null)[];
  readonly ema21: readonly (number | null)[];
  readonly ema50: readonly (number | null)[];
  readonly atr14: readonly (number | null)[];
  readonly intradaySessionVwap: readonly (number | null)[];
  readonly dailySessionVwap: readonly (number | null)[];
  readonly opexTimestamps: { readonly oct2026: number; readonly nov2026: number };
  readonly avwap: {
    readonly monthAnchorIdx: number;
    readonly swingHighAnchorIdx: number;
    readonly swingLowAnchorIdx: number;
    readonly earningsAnchorSec: number;
    readonly earningsAnchorIdx: number;
    readonly monthSeries: readonly (number | null)[];
    readonly swingHighSeries: readonly (number | null)[];
    readonly swingLowSeries: readonly (number | null)[];
    readonly earningsSeries: readonly (number | null)[];
  };
  readonly leeReadyFlow: readonly {
    readonly time: number;
    readonly barDelta: number;
    readonly cvd: number;
    readonly buyerPct: number | null;
    readonly sellerPct: number | null;
  }[];
  readonly relativeStrength: readonly {
    readonly time: number;
    readonly rsRatio: number | null;
    readonly rsNormalizedPct: number | null;
  }[];
  readonly rollingRv30: readonly (number | null)[];
  readonly ci24hCarry: {
    readonly priceCi: number;
    readonly price24h: number;
    readonly settlementDays: number;
    readonly spreadPct: number;
    readonly impliedTnaPct: number;
  };
  readonly expectedMove: {
    readonly spot: number;
    readonly ivDecimal: number;
    readonly daysToExpiry: number;
    readonly oneSigmaAbs: number;
    readonly oneSigmaPct: number;
    readonly upper1Sigma: number;
    readonly lower1Sigma: number;
  };
  readonly atrSizing: {
    readonly equity: number;
    readonly riskPct: number;
    readonly entryPrice: number;
    readonly atr14: number;
    readonly atrMultiple: number;
    readonly stopLossPrice: number;
    readonly stopDistanceAbs: number;
    readonly riskBudget: number;
    readonly suggestedQty: number;
  };
  readonly spatialProximity: {
    readonly spot: number;
    readonly atr14: number;
    readonly bandAtr: number;
    readonly levels: readonly { readonly name: string; readonly category: string; readonly price: number }[];
    readonly expected: readonly {
      readonly name: string;
      readonly category: string;
      readonly price: number;
      readonly signedDistAbs: number;
      readonly distanceAbs: number;
      readonly distancePct: number;
      readonly distanceAtr: number;
      readonly withinBand: boolean;
    }[];
  };
}

const FIXTURE = JSON.parse(
  readFileSync('fixtures/stock_detail_reference.json', 'utf8'),
) as StockDetailFixture;

const TOL = 1e-9;

function expectSeriesMatchesFixture(
  actual: readonly number[],
  expected: readonly (number | null)[],
): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    const exp = expected[i];
    const act = actual[i] ?? Number.NaN;
    if (exp === null || exp === undefined) {
      expect(Number.isNaN(act)).toBe(true);
    } else {
      expect(Math.abs(act - exp)).toBeLessThan(TOL);
    }
  }
}

describe('stockDetailMath vs Python reference (< 1e-9)', () => {
  it('computes EMA(9), EMA(21), EMA(50) and Wilder ATR(14) identically to Python', () => {
    const closes = FIXTURE.dailyBars.map((b) => b.close);
    expectSeriesMatchesFixture(computeEmaSeriesPure(closes, 9), FIXTURE.ema9);
    expectSeriesMatchesFixture(computeEmaSeriesPure(closes, 21), FIXTURE.ema21);
    expectSeriesMatchesFixture(computeEmaSeriesPure(closes, 50), FIXTURE.ema50);
    expectSeriesMatchesFixture(computeWilderAtrPure(FIXTURE.dailyBars, 14), FIXTURE.atr14);
  });

  it('computes intraday session VWAP resetting across UTC days and returns NaN for 1D', () => {
    expectSeriesMatchesFixture(
      computeSessionVwapPure(FIXTURE.intradayBars, true, 0),
      FIXTURE.intradaySessionVwap,
    );
    expectSeriesMatchesFixture(
      computeSessionVwapPure(FIXTURE.dailyBars, false, 0),
      FIXTURE.dailySessionVwap,
    );
  });

  it('resolves OPEX 3rd Friday timestamps and all AVWAP anchors/series within 1e-9', () => {
    expect(thirdFridayUtcSec(2026, 9)).toBe(FIXTURE.opexTimestamps.oct2026);
    expect(thirdFridayUtcSec(2026, 10)).toBe(FIXTURE.opexTimestamps.nov2026);

    const monthIdx = resolveAvwapAnchorIndex(FIXTURE.dailyBars, 'MONTH_START');
    const hiIdx = resolveAvwapAnchorIndex(FIXTURE.dailyBars, 'SWING_HIGH_60D');
    const loIdx = resolveAvwapAnchorIndex(FIXTURE.dailyBars, 'SWING_LOW_60D');
    const earnIdx = resolveAvwapAnchorIndex(
      FIXTURE.dailyBars,
      'LAST_EARNINGS',
      FIXTURE.avwap.earningsAnchorSec,
    );

    expect(monthIdx).toBe(FIXTURE.avwap.monthAnchorIdx);
    expect(hiIdx).toBe(FIXTURE.avwap.swingHighAnchorIdx);
    expect(loIdx).toBe(FIXTURE.avwap.swingLowAnchorIdx);
    expect(earnIdx).toBe(FIXTURE.avwap.earningsAnchorIdx);

    expectSeriesMatchesFixture(computeAnchoredVwapPure(FIXTURE.dailyBars, monthIdx), FIXTURE.avwap.monthSeries);
    expectSeriesMatchesFixture(computeAnchoredVwapPure(FIXTURE.dailyBars, hiIdx), FIXTURE.avwap.swingHighSeries);
    expectSeriesMatchesFixture(computeAnchoredVwapPure(FIXTURE.dailyBars, loIdx), FIXTURE.avwap.swingLowSeries);
    expectSeriesMatchesFixture(computeAnchoredVwapPure(FIXTURE.dailyBars, earnIdx), FIXTURE.avwap.earningsSeries);
  });

  it('computes Lee-Ready CLV flow, causal Relative Strength and Rolling RV(30) identically to Python', () => {
    const flow = computeLeeReadyBarFlow(FIXTURE.dailyBars);
    expect(flow.length).toBe(FIXTURE.leeReadyFlow.length);
    for (let i = 0; i < flow.length; i += 1) {
      const a = flow[i];
      const e = FIXTURE.leeReadyFlow[i];
      if (a === undefined || e === undefined) {
        throw new Error(`Missing leeReadyFlow element at index ${String(i)}`);
      }
      expect(a.time).toBe(e.time);
      expect(Math.abs(a.barDelta - e.barDelta)).toBeLessThan(TOL);
      expect(Math.abs(a.cvd - e.cvd)).toBeLessThan(TOL);
      expect(Math.abs(a.buyerPct - (e.buyerPct ?? Number.NaN))).toBeLessThan(TOL);
      expect(Math.abs(a.sellerPct - (e.sellerPct ?? Number.NaN))).toBeLessThan(TOL);
    }

    const rs = computeRelativeStrengthSeries(FIXTURE.dailyBars, FIXTURE.benchmarkBars, true);
    expect(rs.length).toBe(FIXTURE.relativeStrength.length);
    for (let i = 0; i < rs.length; i += 1) {
      const a = rs[i];
      const e = FIXTURE.relativeStrength[i];
      if (a === undefined || e === undefined) {
        throw new Error(`Missing relativeStrength element at index ${String(i)}`);
      }
      if (e.rsRatio === null) {
        expect(Number.isNaN(a.rsRatio)).toBe(true);
        expect(Number.isNaN(a.rsNormalizedPct)).toBe(true);
      } else {
        expect(Math.abs(a.rsRatio - e.rsRatio)).toBeLessThan(TOL);
        expect(Math.abs(a.rsNormalizedPct - (e.rsNormalizedPct ?? 0))).toBeLessThan(TOL);
      }
    }

    expectSeriesMatchesFixture(computeRollingRvSeries(FIXTURE.dailyBars, 30, 252), FIXTURE.rollingRv30);
  });

  it('computes CI<->24hs implied carry, ±1σ expected move, ATR sizing and spatial proximity', () => {
    const c = FIXTURE.ci24hCarry;
    const carry = computeCi24hImpliedCarry(c.priceCi, c.price24h, c.settlementDays);
    expect(Math.abs(carry.spreadPct - c.spreadPct)).toBeLessThan(TOL);
    expect(Math.abs(carry.impliedTnaPct - c.impliedTnaPct)).toBeLessThan(TOL);

    const em = computeExpectedMoveBounds(
      FIXTURE.expectedMove.spot,
      FIXTURE.expectedMove.ivDecimal,
      FIXTURE.expectedMove.daysToExpiry,
    );
    expect(Math.abs(em.oneSigmaAbs - FIXTURE.expectedMove.oneSigmaAbs)).toBeLessThan(TOL);
    expect(Math.abs(em.oneSigmaPct - FIXTURE.expectedMove.oneSigmaPct)).toBeLessThan(TOL);
    expect(Math.abs(em.upper1Sigma - FIXTURE.expectedMove.upper1Sigma)).toBeLessThan(TOL);
    expect(Math.abs(em.lower1Sigma - FIXTURE.expectedMove.lower1Sigma)).toBeLessThan(TOL);

    const sz = computeAtrPositionSize({
      equity: FIXTURE.atrSizing.equity,
      riskPct: FIXTURE.atrSizing.riskPct,
      entryPrice: FIXTURE.atrSizing.entryPrice,
      atr14: FIXTURE.atrSizing.atr14,
      atrMultiple: FIXTURE.atrSizing.atrMultiple,
    });
    expect(Math.abs(sz.stopLossPrice - FIXTURE.atrSizing.stopLossPrice)).toBeLessThan(TOL);
    expect(Math.abs(sz.stopDistanceAbs - FIXTURE.atrSizing.stopDistanceAbs)).toBeLessThan(TOL);
    expect(Math.abs(sz.riskBudget - FIXTURE.atrSizing.riskBudget)).toBeLessThan(TOL);
    expect(sz.suggestedQty).toBe(FIXTURE.atrSizing.suggestedQty);

    const prox = computeSpatialProximityList(
      FIXTURE.spatialProximity.spot,
      FIXTURE.spatialProximity.atr14,
      FIXTURE.spatialProximity.levels,
      FIXTURE.spatialProximity.bandAtr,
    );
    expect(prox.length).toBe(FIXTURE.spatialProximity.expected.length);
    for (let i = 0; i < prox.length; i += 1) {
      const a = prox[i];
      const e = FIXTURE.spatialProximity.expected[i];
      if (a === undefined || e === undefined) {
        throw new Error(`Missing spatialProximity element at index ${String(i)}`);
      }
      expect(a.name).toBe(e.name);
      expect(a.withinBand).toBe(e.withinBand);
      expect(Math.abs(a.distanceAtr - e.distanceAtr)).toBeLessThan(TOL);
      expect(Math.abs(a.signedDistAbs - e.signedDistAbs)).toBeLessThan(TOL);
    }
  });

  it('enforces Zero Silent Fallbacks (returns NaN/-1 on invalid or missing inputs)', () => {
    expect(resolveAvwapAnchorIndex(FIXTURE.dailyBars, 'LAST_EARNINGS', null)).toBe(-1);
    expect(computeEmaSeriesPure([], 9)).toEqual([]);
    const invalidCarry = computeCi24hImpliedCarry(0, 100);
    expect(Number.isNaN(invalidCarry.impliedTnaPct)).toBe(true);
    const invalidEm = computeExpectedMoveBounds(100, 0, 10);
    expect(Number.isNaN(invalidEm.oneSigmaAbs)).toBe(true);
    const invalidSize = computeAtrPositionSize({
      equity: 1_000_000,
      riskPct: 1,
      entryPrice: 100,
      atr14: 0,
      atrMultiple: 1.5,
    });
    expect(Number.isNaN(invalidSize.suggestedQty)).toBe(true);
  });
});

type MrDeps = NonNullable<ConstructorParameters<typeof MarketRuntime>[0]>;

describe('Stock Detail Backend DTO Extensions (offline)', () => {
  it('exposes ema9/ema50/ema200 on /api/bars and NBBO + benchmarkBars1d on /api/snapshot even without option contracts', async () => {
    const dailyBars: Bar[] = FIXTURE.dailyBars.map((b) => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));
    const intradayBars: Bar[] = Array.from({ length: 240 }, (_, i) => {
      const base = 180 + Math.sin(i * 0.15) * 3;
      return {
        time: 1_780_000_000 + i * 300,
        open: base - 0.3,
        high: base + 0.6,
        low: base - 0.5,
        close: base,
        volume: 25_000 + i * 100,
        vw: base + 0.05,
      };
    });

    const rt = new MarketRuntime({
      apiKey: 'test-key-offline',
      enableWs: false,
      nowMsFn: () => 1_780_100_000_000,
      loadBarsFn: ((req: { readonly timeframe?: string }) =>
        Promise.resolve({
          bars: req.timeframe === '1D' ? dailyBars : intradayBars,
          visibleStart: 0,
          report: { provider: 'massive', fetchedPages: 1, barsCount: 70, providerError: null },
        })) as unknown as NonNullable<MrDeps['loadBarsFn']>,
      loadUnifiedSnapshotFn: (() =>
        Promise.resolve({
          stocks: [
            {
              ticker: 'AMD',
              marketStatus: 'open',
              session: {
                open: 179.5,
                high: 182.1,
                low: 178.4,
                close: 181.2,
                previousClose: 179.0,
                change: 2.2,
                changePercent: 1.23,
                volume: 42_000_000,
                vwap: 180.5,
              },
              lastQuote: {
                bid: 181.18,
                ask: 181.24,
                midpoint: 181.21,
                bidSize: 400,
                askSize: 300,
              },
              lastTrade: { price: 181.2, size: 100, timeSec: 1_780_100_000 },
            },
          ],
          indices: [],
          options: [],
          other: [],
          tickerErrors: [],
          report: { providerError: null },
        })) as unknown as NonNullable<MrDeps['loadUnifiedSnapshotFn']>,
      loadOptionChainFn: (() =>
        Promise.resolve({
          contracts: [],
          underlying: null,
          report: { providerError: null },
        })) as unknown as NonNullable<MrDeps['loadOptionChainFn']>,
      loadOptionContractsFn: (() =>
        Promise.resolve({
          contracts: [],
          report: { providerError: null },
        })) as unknown as NonNullable<MrDeps['loadOptionContractsFn']>,
      loadTreasuryYieldsFn: (() =>
        Promise.resolve({
          observations: [],
          report: { providerError: null },
        })) as unknown as NonNullable<MrDeps['loadTreasuryYieldsFn']>,
      loadFundingConditionsFn: (() =>
        Promise.resolve({
          observations: [],
          report: { providerError: null },
        })) as unknown as NonNullable<MrDeps['loadFundingConditionsFn']>,
      loadDividendsFn: (() =>
        Promise.resolve({
          dividends: [],
          report: { providerError: null },
        })) as unknown as NonNullable<MrDeps['loadDividendsFn']>,
    });

    const barsRes = await rt.getBars('AMD', '5m', { visibleBars: 180 });
    expect(barsRes.overlays.ema9?.length).toBe(barsRes.bars.length);
    expect(barsRes.overlays.ema50?.length).toBe(barsRes.bars.length);
    expect(barsRes.overlays.ema200?.length).toBe(barsRes.bars.length);
    expect(barsRes.overlays.ema9?.[barsRes.bars.length - 1]).not.toBeNull();
    expect(barsRes.overlays.ema200?.[barsRes.bars.length - 1]).not.toBeNull();

    const snapRes = await rt.getSnapshot('AMD');
    expect(snapRes.symbol).toBe('AMD');
    expect(snapRes.exposureSummary).toBeNull();
    expect(snapRes.benchmarkBars1d?.length).toBe(70);
    const q = snapRes.marketContext.unifiedQuotes.find((u) => u.ticker === 'AMD');
    expect(q?.bid).toBe(181.18);
    expect(q?.ask).toBe(181.24);
    expect(q?.bidSize).toBe(400);
    expect(q?.askSize).toBe(300);
    expect(q?.spreadPct).not.toBeNull();
  });

  it('exposes benchmarkBars1d and converted adrBars cleanly on ArgentinaMarketRuntime.getStockDetail', async () => {
    const spyDaily = FIXTURE.benchmarkBars;
    const ggalDaily = FIXTURE.dailyBars;

    const mockFetch: FetchFn = (url) => {
      if (url.includes('/live/arg_stocks')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify([
            { symbol: 'GGAL', c: 8100, v: 900_000, px_bid: 8095, px_ask: 8105, q_op: 100, pct_change: 1.5 },
          ]),
        });
      }
      if (url.includes('/live/usa_adrs')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify([{ symbol: 'GGAL', c: 60.0, pct_change: 1.4 }]),
        });
      }
      if (url.includes('/live/arg_options')) {
        return Promise.resolve({ ok: true, status: 200, headers: {}, text: JSON.stringify([]) });
      }
      if (url.includes('/historical/stocks/GGAL')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify(
            ggalDaily.map((b) => ({
              date: new Date(b.time * 1_000).toISOString().slice(0, 10),
              o: b.open,
              h: b.high,
              l: b.low,
              c: b.close,
              v: b.volume,
            })),
          ),
        });
      }
      if (url.includes('/historical/cedears/SPY')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify(
            spyDaily.map((b) => ({
              date: new Date(b.time * 1_000).toISOString().slice(0, 10),
              o: b.open,
              h: b.high,
              l: b.low,
              c: b.close,
              v: b.volume,
            })),
          ),
        });
      }
      if (url.includes('argentinadatos') || url.includes('bcra') || url.includes('bymadata') || url.includes('/live/')) {
        return Promise.resolve({ ok: true, status: 200, headers: {}, text: JSON.stringify([]) });
      }
      return Promise.resolve({ ok: false, status: 404, headers: {}, text: '{}' });
    };

    const mockUsRt = {
      getBars: (_sym: string, tf: '15m') =>
        Promise.resolve({
        status: 'OK' as const,
        symbol: 'GGAL',
        timeframe: tf,
        barSeconds: 900,
        rthOnly: true,
        asOfUtcSec: 1_790_000_000,
        visibleStartIndex: 0,
        bars: [
          { time: 1_789_990_000, open: 59.5, high: 60.5, low: 59.0, close: 60.0, volume: 120_000, vw: 59.8 },
        ],
        formingBar: null,
        overlays: {
          ema21: [],
          sma50: [],
          sma200: [],
          hma55: [],
          sessionVwap: [],
          sessionVwapSupported: true,
          avwap: [],
          avwapUpper1: [],
          avwapLower1: [],
          avwapUpper2: [],
          avwapLower2: [],
        },
        subPanes: { rsi14: [], sessionCvd: [], deltaMode: null },
        zones: null,
        keyLevels: [],
        markers: [],
      }),
    } as unknown as MarketRuntime;

    const arRt = new ArgentinaMarketRuntime({
      fetchFn: mockFetch,
      minData912IntervalMs: 0,
      nowMsFn: () => 1_790_000_000_000,
      usRuntime: mockUsRt,
    });

    const detail = await arRt.getStockDetail('GGAL', false, '15m');
    expect(detail.benchmarkBars1d?.length).toBeGreaterThan(0);
    expect(detail.adrBars).not.toBeNull();
    expect(detail.adrBars?.source).toBe('MASSIVE_ADR_CONVERTED');
    expect(detail.adrBars?.adrRatio).toBe(10);
    // Spot 8100 * 10 / 60 = CCL 1350 => 60 USD * (1350 / 10) = 8100 ARS
    expect(Math.abs((detail.adrBars?.bars[0]?.close ?? 0) - 8100)).toBeLessThan(1e-6);
  });
});

describe('Pieza 37 — deep history, AR indicators and Tradier symbol prune', () => {
  function makeDailyBars(count: number, endSec = 1_790_000_000): Bar[] {
    return Array.from({ length: count }, (_, idx) => {
      const time = endSec - (count - 1 - idx) * 86_400;
      const base = 100 + idx * 0.05 + Math.sin(idx / 13) * 1.5;
      return {
        time,
        open: base - 0.4,
        high: base + 0.8,
        low: base - 0.8,
        close: base,
        volume: 1_000 + idx,
        vw: base,
      };
    });
  }

  function makeIntradayBars(count: number, endSec = 1_790_000_000): Bar[] {
    return Array.from({ length: count }, (_, idx) => {
      const time = endSec - (count - 1 - idx) * 300;
      const base = 100 + Math.sin(idx / 19) * 0.7;
      return {
        time,
        open: base - 0.1,
        high: base + 0.2,
        low: base - 0.2,
        close: base,
        volume: 500 + idx,
        vw: base,
      };
    });
  }

  it('loads 1250 daily and 1000 intraday US bars with EMA200 and AVWAP bands for IREN', async () => {
    const dailyBars = makeDailyBars(1_250);
    const intradayBars = makeIntradayBars(1_000);
    const rt = new MarketRuntime({
      apiKey: 'deep-history-key',
      enableWs: false,
      nowMsFn: () => 1_790_000_500_000,
      loadBarsFn: ((req: { readonly timeframe?: string }) =>
        Promise.resolve({
          bars: req.timeframe === '1D' ? dailyBars : intradayBars,
          visibleStart: 0,
          report: { provider: 'massive', fetchedPages: 1, barsCount: req.timeframe === '1D' ? 1250 : 1000, providerError: null },
        })) as unknown as NonNullable<MrDeps['loadBarsFn']>,
    });

    const daily = await rt.getBars('IREN', '1D', { visibleBars: 1_250 });
    expect(daily.bars).toHaveLength(1_250);
    expect(daily.visibleStartIndex).toBe(0);
    expect(daily.overlays.ema200).toHaveLength(1_250);
    expect(daily.overlays.ema200?.[1_249]).not.toBeNull();
    expect(daily.overlays.avwap).toHaveLength(1_250);
    expect(daily.overlays.avwap[1_249]).not.toBeNull();
    expect(daily.overlays.avwapUpper1[1_249]).not.toBeNull();
    expect(daily.overlays.avwapLower1[1_249]).not.toBeNull();
    expect(daily.overlays.avwapUpper2[1_249]).not.toBeNull();
    expect(daily.overlays.avwapLower2[1_249]).not.toBeNull();

    const intraday = await rt.getBars('IREN', '5m', { visibleBars: 1_000 });
    expect(intraday.bars).toHaveLength(1_000);
    expect(intraday.overlays.ema200).toHaveLength(1_000);
    expect(intraday.overlays.ema200?.[999]).not.toBeNull();
    expect(intraday.overlays.sessionVwapSupported).toBe(true);
  });

  it('loads deep AR history and computes EMA/VWAP/AVWAP for Panel Líder GGAL', async () => {
    const bars = makeDailyBars(1_250);
    const mockFetch: FetchFn = (url) => {
      if (url.includes('/historical/stocks/GGAL')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify(bars.map((bar) => ({
            date: new Date(bar.time * 1_000).toISOString().slice(0, 10),
            o: bar.open,
            h: bar.high,
            l: bar.low,
            c: bar.close,
            v: bar.volume,
          }))),
        });
      }
      return Promise.resolve({ ok: true, status: 200, headers: {}, text: '[]' });
    };

    const arRt = new ArgentinaMarketRuntime({
      fetchFn: mockFetch,
      minData912IntervalMs: 0,
      nowMsFn: () => 1_790_000_500_000,
    });
    const detail = await arRt.getStockDetail('GGAL', false, '1D');
    expect(detail.historicalBars).toHaveLength(1_250);
    const overlays = detail.overlays;
    expect(overlays).not.toBeNull();
    expect(overlays?.ema9).toHaveLength(1_250);
    expect(overlays?.ema21).toHaveLength(1_250);
    expect(overlays?.ema50).toHaveLength(1_250);
    expect(overlays?.ema200).toHaveLength(1_250);
    expect(overlays?.ema200[1_249]).not.toBeNull();
    expect(overlays?.sessionVwap[1_249]).toBeNull();
    expect(overlays?.sessionVwapSupported).toBe(false);
    expect(overlays?.avwap[1_249]).not.toBeNull();
    expect(overlays?.avwapUpper1[1_249]).not.toBeNull();
    expect(overlays?.avwapLower2[1_249]).not.toBeNull();
    expect(overlays?.avwapAnchorAvailable).toBe(true);
  });

  it('computes the same pure indicator overlays for Panel General and CEDEARs', async () => {
    const hargBars = makeDailyBars(260);
    const valoBars = makeDailyBars(260);
    const spyCedearBars = makeDailyBars(300);
    const mockFetch: FetchFn = (url) => {
      const match = url.match(/\/historical\/(stocks|cedears)\/([A-Z0-9]+)/);
      const ticker = match?.[2];
      const bars = ticker === 'HARG' ? hargBars : ticker === 'VALO' ? valoBars : ticker === 'SPY' ? spyCedearBars : [];
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {},
        text: JSON.stringify(bars.map((bar) => ({
          date: new Date(bar.time * 1_000).toISOString().slice(0, 10),
          o: bar.open,
          h: bar.high,
          l: bar.low,
          c: bar.close,
          v: bar.volume,
        }))),
      });
    };

    const arRt = new ArgentinaMarketRuntime({
      fetchFn: mockFetch,
      minData912IntervalMs: 0,
      nowMsFn: () => 1_790_000_500_000,
    });

    const harg = await arRt.getStockDetail('HARG', false, '1D');
    expect(harg.assetType).toBe('STOCK');
    expect(harg.historicalBars).toHaveLength(260);
    expect(harg.overlays?.ema200[259]).not.toBeNull();
    expect(harg.overlays?.avwap[259]).not.toBeNull();

    const valo = await arRt.getStockDetail('VALO', false, '1D');
    expect(valo.assetType).toBe('STOCK');
    expect(valo.overlays?.ema200[259]).not.toBeNull();

    const spyCedear = await arRt.getStockDetail('SPY', false, '1D');
    expect(spyCedear.assetType).toBe('CEDEAR');
    expect(spyCedear.overlays?.ema200[299]).not.toBeNull();
    expect(spyCedear.overlays?.avwapAnchorAvailable).toBe(true);
  });

  it('prunes invalid Tradier symbols and replaces C3AI with a valid Tradier symbol', () => {
    expect(extractInvalidTradierSymbol('C3AI is not a valid symbol')).toBe('C3AI');
    expect(US_PANEL_TICKERS).not.toContain('C3AI');
    expect(US_PANEL_TICKERS).toContain('AI');
    expect(US_PANEL_TICKERS).toContain('PLTR');
    expect(US_PANEL_TICKERS).toHaveLength(162);
  });
});

describe('Pieza 38 — /api/bars enruta velas reales ARS (Panel Líder / CEDEARs)', () => {
  const activeServers: HttpWsServerHandle[] = [];
  afterAll(async () => {
    for (const server of activeServers) {
      await server.stop();
    }
  });

  function makeArDailyBars(count: number, endSec = 1_790_000_000): Bar[] {
    return Array.from({ length: count }, (_, idx) => {
      const time = endSec - (count - 1 - idx) * 86_400;
      const base = 100 + idx * 0.05 + Math.sin(idx / 13) * 1.5;
      return {
        time,
        open: base - 0.4,
        high: base + 0.8,
        low: base - 0.8,
        close: base,
        volume: 1_000 + idx,
        vw: base,
      };
    });
  }

  function toData912Rows(bars: readonly Bar[]): string {
    return JSON.stringify(
      bars.map((bar) => ({
        date: new Date(bar.time * 1_000).toISOString().slice(0, 10),
        o: bar.open,
        h: bar.high,
        l: bar.low,
        c: bar.close,
        v: bar.volume,
      })),
    );
  }

  function makeOfflineUsRuntime(): MarketRuntime {
    type MrDeps = NonNullable<ConstructorParameters<typeof MarketRuntime>[0]>;
    const usDailyBars = makeArDailyBars(400);
    return new MarketRuntime({
      apiKey: 'pieza38-us-stub-key',
      enableWs: false,
      nowMsFn: () => 1_790_000_500_000,
      loadBarsFn: ((req: { readonly timeframe?: string; readonly visibleBars?: number }) =>
        Promise.resolve({
          bars: (req.timeframe === '1D' ? usDailyBars : []).slice(-(req.visibleBars ?? 400)),
          visibleStart: 0,
          report: { provider: 'massive', fetchedPages: 1, barsCount: req.timeframe === '1D' ? 400 : 0, providerError: null },
        })) as unknown as NonNullable<MrDeps['loadBarsFn']>,
    });
  }

  async function startServerWithArHistory(
    ggalBars: readonly Bar[],
    nvdaCedearBars: readonly Bar[],
  ): Promise<string> {
    const mockFetch: FetchFn = (url) => {
      if (url.includes('/historical/stocks/GGAL')) {
        return Promise.resolve({ ok: true, status: 200, headers: {}, text: toData912Rows(ggalBars) });
      }
      if (url.includes('/historical/cedears/NVDA')) {
        return Promise.resolve({ ok: true, status: 200, headers: {}, text: toData912Rows(nvdaCedearBars) });
      }
      // Todos los demás endpoints responden vacío: el path de velas ARS sólo
      // consulta /historical/{kind}/{ticker} (caché single-flight).
      return Promise.resolve({ ok: true, status: 200, headers: {}, text: '[]' });
    };
    const arRuntime = new ArgentinaMarketRuntime({
      fetchFn: mockFetch,
      minData912IntervalMs: 0,
      nowMsFn: () => 1_790_000_500_000,
    });
    const server = createHttpWsServer({
      runtime: makeOfflineUsRuntime(),
      arRuntime,
      host: '127.0.0.1',
      port: 0,
      startRuntimeWs: false,
      enableBackgroundWarmup: false,
    });
    activeServers.push(server);
    const { host, port } = await server.start();
    return `http://${host}:${String(port)}`;
  }

  interface BarsHttpResult {
    readonly status: number;
    readonly body: Record<string, unknown>;
  }

  async function fetchBars(base: string, query: string): Promise<BarsHttpResult> {
    const res = await fetch(`${base}/api/bars?${query}`);
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  }

  function lastOf(series: unknown): unknown {
    const arr = series as readonly unknown[] | undefined;
    const last = arr?.at(-1);
    return last === undefined ? null : last;
  }

  it('serves GGAL &market=AR 1D with real ARS bars, ema200 and avwap populated (never empty)', async () => {
    const ggalBars = makeArDailyBars(1_250);
    const base = await startServerWithArHistory(ggalBars, makeArDailyBars(1_100, 1_790_000_000 - 5 * 86_400));

    const res = await fetchBars(base, 'symbol=GGAL&market=AR&timeframe=1D');
    expect(res.status).toBe(200);
    expect(res.body['market']).toBe('AR');
    expect(res.body['currency']).toBe('ARS');
    expect(res.body['symbol']).toBe('GGAL');
    expect(res.body['timeframe']).toBe('1D');
    const bars = res.body['bars'] as readonly Record<string, unknown>[];
    expect(bars.length).toBeGreaterThanOrEqual(1_000);
    expect(bars.at(-1)?.['close']).toBeCloseTo(ggalBars.at(-1)?.close ?? Number.NaN, 9);
    const overlays = res.body['overlays'] as Record<string, unknown>;
    expect(lastOf(overlays['ema200'])).not.toBeNull();
    expect(lastOf(overlays['ema9'])).not.toBeNull();
    expect(lastOf(overlays['avwap'])).not.toBeNull();
    expect(lastOf(overlays['avwapUpper1'])).not.toBeNull();
    expect(lastOf(overlays['avwapLower1'])).not.toBeNull();
    expect(lastOf(overlays['avwapUpper2'])).not.toBeNull();
    expect(lastOf(overlays['avwapLower2'])).not.toBeNull();
    // VWAP de sesión no calculable sobre velas diarias EOD => null explícito.
    expect(overlays['sessionVwapSupported']).toBe(false);
    expect(lastOf(overlays['sessionVwap'])).toBeNull();

    // Sin `market`: el local BYMA GGAL resuelve a AR por defecto (SPEC punto 10).
    const defaultMarket = await fetchBars(base, 'symbol=GGAL&timeframe=1D');
    expect(defaultMarket.status).toBe(200);
    expect(defaultMarket.body['currency']).toBe('ARS');

    // Ventana visible recortada: los indicadores se calculan sobre el historial
    // completo y se rebanan al final, ema200/avwap siguen poblados.
    const windowed = await fetchBars(base, 'symbol=GGAL&market=AR&timeframe=1D&visibleBars=250');
    expect(windowed.status).toBe(200);
    expect((windowed.body['bars'] as readonly unknown[]).length).toBe(250);
    const windowedOverlays = windowed.body['overlays'] as Record<string, unknown>;
    expect(lastOf(windowedOverlays['ema200'])).not.toBeNull();
    expect(lastOf(windowedOverlays['avwap'])).not.toBeNull();
  });

  it('serves NVDA CEDEAR &market=AR in ARS and keeps plain NVDA unambiguous on the US route', async () => {
    const nvdaCedearBars = makeArDailyBars(1_100, 1_790_000_000 - 5 * 86_400);
    const base = await startServerWithArHistory(makeArDailyBars(1_250), nvdaCedearBars);

    const arRes = await fetchBars(base, 'symbol=NVDA&market=AR&timeframe=1D');
    expect(arRes.status).toBe(200);
    expect(arRes.body['market']).toBe('AR');
    expect(arRes.body['currency']).toBe('ARS');
    const arBars = arRes.body['bars'] as readonly Record<string, unknown>[];
    expect(arBars.length).toBeGreaterThanOrEqual(1_000);
    expect(arBars.at(-1)?.['close']).toBeCloseTo(nvdaCedearBars.at(-1)?.close ?? Number.NaN, 9);
    const arOverlays = arRes.body['overlays'] as Record<string, unknown>;
    expect(lastOf(arOverlays['ema200'])).not.toBeNull();
    expect(lastOf(arOverlays['avwap'])).not.toBeNull();

    // Ambigüedad resuelta por parámetro: NVDA sin market sigue siendo el stock
    // US en USD (payload US sin campos market/currency).
    const usRes = await fetchBars(base, 'symbol=NVDA&timeframe=1D&visibleBars=250');
    expect(usRes.status).toBe(200);
    expect(usRes.body['symbol']).toBe('NVDA');
    expect(usRes.body['market']).toBeUndefined();
    expect(usRes.body['currency']).toBeUndefined();
    expect((usRes.body['bars'] as readonly unknown[]).length).toBe(250);
    expect((usRes.body['bars'] as readonly Record<string, unknown>[]).at(-1)?.['close']).not.toBe(
      nvdaCedearBars.at(-1)?.close,
    );

    // market=US explícito también resuelve US.
    const usExplicit = await fetchBars(base, 'symbol=NVDA&market=US&timeframe=1D&visibleBars=100');
    expect(usExplicit.status).toBe(200);
    expect(usExplicit.body['currency']).toBeUndefined();
  });

  it('responds 503 NO_BARS_DATA honestly when AR history is missing or intraday is requested', async () => {
    const base = await startServerWithArHistory(makeArDailyBars(1_250), makeArDailyBars(1_100));

    const missing = await fetchBars(base, 'symbol=PAMP&market=AR&timeframe=1D');
    expect(missing.status).toBe(503);
    expect(missing.body['reason']).toBe('NO_BARS_DATA');

    const intraday = await fetchBars(base, 'symbol=GGAL&market=AR&timeframe=5m');
    expect(intraday.status).toBe(200);
    expect(intraday.body['requestedTimeframe']).toBe('5m');
    expect(intraday.body['effectiveTimeframe']).toBe('1D');
    expect(intraday.body['fallbackReason']).toBe('NO_5M_BARS_AR');
    expect(Array.isArray(intraday.body['bars']) && intraday.body['bars'].length > 0).toBe(true);

    const invalidMarket = await fetchBars(base, 'symbol=GGAL&market=MERVAL&timeframe=1D');
    expect(invalidMarket.status).toBe(400);
    expect(invalidMarket.body['reason']).toBe('INVALID_PARAMETER');
  });
});

describe('Pieza 50.6 — VWAP US desde el backend (sin recálculo local)', () => {
  const barAt = (time: number, close: number): MinimalOhlcvBar => ({
    time,
    open: close - 0.2,
    high: close + 0.3,
    low: close - 0.4,
    close,
    volume: 1_000,
  });

  it('usa los valores del backend US y no el VWAP local cuando difieren', () => {
    const source = [barAt(1_800, 100), barAt(1_860, 101), barAt(1_920, 102)];
    const backend = [null, 500.25, 500.5];
    const local = computeSessionVwapPure(source, true, -14_400);
    expect(Number.isFinite(local[2])).toBe(true);
    expect(local[2]).not.toBeCloseTo(500.5, 9);

    const aligned = alignSessionVwapOverlayByTime(source, backend, source);
    expect(aligned).toEqual(backend);
    expect(aligned?.[2]).toBeCloseTo(500.5, 12);
    expect(aligned?.[0]).toBeNull();
  });

  it('alinea por timestamp: barras desordenadas, duplicados (última gana) y null preservado', () => {
    const source = [barAt(120, 100), barAt(60, 99), barAt(120, 101), barAt(180, 102)];
    const backend = [1, 2, 3, null];
    const rendered = [barAt(60, 99), barAt(120, 101), barAt(180, 102), barAt(240, 103)];
    const aligned = alignSessionVwapOverlayByTime(source, backend, rendered);
    expect(aligned).toEqual([2, 3, null, null]);
  });

  it('overlay ausente o con longitud incorrecta deja la serie vacía sin respaldo local', () => {
    const source = [barAt(60, 100), barAt(120, 101)];
    const rendered = [barAt(60, 100), barAt(120, 101)];
    expect(alignSessionVwapOverlayByTime(source, undefined, rendered)).toBeNull();
    expect(alignSessionVwapOverlayByTime(source, null, rendered)).toBeNull();
    expect(alignSessionVwapOverlayByTime(source, [1], rendered)).toBeNull();
    expect(alignSessionVwapOverlayByTime(source, [1, 2, 3], rendered)).toBeNull();
  });

  it('valores no finitos del overlay se preservan como null y no contaminan la serie', () => {
    const source = [barAt(60, 100), barAt(120, 101), barAt(180, 102)];
    const aligned = alignSessionVwapOverlayByTime(
      source,
      [Number.NaN, 250.5, Number.POSITIVE_INFINITY],
      source,
    );
    expect(aligned).toEqual([null, 250.5, null]);
  });

  it('el backend US publica soporte y serie alineada solo en marcos compatibles', async () => {
    type MrDeps = NonNullable<ConstructorParameters<typeof MarketRuntime>[0]>;
    const intradayBars: Bar[] = Array.from({ length: 30 }, (_, index) => ({
      time: 1_780_000_000 + index * 300,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100 + Math.sin(index / 5),
      volume: 1_000,
      vw: 100 + Math.sin(index / 5),
    }));
    const dailyBars: Bar[] = Array.from({ length: 30 }, (_, index) => ({
      time: 1_779_000_000 + index * 86_400,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100 + Math.sin(index / 7),
      volume: 10_000,
    }));
    const runtime = new MarketRuntime({
      apiKey: 'pieza506-offline-key',
      enableWs: false,
      nowMsFn: () => 1_780_100_000_000,
      loadBarsFn: ((req: { readonly timeframe?: string; readonly visibleBars?: number }) =>
        Promise.resolve({
          bars: (req.timeframe === '1D' ? dailyBars : intradayBars).slice(-(req.visibleBars ?? 200)),
          visibleStart: 0,
          report: { provider: 'massive', fetchedPages: 1, barsCount: 30, providerError: null },
        })) as unknown as NonNullable<MrDeps['loadBarsFn']>,
    });

    const five = await runtime.getBars('AMD', '5m', { visibleBars: 30 });
    expect(five.bars.length).toBeGreaterThan(0);
    expect(five.overlays.sessionVwapSupported).toBe(true);
    expect(five.overlays.sessionVwap).toHaveLength(five.bars.length);

    const fourHour = await runtime.getBars('AMD', '4h', { visibleBars: 30 });
    expect(fourHour.overlays.sessionVwapSupported).toBe(false);
    expect(fourHour.overlays.sessionVwap.every((value) => value === null)).toBe(true);

    const daily = await runtime.getBars('AMD', '1D', { visibleBars: 30 });
    expect(daily.overlays.sessionVwapSupported).toBe(false);
    expect(daily.overlays.sessionVwap.every((value) => value === null)).toBe(true);
  });

  it('la vista consume el overlay US, apaga marcos no soportados y conserva la preferencia', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );

    // US: overlay del backend alineado por tiempo desde las parejas originales;
    // sin recálculo local (-14_400) y con el camino AR intacto (-10_800).
    expect(src).toContain('usBarsResp.overlays.sessionVwapSupported === true');
    expect(src).toContain(
      'alignSessionVwapOverlayByTime(rawBars, usBarsResp.overlays.sessionVwap, bars)',
    );
    expect(src).not.toContain('computeSessionVwapPure(bars, isIntraday, isArMarket ? -10_800 : -14_400)');
    expect(src).not.toContain('computeSessionVwapPure(bars, isIntraday, -14_400)');
    expect(src).toContain('computeSessionVwapPure(bars, isIntraday, -10_800)');

    // Marcos US soportados: solo 1m/5m/15m (1h/4h/1D/1W apagados).
    for (const frame of ['1h', '4h', '1D', '1W']) {
      expect(src).toContain(`effectiveChartTimeframe !== '${frame}'`);
    }

    // Soporte efectivo en chip y visibilidad; serie sustituida por el bundle.
    expect(src).toContain('chartBundle.sessionVwapAvailable');
    expect(src).toContain('visible: overlays.sessionVwap && bundle.sessionVwapAvailable');
    expect(src).toContain('vwapRef.current?.setData(toLineData(bundle.sessionVwap))');
    expect(src).toContain('}, [bundle, ticker, timeframe]);');

    // Ningún tick inventa puntos: setData solo desde el bundle o limpieza.
    expect(src.split('vwapRef.current?.setData(').length - 1).toBe(2);
    expect(src.split('vwapRef.current?.update(').length - 1).toBe(0);
    expect(src.split('vwapRef.current?.setData(toLineData(bundle.sessionVwap))').length - 1).toBe(1);

    // La preferencia del usuario solo cambia con el toggle (se conserva al cambiar de marco).
    expect(src.split('setOverlays(').length - 1).toBe(1);
  });
});
