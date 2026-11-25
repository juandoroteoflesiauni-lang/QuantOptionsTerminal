/**
 * Suite Vitest S2-1 — Motor puro de Perfil de Volumen Multihorizonte (`1D`, `5D`, `20D`, `252R`):
 *  - Paridad <= 1e-9 contra referencia independiente en Python (`Decimal(prec=50)`):
 *    `fixtures/multi_horizon_vp_hvn_lvn.json`.
 *  - Conservación exacta de volumen: `|Σ binVol - totalVolume| <= 1e-9 * max(1, totalVolume)`.
 *  - Actualización incremental O(B_bar) al cerrar barra `1m` (`1D`/`5D`) y `5m` (`20D`).
 *  - Caché LRU de histogramas diarios cerrados, hits con caché caliente e invalidación ante splits/revisiones OHLC.
 *  - Integración backend (`UsHistoricalService`, `MarketRuntime`, `ArgentinaMarketRuntime`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DailySessionHistogramCache,
  MAX_PROFILE_BINS,
  advanceMultiHorizonVpLiveOnClosed1m,
  buildSessionVolumeHistogram,
  computeMultiHorizonVolumeProfile,
  createMultiHorizonVpLiveState,
  enumerateRecentUsSessions,
  mergeSessionVolumeHistograms,
  resolveScaledTickSize,
  type HorizonVolumeProfile,
  type VolumeProfileNodeZone,
} from '../src/core/microstructure/multiHorizonVolumeProfile.js';
import type { Bar } from '../src/core/types.js';
import type { FetchFn, FetchResponse } from '../src/data/types.js';
import { ArgentinaMarketRuntime } from '../src/server/argentinaMarketLoader.js';
import { resolveFmpConfig } from '../src/server/fmpClient.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';

interface HorizonExpected {
  readonly minBinIndex: number;
  readonly maxBinIndex: number;
  readonly minPrice: number;
  readonly maxPrice: number;
  readonly poc: number;
  readonly vah: number;
  readonly val: number;
  readonly profileVwap: number;
  readonly totalVolume: number;
  readonly valueAreaVolume: number;
  readonly valueAreaCoverage: number;
  readonly sessionsCovered: number;
  readonly closedBarCount: number;
  readonly hvnZones: readonly VolumeProfileNodeZone[];
  readonly lvnZones: readonly VolumeProfileNodeZone[];
}

interface Fixture {
  readonly meta: { readonly generator: string; readonly tolerance: number };
  readonly multiHorizonCase: {
    readonly symbol: string;
    readonly asOfUtcSec: number;
    readonly rthOnly: boolean;
    readonly tickSize: number;
    readonly referencePrice: number;
    readonly bars1m: readonly Bar[];
    readonly bars5m: readonly Bar[];
    readonly bars1d: readonly Bar[];
    readonly expected: Readonly<Record<'1D' | '5D' | '20D' | '252R', HorizonExpected>>;
  };
  readonly tieCases: readonly {
    readonly name: string;
    readonly tickSize: number;
    readonly bars: readonly Bar[];
    readonly expected: HorizonExpected;
  }[];
  readonly scalingCase: {
    readonly name: string;
    readonly baseTickSize: number;
    readonly expectedTickSize: number;
    readonly bars: readonly Bar[];
    readonly expected: HorizonExpected;
  };
}

const fixturePath = join(process.cwd(), 'fixtures', 'multi_horizon_vp_hvn_lvn.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Fixture;
const TOL = fixture.meta.tolerance;

function expectClose(actual: number, expected: number, label: string): void {
  expect(Number.isFinite(actual), `${label} must be finite`).toBe(true);
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(TOL * Math.max(1, Math.abs(expected)));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function compareHorizon(actual: HorizonVolumeProfile, expected: HorizonExpected, label: string): void {
  expect(actual.coverageStatus, `${label}.status`).toBe('COMPLETE');
  expect(actual.methodology, `${label}.methodology`).toBe('OHLCV_UNIFORM_BIN');
  expect(actual.nodesMethodology, `${label}.nodesMethodology`).toBe('OHLCV_UNIFORM_SMOOTHED_PROMINENCE');
  expect(actual.sessionsCovered, `${label}.sessionsCovered`).toBe(expected.sessionsCovered);
  expect(actual.closedBarCount, `${label}.closedBarCount`).toBe(expected.closedBarCount);
  expect(actual.minBinIndex, `${label}.minBinIndex`).toBe(expected.minBinIndex);
  expect(actual.maxBinIndex, `${label}.maxBinIndex`).toBe(expected.maxBinIndex);
  expectClose(actual.minPrice, expected.minPrice, `${label}.minPrice`);
  expectClose(actual.maxPrice, expected.maxPrice, `${label}.maxPrice`);
  expectClose(actual.poc, expected.poc, `${label}.poc`);
  expectClose(actual.vah, expected.vah, `${label}.vah`);
  expectClose(actual.val, expected.val, `${label}.val`);
  expectClose(actual.profileVwap, expected.profileVwap, `${label}.profileVwap`);
  expectClose(actual.totalVolume, expected.totalVolume, `${label}.totalVolume`);
  expectClose(actual.valueAreaVolume, expected.valueAreaVolume, `${label}.valueAreaVolume`);
  expectClose(actual.valueAreaCoverage, expected.valueAreaCoverage, `${label}.valueAreaCoverage`);

  expect(actual.hvnZones.length, `${label}.hvnZones.length`).toBe(expected.hvnZones.length);
  actual.hvnZones.forEach((z, idx) => {
    const exp = expected.hvnZones[idx];
    if (exp === undefined) throw new Error(`Missing expected HVN zone ${String(idx)}`);
    expect(z.startBinIndex).toBe(exp.startBinIndex);
    expect(z.endBinIndex).toBe(exp.endBinIndex);
    expectClose(z.lowPrice, exp.lowPrice, `${label}.hvn[${String(idx)}].lowPrice`);
    expectClose(z.highPrice, exp.highPrice, `${label}.hvn[${String(idx)}].highPrice`);
    expectClose(z.centerPrice, exp.centerPrice, `${label}.hvn[${String(idx)}].centerPrice`);
    expectClose(z.volume, exp.volume, `${label}.hvn[${String(idx)}].volume`);
    expectClose(z.volumeSharePct, exp.volumeSharePct, `${label}.hvn[${String(idx)}].share`);
  });

  expect(actual.lvnZones.length, `${label}.lvnZones.length`).toBe(expected.lvnZones.length);
  actual.lvnZones.forEach((z, idx) => {
    const exp = expected.lvnZones[idx];
    if (exp === undefined) throw new Error(`Missing expected LVN zone ${String(idx)}`);
    expect(z.startBinIndex).toBe(exp.startBinIndex);
    expect(z.endBinIndex).toBe(exp.endBinIndex);
    expect(z.isPriceGap).toBe(exp.isPriceGap);
    expectClose(z.lowPrice, exp.lowPrice, `${label}.lvn[${String(idx)}].lowPrice`);
    expectClose(z.highPrice, exp.highPrice, `${label}.lvn[${String(idx)}].highPrice`);
    expectClose(z.volume, exp.volume, `${label}.lvn[${String(idx)}].volume`);
  });
}

describe('S2-1 — Motor puro de Perfil de Volumen Multihorizonte vs oráculo Python (<= 1e-9)', () => {
  it('calcula 1D, 5D, 20D y 252R cruzando DST, Thanksgiving y cierre anticipado 13:00 ET sin mutar argumentos', () => {
    const mc = fixture.multiHorizonCase;
    const frozen1m = deepFreeze(structuredClone(mc.bars1m));
    const frozen5m = deepFreeze(structuredClone(mc.bars5m));
    const frozen1d = deepFreeze(structuredClone(mc.bars1d));
    const snapBefore = JSON.stringify({ frozen1m, frozen5m, frozen1d });

    const cache = new DailySessionHistogramCache({ maxEntries: 64 });
    const result = computeMultiHorizonVolumeProfile({
      market: 'US',
      symbol: mc.symbol,
      asOfUtcSec: mc.asOfUtcSec,
      rthOnly: mc.rthOnly,
      tickSize: mc.tickSize,
      referencePrice: mc.referencePrice,
      bars1m: frozen1m,
      bars5m: frozen5m,
      bars1d: frozen1d,
      cache,
      adjustmentRevision: 1,
    });

    expect(JSON.stringify({ frozen1m, frozen5m, frozen1d })).toBe(snapBefore);
    expect(result.methodology).toBe('OHLCV_UNIFORM_BIN');
    compareHorizon(result.horizons['1D'], mc.expected['1D'], '1D');
    compareHorizon(result.horizons['5D'], mc.expected['5D'], '5D');
    compareHorizon(result.horizons['20D'], mc.expected['20D'], '20D');
    compareHorizon(result.horizons['252R'], mc.expected['252R'], '252R');

    // Conservación exacta de volumen en histogramas de sesión individuales.
    const sessions5 = enumerateRecentUsSessions(mc.asOfUtcSec, 5, true, 60);
    expect(sessions5.map((s) => s.dateKey)).toEqual([
      '2026-11-20',
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-27',
    ]);
    for (const s of sessions5) {
      const sBars = frozen1m.filter((b) => b.time >= s.open && b.time + 60 <= s.close);
      const hist = buildSessionVolumeHistogram(s.dateKey, sBars, 60, mc.tickSize, true);
      expect(hist).not.toBeNull();
      if (hist !== null) {
        const sumBins = hist.binVolumes.reduce((acc, v) => acc + v, 0);
        expect(Math.abs(sumBins - hist.totalVolume)).toBeLessThanOrEqual(
          1e-9 * Math.max(1, hist.totalVolume),
        );
      }
    }

    // Segunda ejecución sobre ruedas cerradas reutiliza caché LRU sin misses extra.
    const statsBefore = cache.stats();
    const cachedRes = computeMultiHorizonVolumeProfile({
      market: 'US',
      symbol: mc.symbol,
      asOfUtcSec: mc.asOfUtcSec,
      rthOnly: mc.rthOnly,
      tickSize: mc.tickSize,
      referencePrice: mc.referencePrice,
      bars1m: frozen1m,
      bars5m: frozen5m,
      bars1d: frozen1d,
      cache,
      adjustmentRevision: 1,
    });
    const statsAfter = cache.stats();
    expect(statsAfter.hits).toBeGreaterThan(statsBefore.hits);
    expect(statsAfter.misses).toBe(statsBefore.misses);
    expect(cachedRes.horizons['20D'].poc).toBe(result.horizons['20D'].poc);
  });

  it('resuelve empates deterministas de POC/VA y escala tickSize bajo MAX_PROFILE_BINS = 4000', () => {
    expect(MAX_PROFILE_BINS).toBe(4_000);
    for (const tc of fixture.tieCases) {
      const hist = buildSessionVolumeHistogram('2026-11-27', tc.bars, 60, tc.tickSize, true);
      expect(hist, tc.name).not.toBeNull();
      if (hist !== null) {
        const profile = mergeSessionVolumeHistograms([hist], {
          horizon: '1D',
          sourceTimeframe: '1m',
          sessionsTarget: 1,
          sessionsCovered: 1,
          coverageStatus: 'COMPLETE',
        });
        expectClose(profile.poc, tc.expected.poc, `${tc.name}.poc`);
        expectClose(profile.vah, tc.expected.vah, `${tc.name}.vah`);
        expectClose(profile.val, tc.expected.val, `${tc.name}.val`);
      }
    }

    const sc = fixture.scalingCase;
    const scaled = resolveScaledTickSize(100, 160, sc.baseTickSize, MAX_PROFILE_BINS);
    expect(scaled).toBe(sc.expectedTickSize);
    const hist = buildSessionVolumeHistogram('2026-11-27', sc.bars, 60, scaled, true);
    expect(hist).not.toBeNull();
    if (hist !== null) {
      expect(hist.maxBinIndex - hist.minBinIndex + 1).toBeLessThanOrEqual(MAX_PROFILE_BINS);
      const sumBins = hist.binVolumes.reduce((acc, v) => acc + v, 0);
      expect(Math.abs(sumBins - hist.totalVolume)).toBeLessThanOrEqual(1e-9 * Math.max(1, hist.totalVolume));
      const profile = mergeSessionVolumeHistograms([hist], {
        horizon: '1D',
        sourceTimeframe: '1m',
        sessionsTarget: 1,
        sessionsCovered: 1,
        coverageStatus: 'COMPLETE',
      });
      expectClose(profile.poc, sc.expected.poc, 'scaling.poc');
      expectClose(profile.vah, sc.expected.vah, 'scaling.vah');
      expectClose(profile.val, sc.expected.val, 'scaling.val');
    }
  });

  it('actualiza 1D/5D incrementalmente al cerrar barra 1m y 20D únicamente al cerrar barra 5m', () => {
    const mc = fixture.multiHorizonCase;
    const lastSession = enumerateRecentUsSessions(mc.asOfUtcSec, 1, true, 60)[0];
    if (lastSession === undefined) throw new Error('Missing lastSession');
    // Simular evaluación 15 minutos antes del cierre de la última sesión.
    const splitEvalSec = lastSession.close - 900;
    const bars1mBefore = mc.bars1m.filter((b) => b.time + 60 <= splitEvalSec);
    const bars5mBefore = mc.bars5m.filter((b) => b.time + 300 <= splitEvalSec);
    const bars1mTail = mc.bars1m.filter((b) => b.time + 60 > splitEvalSec && b.time + 60 <= mc.asOfUtcSec);
    expect(bars1mTail.length).toBe(15);

    const initial = computeMultiHorizonVolumeProfile({
      market: 'US',
      symbol: mc.symbol,
      asOfUtcSec: splitEvalSec,
      rthOnly: true,
      tickSize: mc.tickSize,
      referencePrice: mc.referencePrice,
      bars1m: bars1mBefore,
      bars5m: bars5mBefore,
    });
    expect(initial.liveSeed).not.toBeNull();
    if (initial.liveSeed === null) return;

    let liveState = createMultiHorizonVpLiveState(initial.liveSeed);
    for (let i = 0; i < bars1mTail.length; i += 1) {
      const bar = bars1mTail[i];
      if (bar === undefined) continue;
      const before20d = liveState.profile20d;
      liveState = advanceMultiHorizonVpLiveOnClosed1m(liveState, bar, bar.time + 60, mc.referencePrice);
      expect(liveState.profile1d).not.toBeNull();
      expect(liveState.profile5d).not.toBeNull();
      // 20D solo debe recalcularse cuando cierra el 5to minuto de un bucket 5m.
      if ((i + 1) % 5 !== 0) {
        expect(liveState.profile20d).toBe(before20d);
      } else {
        expect(liveState.profile20d).not.toBe(before20d);
      }
    }

    expect(liveState.profile1d).not.toBeNull();
    expect(liveState.profile5d).not.toBeNull();
    expect(liveState.profile20d).not.toBeNull();
    if (liveState.profile1d !== null) {
      compareHorizon(liveState.profile1d, mc.expected['1D'], 'incremental.1D');
    }
    if (liveState.profile5d !== null) {
      compareHorizon(liveState.profile5d, mc.expected['5D'], 'incremental.5D');
    }
    if (liveState.profile20d !== null) {
      compareHorizon(liveState.profile20d, mc.expected['20D'], 'incremental.20D');
    }
  });

  it('invalida caché LRU ante cambio de adjustmentRevision o revisión OHLC y degrada honestamente en AR', async () => {
    const cache = new DailySessionHistogramCache({ maxEntries: 3 });
    const b1: Bar = { time: 1_795_444_200, open: 100, high: 101, low: 99, close: 100.5, volume: 1_000 };
    const h1 = cache.getOrComputeClosedSession('AAPL', 60, true, 0.1, '2026-11-23', [b1]);
    expect(h1?.totalVolume).toBe(1_000);
    // Cambio de revisión (split / ajuste) purga entradas del símbolo.
    cache.ensureSymbolRevision('AAPL', 1);
    cache.ensureSymbolRevision('AAPL', 2);
    expect(cache.get('AAPL', 60, true, 0.1, '2026-11-23')).toBeNull();
    expect(cache.stats().invalidations).toBeGreaterThanOrEqual(1);

    // Revisión OHLC observada en una sesión previamente cerrada también invalida el símbolo.
    cache.getOrComputeClosedSession('AAPL', 60, true, 0.1, '2026-11-23', [b1]);
    const hSplit = cache.getOrComputeClosedSession('AAPL', 60, true, 0.1, '2026-11-23', [{ ...b1, close: 50.25, high: 50.5, low: 49.5 }]);
    expect(hSplit?.minPrice).toBe(49.5);
    expect(cache.stats().invalidations).toBeGreaterThanOrEqual(2);

    // Cota LRU de 3 entradas: insertar 4 símbolos distintos evicta el más antiguo.
    for (const sym of ['S1', 'S2', 'S3', 'S4']) {
      cache.getOrComputeClosedSession(sym, 60, true, 0.1, '2026-11-24', [b1]);
    }
    expect(cache.stats().size).toBe(3);
    expect(cache.stats().evictions).toBeGreaterThanOrEqual(1);

    // Integración backend US: MarketRuntime expone volumeProfilesByHorizon en /api/bars y /api/snapshot sin requests extra.
    const mc = fixture.multiHorizonCase;
    let massiveCalls = 0;
    let intradayMassiveCalls = 0;
    const runtime = new MarketRuntime({
      apiKey: '',
      massiveEnv: { MASSIVE_KEY_2: 'SYNTH_VP' },
      enableWs: false,
      fmpConfig: resolveFmpConfig({}),
      nowMsFn: () => mc.asOfUtcSec * 1_000,
      fetchFn: (url): Promise<FetchResponse> => {
        massiveCalls += 1;
        const parsed = new URL(url);
        if (parsed.pathname.includes('/range/1/minute/')) {
          intradayMassiveCalls += 1;
          const from = Number(parsed.pathname.split('/')[8]) / 1_000;
          const to = (Number(parsed.pathname.split('/')[9]) + 1) / 1_000;
          const rows = mc.bars5m.flatMap((b) =>
            Array.from({ length: 5 }, (_, i) => ({
              t: (b.time + i * 60) * 1_000,
              o: b.open,
              h: b.high,
              l: b.low,
              c: b.close,
              v: b.volume / 5,
              vw: b.vw,
            })),
          ).filter((r) => r.t / 1_000 >= from && r.t / 1_000 + 60 <= to);
          return Promise.resolve({
            ok: true,
            status: 200,
            text: JSON.stringify({ status: 'OK', adjusted: true, queryCount: rows.length, results: rows }),
          });
        }
        if (parsed.pathname.includes('/range/1/day/')) {
          const rows = mc.bars1d.map((b) => ({
            t: b.time * 1_000,
            o: b.open,
            h: b.high,
            l: b.low,
            c: b.close,
            v: b.volume,
            vw: b.vw,
          }));
          return Promise.resolve({
            ok: true,
            status: 200,
            text: JSON.stringify({ status: 'OK', adjusted: true, queryCount: rows.length, results: rows }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ status: 'OK', results: [] }) });
      },
    });
    try {
      const bars5m = await runtime.getBars('AAPL', '5m', { rthOnly: true, includeOverlays: false });
      const callsAfterCold = massiveCalls;
      const intradayAfterCold = intradayMassiveCalls;
      expect(bars5m.volumeProfilesByHorizon?.methodology).toBe('OHLCV_UNIFORM_BIN');
      expect(bars5m.volumeProfilesByHorizon?.horizons['1D'].coverageStatus).toBe('COMPLETE');
      expect(bars5m.volumeProfilesByHorizon?.horizons['5D'].coverageStatus).toBe('COMPLETE');
      expect(bars5m.volumeProfilesByHorizon?.horizons['20D'].coverageStatus).toBe('COMPLETE');
      // Segunda lectura en caché: 0 requests HTTP adicionales (ni intradiarios ni diarios).
      const bars1m = await runtime.getBars('AAPL', '1m', { rthOnly: true, includeOverlays: false });
      expect(bars1m.volumeProfilesByHorizon?.horizons['20D'].coverageStatus).toBe('COMPLETE');
      expect(intradayMassiveCalls).toBe(intradayAfterCold);
      expect(massiveCalls).toBe(callsAfterCold);
    } finally {
      runtime.stopWs();
    }

    // AR/BYMA sin intradiario: 1D/5D/20D degradan honestamente a UNAVAILABLE y 252R conserva su cobertura.
    const arDaily = mc.bars1d.map((b) => ({
      date: new Date(b.time * 1_000).toISOString().slice(0, 10),
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume,
    }));
    const arRt = new ArgentinaMarketRuntime({
      fetchFn: ((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: url.includes('/historical/stocks/GGAL') ? JSON.stringify(arDaily) : '[]',
        })) as unknown as FetchFn,
      minData912IntervalMs: 0,
      nowMsFn: () => mc.asOfUtcSec * 1_000,
    });
    const arBars = await arRt.getArTerminalBars('GGAL', '1D');
    expect(arBars.volumeProfilesByHorizon?.horizons['1D'].coverageStatus).toBe('UNAVAILABLE');
    expect(arBars.volumeProfilesByHorizon?.horizons['1D'].poc).toBeNull();
    expect(arBars.volumeProfilesByHorizon?.horizons['5D'].coverageStatus).toBe('UNAVAILABLE');
    expect(arBars.volumeProfilesByHorizon?.horizons['20D'].coverageStatus).toBe('UNAVAILABLE');
    expect(arBars.volumeProfilesByHorizon?.horizons['252R'].coverageStatus).toBe('COMPLETE');
  });
});
