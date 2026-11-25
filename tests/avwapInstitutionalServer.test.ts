import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeCohortSurvivalSeries } from '../src/core/avwap/index.js';
import { getWelfordOutput } from '../src/core/welford.js';
import type { Bar } from '../src/core/types.js';
import {
  InstitutionalAvwapRuntime,
  InstitutionalCatalystProvider,
  assertOratsUrlAllowed,
  classifyEarningsReaction,
  computeOratsStrikesGexSummary,
  normalizeOratsCoresRow,
  normalizeOratsSummaryRow,
  reconcileCorporateActions,
  renderInstitutionalAvwapContextMarkdown,
  resolveEarningsImpliedMoveDec,
  resolveEarningsTimingCascade,
  type CatalystHttpResponse,
} from '../src/server/avwap/index.js';
import { MassiveKeyRouter } from '../src/server/massiveKeyPool.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import type { TradierStreamTick } from '../src/server/tradierAdapter.js';
import type { UsHistoricalResult } from '../src/server/usHistoricalService.js';

function jsonResp(payload: unknown, status = 200): CatalystHttpResponse {
  const txt = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(txt),
  };
}

function buildDailyBars(symbolStartSec: number, count: number, startClose = 120): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < count; i += 1) {
    const close = startClose + i * 0.6;
    out.push({
      time: symbolStartSec + i * 86_400,
      open: close - 0.5,
      high: close + 1.2,
      low: close - 1.1,
      close,
      volume: 10_000_000 + i * 100_000,
      vw: close - 0.1,
    });
  }
  return out;
}

