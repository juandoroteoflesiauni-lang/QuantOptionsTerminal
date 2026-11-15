/**
 * Suite Vitest 100% offline para Stock Detail unificado (`/acciones/:ticker`):
 *  - Verifica todas las funciones matemáticas puras de `web/src/components/stock-detail/stockDetailMath.ts`
 *    contra referencia independiente en Python (`fixtures/stock_detail_reference.json`, tol < 1e-9).
 *  - Verifica política Zero Silent Fallbacks (`NaN` ante faltantes/divisores inválidos).
 *  - Verifica las extensiones de DTO en `MarketRuntime` (`ema9/50/200`, NBBO, `benchmarkBars1d`)
 *    y `ArgentinaMarketRuntime` (`benchmarkBars1d`, `nextExpiry`, `adrBars`, `byStrike`).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/core/types.js';
import type { FetchFn } from '../src/data/types.js';
import { ArgentinaMarketRuntime } from '../src/server/argentinaMarketLoader.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import {
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
