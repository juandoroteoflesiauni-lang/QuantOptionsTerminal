import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import { ArgentinaMarketRuntime, type ArHttpFn } from '../src/server/argentinaMarketLoader.js';
import { GgalSpecialistRuntime } from '../src/server/ggalSpecialistRuntime.js';
import type { FetchFn } from '../src/data/types.js';
import { priceBsm } from '../src/core/options/blackScholes.js';
import { boxesOverlap, layoutCurveLabels } from '../src/core/bondCurveLayout.js';
import {
  computeDualChartVisibleRange,
  filterOverlayLevelsForCoordMode,
} from '../src/core/ggal/chartCoordGuard.js';
import {
  mergeFmpPaginatedBars,
  planFmpIntradayDateWindows,
} from '../src/core/ggal/fmpPagination.js';
import { computeIndividualOptionRepricingBsm } from '../src/core/ggal/parityGap.js';
import { computeMaxPainStrike } from '../src/core/options/exposure.js';
import { ArFeedRouter } from '../src/server/arFeedRouter.js';
import { FmpEnterpriseClient, loadFmpConfigFromEnv } from '../src/server/fmpClient.js';
import {
  GgalAdrDeepHistoryStore,
  isGgalPaginatedHistoryTimeframe,
} from '../src/server/ggalDeepHistory.js';
import {
  computeDlrContractMetrics,
  isArMarketOutOfSession,
  mergePrimaryMarketData,
  PrimaryRofexClient,
  resolveMervBookTarget,
  type PrimaryWsLike,
} from '../src/server/primaryRofexLoader.js';

interface FixtureRoot {
  readonly fmpPagination: {
    readonly fromUtcSec: number;
    readonly toUtcSec: number;
    readonly windows15m: readonly { readonly fromUtcSec: number; readonly toUtcSec: number }[];
    readonly windows1h: readonly { readonly fromUtcSec: number; readonly toUtcSec: number }[];
    readonly windows4h: readonly { readonly fromUtcSec: number; readonly toUtcSec: number }[];
    readonly pagesInput: readonly (readonly {
      readonly time: number;
      readonly open: number;
      readonly high: number;
      readonly low: number;
      readonly close: number;
      readonly volume: number;
    }[])[];
    readonly expectedMerged: readonly {
      readonly time: number;
      readonly open: number;
      readonly high: number;
      readonly low: number;
      readonly close: number;
      readonly volume: number;
    }[];
  };
  readonly bsmRepricing: {
    readonly adrPriceUsd: number;
    readonly cclRate: number;
    readonly spotTeoricoArs: number;
    readonly cases: readonly {
      readonly input: {
        readonly tickerByma: string;
        readonly prevSpotArs: number;
        readonly projectedSpotArs: number;
        readonly strikeArs: number;
        readonly contractType: 'call' | 'put';
        readonly timeToExpiryYears: number;
        readonly iv: number;
        readonly rateCont: number;
        readonly prevCloseArs: number;
      };
      readonly expected: {
        readonly tickerByma: string;
        readonly prevCloseArs: number;
        readonly fairOpenArs: number;
        readonly deltaRepricePct: number;
        readonly bsmFairPrevArs: number;
        readonly bsmFairProjectedArs: number;
        readonly deltaAtClose: number;
        readonly gammaAtClose: number;
      };
    }[];
  };
  readonly dlrOutOfSession: readonly {
    readonly name: string;
    readonly input: Parameters<typeof computeDlrContractMetrics>[0];
    readonly expected: {
      readonly priceBasis: 'LAST' | 'MID' | 'SETTLEMENT_EOD' | 'NONE';
      readonly status: 'LIVE' | 'CIERRE_AJUSTE' | 'NONE';
      readonly referencePrice: number;
      readonly spotUsed: number;
      readonly spotSource: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE';
      readonly maturityUtcSec: number;
      readonly days: number;
      readonly baseArs: number;
      readonly devalDirectaPct: number;
      readonly tnaImplicitaPct: number;
      readonly teaImplicitaPct: number;
      readonly temImplicitaPct: number;
    };
  }[];
  readonly bondCurveLayout: {
    readonly points: readonly { readonly id: string; readonly label: string; readonly x: number; readonly y: number }[];
    readonly expected: readonly {
      readonly id: string;
      readonly labelX: number;
      readonly labelY: number;
      readonly textAnchor: 'start' | 'middle' | 'end';
      readonly needsLeader: boolean;
      readonly overlapCount: number;
    }[];
  };
  readonly coordGuardAndMaxPain: {
    readonly usBars: readonly {
      readonly timeSec: number;
      readonly open: number;
      readonly high: number;
      readonly low: number;
      readonly close: number;
      readonly volume: number;
    }[];
    readonly arsLeakOnUsdInput: {
      readonly activeCoordMode: 'USD_ADR_NASDAQ';
      readonly payloadCoordMode: 'USD_ADR_NASDAQ';
      readonly levels: {
        readonly callWall: number;
        readonly putWall: number;
        readonly zeroGamma: number;
        readonly maxPain: number;
      };
    };
    readonly arsLeakOnUsdExpected: {
      readonly callWall: number | null;
      readonly putWall: number | null;
      readonly zeroGamma: number | null;
      readonly maxPain: number | null;
    };
    readonly maxPainContracts: readonly {
      readonly strike: number;
      readonly contractType: 'call' | 'put';
      readonly openInterest: number;
    }[];
    readonly expectedMaxPain: number;
  };
}