describe('Phase 2B Server AVWAP Layer (100% Offline)', () => {
  it('enforces ORATS Key #3 exclusion, blocks /live/cores, isolates OPTIONS_REST on MASSIVE_API_KEY, normalizes field-by-field, and avoids Massive WS', async () => {
    // 1. Hard-block /live/cores
    expect(() => {
      assertOratsUrlAllowed('https://api.orats.io/datav2/live/cores?ticker=SPY');
    }).toThrow(/ORATS_FORBIDDEN_ENDPOINT/);

    // 2. Zero Massive WS imports in src/server/avwap/
    for (const file of ['catalystProvider.ts', 'institutionalAvwapRuntime.ts', 'markdownExport.ts']) {
      const code = readFileSync(path.resolve(process.cwd(), 'src/server/avwap', file), 'utf-8');
      expect(code).not.toMatch(/MassiveStocksStream|MassiveWsClient|wss:\/\/.*massive/i);
    }

    // 3. Verify Key #3 exclusion + pool isolation + field normalization
    const seenOratsUrls: string[] = [];
    const seenMassiveCalls: { readonly url: string; readonly apiKey: string | null }[] = [];
    const seenFmpUrls: string[] = [];

    const env = {
      ORATS_API_KEY_1: 'orats-key-one-secret',
      ORATS_API_KEY_2: 'orats-key-two-secret',
      ORATS_API_KEY_3: 'orats-key-three-FORBIDDEN',
      MASSIVE_KEY_2: 'massive-stocks-key2',
      MASSIVE_KEY_3: 'massive-stocks-key3',
      MASSIVE_API_KEY: 'massive-options-PRIMARY',
      FMP_API_KEY: 'fmp-enterprise-secret',
    } as unknown as NodeJS.ProcessEnv;

    const router = new MassiveKeyRouter({ env, fileValues: new Map() }, { nowMsFn: () => 1_700_000_000_000 });
    const baseMassiveFetch = (url: string) => {
      const parsed = new URL(url);
      const apiKey = parsed.searchParams.get('apikey') ?? parsed.searchParams.get('apiKey');
      seenMassiveCalls.push({ url: parsed.pathname, apiKey });
      if (parsed.pathname === '/options/v1/open-interest/underlying') {
        return Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ total_oi: 16_786_351 }), headers: {} });
      }
      if (parsed.pathname.includes('/stocks/v1/splits')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({ results: [{ execution_date: '2024-06-10', split_from: 1, split_to: 10 }] }),
          headers: {},
        });
      }
      if (parsed.pathname.includes('/stocks/v1/dividends')) {
        return Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ results: [] }), headers: {} });
      }
      return Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ results: [{ free_float: 24_000_000_000 }] }), headers: {} });
    };

    const provider = new InstitutionalCatalystProvider({
      env,
      nowMsFn: () => 1_760_000_000_000,
      stocksMassiveFetchFn: router.createDomainFetchFn('STOCKS_REST', baseMassiveFetch),
      optionsMassiveFetchFn: router.createDomainFetchFn('OPTIONS_REST', baseMassiveFetch),
      oratsFetchFn: (url) => {
        seenOratsUrls.push(url);
        const u = new URL(url);
        if (u.pathname.endsWith('/live/summaries')) {
          return Promise.resolve(jsonResp({
            data: [
              {
                ticker: 'SPY',
                tradeDate: '2026-10-15',
                impliedEarningsMove: 0.042,
                iv30d: 0.145,
                exErnIv30d: 0.142,
                riskFree30: 0.0425,
                contango: 0.45,
                slope: 2.1,
                stockPrice: 999.99,
                pxAtmIv: 998.88,
              },
            ],
          }));
        }
        if (u.pathname.endsWith('/live/strikes')) {
          // Return cOi=0, pOi=0 to trigger Massive OPTIONS_REST OI fallback
          return Promise.resolve(jsonResp({
            data: [{ strike: 580, expirDate: '2026-10-16', dte: 1, cOi: 0, pOi: 0, delta: 0.5, gamma: 0.04, smvVol: 14.5 }],
          }));
        }
        if (u.pathname.endsWith('/cores')) {
          return Promise.resolve(jsonResp({
            data: [
              {
                ticker: 'SPY',
                tradeDate: '2026-10-15',
                orIvXern20d: 22.0,
                iv30d: 24.5,
                orHv5d: 19.5,
                impErnMv: 10.04,
                contango: 0.45,
                slope: 2.1,
                ivPct1y: 64,
                ivRank1y: 58,
                stockPrice: 999.99,
                pxAtmIv: 998.88,
              },
            ],
          }));
        }
        if (u.pathname.endsWith('/hist/wham')) {
          return Promise.resolve(jsonResp({ data: [{ tradeDate: '2026-10-15', wham_status: 'OK' }] }));
        }
        return Promise.resolve(jsonResp({ data: [] }));
      },
      fmpFetchFn: (url) => {
        seenFmpUrls.push(url);
        if (url.includes('/stable/splits')) {
          return Promise.resolve(jsonResp([{ date: '2024-06-10', denominator: 1, numerator: 10 }]));
        }
        return Promise.resolve(jsonResp([]));
      },
    });

    expect(provider.getAllowedOratsKeyCount()).toBe(2);

    // Concurrent calls test single-flight + TTL dedup + shared global calendars
    const [bundle1, bundle2] = await Promise.all([
      provider.fetchSymbolCatalystBundle('SPY'),
      provider.fetchSymbolCatalystBundle('SPY'),
    ]);
    expect(bundle1.fetchedAtMs).toBe(bundle2.fetchedAtMs);
    expect(seenOratsUrls.every((u) => !u.includes('orats-key-three-FORBIDDEN'))).toBe(true);
    expect(seenOratsUrls.every((u) => !u.includes('/live/cores'))).toBe(true);
    expect(seenFmpUrls.filter((u) => u.includes('/stable/sp500-constituent')).length).toBe(1);

    // Field-by-field ORATS normalization checks
    expect(bundle1.cores?.iv30dDec).toBeCloseTo(0.245, 12);
    expect(bundle1.cores?.orIvXern20dDec).toBeCloseTo(0.22, 12);
    expect(bundle1.cores?.orHv5dDec).toBeCloseTo(0.195, 12);
    expect(bundle1.cores?.impErnMvDec).toBeCloseTo(0.1004, 12);
    expect(bundle1.cores?.contango).toBe(0.45);
    expect(bundle1.cores?.slope).toBe(2.1);
    expect(bundle1.cores?.ivPct1y).toBe(64);
    expect(bundle1.cores?.blockedReferencePriceFields).toEqual(['stockPrice', 'pxAtmIv']);
    expect('stockPrice' in (bundle1.cores ?? {})).toBe(false);
    expect('pxAtmIv' in (bundle1.cores ?? {})).toBe(false);

    // Massive OPTIONS_REST isolated strictly to MASSIVE_API_KEY
    const optionsOiCalls = seenMassiveCalls.filter((c) => c.url.includes('/options/v1/open-interest/'));
    expect(optionsOiCalls.length).toBe(1);
    expect(optionsOiCalls[0]?.apiKey).toBe('massive-options-PRIMARY');
    expect(bundle1.oiReconciliation.usedMassiveFallback).toBe(true);
    expect(bundle1.oiReconciliation.effectiveTotalOi).toBe(16_786_351);
    expect(bundle1.degradationFlags).toContain('ORATS_OI_FALLBACK_MASSIVE');
    expect(bundle1.degradationFlags).toContain('FLOAT_NON_PIT_SNAPSHOT');
    expect(bundle1.degradationFlags).toContain('NO_NOI_IMBALANCE_FEED');

    // Standalone normalizer & isolated impliedEarningsMove check (never fuse impErnMv)
    const coresOnly = normalizeOratsCoresRow({ ticker: 'NVDA', impErnMv: 10.04, contango: -0.25, stockPrice: 130 });
    expect(coresOnly?.impErnMvDec).toBeCloseTo(0.1004, 12);
    expect(coresOnly?.contango).toBe(-0.25);
    const missingSummary = normalizeOratsSummaryRow({ ticker: 'NVDA', iv30d: 0.45, contango: -0.25 });
    const impMove = resolveEarningsImpliedMoveDec(missingSummary);
    expect(impMove).toBeNull();
    expect(classifyEarningsReaction(0.16, impMove)).toBe('UNCLASSIFIED');
    expect(classifyEarningsReaction(0.16, 0.09)).toBe('EARNINGS_BLOWOUT');
    expect(classifyEarningsReaction(0.03, 0.09)).toBe('EARNINGS_INLINE');
  });

  it('reconciles BMO/AMC cascade, quarantines split/dividend conflicts, gates WHAM on DIA, and degrades ADRs without ORATS cleanly', async () => {
    // 1. BMO/AMC cascade: ORATS anncTod -> MASSIVE_ETH_INFERRED -> UNKNOWN (never trust FMP time)
    expect(resolveEarningsTimingCascade({ oratsAnncTod: '1630', eventDateEt: '2024-02-21' })).toEqual({
      timing: 'AMC',
      source: 'ORATS_ANNC_TOD',
    });
    expect(resolveEarningsTimingCascade({ oratsAnncTod: '0900', eventDateEt: '2024-02-21' })).toEqual({
      timing: 'BMO',
      source: 'ORATS_ANNC_TOD',
    });
    const amcEthBars: Bar[] = [
      // 2024-02-21 17:00 ET = 22:00 UTC (EST -5)
      { time: Date.UTC(2024, 1, 21, 22, 0, 0) / 1000, open: 100, high: 112, low: 99, close: 110, volume: 2_500_000 },
      // 2024-02-21 08:00 ET = 13:00 UTC
      { time: Date.UTC(2024, 1, 21, 13, 0, 0) / 1000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 10_000 },
    ];
    expect(resolveEarningsTimingCascade({ ethBars1m: amcEthBars, eventDateEt: '2024-02-21' })).toEqual({
      timing: 'AMC',
      source: 'MASSIVE_ETH_INFERRED',
    });
    expect(resolveEarningsTimingCascade({ eventDateEt: '2024-02-21' })).toEqual({
      timing: 'UNKNOWN',
      source: 'UNKNOWN',
    });

    // 2. Corporate action conflict quarantine
    const caConflict = reconcileCorporateActions({
      massiveSplits: [{ effectiveDate: '2024-06-10', splitFrom: 1, splitTo: 10 }],
      fmpSplits: [{ effectiveDate: '2024-06-10', splitFrom: 1, splitTo: 5 }],
      massiveDividends: [{ exDate: '2023-12-27', cashAmount: 15.0 }],
      fmpDividends: [{ exDate: '2023-12-27', cashAmount: 12.0 }],
      prevCloseByDate: new Map([['2023-12-27', 674.62]]),
    });
    expect(caConflict.conflictQuarantined).toBe(true);
    expect(caConflict.splits[0]?.quarantined).toBe(true);
    expect(caConflict.splits[0]?.safeToApply).toBe(false);
    expect(caConflict.dividends[0]?.quarantined).toBe(true);
    expect(caConflict.dividends[0]?.safeToApply).toBe(false);

    // 3. WHAM gating on DIA (skips /hist/wham HTTP call) + ADR MELI without ORATS coverage
    let whamCalled = false;
    const diaProvider = new InstitutionalCatalystProvider({
      oratsApiKeys: ['orats-1'],
      fmpApiKey: 'fmp-1',
      nowMsFn: () => 1_760_000_000_000,
      oratsFetchFn: (url) => {
        if (url.includes('/hist/wham')) {
          whamCalled = true;
        }
        return Promise.resolve(jsonResp({ data: [] }, 404));
      },
      fmpFetchFn: () => Promise.resolve(jsonResp([])),
      stocksMassiveFetchFn: (url) => {
        if (url.includes('/splits')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: JSON.stringify({ results: [{ execution_date: '2024-06-10', split_from: 1, split_to: 10 }] }),
            headers: {},
          });
        }
        return Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ results: [] }), headers: {} });
      },
    });

    const diaBundle = await diaProvider.fetchSymbolCatalystBundle('DIA');
    expect(whamCalled).toBe(false);
    expect(diaBundle.wham.supported).toBe(false);
    expect(diaBundle.wham.status).toBe('UNSUPPORTED_INSTRUMENT');
    expect(diaBundle.degradationFlags).toContain('MISSING_WHAM_COVERAGE');
    expect(diaBundle.degradationFlags).toContain('NO_ORATS_COVERAGE');

    // ADR MELI Bayesian shrinkage when ORATS coverage is absent
    const meliBars = buildDailyBars(Date.UTC(2025, 0, 2, 14, 30, 0) / 1000, 10, 1850);
    const runtime = new InstitutionalAvwapRuntime({
      historicalService: {
        load: () => Promise.resolve({} as UsHistoricalResult),
        adjustmentRevision: () => 1,
      },
      catalystProvider: diaProvider,
      nowMsFn: () => 1_760_000_000_000,
    });
    const diagMeli = await runtime.hydrateSymbol('MELI', { bars1d: meliBars });
    const ytdAnchor = diagMeli.committedAnchors.find((a) => a.family === 'CALENDAR_YTD');
    expect(ytdAnchor).toBeDefined();
    expect(ytdAnchor?.iass.dataCoverage).toBeCloseTo(0.7, 12);
    expect(diagMeli.degradationFlags).toContain('NO_ORATS_COVERAGE');
  });

  it('drives Dual O(1) live state from TradierStreamTick (immutability, rollover commit, 50ms throttle, revision invalidation, fail-open)', async () => {
    let nowMs = 1_760_103_000_000; // 2025-10-10 ~13:30 UTC (RTH open window in NY)
    let revision = 1;
    const revHist = {
      load: () => Promise.resolve({} as UsHistoricalResult),
      adjustmentRevision: () => revision,
    };

    const failingProvider = new InstitutionalCatalystProvider({
      oratsApiKeys: ['orats-1'],
      oratsFetchFn: () => Promise.reject(new Error('ORATS_UPSTREAM_500')),
      fmpFetchFn: () => Promise.reject(new Error('FMP_DOWN')),
      stocksMassiveFetchFn: () => Promise.resolve({ ok: false, status: 500, text: 'ERR', headers: {} }),
      optionsMassiveFetchFn: () => Promise.resolve({ ok: false, status: 500, text: 'ERR', headers: {} }),
      nowMsFn: () => nowMs,
    });

    const runtime = new InstitutionalAvwapRuntime({
      historicalService: revHist,
      catalystProvider: failingProvider,
      nowMsFn: () => nowMs,
      projectionThrottleMs: 50,
    });

    const bars1d = buildDailyBars(Date.UTC(2025, 9, 1, 13, 30, 0) / 1000, 10, 500);
    // Must never throw even when all external HTTP providers fail
    const initialDiag = await runtime.hydrateSymbol('SPY', { bars1d });
    const initialCommitted = initialDiag.committedAnchors[0]?.committedState;
    expect(initialCommitted).toBeDefined();
    const initialSnapshotCopy = { ...(initialCommitted as NonNullable<typeof initialCommitted>) };

    // Use real NYSE RTH timestamps: 2025-10-10 10:00:00 ET = 14:00:00 UTC
    const rthMinute1 = Date.UTC(2025, 9, 10, 14, 0, 0) / 1000;
    const tickBase = (ts: number, price: number, size: number): TradierStreamTick => ({
      symbol: 'SPY',
      event: 'trade',
      price,
      size,
      bid: price - 0.01,
      bidSize: 100,
      ask: price + 0.01,
      askSize: 100,
      open: 505,
      high: 507,
      low: 504,
      cumulativeVolume: 1_000_000,
      previousClose: 504,
      asOfUtcSec: ts,
      provider: 'TRADIER',
    });

    // Tick 1 at minute 1: emits live projection
    expect(runtime.ingestTradierTick(tickBase(rthMinute1 + 5, 510.0, 5_000))).toBe(true);
    // Tick 2 only 10ms later at same minute: ingested in liveAcc, throttled (< 50ms)
    nowMs += 10;
    expect(runtime.ingestTradierTick(tickBase(rthMinute1 + 15, 512.0, 5_000))).toBe(false);
    // Tick 3 60ms later at same minute: projection updates cleanly
    nowMs += 60;
    expect(runtime.ingestTradierTick(tickBase(rthMinute1 + 40, 511.0, 5_000))).toBe(true);

    // Verify original committedState object was NEVER mutated intraminute
    expect(initialDiag.committedAnchors[0]?.committedState).toEqual(initialSnapshotCopy);

    // Rollover into minute 2 -> commits closed minute 1 into committedAnchors
    nowMs += 60;
    const rthMinute2 = rthMinute1 + 60;
    expect(runtime.ingestTradierTick(tickBase(rthMinute2 + 2, 513.0, 2_000))).toBe(true);

    const afterRollDiag = runtime.getSymbolDiagnostics('SPY');
    expect(afterRollDiag.minuteRolloverCommits).toBe(1);
    const updatedCommitted = afterRollDiag.committedAnchors[0]?.committedState;
    expect(updatedCommitted?.cumWeight).toBe((initialSnapshotCopy.cumWeight) + 15_000);
    expect(Number.isFinite(getWelfordOutput(updatedCommitted as NonNullable<typeof updatedCommitted>).vwap)).toBe(true);

    // Increment adjustmentRevision -> automatic dirty invalidation & accumulator reset
    revision = 2;
    expect(runtime.checkAdjustmentRevision('SPY')).toBe(true);
    const afterRevDiag = runtime.getSymbolDiagnostics('SPY');
    expect(afterRevDiag.dirty).toBe(true);
    expect(afterRevDiag.liveAccumulator).toBeNull();

    // Update market context with NEGATIVE_GAMMA (g < -0.30) and validate Confluence, Policy, and Markdown Export
    runtime.updateMarketContext('SPY', {
      asOfUtcSec: rthMinute2 + 2,
      spot: 506.0,
      atr14: 4.0,
      dollarVol20d: 100_000_000, // G0 = 1_000_000
      netGex: -600_000, // tanh(-0.6) = -0.537 < -0.30 -> SHORT_GAMMA_BOUNCE_HAZARD
      callWallStrike: 512,
      putWallStrike: 500,
      zeroGamma: 506,
      vpPoc: 506,
      vpVah: 510,
      vpVal: 502,
      vpHvns: [506],
      vpLvns: [506],
      cvdAbsorptionScore: 0.4,
      cvdDirectionalAlignment: 0.85,
      bucketRvolZ: 2.1,
      contango: 0.1,
      spyIv30dDec: 0.27,
      bars1d,
    });

    await runtime.hydrateSymbol('SPY', {
      bars1d,
      extraFamilies: ['POST_OPEX', 'EARNINGS_INLINE', 'SWING_NO_RVOL', 'EX_DIVIDEND_REGULAR'],
    });
    const postHydrate = runtime.getSymbolDiagnostics('SPY');
    // Verify POST_OPEX & negative controls strictly excluded by DEFAULT_AVWAP_CONTEXT_POLICY
    expect(postHydrate.committedAnchors.some((a) => a.family === 'POST_OPEX')).toBe(false);
    expect(postHydrate.committedAnchors.some((a) => a.family === 'EARNINGS_INLINE')).toBe(false);
    expect(postHydrate.committedAnchors.some((a) => a.family === 'SWING_NO_RVOL')).toBe(false);
    expect(postHydrate.committedAnchors.some((a) => a.family === 'EX_DIVIDEND_REGULAR')).toBe(false);

    const ctx = runtime.getSnapshotContext('SPY', '1D');
    expect(ctx).not.toBeNull();
    expect(ctx?.gammaRegime).toBe('NEGATIVE_GAMMA');
    expect(ctx?.volRegime).toBe('HIGH_VOL_TREND');
    expect(ctx?.hazardFlags).toContain('SHORT_GAMMA_BOUNCE_HAZARD');

    // Backward compatibility of Markdown exporter
    expect(renderInstitutionalAvwapContextMarkdown(undefined)).toBe('');
    const exportPayload = runtime.getOptionsExportPayload('SPY', '1D');
    expect(exportPayload).not.toBeNull();
    expect(exportPayload?.opexResetMarkerDates).toEqual([]);
    const md = renderInstitutionalAvwapContextMarkdown(exportPayload ?? undefined);
    expect(md).toContain('### Institutional AVWAP Context');
    expect(md).toContain('Context Only');
    expect(md).toContain('SHORT_GAMMA_BOUNCE_HAZARD');
    expect(md).toContain('Bounce');
    expect(md).toContain('Breakout');
  });

  it('wires TradierStreamTick -> institutionalAvwapContext inside MarketRuntime snapshot without Massive WS', async () => {
    const nowSec = Math.floor(Date.UTC(2025, 2, 11, 14, 30, 0) / 1000); // 2025-03-11 10:30 ET (RTH)
    const barsPayload = (count: number, stepSec: number) => {
      const results: Record<string, unknown>[] = [];
      const endSec = Math.floor((nowSec - stepSec) / stepSec) * stepSec;
      for (let i = count - 1; i >= 0; i -= 1) {
        const c = 595 + Math.sin(i * 0.2) * 1.5;
        results.push({
          t: (endSec - i * stepSec) * 1000,
          o: c - 0.3,
          h: c + 0.8,
          l: c - 0.8,
          c,
          v: 250_000,
          vw: c - 0.05,
        });
      }
      return { status: 'OK', ticker: 'SPY', resultsCount: results.length, results };
    };

    const runtime = new MarketRuntime({
      apiKey: 'test-offline-massive-key',
      nowMsFn: () => nowSec * 1000,
      enableWs: false,
      fetchFn: (url: string) => {
        const u = new URL(url);
        const p = u.pathname;
        if (p.startsWith('/v2/aggs/ticker/')) {
          const isDay = p.includes('/day/');
          return Promise.resolve({
            ok: true,
            status: 200,
            text: JSON.stringify(barsPayload(isDay ? 60 : 80, isDay ? 86_400 : 300)),
            headers: {},
          });
        }
        if (p === '/v3/snapshot') {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: JSON.stringify({
              status: 'OK',
              results: [
                {
                  ticker: 'SPY',
                  type: 'stocks',
                  market_status: 'open',
                  session: { price: 595, close: 595, previous_close: 593, volume: 25_000_000 },
                  last_trade: { price: 595, size: 100, sip_timestamp: String(nowSec * 1_000_000_000) },
                  last_quote: { bid: 594.99, ask: 595.01, midpoint: 595 },
                },
                {
                  ticker: 'I:VIX',
                  type: 'indices',
                  market_status: 'open',
                  value: 16.5,
                  session: { price: 16.5, previous_close: 16.8 },
                },
              ],
            }),
            headers: {},
          });
        }
        if (p === '/fed/v1/treasury-yields') {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: JSON.stringify({
              status: 'OK',
              results: [{ date: '2025-03-11', yield_1_month: 4.3, yield_1_year: 4.15, yield_10_year: 4.25 }],
            }),
            headers: {},
          });
        }
        if (p === '/fed/v1/funding-conditions') {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: JSON.stringify({ status: 'OK', results: [{ date: '2025-03-11', sofr: 4.31 }] }),
            headers: {},
          });
        }
        return Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ status: 'OK', results: [] }), headers: {} });
      },
    });

    const snap = await runtime.getSnapshot('SPY', { forceRefresh: false });
    expect(snap.institutionalAvwapContext).toBeDefined();
    expect(snap.institutionalAvwapContext?.role).toBe('INSTITUTIONAL_CONTEXT_ONLY');
    expect(snap.institutionalAvwapContext?.volRegime).toBeDefined();
    const exportPayload = runtime.getInstitutionalAvwapExportPayload('SPY', '1D');
    expect(exportPayload?.role).toBe('INSTITUTIONAL_CONTEXT_ONLY');
    expect(renderInstitutionalAvwapContextMarkdown(exportPayload ?? undefined)).toContain(
      '### Institutional AVWAP Context',
    );
  });

  it('hardens Massive OI query params, ORATS WHAM live/hist routing, pre-event /hist/summaries EARNINGS_BLOWOUT, YTD 1D retention & strikes GEX fallback (Phase 2B.1)', async () => {
    const seenOptionsUrls: string[] = [];
    const seenOratsUrls: string[] = [];

    const provider = new InstitutionalCatalystProvider({
      oratsApiKeys: ['orats-key-1'],
      excludedOratsKeys: ['orats-key-3'],
      fmpApiKey: 'fmp-key-1',
      nowMsFn: () => Date.UTC(2026, 10, 25, 16, 0, 0),
      optionsMassiveFetchFn: (url) => {
        seenOptionsUrls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({
            results: [
              { underlying_ticker: 'QQQ', date: '2026-11-24', open_interest: 14_474_848 },
              { underlying_ticker: 'QQQ', date: '2026-11-25', open_interest: 14_623_724 },
            ],
          }),
          headers: {},
        });
      },
      stocksMassiveFetchFn: () =>
        Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ results: [] }), headers: {} }),
      fmpFetchFn: () => Promise.resolve(jsonResp([])),
      oratsFetchFn: (url) => {
        seenOratsUrls.push(url);
        const u = new URL(url);
        if (u.pathname.endsWith('/wham') && !u.pathname.endsWith('/hist/wham')) {
          return Promise.resolve(jsonResp({ data: [{ ticker: 'QQQ', tradeDate: '2026-11-25', wham: 1.0 }] }));
        }
        if (u.pathname.endsWith('/hist/wham')) {
          if (!u.searchParams.get('tradeDate')) {
            return Promise.resolve(jsonResp({ error: 'tradeDate required' }, 400));
          }
          return Promise.resolve(jsonResp({ data: [{ ticker: 'QQQ', tradeDate: '2026-11-24', wham: 1.0 }] }));
        }
        if (u.pathname.endsWith('/live/summaries')) {
          return Promise.resolve(
            jsonResp({
              data: [
                { ticker: 'MELI', tradeDate: '2026-11-25', impliedEarningsMove: 0.0, iv30d: 0.42, contango: 0.2 },
              ],
            }),
          );
        }
        if (u.pathname.endsWith('/hist/summaries')) {
          const td = u.searchParams.get('tradeDate');
          const ticker = u.searchParams.get('ticker');
          if (ticker === 'MELI' && td === '2026-11-04') {
            return Promise.resolve(
              jsonResp({
                data: [{ ticker: 'MELI', tradeDate: '2026-11-04', impliedEarningsMove: 0.0683, iv30d: 0.47 }],
              }),
            );
          }
          if (ticker === 'NVDA' && td === '2026-11-17') {
            return Promise.resolve(
              jsonResp({
                data: [{ ticker: 'NVDA', tradeDate: '2026-11-17', impliedEarningsMove: 0.0802, iv30d: 0.66 }],
              }),
            );
          }
          return Promise.resolve(jsonResp({ data: [] }));
        }
        if (u.pathname.endsWith('/hist/earnings')) {
          const ticker = u.searchParams.get('ticker');
          if (ticker === 'MELI') {
            return Promise.resolve(
              jsonResp({ data: [{ ticker: 'MELI', earnDate: '2026-11-04', anncTod: '1630' }] }),
            );
          }
          if (ticker === 'NVDA') {
            return Promise.resolve(
              jsonResp({ data: [{ ticker: 'NVDA', earnDate: '2026-11-17', anncTod: '1630' }] }),
            );
          }
        }
        if (u.pathname.endsWith('/live/strikes')) {
          return Promise.resolve(
            jsonResp({
              data: [
                {
                  strike: 1500,
                  expirDate: '2026-11-27',
                  dte: 3,
                  callOpenInterest: 800,
                  putOpenInterest: 200,
                  delta: 0.4,
                  gamma: 0.008,
                  smvVol: 0.42,
                  stockPrice: 9999.0,
                },
                {
                  strike: 1400,
                  expirDate: '2026-11-27',
                  dte: 3,
                  callOpenInterest: 100,
                  putOpenInterest: 1200,
                  delta: -0.35,
                  gamma: 0.009,
                  smvVol: 0.44,
                  stockPrice: 9999.0,
                },
              ],
            }),
          );
        }
        return Promise.resolve(jsonResp({ data: [] }));
      },
    });

    // 1. Massive OPTIONS_REST OI uses query params and takes ONLY latest trade date (never sums)
    const oiRes = await provider.reconcileOpenInterest('QQQ', []);
    expect(oiRes.source).toBe('MASSIVE_FALLBACK');
    expect(oiRes.effectiveTotalOi).toBe(14_623_724);
    expect(seenOptionsUrls.length).toBe(1);
    const oiUrl = new URL(seenOptionsUrls[0] ?? 'https://example.com');
    expect(oiUrl.pathname).toBe('/options/v1/open-interest/underlying');
    expect(oiUrl.searchParams.get('underlying_ticker')).toBe('QQQ');
    expect(oiUrl.searchParams.get('date.gte')).toBe('2026-11-15');
    expect(oiUrl.searchParams.get('date.lte')).toBe('2026-11-25');

    // 2. ORATS WHAM on QQQ uses /wham?ticker=QQQ (0 /hist/wham HTTP 400 errors, zero MISSING_WHAM_COVERAGE)
    const qqqBundle = await provider.fetchSymbolCatalystBundle('QQQ', { latestTradingDate: '2026-11-24' });
    expect(qqqBundle.wham.supported).toBe(true);
    expect(qqqBundle.wham.status).toBe('OK');
    expect(qqqBundle.degradationFlags).not.toContain('MISSING_WHAM_COVERAGE');
    expect(qqqBundle.providerWarnings).toEqual([]);
    expect(qqqBundle.strikes.every((s) => s.callOpenInterest > 0 || s.putOpenInterest > 0)).toBe(true);

    // 3. Pre-event /hist/summaries EARNINGS_BLOWOUT for MELI (2026-11-04 AMC -> reactDate 2026-11-05)
    // while NVDA (2026-11-17 AMC -> -2.89% vs 8.02%) resolves to EARNINGS_INLINE and is blocked from runtime
    const meliBars: Bar[] = [
      { time: Date.UTC(2026, 0, 2, 14, 30, 0) / 1000, open: 1700, high: 1720, low: 1690, close: 1710, volume: 300_000 },
      { time: Date.UTC(2026, 10, 4, 14, 30, 0) / 1000, open: 1735, high: 1750, low: 1720, close: 1739.88, volume: 400_000 },
      { time: Date.UTC(2026, 10, 5, 14, 30, 0) / 1000, open: 1550, high: 1560, low: 1510, close: 1530.28, volume: 900_000 },
      { time: Date.UTC(2026, 10, 24, 14, 30, 0) / 1000, open: 1495, high: 1510, low: 1480, close: 1500.0, volume: 450_000 },
    ];
    const nvdaBars: Bar[] = [
      { time: Date.UTC(2026, 0, 2, 14, 30, 0) / 1000, open: 150, high: 152, low: 149, close: 151, volume: 10_000_000 },
      { time: Date.UTC(2026, 10, 17, 14, 30, 0) / 1000, open: 155, high: 157, low: 154, close: 155.46, volume: 20_000_000 },
      { time: Date.UTC(2026, 10, 18, 14, 30, 0) / 1000, open: 151, high: 152, low: 149, close: 150.96, volume: 25_000_000 },
      { time: Date.UTC(2026, 10, 24, 14, 30, 0) / 1000, open: 150, high: 152, low: 149, close: 151.0, volume: 15_000_000 },
    ];

    const rt = new InstitutionalAvwapRuntime({
      historicalService: null,
      catalystProvider: provider,
      nowMsFn: () => Date.UTC(2026, 10, 25, 16, 0, 0),
    });

    const meliDiag = await rt.hydrateSymbol('MELI', { bars1d: meliBars, forceRefresh: true });
    const blowoutAnchor = meliDiag.committedAnchors.find((a) => a.family === 'EARNINGS_BLOWOUT');
    expect(blowoutAnchor).toBeDefined();
    expect(blowoutAnchor?.anchorTimeSec).toBe(Date.UTC(2026, 10, 5, 14, 30, 0) / 1000);
    expect(blowoutAnchor?.polarity).toBe('SHORT');

    const nvdaDiag = await rt.hydrateSymbol('NVDA', { bars1d: nvdaBars, forceRefresh: true });
    expect(nvdaDiag.committedAnchors.some((a) => a.family === 'EARNINGS_BLOWOUT')).toBe(false);
    expect(nvdaDiag.committedAnchors.some((a) => a.family === 'EARNINGS_INLINE')).toBe(false);
    expect(nvdaDiag.committedAnchors.some((a) => a.family === 'CALENDAR_YTD')).toBe(true);

    // 4. Strikes GEX fallback uses real spot (ignores ORATS stockPrice=9999) and yields non-null regime/confluence
    const realSpot = 1480.0;
    rt.updateMarketContext('MELI', {
      asOfUtcSec: Date.UTC(2026, 10, 24, 21, 0, 0) / 1000,
      spot: realSpot,
      atr14: 60.0,
      dollarVol20d: 750_000_000,
      netGex: null,
      callWallStrike: null,
      putWallStrike: null,
      zeroGamma: null,
      vpPoc: 1510.0,
      vpVah: 1540.0,
      vpVal: 1460.0,
      vpHvns: [1510.0],
      vpLvns: [1485.0],
      cvdAbsorptionScore: 0.7,
      cvdDirectionalAlignment: 0.65,
      bucketRvolZ: 1.5,
      contango: 0.2,
      spyIv30dDec: 0.22,
      bars1d: meliBars,
    });
    const meliSnap = rt.getSnapshotContext('MELI', '1D');
    expect(meliSnap).not.toBeNull();
    expect(meliSnap?.gammaRegime).toBe('NEGATIVE_GAMMA');
    expect(meliSnap?.volRegime).toBe('MID_VOL');
    expect((meliSnap?.bounceConfluenceScore ?? 0) > 0 || (meliSnap?.breakoutConfluenceScore ?? 0) > 0).toBe(true);

    const gexFallback = computeOratsStrikesGexSummary(qqqBundle.strikes, realSpot);
    expect(gexFallback.netGex).not.toBeNull();
    expect(gexFallback.callWallStrike).toBe(1500);
    expect(gexFallback.putWallStrike).toBe(1400);
    expect(gexFallback.zeroGamma).not.toBeNull();
    expect((gexFallback.zeroGamma ?? 0) >= 1400 && (gexFallback.zeroGamma ?? 0) <= 1500).toBe(true);
    expect(seenOratsUrls.every((u) => !u.includes('/live/cores'))).toBe(true);

    // 5. CALENDAR_YTD is exempt from COHORT_DECAY in 1D even under 3x float turnover (while VOLUME_CLIMAX triggers)
    const heavyVols = new Array<number>(12).fill(300_000);
    const ytdCohort = computeCohortSurvivalSeries({
      volumes: heavyVols,
      anchorIdx: 0,
      freeFloat: 1_000_000,
      family: 'CALENDAR_YTD',
      timeframe: '1D',
      floatIsPit: true,
    });
    expect(ytdCohort.exemptApplied).toBe(true);
    expect(ytdCohort.triggered).toBe(false);

    const climaxCohort = computeCohortSurvivalSeries({
      volumes: heavyVols,
      anchorIdx: 0,
      freeFloat: 1_000_000,
      family: 'VOLUME_CLIMAX',
      timeframe: '1D',
      floatIsPit: true,
    });
    expect(climaxCohort.exemptApplied).toBe(false);
    expect(climaxCohort.triggered).toBe(true);
  });
});