function loadFixture(): FixtureRoot {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'fixtures', 'pieza44_ggal_dlr_reference.json'), 'utf8'),
  ) as FixtureRoot;
}

describe('Pieza 44 — Paridad matemática exacta (< 1e-9) contra fixtures/pieza44_ggal_dlr_reference.json', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('valida paginación y deduplicación FMP intradiaria para 15m, 1H y 4H', () => {
    const f = loadFixture().fmpPagination;
    const w15 = planFmpIntradayDateWindows({
      fromUtcSec: f.fromUtcSec,
      toUtcSec: f.toUtcSec,
      timeframe: '15m',
    });
    const w1h = planFmpIntradayDateWindows({
      fromUtcSec: f.fromUtcSec,
      toUtcSec: f.toUtcSec,
      timeframe: '1h',
    });
    const w4h = planFmpIntradayDateWindows({
      fromUtcSec: f.fromUtcSec,
      toUtcSec: f.toUtcSec,
      timeframe: '4h',
    });

    expect(w15).toEqual(f.windows15m);
    expect(w1h).toEqual(f.windows1h);
    expect(w4h).toEqual(f.windows4h);
    expect(isGgalPaginatedHistoryTimeframe('4h')).toBe(true);
    expect(isGgalPaginatedHistoryTimeframe('15m')).toBe(true);
    expect(isGgalPaginatedHistoryTimeframe('1h')).toBe(true);

    const merged = mergeFmpPaginatedBars(f.pagesInput, {
      fromUtcSec: f.fromUtcSec,
      toUtcSec: f.toUtcSec,
    });
    expect(merged).toEqual(f.expectedMerged);
    expect(merged[0]?.time).toBeLessThan(Date.UTC(2025, 9, 27) / 1_000);
  });

  it('valida repricing BSM individual GFGC*/GFGV* sin valores planos uniformes (< 1e-9)', () => {
    const { cases } = loadFixture().bsmRepricing;
    const distinctPct = new Set<string>();

    for (const c of cases) {
      const snapshot = JSON.stringify(c.input);
      const res = computeIndividualOptionRepricingBsm(c.input);
      expect(JSON.stringify(c.input)).toBe(snapshot);

      expect(res.tickerByma).toBe(c.expected.tickerByma);
      expect(Math.abs(res.fairOpenArs - c.expected.fairOpenArs)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(res.deltaRepricePct - c.expected.deltaRepricePct)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs((res.bsmFairPrevArs ?? Number.NaN) - c.expected.bsmFairPrevArs)).toBeLessThanOrEqual(1e-9);
      expect(
        Math.abs((res.bsmFairProjectedArs ?? Number.NaN) - c.expected.bsmFairProjectedArs),
      ).toBeLessThanOrEqual(1e-9);
      expect(Math.abs((res.deltaAtClose ?? Number.NaN) - c.expected.deltaAtClose)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs((res.gammaAtClose ?? Number.NaN) - c.expected.gammaAtClose)).toBeLessThanOrEqual(1e-9);
      distinctPct.add(res.deltaRepricePct.toFixed(6));
    }

    // Cada strike/moneyness/IV genera su propia variación porcentual distinta (nunca plana).
    expect(distinctPct.size).toBe(cases.length);
  });

  it('valida Devaluación Directa, TNA, TEA, Base y prioridad SE -> CL -> LA en DLR/* fuera de rueda (< 1e-9)', () => {
    const cases = loadFixture().dlrOutOfSession;
    for (const c of cases) {
      const res = computeDlrContractMetrics(c.input);
      expect(res.priceBasis).toBe(c.expected.priceBasis);
      expect(res.status).toBe(c.expected.status);
      expect(res.spotSource).toBe(c.expected.spotSource);
      expect(Math.abs(res.referencePrice - c.expected.referencePrice)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(res.spotUsed - c.expected.spotUsed)).toBeLessThanOrEqual(1e-9);
      expect(res.maturityUtcSec).toBe(c.expected.maturityUtcSec);
      expect(res.days).toBe(c.expected.days);
      expect(Math.abs(res.baseArs - c.expected.baseArs)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(res.devalDirectaPct - c.expected.devalDirectaPct)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(res.tnaImplicitaPct - c.expected.tnaImplicitaPct)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(res.teaImplicitaPct - c.expected.teaImplicitaPct)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(res.temImplicitaPct - c.expected.temImplicitaPct)).toBeLessThanOrEqual(1e-9);
    }

    // Verifica horario ART: lunes 12:30 ART en rueda; sábado o 20:00 ART fuera de rueda.
    expect(isArMarketOutOfSession(Math.floor(Date.UTC(2026, 10, 16, 15, 30, 0) / 1_000))).toBe(false);
    expect(isArMarketOutOfSession(Math.floor(Date.UTC(2026, 10, 16, 23, 0, 0) / 1_000))).toBe(true);
    expect(isArMarketOutOfSession(Math.floor(Date.UTC(2026, 10, 21, 15, 0, 0) / 1_000))).toBe(true);
  });

  it('valida layout anti-colisión determinístico de etiquetas en Curva TIR vs. Duration (< 1e-9 y 0 choques)', () => {
    const f = loadFixture().bondCurveLayout;
    const placements = layoutCurveLabels(f.points);
    expect(placements).toHaveLength(f.expected.length);

    for (let i = 0; i < placements.length; i += 1) {
      const actual = placements[i];
      const expected = f.expected[i];
      if (actual === undefined || expected === undefined) {
        throw new Error('Placement count mismatch');
      }
      expect(actual.id).toBe(expected.id);
      expect(Math.abs(actual.labelX - expected.labelX)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(actual.labelY - expected.labelY)).toBeLessThanOrEqual(1e-9);
      expect(actual.textAnchor).toBe(expected.textAnchor);
      expect(actual.needsLeader).toBe(expected.needsLeader);
      expect(actual.overlapCount).toBe(0);
    }

    // Validación geométrica por pares entre todas las cajas colocadas.
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const a = placements[i]?.box;
        const b = placements[j]?.box;
        if (a !== undefined && b !== undefined) {
          expect(boxesOverlap(a, b, 2.0)).toBe(false);
        }
      }
    }
  });

  it('valida guardias de moneda ARS/USD para overlays, rango visible y Max Pain US ADR (< 1e-9)', () => {
    const f = loadFixture().coordGuardAndMaxPain;
    const filtered = filterOverlayLevelsForCoordMode({
      activeCoordMode: f.arsLeakOnUsdInput.activeCoordMode,
      payloadCoordMode: f.arsLeakOnUsdInput.payloadCoordMode,
      bars: f.usBars,
      levels: f.arsLeakOnUsdInput.levels,
    });
    expect(filtered.coordMatched).toBe(true);
    expect(Number.isNaN(filtered.levels.callWall)).toBe(true);
    expect(filtered.levels.putWall).toBe(f.arsLeakOnUsdExpected.putWall);
    expect(Number.isNaN(filtered.levels.zeroGamma)).toBe(true);
    expect(filtered.levels.maxPain).toBe(f.arsLeakOnUsdExpected.maxPain);

    // Mismatch explícito de coordMode purga absolutamente todos los niveles y zonas.
    const mismatch = filterOverlayLevelsForCoordMode({
      activeCoordMode: 'USD_ADR_NASDAQ',
      payloadCoordMode: 'ARS_BYMA',
      bars: f.usBars,
      levels: { callWall: 50, putWall: 48, zeroGamma: 49, maxPain: 50 },
    });
    expect(mismatch.coordMatched).toBe(false);
    expect(Number.isNaN(mismatch.levels.putWall)).toBe(true);

    // Encuadre visible sin espacio muerto a la derecha
    expect(computeDualChartVisibleRange({ totalBars: 60, maxVisibleBars: 220, rightPaddingBars: 2 })).toEqual({
      from: 0,
      to: 61,
    });
    expect(computeDualChartVisibleRange({ totalBars: 800, maxVisibleBars: 220, rightPaddingBars: 2 })).toEqual({
      from: 580,
      to: 801,
    });

    const maxPain = computeMaxPainStrike(f.maxPainContracts);
    expect(Math.abs(maxPain - f.expectedMaxPain)).toBeLessThanOrEqual(1e-9);
  });

  it('integración: FmpEnterpriseClient.fetchHistoricalPaginated cubre >14m pre-electoral y GgalAdrDeepHistoryStore persiste 4h en disco', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'pieza44-fmp-'));
    tempDirs.push(cacheDir);
    const nowSec = Math.floor(Date.UTC(2026, 10, 20, 18, 0, 0) / 1_000);
    const urlsCalled: string[] = [];

    const client = new FmpEnterpriseClient({
      config: loadFmpConfigFromEnv({ FMP_API_KEY: 'fmp_pieza44_test' }),
      nowMsFn: () => nowSec * 1_000,
      fetchFn: async (url) => {
        urlsCalled.push(url);
        await Promise.resolve();
        const parsed = new URL(url);
        const fromStr = parsed.searchParams.get('from') ?? '2026-11-01';
        const toStr = parsed.searchParams.get('to') ?? '2026-11-20';
        // Simula FMP Enterprise devolviendo barras solo dentro de la ventana [from, to] pedida
        return {
          ok: true,
          status: 200,
          text: JSON.stringify([
            { date: `${toStr} 14:00:00`, open: 54.0, high: 54.8, low: 53.5, close: 54.5, volume: 11_000 },
            { date: `${fromStr} 10:00:00`, open: 48.0, high: 48.9, low: 47.7, close: 48.4, volume: 9_500 },
          ]),
        };
      },
    });

    const res4h = await client.fetchHistoricalPaginated({
      symbol: 'GGAL',
      timeframe: '4h',
      fromUtcSec: Date.UTC(2025, 8, 15, 0, 0, 0) / 1_000,
      toUtcSec: nowSec,
      includeExtended: false,
    });

    expect(urlsCalled.length).toBeGreaterThanOrEqual(7);
    expect(res4h.rows).toBeGreaterThanOrEqual(10);
    expect(res4h.bars[0]?.time ?? Number.POSITIVE_INFINITY).toBeLessThan(Date.UTC(2025, 9, 27) / 1_000);
    for (let i = 1; i < res4h.bars.length; i += 1) {
      const prev = res4h.bars[i - 1];
      const curr = res4h.bars[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr.time).toBeGreaterThan(prev.time);
      }
    }

    const store = new GgalAdrDeepHistoryStore({ cacheDir, nowMsFn: () => nowSec * 1_000 });
    const saved = await store.ensure('4h', {
      forceRefresh: false,
      loadFn: async () => Promise.resolve(res4h.bars),
    });
    expect(saved.length).toBe(res4h.bars.length);
    const storeReload = new GgalAdrDeepHistoryStore({ cacheDir, nowMsFn: () => nowSec * 1_000 });
    let networkRehit = false;
    const instantReload = await storeReload.ensure('4h', {
      forceRefresh: false,
      loadFn: () => {
        networkRehit = true;
        return Promise.resolve([]);
      },
    });
    expect(networkRehit).toBe(false);
    expect(instantReload.length).toBe(res4h.bars.length);
  });

  it('integración: DLR/* conserva CL/SE en cierre/reinicio fuera de rueda y L2 5 puntas MERV soporta clave canónica + CI + EOD', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'pieza44-primary-'));
    tempDirs.push(cacheDir);
    const cacheFile = join(cacheDir, 'primary-closures.json');

    expect(resolveMervBookTarget('AR:GGAL:24hs')).toEqual({
      ticker: 'GGAL',
      preferredSettlement: '24HS',
    });
    expect(resolveMervBookTarget('MERV - XMEV - GGAL - CI')).toEqual({
      ticker: 'GGAL',
      preferredSettlement: 'CI',
    });

    // Verifica que un tick incremental con LA/SE/CL en null NO borra cierre previo válido
    const mergedClean = mergePrimaryMarketData(
      {
        symbol: 'DLR/DIC26',
        marketId: 'ROFX',
        bids: [],
        asks: [],
        last: 1545,
        settlement: 1552.5,
        close: 1550,
        open: null,
        high: null,
        low: null,
        openInterest: 1000,
        nominalVolume: 500,
        impliedVol: null,
        updatedAtUtcSec: 1795200000,
        lastTradeAtUtcSec: 1795200000,
        turnover: null,
      },
      {
        symbol: 'DLR/DIC26',
        marketId: 'ROFX',
        bids: [],
        asks: [],
        last: null,
        settlement: null,
        close: null,
        open: null,
        high: null,
        low: null,
        openInterest: null,
        nominalVolume: null,
        impliedVol: null,
        updatedAtUtcSec: null,
        lastTradeAtUtcSec: null,
        turnover: null,
      },
      new Set(['BI', 'OF', 'LA', 'SE', 'CL']),
    );
    expect(mergedClean.settlement).toBe(1552.5);
    expect(mergedClean.close).toBe(1550);
    expect(mergedClean.last).toBe(1545);

    // Simula sábado 15:00 UTC (fuera de rueda) con Primary REST snapshot CL/SE y libro L2 en CI
    const saturdayMs = Date.UTC(2026, 10, 21, 15, 0, 0);
    const wsHandlers: ((raw: unknown) => void)[] = [];
    const client = new PrimaryRofexClient({
      env: {
        PRIMARY_API_URL: 'https://primary.test',
        PRIMARY_WS_URL: 'wss://primary.test/',
        PRIMARY_USERNAME: 'u_test',
        PRIMARY_PASSWORD: 'p_test_secret',
        PRIMARY_ACCOUNT: 'ACC1',
      },
      secrets: ['p_test_secret'],
      nowMsFn: () => saturdayMs,
      persistCachePath: cacheFile,
      wsFactory: (): PrimaryWsLike => {
        const sock: PrimaryWsLike = {
          readyState: 1,
          send: () => undefined,
          close: () => undefined,
          on: ((ev: 'open' | 'message' | 'error' | 'close', cb: (...args: unknown[]) => void) => {
            if (ev === 'open') {
              queueMicrotask(() => {
                cb();
              });
            }
            if (ev === 'message') {
              wsHandlers.push(cb);
            }
            return sock;
          }) as PrimaryWsLike['on'],
        };
        return sock;
      },
      fetchFn: async (url) => {
        await Promise.resolve();
        if (url.endsWith('/auth/getToken')) {
          return { ok: true, status: 200, text: '{}', headers: { 'x-auth-token': 'TOK_1' } };
        }
        if (url.includes('/rest/instruments/byCFICode')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({
              status: 'OK',
              instruments: [{ instrumentId: { marketId: 'ROFX', symbol: 'DLR/DIC26' } }],
            }),
          };
        }
        if (url.includes('/rest/instruments/detail')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({
              status: 'OK',
              instrument: { maturityDate: '20261230', contractMultiplier: 1000 },
            }),
          };
        }
        if (url.includes('/rest/instruments/bySegment')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({
              status: 'OK',
              instruments: [
                { instrumentId: { marketId: 'MERV', symbol: 'MERV - XMEV - GGAL - 24hs' } },
                { instrumentId: { marketId: 'MERV', symbol: 'MERV - XMEV - GGAL - CI' } },
              ],
            }),
          };
        }
        if (url.includes('/rest/marketdata/get') && url.includes('DLR%2FDIC26')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({
              status: 'OK',
              marketData: {
                BI: [],
                OF: [],
                LA: { price: 1545.0, date: saturdayMs - 72_000_000 },
                SE: { price: 1552.5, date: saturdayMs - 72_000_000 },
                CL: { price: 1550.0, date: saturdayMs - 72_000_000 },
                OI: { size: 42_000 },
              },
            }),
          };
        }
        if (url.includes('/rest/marketdata/get') && url.includes('GGAL%20-%2024hs')) {
          return { ok: true, status: 200, text: JSON.stringify({ status: 'OK', marketData: { BI: [], OF: [] } }) };
        }
        if (url.includes('/rest/marketdata/get') && url.includes('GGAL%20-%20CI')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({
              status: 'OK',
              marketData: {
                BI: [{ price: 7180, size: 500 }, { price: 7170, size: 800 }],
                OF: [{ price: 7210, size: 400 }, { price: 7220, size: 650 }],
                LA: { price: 7190, date: saturdayMs - 72_000_000 },
              },
            }),
          };
        }
        return { ok: false, status: 404, text: 'Not found' };
      },
    });

    const dlr = await client.getDlrFuturesAndDerivatives({
      asOfUtcSec: Math.floor(saturdayMs / 1_000),
      a3500: 1445.0,
      allowRestEodFallback: true,
    });
    expect(dlr.contracts).toHaveLength(1);
    expect(dlr.contracts[0]).toMatchObject({
      contract: 'DLR/DIC26',
      price: 1552.5,
      priceBasis: 'SETTLEMENT_EOD',
      status: 'CIERRE_AJUSTE',
      baseArs: 107.5,
    });
    expect(dlr.contracts[0]?.devalDirectaPct).not.toBeNull();
    expect(dlr.contracts[0]?.tnaImplicitaPct).not.toBeNull();
    expect(dlr.contracts[0]?.teaImplicitaPct).not.toBeNull();

    // Verifica L2 5 puntas MERV con fallback a CI + ArFeedRouter sirviendo snapshot aunque BMB esté OUT_OF_SESSION
    const ggalBook = await client.getMervOrderBook5Levels('AR:GGAL:24hs', true);
    expect(ggalBook?.symbol).toBe('GGAL');
    expect(ggalBook?.bids.length).toBeGreaterThanOrEqual(2);
    expect(ggalBook?.asks.length).toBeGreaterThanOrEqual(2);

    const router = new ArFeedRouter({
      env: { PRIMARY_WS_URL: 'wss://eco.invalid', PRIMARY_PASSWORD: 'p_test_secret', BMB_PASSWORD: 'bmb_s' },
      nowMsFn: () => saturdayMs,
    });
    router.updateFromRuntimeTelemetry({
      asOfUtcSec: Math.floor(saturdayMs / 1_000),
      primaryConfigured: true,
      primaryConnected: true,
      primaryLastMsgUtcSec: Math.floor(saturdayMs / 1_000) - 600,
      primaryError: null,
      bmbConfigured: true,
      bmbConnected: false,
      bmbLastMsgUtcSec: null,
      bmbError: 'ARMED_OUT_OF_SESSION',
      bmbOutOfSession: true,
      ppiConfigured: false,
      ppiHealthy: false,
      ppiLastMsgUtcSec: null,
      ppiError: null,
      iolConfigured: false,
      iolHealthy: false,
      iolLastMsgUtcSec: null,
      iolError: null,
      maeConfigured: false,
      maeHealthy: false,
      maeLastMsgUtcSec: null,
      maeError: null,
      bymaClearingConfigured: false,
      bymaClearingHealthy: false,
      bymaClearingLastMsgUtcSec: null,
      bymaClearingError: null,
      anexoBLoaded: false,
      anexoBLastMsgUtcSec: null,
      anexoBError: null,
      data912Reachable: true,
      data912LastMsgUtcSec: Math.floor(saturdayMs / 1_000),
      data912Error: null,
    });
    const ladder = router.resolveL2LadderState('GGAL', ggalBook, Math.floor(saturdayMs / 1_000));
    expect(ladder.available).toBe(true);
    if (ladder.available) {
      expect(ladder.activeProvider).toBe('PRIMARY_MATRIZ_WS');
      expect(ladder.bids[0]?.price).toBe(7180);
    }
    client.closeWebSocket();

    // Simula reinicio del backend sin respuestas de mercado en vivo: debe hidratar DLR/* y L2 desde caché en disco.
    const coldRestartClient = new PrimaryRofexClient({
      env: {
        PRIMARY_API_URL: 'https://primary.test',
        PRIMARY_WS_URL: 'wss://primary.test/',
        PRIMARY_USERNAME: 'u_test',
        PRIMARY_PASSWORD: 'p_test_secret',
        PRIMARY_ACCOUNT: 'ACC1',
      },
      secrets: ['p_test_secret'],
      nowMsFn: () => saturdayMs + 60_000,
      persistCachePath: cacheFile,
      wsFactory: (): PrimaryWsLike => {
        const sock: PrimaryWsLike = {
          readyState: 1,
          send: () => undefined,
          close: () => undefined,
          on: ((ev: 'open' | 'message' | 'error' | 'close', cb: (...args: unknown[]) => void) => {
            if (ev === 'open') {
              queueMicrotask(() => {
                cb();
              });
            }
            return sock;
          }) as PrimaryWsLike['on'],
        };
        return sock;
      },
      fetchFn: async (url) => {
        await Promise.resolve();
        if (url.endsWith('/auth/getToken')) {
          return { ok: true, status: 200, text: '{}', headers: { 'x-auth-token': 'TOK_2' } };
        }
        if (url.includes('/rest/instruments/byCFICode')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({
              status: 'OK',
              instruments: [{ instrumentId: { marketId: 'ROFX', symbol: 'DLR/DIC26' } }],
            }),
          };
        }
        if (url.includes('/rest/instruments/detail')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({ status: 'OK', instrument: { maturityDate: '20261230', contractMultiplier: 1000 } }),
          };
        }
        if (url.includes('/rest/instruments/bySegment')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({
              status: 'OK',
              instruments: [{ instrumentId: { marketId: 'MERV', symbol: 'MERV - XMEV - GGAL - 24hs' } }],
            }),
          };
        }
        return { ok: true, status: 200, text: JSON.stringify({ status: 'OK', marketData: { BI: [], OF: [] } }) };
      },
    });

    const dlrCold = await coldRestartClient.getDlrFuturesAndDerivatives({
      asOfUtcSec: Math.floor((saturdayMs + 60_000) / 1_000),
      a3500: 1445.0,
    });
    expect(dlrCold.contracts[0]).toMatchObject({
      contract: 'DLR/DIC26',
      price: 1552.5,
      status: 'CIERRE_AJUSTE',
      baseArs: 107.5,
    });
    expect(dlrCold.contracts[0]?.teaImplicitaPct).not.toBeNull();

    const cachedBookAfterRestart = coldRestartClient.getCachedMervOrderBook5LevelsSync('AR:GGAL:24hs');
    expect(cachedBookAfterRestart?.bids.length).toBeGreaterThanOrEqual(2);
    expect(cachedBookAfterRestart?.bookStatus).toBe('EOD_CIERRE');
    coldRestartClient.closeWebSocket();
  });

  it('integración E2E GgalSpecialistRuntime: repricing individual GFGC* no plano y niveles clave en USD y ARS', async () => {
    const asOfSec = Math.floor(Date.UTC(2026, 10, 18, 12, 30, 0) / 1_000); // Miércoles pre-apertura BYMA
    const nowMs = asOfSec * 1_000;
    const prevSpotArs = 7200;
    const adrUsd = 52.4;
    const ccl = 1285;
    const expiryIso = '2026-12-18';
    const dte = 30;
    const tYears = dte / 365;
    const rArs = Math.log(1 + 0.35);

    const dailyUsBars = Array.from({ length: 120 }, (_, i) => {
      const t = (asOfSec - (120 - i) * 86_400) * 1_000;
      const px = i === 118 ? 55.2 : 52.4;
      return { t, o: px, h: px + 0.6, l: px - 0.5, c: px, v: 250_000, vw: px };
    });
    const usContracts = [45, 50, 55, 60].flatMap((k) => [
      {
        details: { ticker: `O:GGAL261218C000${String(k)}000`, contract_type: 'call', strike_price: k, expiration_date: expiryIso, shares_per_contract: 100 },
        day: { volume: 300, open_interest: k === 55 ? 2400 : 800, close: Math.max(0.5, adrUsd - k + 2) },
        last_quote: { bid: Math.max(0.2, adrUsd - k + 1.8), ask: Math.max(0.4, adrUsd - k + 2.2) },
        underlying_asset: { ticker: 'GGAL', price: adrUsd },
        open_interest: k === 55 ? 2400 : 800,
        implied_volatility: 0.48,
        greeks: { delta: 0.5, gamma: 0.04, theta: -0.02, vega: 0.1 },
      },
      {
        details: { ticker: `O:GGAL261218P000${String(k)}000`, contract_type: 'put', strike_price: k, expiration_date: expiryIso, shares_per_contract: 100 },
        day: { volume: 250, open_interest: k === 45 ? 2100 : 700, close: Math.max(0.5, k - adrUsd + 2) },
        last_quote: { bid: Math.max(0.2, k - adrUsd + 1.8), ask: Math.max(0.4, k - adrUsd + 2.2) },
        underlying_asset: { ticker: 'GGAL', price: adrUsd },
        open_interest: k === 45 ? 2100 : 700,
        implied_volatility: 0.52,
        greeks: { delta: -0.45, gamma: 0.04, theta: -0.02, vega: 0.1 },
      },
    ]);

    const usFetch: FetchFn = async (url) => {
      await Promise.resolve();
      const u = new URL(url);
      if (u.hostname.includes('financialmodelingprep')) {
        if (u.pathname.includes('batch-quote') || u.pathname.includes('/quote')) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify([{ symbol: 'GGAL', price: adrUsd, previousClose: 55.2, volume: 400_000 }]),
            headers: {},
          };
        }
        return {
          ok: true,
          status: 200,
          text: JSON.stringify(
            dailyUsBars.map((b) => ({
              date: new Date(b.t).toISOString().slice(0, 10),
              open: b.o,
              high: b.h,
              low: b.l,
              close: b.c,
              volume: b.v,
            })),
          ),
          headers: {},
        };
      }
      if (u.pathname.startsWith('/v2/aggs/ticker/') && u.pathname.includes('/range/')) {
        return { ok: true, status: 200, text: JSON.stringify({ status: 'OK', results: dailyUsBars }), headers: {} };
      }
      if (u.pathname.startsWith('/v3/snapshot/options/GGAL')) {
        return { ok: true, status: 200, text: JSON.stringify({ status: 'OK', results: usContracts }), headers: {} };
      }
      if (u.pathname.startsWith('/v3/reference/options/contracts')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'OK',
            results: usContracts.map((c) => c.details),
          }),
          headers: {},
        };
      }
      if (u.pathname.includes('treasury')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'OK',
            results: [{ date: '2026-11-17', yield_1_month: 4.35, yield_3_month: 4.35, yield_1_year: 4.2 }],
          }),
          headers: {},
        };
      }
      if (u.pathname.includes('/tickers/GGAL')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'OK',
            ticker: {
              ticker: 'GGAL',
              day: { o: adrUsd, h: adrUsd + 0.5, l: adrUsd - 0.5, c: adrUsd, v: 400_000, vw: adrUsd },
              prevDay: { o: 55.0, h: 55.5, l: 54.8, c: 55.2, v: 350_000, vw: 55.1 },
              lastTrade: { p: adrUsd, s: 100, t: nowMs * 1_000_000 },
              lastQuote: { p: adrUsd - 0.05, s: 10, P: adrUsd + 0.05, S: 10, t: nowMs * 1_000_000 },
            },
          }),
          headers: {},
        };
      }
      if (u.pathname.includes('/v2/snapshot/locale/us/markets/stocks/tickers')) {
        return { ok: true, status: 200, text: JSON.stringify({ status: 'OK', tickers: [] }), headers: {} };
      }
      return { ok: false, status: 404, text: 'Not found', headers: {} };
    };

    const optSpecs: readonly { sym: string; k: number; iv: number; oi: number }[] = [
      { sym: 'GFGC6400DI', k: 6400, iv: 0.56, oi: 12_000 },
      { sym: 'GFGC6800DI', k: 6800, iv: 0.52, oi: 18_000 },
      { sym: 'GFGC7200DI', k: 7200, iv: 0.49, oi: 25_000 },
      { sym: 'GFGC7600DI', k: 7600, iv: 0.47, oi: 35_000 },
      { sym: 'GFGC8000DI', k: 8000, iv: 0.46, oi: 15_000 },
    ];
    const data912Opts = optSpecs.map((o) => {
      const px = priceBsm({
        spot: prevSpotArs,
        strike: o.k,
        timeToExpiry: tYears,
        rate: rArs,
        dividendYield: 0,
        volatility: o.iv,
        contractType: 'call',
      });
      return {
        symbol: o.sym,
        underlying: 'GGAL',
        px_bid: px * 0.99,
        px_ask: px * 1.01,
        c: px,
        v: 4000,
        oi: o.oi,
        expiration: expiryIso,
      };
    });

    const dailyArBars = Array.from({ length: 120 }, (_, i) => {
      const dateStr = new Date((asOfSec - (120 - i) * 86_400) * 1_000).toISOString().slice(0, 10);
      return { date: dateStr, o: prevSpotArs, h: prevSpotArs + 60, l: prevSpotArs - 60, c: prevSpotArs, v: 600_000 };
    });

    const hmacCheck = createHmac('sha256', 'pieza44').update('ok').digest('hex');
    expect(hmacCheck.length).toBe(64);

    const arFetch: ArHttpFn = async (url) => {
      await Promise.resolve();
      const u = new URL(url);
      if (u.hostname.includes('data912')) {
        if (u.pathname === '/live/arg_stocks') {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify([
              { symbol: 'GGAL', px_bid: 0, px_ask: 0, c: prevSpotArs, prev_close: prevSpotArs, v: 500_000 },
              { symbol: 'BMA', c: 11200, prev_close: 11200, v: 100_000 },
              { symbol: 'BBAR', c: 8400, prev_close: 8400, v: 100_000 },
              { symbol: 'SUPV', c: 3900, prev_close: 3900, v: 100_000 },
            ]),
            headers: {},
          };
        }
        if (u.pathname === '/live/arg_options') {
          return { ok: true, status: 200, text: JSON.stringify(data912Opts), headers: {} };
        }
        if (u.pathname === '/live/arg_bonds') {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify([
              { symbol: 'AL30', px_bid: 82_000, px_ask: 82_200, c: 82_100, v: 900_000 },
              { symbol: 'AL30C', px_bid: 63.75, px_ask: 63.95, c: 63.89, v: 800_000 },
              { symbol: 'GD30', px_bid: 83_400, px_ask: 83_600, c: 83_500, v: 700_000 },
              { symbol: 'GD30C', px_bid: 64.9, px_ask: 65.1, c: 64.98, v: 600_000 },
            ]),
            headers: {},
          };
        }
        if (u.pathname === '/live/arg_notes') {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify([{ symbol: 'S30N6', px_bid: 104, px_ask: 104.5, c: 104.2, v: 120_000 }]),
            headers: {},
          };
        }
        if (u.pathname === '/live/mep' || u.pathname === '/live/ccl') {
          return { ok: true, status: 200, text: JSON.stringify({ close: ccl, ccl }), headers: {} };
        }
        if (u.pathname.startsWith('/historical/')) {
          return { ok: true, status: 200, text: JSON.stringify(dailyArBars), headers: {} };
        }
        return { ok: true, status: 200, text: JSON.stringify([]), headers: {} };
      }
      if (u.hostname.includes('bcra.gob.ar')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 200,
            results: [
              { idVariable: 5, descripcion: 'Tipo de Cambio A3500', ultValorInformado: 1190.0, ultFechaInformada: '2026-11-17' },
              { idVariable: 6, descripcion: 'Tasa Politica Monetaria', ultValorInformado: 33.0, ultFechaInformada: '2026-11-17' },
              { idVariable: 7, descripcion: 'BADLAR TNA', ultValorInformado: 35.0, ultFechaInformada: '2026-11-17' },
            ],
          }),
          headers: {},
        };
      }
      if (u.hostname.includes('markets.newyorkfed.org')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ refRates: [{ percentRate: 4.35 }] }),
          headers: {},
        };
      }
      return { ok: true, status: 200, text: JSON.stringify([]), headers: {} };
    };

    const runtime = new MarketRuntime({
      apiKey: 'FAKE_MASSIVE_KEY_44',
      secrets: ['FAKE_MASSIVE_KEY_44'],
      fetchFn: usFetch,
      nowMsFn: () => nowMs,
      fmpConfig: loadFmpConfigFromEnv({}),
      tradierHistoricalBars: false,
      oratsClient: null,
    });
    const arRuntime = new ArgentinaMarketRuntime({
      fetchFn: arFetch,
      secrets: ['FAKE_MASSIVE_KEY_44'],
      nowMsFn: () => nowMs,
      minData912IntervalMs: 0,
      usRuntime: runtime,
    });
    const ggalRuntime = new GgalSpecialistRuntime({
      runtime,
      arRuntime,
      fetchFn: arFetch,
      secrets: ['FAKE_MASSIVE_KEY_44'],
      nowMsFn: () => nowMs,
    });

    const parity = await ggalRuntime.getParityGap(true);
    const repriceRows = parity.result.preOpenOptionRepricing;
    expect(repriceRows.length).toBeGreaterThanOrEqual(4);
    const roundedPcts = new Set(
      repriceRows
        .filter((r) => r.deltaRepricePct !== null)
        .map((r) => (r.deltaRepricePct as number).toFixed(4)),
    );
    // Con el nuevo spot proyectado (~6733 vs 7200), las bases muestran repricing individuales no planos.
    expect(roundedPcts.size).toBe(repriceRows.length);

    const chartUsd = await ggalRuntime.getDualChart({
      coordMode: 'USD_ADR_NASDAQ',
      timeframe: '1D',
      avwapAnchor: 'ELECTORAL_GAP',
      forceRefresh: false,
    });
    expect(chartUsd.dualChart.status).toBe('OPERATIONAL');
    if (chartUsd.dualChart.status === 'OPERATIONAL') {
      expect(Number.isFinite(chartUsd.dualChart.callWall ?? Number.NaN)).toBe(true);
      expect(chartUsd.dualChart.callWall ?? 0).toBeGreaterThan(20);
      expect(chartUsd.dualChart.callWall ?? 0).toBeLessThan(120);
      expect(Number.isFinite(chartUsd.dualChart.putWall ?? Number.NaN)).toBe(true);
      expect(chartUsd.dualChart.putWall ?? 0).toBeGreaterThan(20);
      expect(chartUsd.dualChart.putWall ?? 0).toBeLessThan(120);
      expect(Number.isFinite(chartUsd.dualChart.maxPain ?? Number.NaN)).toBe(true);
      expect(chartUsd.dualChart.maxPain ?? 0).toBeGreaterThan(20);
      expect(chartUsd.dualChart.maxPain ?? 0).toBeLessThan(120);
      expect(chartUsd.dualChart.greekProfile.length).toBeGreaterThan(0);
    }

    const chartArs = await ggalRuntime.getDualChart({
      coordMode: 'ARS_BYMA',
      timeframe: '1D',
      avwapAnchor: 'ELECTORAL_GAP',
      forceRefresh: false,
    });
    expect(chartArs.dualChart.status).toBe('OPERATIONAL');
    if (chartArs.dualChart.status === 'OPERATIONAL') {
      expect(Number.isFinite(chartArs.dualChart.callWall ?? Number.NaN)).toBe(true);
      expect(chartArs.dualChart.callWall ?? 0).toBeGreaterThan(1000);
      expect(Number.isFinite(chartArs.dualChart.putWall ?? Number.NaN)).toBe(true);
      expect(Number.isFinite(chartArs.dualChart.maxPain ?? Number.NaN)).toBe(true);
      expect(chartArs.dualChart.greekProfile.length).toBeGreaterThan(0);
    }
  });
});
