/**
 * Suite Vitest Pieza 50.5 — Motor determinístico Auto-AVWAP:
 *  1) Paridad `<= 1e-9` contra referencia independiente en Python
 *     (`fixtures/auto_avwap_pieza50_5_reference.json`, 5 escenarios).
 *  2) Inmutabilidad profunda (`Object.freeze`) de barras y eventos.
 *  3) Proyección multi-timeframe `resolveAutoAvwapBarIndex` (1D/1W/intradiario).
 *  4) Backend: `/api/bars` adjunta `autoAvwapAnchors` cacheados por día
 *     (`US:${symbol}:YYYY-MM-DD` / `AR:${symbol}:YYYY-MM-DD`), degrada limpio a
 *     `PIVOT + RVOL` si FMP falla o en tickers BYMA/AR, y no dispara FMP extra
 *     cuando el proveedor histórico está deshabilitado.
 *  5) Guardas estructurales de `StockDetailView.tsx` (modo Auto, slots, marcadores
 *     v5, higiene visual Piezas 48–49.1).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  computeAutoAvwapAtrSeries,
  computeAutoAvwapVolumeStats,
  detectAutoAvwapAnchors,
  type AutoAvwapAnchor,
  type AutoAvwapEventInput,
} from '../src/core/autoAvwap.js';
import { resolveAutoAvwapBarIndex } from '../src/core/stockDetailChartNavigation.js';
import type { Bar } from '../src/core/types.js';
import type { FetchFn } from '../src/data/types.js';
import { ArgentinaMarketRuntime } from '../src/server/argentinaMarketLoader.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';

interface ExpectedAnchor {
  readonly role: 'SUPPORT' | 'RESISTANCE' | 'EVENT';
  readonly anchorTimeSec: number;
  readonly windowIndex: number;
  readonly anchorPrice: number;
  readonly currentAvwap: number;
  readonly distancePct: number;
  readonly score: number;
  readonly sources: readonly string[];
  readonly eventLabel: string | null;
}

interface ScenarioFixture {
  readonly name: string;
  readonly dailyBars: readonly Record<string, number>[];
  readonly events: readonly {
    readonly utcSec: number;
    readonly label: string;
    readonly timeOfDay?: string | null;
    readonly date?: string;
  }[];
  readonly windowBars: number;
  readonly lastClose?: number | null;
  readonly atr14: readonly (number | null)[];
  readonly smaVol20: readonly (number | null)[];
  readonly stdVol20: readonly (number | null)[];
  readonly rvol20: readonly (number | null)[];
  readonly zVol20: readonly (number | null)[];
  readonly expectedAnchors: readonly ExpectedAnchor[];
  readonly emptyBars?: readonly Record<string, number>[];
  readonly emptyAnchors?: readonly ExpectedAnchor[];
}

interface ProjectionCase {
  readonly name: string;
  readonly bars: readonly { readonly time: number }[];
  readonly anchorTimeSec: number;
  readonly timeframe: string;
  readonly expected: number;
}

interface AutoAvwapFixture {
  readonly meta: { readonly generator: string; readonly precisionTolerance: number };
  readonly scenarios: readonly ScenarioFixture[];
  readonly projectionCases: readonly ProjectionCase[];
}

const fixturePath = join(process.cwd(), 'fixtures', 'auto_avwap_pieza50_5_reference.json');
const fixture: AutoAvwapFixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as AutoAvwapFixture;
const TOL = fixture.meta.precisionTolerance;

function scenarioByName(name: string): ScenarioFixture {
  const scenario = fixture.scenarios.find((entry) => entry.name === name);
  if (scenario === undefined) throw new Error(`Escenario ausente en el fixture: ${name}`);
  return scenario;
}

function toBars(rows: readonly Record<string, number>[]): Bar[] {
  return rows.map((row) => ({
    time: row['time'] ?? Number.NaN,
    open: row['open'] ?? Number.NaN,
    high: row['high'] ?? Number.NaN,
    low: row['low'] ?? Number.NaN,
    close: row['close'] ?? Number.NaN,
    volume: row['volume'] ?? Number.NaN,
  }));
}

function toEvents(scenario: ScenarioFixture): AutoAvwapEventInput[] {
  return scenario.events.map((event) => ({
    utcSec: event.utcSec,
    label: event.label,
    timeOfDay: (event.timeOfDay ?? 'unknown') as 'bmo' | 'amc' | 'unknown',
    ...(event.date === undefined ? {} : { date: event.date }),
  }));
}

function expectCloseNumber(actual: number, expected: number | null, label: string): void {
  if (expected === null) {
    expect(Number.isNaN(actual), label).toBe(true);
    return;
  }
  expect(Number.isFinite(actual), label).toBe(true);
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(TOL * Math.max(1, Math.abs(expected)));
}

function expectSeriesMatches(
  actual: readonly number[],
  expected: readonly (number | null)[],
  label: string,
): void {
  expect(actual.length, `${label}.length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expectCloseNumber(actual[i] ?? Number.NaN, expected[i] ?? null, `${label}[${String(i)}]`);
  }
}

function expectAnchorsMatch(
  actual: readonly AutoAvwapAnchor[],
  expected: readonly ExpectedAnchor[],
  label: string,
): void {
  expect(actual.length, `${label}.length`).toBe(expected.length);
  actual.forEach((anchor, index) => {
    const exp = expected[index];
    if (exp === undefined) throw new Error(`${label}: ancla extra en índice ${String(index)}`);
    const ctx = `${label}[${String(index)}].${exp.role}`;
    expect(anchor.role, `${ctx}.role`).toBe(exp.role);
    expect(anchor.anchorTimeSec, `${ctx}.anchorTimeSec`).toBe(exp.anchorTimeSec);
    expect(anchor.windowIndex, `${ctx}.windowIndex`).toBe(exp.windowIndex);
    expectCloseNumber(anchor.anchorPrice, exp.anchorPrice, `${ctx}.anchorPrice`);
    expectCloseNumber(anchor.currentAvwap, exp.currentAvwap, `${ctx}.currentAvwap`);
    expectCloseNumber(anchor.distancePct, exp.distancePct, `${ctx}.distancePct`);
    expectCloseNumber(anchor.score, exp.score, `${ctx}.score`);
    expect([...anchor.sources], `${ctx}.sources`).toEqual([...exp.sources]);
    expect(anchor.eventLabel, `${ctx}.eventLabel`).toBe(exp.eventLabel);
  });
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

describe('Pieza 50.5 — referencia Python independiente (tolerancia <= 1e-9)', () => {
  it('declara el generador y la tolerancia esperada en el fixture', () => {
    expect(fixture.meta.generator).toBe('tools/gen_auto_avwap_pieza50_5_reference.py');
    expect(fixture.meta.precisionTolerance).toBe(1e-9);
    expect(fixture.scenarios.map((scenario) => scenario.name)).toEqual([
      'pivot_rvol_balanced_pincer',
      'cluster_fusion_within_3_bars',
      'far_penalty_25pct_and_global_exemption',
      'degradation_no_events_and_zero_std',
      'edge_short_and_empty',
      'polarity_low_below_avwap_never_resistance',
      'polarity_high_reclaimed_never_support',
      'dominant_6m_1y_beats_minor_peak_and_rvol',
    ]);
  });

  for (const scenario of fixture.scenarios) {
    it(`${scenario.name}: ATR(14), RVOL(20)/zVol(20) ddof=0 y anclas coinciden con Python`, () => {
      const allBars = toBars(scenario.dailyBars);
      const windowBars = allBars.slice(-scenario.windowBars);
      expect(windowBars.length).toBe(scenario.windowBars);

      const atr = computeAutoAvwapAtrSeries(windowBars, 14);
      const stats = computeAutoAvwapVolumeStats(windowBars, 20);
      expectSeriesMatches(atr, scenario.atr14, `${scenario.name}.atr14`);
      expectSeriesMatches([...stats.smaVol], scenario.smaVol20, `${scenario.name}.smaVol20`);
      expectSeriesMatches([...stats.stdVol], scenario.stdVol20, `${scenario.name}.stdVol20`);
      expectSeriesMatches([...stats.rvol], scenario.rvol20, `${scenario.name}.rvol20`);
      expectSeriesMatches([...stats.zVol], scenario.zVol20, `${scenario.name}.zVol20`);

      const anchors = detectAutoAvwapAnchors(allBars, toEvents(scenario));
      expectAnchorsMatch(anchors, scenario.expectedAnchors, `${scenario.name}.anchors`);

      if (scenario.emptyBars !== undefined && scenario.emptyAnchors !== undefined) {
        const empty = detectAutoAvwapAnchors(toBars(scenario.emptyBars), toEvents(scenario));
        expect(empty).toEqual([]);
        expectAnchorsMatch(empty, scenario.emptyAnchors, `${scenario.name}.emptyAnchors`);
      }
    });
  }

  it('pivot_rvol_balanced_pincer: pinza balanceada de 3 anclas con escala calibrada', () => {
    const scenario = scenarioByName('pivot_rvol_balanced_pincer');
    const anchors = detectAutoAvwapAnchors(toBars(scenario.dailyBars), toEvents(scenario));
    expect(anchors.map((anchor) => anchor.role)).toEqual(['SUPPORT', 'RESISTANCE', 'EVENT']);
    const [support, resistance, event] = anchors;
    // Pieza 50.5.1: PIVOT_MAJOR = 40 + bonus(dominanceSpan) ∈ [40, 60]; RVOL ≤ 15.
    expect([...(support?.sources ?? [])]).toEqual(['PIVOT_MAJOR', 'RVOL']);
    expect(support?.score).toBeGreaterThanOrEqual(55);
    expect(support?.score).toBeLessThanOrEqual(75);
    expect([...(resistance?.sources ?? [])]).toEqual(['PIVOT_MAJOR', 'RVOL']);
    expect(resistance?.score).toBeGreaterThanOrEqual(55);
    expect(resistance?.score).toBeLessThanOrEqual(75);
    expect(event?.score).toBe(35);
    expect(event?.eventLabel).toBe('Earnings');
  });

  it('cluster_fusion_within_3_bars: fusión <= 3 velas, máximo por familia y vela exacta del PIVOT', () => {
    const scenario = scenarioByName('cluster_fusion_within_3_bars');
    const bars = toBars(scenario.dailyBars);
    const anchors = detectAutoAvwapAnchors(bars, toEvents(scenario));
    const resistance = anchors.find((anchor) => anchor.role === 'RESISTANCE');
    expect(resistance).toBeDefined();
    // Pieza 50.5.1: EVENT 35 + PIVOT_MAJOR (40 + bonus) + max(RVOL, RVOL) ≤ 15.
    expect(resistance?.score).toBeGreaterThanOrEqual(90);
    expect(resistance?.score).toBeLessThan(96);
    expect([...(resistance?.sources ?? [])]).toEqual(['EVENT', 'PIVOT_MAJOR', 'RVOL']);
    const pivotBar = bars[40];
    expect(resistance?.anchorTimeSec).toBe(pivotBar?.time);
    expect(resistance?.anchorPrice).toBe(pivotBar?.high);

    // Clúster sin PIVOT con volúmenes empatados: gana el índice más antiguo, la vela
    // ganadora es alcista y el puntaje es el MÁXIMO de la familia RVOL (no la suma).
    const support = anchors.find((anchor) => anchor.role === 'SUPPORT');
    expect(support?.windowIndex).toBe(190);
    expect([...(support?.sources ?? [])]).toEqual(['RVOL']);
    const z190 = scenario.zVol20[190];
    const z192 = scenario.zVol20[192];
    expect(z190).not.toBeNull();
    expect(z192).not.toBeNull();
    const expectedMax = Math.max(
      Math.min(15, Math.max(0, 5 * (z190 ?? 0))),
      Math.min(15, Math.max(0, 5 * (z192 ?? 0))),
    );
    expect(support?.score).toBeCloseTo(expectedMax, 12);
    expect(support?.score).toBeLessThan(30);
    const event = anchors.find((anchor) => anchor.role === 'EVENT');
    expect(event?.windowIndex).toBe(50);
    expect(event?.score).toBe(35);
  });

  it('far_penalty_25pct_and_global_exemption: -20 pts lejos del cierre y exención de extremos', () => {
    const scenario = scenarioByName('far_penalty_25pct_and_global_exemption');
    const anchors = detectAutoAvwapAnchors(toBars(scenario.dailyBars), toEvents(scenario));
    expect(anchors.map((anchor) => anchor.role)).toEqual(['SUPPORT', 'RESISTANCE', 'EVENT']);
    const [support, resistance, event] = anchors;
    expect(Math.abs(support?.distancePct ?? 0)).toBeGreaterThan(0.25);
    // Extremo global: exento => 40 + bonus(dominance) > 40 (penalizado sería ≤ 40).
    expect([...(support?.sources ?? [])]).toEqual(['PIVOT_MAJOR']);
    expect(support?.score).toBeGreaterThan(40);
    expect(Math.abs(resistance?.distancePct ?? 0)).toBeGreaterThan(0.25);
    expect(resistance?.score).toBeGreaterThan(40); // extremo global (máximo absoluto) exento
    expect(Math.abs(event?.distancePct ?? 0)).toBeGreaterThan(0.25);
    expect(event?.score).toBe(15); // 35 - 20
  });

  it('degradation_no_events_and_zero_std: solo PIVOT+RVOL y sigma=0 => zVol NaN, score 0', () => {
    const scenario = scenarioByName('degradation_no_events_and_zero_std');
    expect(scenario.events).toHaveLength(0);
    const anchors = detectAutoAvwapAnchors(toBars(scenario.dailyBars), []);
    expect(anchors).toHaveLength(1);
    const resistance = anchors[0];
    expect(resistance?.role).toBe('RESISTANCE');
    expect([...(resistance?.sources ?? [])]).toEqual(['PIVOT_INTERMEDIATE', 'RVOL']);
    expect(resistance?.score).toBe(15);
    expect(scenario.zVol20[66]).toBeNull();
    expect(scenario.rvol20[66]).not.toBeNull();
    expect((scenario.rvol20[66] ?? 0) >= 2).toBe(true);
    for (const anchor of anchors) {
      expect(anchor.eventLabel).toBeNull();
      for (const source of anchor.sources) {
        expect(['PIVOT_MAJOR', 'PIVOT_INTERMEDIATE', 'RVOL']).toContain(source);
      }
      expect(Number.isFinite(anchor.anchorPrice)).toBe(true);
      expect(Number.isFinite(anchor.currentAvwap)).toBe(true);
      expect(Number.isFinite(anchor.distancePct)).toBe(true);
      expect(Number.isFinite(anchor.score)).toBe(true);
    }
  });

  it('edge_short_and_empty: < 21 barras y [] devuelven anclas seguras sin NaN', () => {
    const scenario = scenarioByName('edge_short_and_empty');
    const anchors = detectAutoAvwapAnchors(toBars(scenario.dailyBars), toEvents(scenario));
    expect(anchors).toHaveLength(1);
    // Vela bajista: no secuestra SUPPORT; siempre emitida en su rol correcto.
    expect(anchors[0]?.role).toBe('EVENT');
    expect(anchors[0]?.sources).toEqual(['EVENT']);
    expect(anchors[0]?.windowIndex).toBe(4);
    expect(anchors[0]?.score).toBe(35);
    expect(Number.isFinite(anchors[0]?.score ?? Number.NaN)).toBe(true);
    expect(detectAutoAvwapAnchors([], toEvents(scenario))).toEqual([]);
  });

  it('polarity_low_below_avwap_never_resistance: un Swing Low bajo su AVWAP jamás es RESISTANCE', () => {
    const scenario = scenarioByName('polarity_low_below_avwap_never_resistance');
    const lastClose = scenario.lastClose ?? Number.NaN;
    const anchors = detectAutoAvwapAnchors(toBars(scenario.dailyBars), []);
    expect(anchors.map((anchor) => anchor.role)).toEqual(['SUPPORT', 'RESISTANCE']);
    const support = anchors.find((anchor) => anchor.role === 'SUPPORT');
    const resistance = anchors.find((anchor) => anchor.role === 'RESISTANCE');
    expect(support?.windowIndex).toBe(60);
    // El precio posterior cayó debajo de su AVWAP (currentAvwap > cierre) …
    expect(support?.currentAvwap).toBeGreaterThan(lastClose);
    // … pero el piso sigue vigente debajo del spot => SUPPORT (jamás RESISTANCE).
    expect(support?.anchorPrice).toBeLessThanOrEqual(lastClose);
    expect(resistance?.windowIndex).toBe(75);
    expect(resistance?.windowIndex).not.toBe(support?.windowIndex);
  });

  it('polarity_high_reclaimed_never_support: un Swing High recuperado por encima de su AVWAP jamás es SUPPORT', () => {
    const scenario = scenarioByName('polarity_high_reclaimed_never_support');
    const lastClose = scenario.lastClose ?? Number.NaN;
    const anchors = detectAutoAvwapAnchors(toBars(scenario.dailyBars), []);
    // Ni siquiera siendo el único pivote de la serie recibe SUPPORT.
    expect(anchors.some((anchor) => anchor.role === 'SUPPORT')).toBe(false);
    expect(anchors.map((anchor) => anchor.role)).toEqual(['RESISTANCE']);
    const resistance = anchors[0];
    expect(resistance?.windowIndex).toBe(40);
    expect(resistance?.currentAvwap).toBeLessThanOrEqual(lastClose);
    expect(resistance?.anchorPrice).toBeGreaterThanOrEqual(lastClose);
  });

  it('dominant_6m_1y_beats_minor_peak_and_rvol: domina el extremo 6M–1Y y detecta el borde derecho', () => {
    const scenario = scenarioByName('dominant_6m_1y_beats_minor_peak_and_rvol');
    const anchors = detectAutoAvwapAnchors(toBars(scenario.dailyBars), []);
    expect(anchors.map((anchor) => anchor.role)).toEqual(['SUPPORT', 'RESISTANCE']);
    const support = anchors.find((anchor) => anchor.role === 'SUPPORT');
    const resistance = anchors.find((anchor) => anchor.role === 'RESISTANCE');
    // Piso en V dominante (380 ruedas): exento de -20 pese a caer > 25% del cierre.
    expect(support?.windowIndex).toBe(60);
    expect(Math.abs(support?.distancePct ?? 0)).toBeGreaterThan(0.25);
    expect(support?.score).toBe(60);
    // Techo estructural reciente en el borde derecho (n - 5): invisible para el rango ±10.
    expect(resistance?.windowIndex).toBe(scenario.windowBars - 5);
    expect([...(resistance?.sources ?? [])]).toEqual(['PIVOT_MAJOR']);
    expect(resistance?.score).toBe(60);
  });

  it('no muta barras ni eventos congelados (Object.freeze) y es determinístico', () => {
    const scenario = scenarioByName('pivot_rvol_balanced_pincer');
    const frozenBars = deepFreeze(structuredClone(scenario.dailyBars));
    const frozenEvents = deepFreeze(structuredClone(scenario.events));
    const barsSnapshot = JSON.stringify(frozenBars);
    const eventsSnapshot = JSON.stringify(frozenEvents);

    const frozenScenario: ScenarioFixture = { ...scenario, dailyBars: frozenBars, events: frozenEvents };
    const first = detectAutoAvwapAnchors(toBars(frozenBars), toEvents(frozenScenario));
    expect(JSON.stringify(frozenBars)).toBe(barsSnapshot);
    expect(JSON.stringify(frozenEvents)).toBe(eventsSnapshot);
    const second = detectAutoAvwapAnchors(toBars(frozenBars), toEvents(frozenScenario));
    expect(second).toEqual(first);
  });

  it('sanitiza entradas inválidas sin romper (NaN, milisegundos y volumen negativo)', () => {
    const scenario = scenarioByName('pivot_rvol_balanced_pincer');
    const bars = toBars(scenario.dailyBars);
    const polluted: Bar[] = [
      ...bars,
      { time: Number.NaN, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: bars[0]?.time ?? 0, open: 1, high: 1, low: 1, close: 1, volume: -5 },
      { time: (bars[0]?.time ?? 0) * 1_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    const anchors = detectAutoAvwapAnchors(polluted, toEvents(scenario));
    expectAnchorsMatch(anchors, scenario.expectedAnchors, 'polluted');
  });
});

describe('Pieza 50.5 — proyección multi-timeframe (resolveAutoAvwapBarIndex)', () => {
  for (const testCase of fixture.projectionCases) {
    it(`${testCase.name} (${testCase.timeframe})`, () => {
      expect(
        resolveAutoAvwapBarIndex(testCase.bars, testCase.anchorTimeSec, testCase.timeframe),
      ).toBe(testCase.expected);
    });
  }

  it('rechaza entradas vacías o no finitas', () => {
    expect(resolveAutoAvwapBarIndex([], 1_700_000_000, '1D')).toBe(-1);
    expect(resolveAutoAvwapBarIndex([{ time: 1_700_000_000 }], Number.NaN, '1D')).toBe(-1);
    expect(resolveAutoAvwapBarIndex([{ time: 1_700_000_000 }], Number.POSITIVE_INFINITY, '1h')).toBe(-1);
  });
});

type MrDeps = NonNullable<ConstructorParameters<typeof MarketRuntime>[0]>;

const FIXED_NOW_MS = 1_750_000_000_000;
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1_000);

/** Serie diaria determinista en V (caída + rally con pico de volumen) que garantiza anclas. */
function makeBackendDailyBars(count: number, endSec = FIXED_NOW_SEC): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const declineEnd = Math.floor(count * 0.25);
    const base =
      index <= declineEnd
        ? 140 - (40 * index) / declineEnd
        : 100 + (60 * (index - declineEnd)) / (count - declineEnd);
    const wave = Math.sin(index / 9) * 0.4;
    const close = base + wave;
    const volume = index === declineEnd + 1 ? 5_000 : 900 + (index * 7) % 200;
    return {
      time: endSec - (count - 1 - index) * 86_400,
      open: close - 0.3,
      high: close + 0.8,
      low: close - 0.6,
      close,
      volume,
      vw: close,
    };
  });
}

function makeBackendIntradayBars(count: number, endSec = FIXED_NOW_SEC): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const base = 150 + Math.sin(index / 17) * 1.2;
    return {
      time: endSec - (count - 1 - index) * 300,
      open: base - 0.1,
      high: base + 0.3,
      low: base - 0.3,
      close: base,
      volume: 500 + (index % 97),
    };
  });
}

function makeOfflineBarsLoader(): {
  readonly calls: string[];
  readonly loader: NonNullable<MrDeps['loadBarsFn']>;
} {
  const calls: string[] = [];
  const loader = ((req: { readonly timeframe?: string; readonly visibleBars?: number }) => {
    calls.push(`${req.timeframe ?? '?'}:${String(req.visibleBars ?? '?')}`);
    const bars = req.timeframe === '1D' ? makeBackendDailyBars(220) : makeBackendIntradayBars(320);
    return Promise.resolve({
      bars,
      visibleStart: 0,
      report: {
        provider: 'massive',
        fetchedPages: 1,
        barsCount: bars.length,
        providerError: null,
      },
    });
  }) as unknown as NonNullable<MrDeps['loadBarsFn']>;
  return { calls, loader };
}

/** Loader offline mutable: `1D` devuelve `dailyBars` (ignora la ventana pedida). */
function makeFixedDailyLoader(
  readDailyBars: () => readonly Bar[],
): {
  readonly calls: string[];
  readonly loader: NonNullable<MrDeps['loadBarsFn']>;
} {
  const calls: string[] = [];
  const loader = ((req: { readonly timeframe?: string; readonly visibleBars?: number }) => {
    calls.push(`${req.timeframe ?? '?'}:${String(req.visibleBars ?? '?')}`);
    const bars =
      req.timeframe === '1D' ? [...readDailyBars()] : makeBackendIntradayBars(320);
    return Promise.resolve({
      bars,
      visibleStart: 0,
      report: {
        provider: 'massive',
        fetchedPages: 1,
        barsCount: bars.length,
        providerError: null,
      },
    });
  }) as unknown as NonNullable<MrDeps['loadBarsFn']>;
  return { calls, loader };
}

function makeOfflineRuntime(
  loader: NonNullable<MrDeps['loadBarsFn']>,
  nowMs: () => number = () => FIXED_NOW_MS,
): MarketRuntime {
  return new MarketRuntime({
    apiKey: 'bloque3-harness-key',
    enableWs: false,
    nowMsFn: nowMs,
    loadBarsFn: loader,
  });
}

function countDailyLoads(calls: readonly string[]): number {
  return calls.filter((call) => call.startsWith('1D:')).length;
}

/** Timeout de seguridad para detectar bloqueos; nunca es el mecanismo de sincronización. */
const HOTFIX_SAFETY_TIMEOUT_MS = 2_000;

function withSafetyTimeout<T>(promise: Promise<T>, ms = HOTFIX_SAFETY_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('HOTFIX_SINGLEFLIGHT_TIMEOUT'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

describe('Pieza 50.5 — backend: /api/bars adjunta autoAvwapAnchors cacheados por día', () => {
  it('cachea por símbolo y día: una sola carga 1D por día y cero requests FMP sin proveedor', async () => {
    const { calls, loader } = makeOfflineBarsLoader();
    const fetchUrls: string[] = [];
    const runtime = new MarketRuntime({
      apiKey: 'auto-avwap-cache-key',
      enableWs: false,
      nowMsFn: () => FIXED_NOW_MS,
      loadBarsFn: loader,
      fetchFn: ((url: string) => {
        fetchUrls.push(url);
        return Promise.resolve({ ok: false, status: 404, headers: {}, text: '{}' });
      }) as unknown as FetchFn,
    });

    // Primer request sin hint 1D: la resolución carga 1D una única vez y cachea por día.
    const firstIntraday = await runtime.getBars('CACHEX', '5m', { visibleBars: 200 });
    expect(Array.isArray(firstIntraday.autoAvwapAnchors)).toBe(true);
    expect((firstIntraday.autoAvwapAnchors?.length ?? 0)).toBeGreaterThanOrEqual(1);
    const dailyLoadsAfterFirst = calls.filter((call) => call.startsWith('1D:')).length;
    expect(dailyLoadsAfterFirst).toBe(1);

    // Segundo request con otra ventana: misma caché diaria, sin recargar 1D.
    const secondIntraday = await runtime.getBars('CACHEX', '5m', { visibleBars: 210 });
    const dailyLoadsAfterSecond = calls.filter((call) => call.startsWith('1D:')).length;
    expect(dailyLoadsAfterSecond).toBe(dailyLoadsAfterFirst);
    expect(secondIntraday.autoAvwapAnchors).toEqual(firstIntraday.autoAvwapAnchors);

    // El request 1D real reutiliza las anclas ya cacheadas del día.
    const daily = await runtime.getBars('CACHEX', '1D', { visibleBars: 300 });
    expect(daily.autoAvwapAnchors).toEqual(firstIntraday.autoAvwapAnchors);

    // `fmpHistoricalProviderEnabled === false` (harness sin config FMP): cero requests FMP.
    expect(fetchUrls.filter((url) => url.includes('financialmodelingprep'))).toHaveLength(0);
  });

  it('con FMP habilitado consulta Earnings una sola vez por día y degrada a PIVOT+RVOL si falla', async () => {
    const earningsUrlMarker = '/stable/earnings?symbol=FMPX';
    const bars = makeBackendDailyBars(120);
    const eodRows = bars.map((bar) => ({
      symbol: 'FMPX',
      date: new Date(bar.time * 1_000).toISOString().slice(0, 10),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const earningsDate = new Date((bars[30]?.time ?? 0) * 1_000).toISOString().slice(0, 10);
    let earningsCalls = 0;
    const fmpOk: FetchFn = (url) => {
      if (url.includes('historical-price-eod/full')) {
        return Promise.resolve({ ok: true, status: 200, headers: {}, text: JSON.stringify(eodRows) });
      }
      if (url.includes(earningsUrlMarker)) {
        earningsCalls += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {},
          text: JSON.stringify([
            { symbol: 'FMPX', date: earningsDate, time: 'bmo', epsEstimated: 1.1, epsActual: 1.2 },
          ]),
        });
      }
      return Promise.resolve({ ok: false, status: 404, headers: {}, text: '{}' });
    };
    const fmpConfig: NonNullable<MrDeps['fmpConfig']> = {
      apiKey: 'fmp-test-key-505',
      quotesApiKey: null,
      marketApiKey: null,
      etfApiKey: null,
      macroApiKey: null,
      calendarsApiKey: null,
      configured: true,
      baseUrl: 'https://financialmodelingprep.com',
    };
    const runtime = new MarketRuntime({
      apiKey: 'fmp-harness-key',
      enableWs: false,
      nowMsFn: () => FIXED_NOW_MS,
      fetchFn: fmpOk,
      fmpConfig,
    });

    const first = await runtime.getBars('FMPX', '1D', { visibleBars: 120 });
    expect(earningsCalls).toBe(1);
    const eventAnchors = (first.autoAvwapAnchors ?? []).filter((anchor) =>
      anchor.sources.includes('EVENT'),
    );
    expect(eventAnchors.length).toBeGreaterThanOrEqual(1);
    expect(eventAnchors[0]?.eventLabel).toBe('Earnings');

    // Segunda ventana 1D del mismo día: anclas idénticas desde la caché diaria,
    // sin una segunda consulta de Earnings.
    const second = await runtime.getBars('FMPX', '1D', { visibleBars: 100 });
    expect(second.autoAvwapAnchors).toEqual(first.autoAvwapAnchors);
    expect(earningsCalls).toBe(1);

    // Earnings caído (HTTP 500 con barras EOD OK): degrada limpiamente a PIVOT + RVOL.
    const failingRuntime = new MarketRuntime({
      apiKey: 'fmp-harness-key-2',
      enableWs: false,
      nowMsFn: () => FIXED_NOW_MS,
      fetchFn: ((url: string) => {
        if (url.includes('historical-price-eod/full')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: {},
            text: JSON.stringify(
              eodRows.map((row) => ({ ...row, symbol: 'FAILX' })),
            ),
          });
        }
        return Promise.resolve({ ok: false, status: 500, headers: {}, text: 'boom' });
      }) as unknown as FetchFn,
      fmpConfig,
    });
    const degraded = await failingRuntime.getBars('FAILX', '1D', { visibleBars: 120 });
    const degradedAnchors = degraded.autoAvwapAnchors ?? [];
    expect(Array.isArray(degradedAnchors)).toBe(true);
    expect(degradedAnchors.length).toBeGreaterThanOrEqual(1);
    for (const anchor of degradedAnchors) {
      expect(anchor.sources).not.toContain('EVENT');
      expect(anchor.eventLabel).toBeNull();
    }
  });

  it('ETFs (QQQ): pagina /stable/economic-calendar en tramos <= 85 días y produce ancla EVENT FOMC/CPI', async () => {
    const calendarUrls: string[] = [];
    const bars = makeBackendDailyBars(220);
    const eodRows = bars.map((bar) => ({
      symbol: 'QQQ',
      date: new Date(bar.time * 1_000).toISOString().slice(0, 10),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const fomcDate = new Date((bars[120]?.time ?? 0) * 1_000).toISOString().slice(0, 10);
    const cpiDate = new Date((bars[40]?.time ?? 0) * 1_000).toISOString().slice(0, 10);
    const fmpConfig: NonNullable<MrDeps['fmpConfig']> = {
      apiKey: 'market-505',
      quotesApiKey: null,
      marketApiKey: null,
      etfApiKey: null,
      macroApiKey: 'macro-505',
      calendarsApiKey: null,
      configured: true,
      baseUrl: 'https://financialmodelingprep.com',
    };
    const runtime = new MarketRuntime({
      apiKey: 'qqq-harness-key',
      enableWs: false,
      nowMsFn: () => FIXED_NOW_MS,
      fmpConfig,
      fetchFn: ((url: string) => {
        if (url.includes('historical-price-eod/full')) {
          return Promise.resolve({ ok: true, status: 200, headers: {}, text: JSON.stringify(eodRows) });
        }
        if (url.includes('/stable/economic-calendar?')) {
          calendarUrls.push(url);
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: {},
            text: JSON.stringify([
              { country: 'US', event: 'FOMC Rate Decision', date: fomcDate, impact: 'High' },
              { country: 'US', event: 'CPI y/y', date: cpiDate, impact: 'High' },
            ]),
          });
        }
        return Promise.resolve({ ok: false, status: 404, headers: {}, text: '{}' });
      }) as unknown as FetchFn,
    });

    const res = await runtime.getBars('QQQ', '1D', { visibleBars: 220 });
    // 560 días de historia => tramos consecutivos de <= 85 días (6×85 + 50): 7 requests.
    expect(calendarUrls).toHaveLength(7);
    for (const url of calendarUrls) {
      expect(url).toContain('from=');
      expect(url).toContain('to=');
    }
    const anchors = res.autoAvwapAnchors ?? [];
    const eventAnchors = anchors.filter((anchor) => anchor.sources.includes('EVENT'));
    expect(eventAnchors.length).toBeGreaterThanOrEqual(1);
    expect(
      eventAnchors.some(
        (anchor) => anchor.eventLabel === 'FOMC' || anchor.eventLabel === 'CPI' || anchor.eventLabel === 'FOMC/CPI',
      ),
    ).toBe(true);
    expect(eventAnchors.some((anchor) => anchor.role === 'EVENT')).toBe(true);
  });

  it('Acciones (AAPL): 403 en /stable/earnings reintenta otra clave y cae a income-statement', async () => {
    const bars = makeBackendDailyBars(160);
    const eodRows = bars.map((bar) => ({
      symbol: 'AAPL',
      date: new Date(bar.time * 1_000).toISOString().slice(0, 10),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const filings = [70, 110, 150].map((index, offset) => ({
      symbol: 'AAPL',
      filingDate: new Date((bars[index]?.time ?? 0) * 1_000).toISOString().slice(0, 10),
      epsActual: 1.1 + offset * 0.1,
    }));
    let earningsAttempts = 0;
    let incomeAttempts = 0;
    const fmpConfig: NonNullable<MrDeps['fmpConfig']> = {
      apiKey: 'primary-505',
      quotesApiKey: null,
      marketApiKey: null,
      etfApiKey: null,
      macroApiKey: null,
      calendarsApiKey: 'cal-505',
      configured: true,
      baseUrl: 'https://financialmodelingprep.com',
    };
    const runtime = new MarketRuntime({
      apiKey: 'aapl-harness-key',
      enableWs: false,
      nowMsFn: () => FIXED_NOW_MS,
      fmpConfig,
      fetchFn: ((url: string) => {
        if (url.includes('historical-price-eod/full')) {
          return Promise.resolve({ ok: true, status: 200, headers: {}, text: JSON.stringify(eodRows) });
        }
        if (url.includes('/stable/earnings?')) {
          earningsAttempts += 1;
          return Promise.resolve({ ok: false, status: 403, headers: {}, text: '{}' });
        }
        if (url.includes('/stable/income-statement?')) {
          incomeAttempts += 1;
          return Promise.resolve({ ok: true, status: 200, headers: {}, text: JSON.stringify(filings) });
        }
        return Promise.resolve({ ok: false, status: 404, headers: {}, text: '{}' });
      }) as unknown as FetchFn,
    });

    const res = await runtime.getBars('AAPL', '1D', { visibleBars: 160 });
    // Fallback de clave en 402/403: `calendarsApiKey` y luego `apiKey`.
    expect(earningsAttempts).toBe(2);
    expect(incomeAttempts).toBe(1);
    const anchors = res.autoAvwapAnchors ?? [];
    const eventAnchors = anchors.filter((anchor) => anchor.sources.includes('EVENT'));
    expect(eventAnchors.length).toBeGreaterThanOrEqual(1);
    expect(eventAnchors.some((anchor) => anchor.role === 'EVENT' && anchor.eventLabel === 'Earnings')).toBe(true);
    // El catalizador nunca roba los slots de pivote: SUPPORT/RESISTANCE llevan PIVOT.
    for (const anchor of anchors) {
      if (anchor.role === 'SUPPORT' || anchor.role === 'RESISTANCE') {
        expect(
          anchor.sources.some((source) => source === 'PIVOT_MAJOR' || source === 'PIVOT_INTERMEDIATE'),
        ).toBe(true);
      }
    }
  });

  it('no envenena la caché 24 h: tras fallo FMP degrada, aplica backoff corto y recupera EVENT', async () => {
    const bars = makeBackendDailyBars(200);
    const eodRows = bars.map((bar) => ({
      symbol: 'QQQ',
      date: new Date(bar.time * 1_000).toISOString().slice(0, 10),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const cpiDate = new Date((bars[80]?.time ?? 0) * 1_000).toISOString().slice(0, 10);
    let healthy = false;
    let calendarCalls = 0;
    let nowMs = FIXED_NOW_MS;
    const fmpConfig: NonNullable<MrDeps['fmpConfig']> = {
      apiKey: 'market-505',
      quotesApiKey: null,
      marketApiKey: null,
      etfApiKey: null,
      macroApiKey: 'macro-505',
      calendarsApiKey: null,
      configured: true,
      baseUrl: 'https://financialmodelingprep.com',
    };
    const runtime = new MarketRuntime({
      apiKey: 'poison-harness-key',
      enableWs: false,
      nowMsFn: () => nowMs,
      fmpConfig,
      fetchFn: ((url: string) => {
        if (url.includes('historical-price-eod/full')) {
          return Promise.resolve({ ok: true, status: 200, headers: {}, text: JSON.stringify(eodRows) });
        }
        if (url.includes('/stable/economic-calendar?')) {
          calendarCalls += 1;
          if (!healthy) {
            return Promise.resolve({ ok: false, status: 500, headers: {}, text: 'boom' });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: {},
            text: JSON.stringify([{ country: 'US', event: 'CPI y/y', date: cpiDate, impact: 'High' }]),
          });
        }
        return Promise.resolve({ ok: false, status: 404, headers: {}, text: '{}' });
      }) as unknown as FetchFn,
    });

    const first = await runtime.getBars('QQQ', '1D', { visibleBars: 200 });
    const firstAnchors = first.autoAvwapAnchors ?? [];
    expect(firstAnchors.length).toBeGreaterThanOrEqual(1);
    expect(firstAnchors.every((anchor) => !anchor.sources.includes('EVENT'))).toBe(true);
    expect(calendarCalls).toBe(7); // 560d en tramos ≤ 85d, todos fallan con HTTP 500

    // Dentro del backoff de 5 min: degradado inmediato sin reintentar FMP.
    const withinBackoff = await runtime.getBars('QQQ', '1D', { visibleBars: 210 });
    expect(calendarCalls).toBe(7);
    expect(withinBackoff.autoAvwapAnchors).toEqual(firstAnchors);

    // Tras expirar el backoff con FMP sano: recupera EVENT (sin quedar bloqueado 24 h).
    nowMs += 6 * 60 * 1_000;
    healthy = true;
    const recovered = await runtime.getBars('QQQ', '1D', { visibleBars: 220 });
    expect(calendarCalls).toBe(14); // 7 tramos del refresh saludable
    const eventAnchors = (recovered.autoAvwapAnchors ?? []).filter(
      (anchor) => anchor.sources.includes('EVENT'),
    );
    expect(eventAnchors.length).toBeGreaterThanOrEqual(1);
    expect(eventAnchors.some((anchor) => anchor.eventLabel === 'CPI')).toBe(true);
  });

  it('Bloque 3: 5m primero y luego 1D comparten las últimas 380 cerradas sin recargar', async () => {
    const closedDaily = makeBackendDailyBars(420, FIXED_NOW_SEC - 86_400);
    const { calls, loader } = makeFixedDailyLoader(() => closedDaily);
    const runtime = makeOfflineRuntime(loader);

    const intraday = await runtime.getBars('B3A', '5m', { visibleBars: 200 });
    const intradayAnchors = intraday.autoAvwapAnchors ?? [];
    expect(intradayAnchors.length).toBeGreaterThanOrEqual(1);

    const daily = await runtime.getBars('B3A', '1D', { visibleBars: 420 });
    expect(daily.autoAvwapAnchors).toEqual(intradayAnchors);
    // Insumo completo: la detección directa sobre las mismas cerradas coincide
    // y la ventana se trunca a las últimas 380 ruedas.
    const expected = detectAutoAvwapAnchors(closedDaily, []);
    expect(intradayAnchors).toEqual(expected);
    expect(detectAutoAvwapAnchors(closedDaily.slice(-380), [])).toEqual(expected);
    // Carga interna única (1D:400) + la consulta diaria del usuario (1D:420):
    // el hint diario ya cubría la ventana y no disparó otra carga de anclas.
    expect(calls.filter((call) => call.startsWith('1D:'))).toEqual(['1D:400', '1D:420']);
  });

  it('Bloque 3: 1D primero y luego 5m reutilizan la caché del día sin recargar', async () => {
    const closedDaily = makeBackendDailyBars(420, FIXED_NOW_SEC - 86_400);
    const { calls, loader } = makeFixedDailyLoader(() => closedDaily);
    const runtime = makeOfflineRuntime(loader);

    const daily = await runtime.getBars('B3B', '1D', { visibleBars: 420 });
    const dailyAnchors = daily.autoAvwapAnchors ?? [];
    expect(dailyAnchors).toEqual(detectAutoAvwapAnchors(closedDaily, []));

    const intraday = await runtime.getBars('B3B', '5m', { visibleBars: 200 });
    expect(intraday.autoAvwapAnchors).toEqual(dailyAnchors);
    expect(countDailyLoads(calls)).toBe(1);
  });

  it('Bloque 3: un histórico corto reutiliza la carga completa sin sellar cobertura parcial', async () => {
    const shortHistory = makeBackendDailyBars(120, FIXED_NOW_SEC - 86_400);
    const { calls, loader } = makeFixedDailyLoader(() => shortHistory);
    const runtime = makeOfflineRuntime(loader);

    const first = await runtime.getBars('B3C', '1D', { visibleBars: 120 });
    const firstAnchors = first.autoAvwapAnchors ?? [];
    expect(firstAnchors).toEqual(detectAutoAvwapAnchors(shortHistory, []));
    // Hint corto (<380 cerradas): se carga una vez la ventana completa 1D.
    expect(calls.filter((call) => call === '1D:400')).toHaveLength(1);

    const second = await runtime.getBars('B3C', '1D', { visibleBars: 130 });
    expect(second.autoAvwapAnchors).toEqual(firstAnchors);
    // La caché diaria de 400 evita otra carga interna; la parcial no se sella.
    expect(calls.filter((call) => call === '1D:400')).toHaveLength(1);
  });

  it('Bloque 3: la vela diaria del día en curso no entra en la selección', async () => {
    const flatDaily: Bar[] = Array.from({ length: 420 }, (_, index) => ({
      time: FIXED_NOW_SEC - (420 - index) * 86_400,
      open: 100,
      high: 100.4,
      low: 99.6,
      close: 100,
      volume: 1_000,
    }));
    const forming: Bar = {
      time: FIXED_NOW_SEC,
      open: 101.6,
      high: 102.4,
      low: 101.2,
      close: 102,
      volume: 200_000,
    };
    const withForming = [...flatDaily, forming];

    const loaderWith = makeFixedDailyLoader(() => withForming);
    const runtimeWith = makeOfflineRuntime(loaderWith.loader);
    const loaderWithout = makeFixedDailyLoader(() => flatDaily);
    const runtimeWithout = makeOfflineRuntime(loaderWithout.loader);

    const anchorsWith = (await runtimeWith.getBars('B3D', '5m', { visibleBars: 200 }))
      .autoAvwapAnchors ?? [];
    const anchorsWithout = (await runtimeWithout.getBars('B3D', '5m', { visibleBars: 200 }))
      .autoAvwapAnchors ?? [];

    // Sensibilidad: incluir la vela en formación crearía un ancla RVOL en su
    // fecha (la serie plana no tiene anclas sin ella).
    const directWith = detectAutoAvwapAnchors(withForming, []);
    expect(directWith.some((anchor) => anchor.anchorTimeSec === forming.time)).toBe(true);
    expect(detectAutoAvwapAnchors(flatDaily, [])).toEqual([]);

    // El runtime la excluye: mismo resultado con o sin la vela abierta.
    expect(anchorsWith).toEqual(anchorsWithout);
    expect(anchorsWith).toEqual(detectAutoAvwapAnchors(flatDaily, []));
  });

  it('Bloque 3: proveedor con menos de 380 ruedas degrada con datos válidos sin inventar', async () => {
    const shortHistory = makeBackendDailyBars(300, FIXED_NOW_SEC - 86_400);
    const { calls, loader } = makeFixedDailyLoader(() => shortHistory);
    const runtime = makeOfflineRuntime(loader);

    const first = await runtime.getBars('B3E', '1D', { visibleBars: 300 });
    const anchors = first.autoAvwapAnchors ?? [];
    expect(anchors).toEqual(detectAutoAvwapAnchors(shortHistory, []));
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    const minTime = shortHistory[0]?.time ?? 0;
    const maxTime = shortHistory[shortHistory.length - 1]?.time ?? 0;
    for (const anchor of anchors) {
      expect(anchor.anchorTimeSec).toBeGreaterThanOrEqual(minTime);
      expect(anchor.anchorTimeSec).toBeLessThanOrEqual(maxTime);
    }

    const second = await runtime.getBars('B3E', '5m', { visibleBars: 200 });
    expect(second.autoAvwapAnchors).toEqual(anchors);
    expect(countDailyLoads(calls)).toBe(2); // 1D:300 + carga completa 1D:400
  });

  it('Bloque 3: el cambio de sesión recomputa y no sirve una selección del día previo', async () => {
    const dayOne = makeBackendDailyBars(420, FIXED_NOW_SEC - 86_400);
    let dataset: readonly Bar[] = dayOne;
    let nowMs = FIXED_NOW_MS;
    const { calls, loader } = makeFixedDailyLoader(() => dataset);
    const runtime = makeOfflineRuntime(loader, () => nowMs);

    const first = await runtime.getBars('B3F', '5m', { visibleBars: 200 });
    const firstAnchors = first.autoAvwapAnchors ?? [];
    expect(firstAnchors).toEqual(detectAutoAvwapAnchors(dayOne, []));
    const loadsAfterFirst = countDailyLoads(calls);

    // Rueda siguiente: la EOD ahora incluye la sesión recién cerrada.
    nowMs = FIXED_NOW_MS + 86_400_000;
    dataset = makeBackendDailyBars(421, FIXED_NOW_SEC);
    const second = await runtime.getBars('B3F', '5m', { visibleBars: 200 });
    const secondAnchors = second.autoAvwapAnchors ?? [];

    expect(countDailyLoads(calls)).toBeGreaterThan(loadsAfterFirst);
    expect(secondAnchors).not.toEqual(firstAnchors);
    expect(secondAnchors).toEqual(detectAutoAvwapAnchors(dataset, []));
    // Equivalente a un arranque en frío del mismo día: la caché no sustituye
    // silenciosamente el resultado por uno del día anterior.
    const cold = makeOfflineRuntime(makeFixedDailyLoader(() => dataset).loader, () => nowMs);
    const coldAnchors = (await cold.getBars('B3F', '5m', { visibleBars: 200 }))
      .autoAvwapAnchors ?? [];
    expect(secondAnchors).toEqual(coldAnchors);
  });

  it('Bloque 3: con FMP habilitado el EVENT entra sobre el insumo cerrado y 5m/1D coinciden', async () => {
    const closedDaily = makeBackendDailyBars(420, FIXED_NOW_SEC - 86_400);
    const eodRows = closedDaily.map((bar) => ({
      symbol: 'B3G',
      date: new Date(bar.time * 1_000).toISOString().slice(0, 10),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const earningsDate = new Date((closedDaily[100]?.time ?? 0) * 1_000)
      .toISOString()
      .slice(0, 10);
    const intradayEtRows = makeBackendIntradayBars(320).map((bar) => {
      const iso = new Date(bar.time * 1_000).toISOString();
      return {
        date: `${iso.slice(0, 10)} ${iso.slice(11, 19)}`,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      };
    });
    let earningsCalls = 0;
    const fmpConfig: NonNullable<MrDeps['fmpConfig']> = {
      apiKey: 'bloque3-market-key',
      quotesApiKey: null,
      marketApiKey: null,
      etfApiKey: null,
      macroApiKey: null,
      calendarsApiKey: null,
      configured: true,
      baseUrl: 'https://financialmodelingprep.com',
    };
    const loader = makeFixedDailyLoader(() => closedDaily);
    const runtime = new MarketRuntime({
      apiKey: 'bloque3-fmp-harness',
      enableWs: false,
      nowMsFn: () => FIXED_NOW_MS,
      loadBarsFn: loader.loader,
      fmpConfig,
      fetchFn: ((url: string) => {
        if (url.includes('historical-price-eod/full')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: {},
            text: JSON.stringify(eodRows),
          });
        }
        if (url.includes('/stable/historical-chart/5min')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: {},
            text: JSON.stringify(intradayEtRows),
          });
        }
        if (url.includes('/stable/earnings?symbol=B3G')) {
          earningsCalls += 1;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: {},
            text: JSON.stringify([
              { symbol: 'B3G', date: earningsDate, time: 'bmo', epsEstimated: 1.1, epsActual: 1.2 },
            ]),
          });
        }
        return Promise.resolve({ ok: false, status: 404, headers: {}, text: '{}' });
      }) as unknown as FetchFn,
    });

    const intraday = await runtime.getBars('B3G', '5m', { visibleBars: 200 });
    const intradayAnchors = intraday.autoAvwapAnchors ?? [];
    expect(intradayAnchors.some((anchor) => anchor.sources.includes('EVENT'))).toBe(true);
    expect(intradayAnchors.some((anchor) => !anchor.sources.includes('EVENT'))).toBe(true);

    const daily = await runtime.getBars('B3G', '1D', { visibleBars: 420 });
    expect(daily.autoAvwapAnchors).toEqual(intradayAnchors);
    expect(earningsCalls).toBe(1);
  });

  it('Hotfix single-flight: 1D:400 en frío con <380 cerradas degrada sin esperar su propia clave', async () => {
    const shortDaily = makeBackendDailyBars(250, FIXED_NOW_SEC - 86_400);
    const { calls, loader } = makeFixedDailyLoader(() => shortDaily);
    const runtime = makeOfflineRuntime(loader);

    const first = await withSafetyTimeout(runtime.getBars('HF1', '1D', { visibleBars: 400 }));
    const firstAnchors = first.autoAvwapAnchors ?? [];
    // Degradación segura con las cerradas disponibles, sin inventar barras.
    expect(firstAnchors).toEqual(detectAutoAvwapAnchors(shortDaily, []));
    expect(firstAnchors.length).toBeGreaterThanOrEqual(1);
    // Sin recursión ni cargas repetidas: una sola ejecución del loader 1D:400.
    expect(calls.filter((call) => call === '1D:400')).toHaveLength(1);

    // Consulta posterior: reutiliza la ventana completada, sin REST nuevo.
    const second = await withSafetyTimeout(runtime.getBars('HF1', '5m', { visibleBars: 200 }));
    expect(second.autoAvwapAnchors).toEqual(firstAnchors);
    expect(calls.filter((call) => call === '1D:400')).toHaveLength(1);
  });

  it('Hotfix single-flight: dos solicitudes concurrentes de la misma clave resuelven sin bloqueo', async () => {
    const shortDaily = makeBackendDailyBars(250, FIXED_NOW_SEC - 86_400);
    const { calls, loader } = makeFixedDailyLoader(() => shortDaily);
    const runtime = makeOfflineRuntime(loader);

    const [first, second] = await withSafetyTimeout(
      Promise.all([
        runtime.getBars('HF2', '1D', { visibleBars: 400 }),
        runtime.getBars('HF2', '1D', { visibleBars: 400 }),
      ]),
    );
    expect(first.autoAvwapAnchors).toEqual(second.autoAvwapAnchors);
    expect(first.bars).toHaveLength(250);
    // SingleFlight conserva la deduplicación legítima: una sola carga.
    expect(calls.filter((call) => call.startsWith('1D:'))).toHaveLength(1);
  });

  it('Hotfix single-flight: la cobertura corta no se sella y una consulta posterior recupera', async () => {
    let dataset: readonly Bar[] = makeBackendDailyBars(250, FIXED_NOW_SEC - 86_400);
    let nowMs = FIXED_NOW_MS;
    const { calls, loader } = makeFixedDailyLoader(() => dataset);
    const runtime = makeOfflineRuntime(loader, () => nowMs);

    const degraded = await withSafetyTimeout(runtime.getBars('HF3', '1D', { visibleBars: 400 }));
    const degradedAnchors = degraded.autoAvwapAnchors ?? [];
    expect(degradedAnchors).toEqual(detectAutoAvwapAnchors(dataset, []));

    // Mismo día, misma caché de barras parcial: se reutiliza sin sellarla.
    const withinTtl = await withSafetyTimeout(runtime.getBars('HF3', '5m', { visibleBars: 200 }));
    expect(withinTtl.autoAvwapAnchors).toEqual(degradedAnchors);
    expect(calls.filter((call) => call === '1D:400')).toHaveLength(1);

    // Proveedor con cobertura completa y TTL de barras vencido: recupera y sella.
    nowMs = FIXED_NOW_MS + 60_000;
    dataset = makeBackendDailyBars(420, FIXED_NOW_SEC - 86_400);
    const recovered = await withSafetyTimeout(runtime.getBars('HF3', '5m', { visibleBars: 200 }));
    const recoveredAnchors = recovered.autoAvwapAnchors ?? [];
    expect(recoveredAnchors).toEqual(detectAutoAvwapAnchors(dataset, []));
    expect(calls.filter((call) => call === '1D:400').length).toBeGreaterThanOrEqual(2);

    // Sellado: una consulta del mismo día con hint corto usa la caché diaria.
    const sealed = await withSafetyTimeout(runtime.getBars('HF3', '1D', { visibleBars: 120 }));
    expect(sealed.autoAvwapAnchors).toEqual(recoveredAnchors);
    expect(calls.filter((call) => call === '1D:400')).toHaveLength(2);
  });
});

describe('Pieza 50.5 — /api/bars HTTP (US y AR) expone autoAvwapAnchors', () => {
  const activeServers: HttpWsServerHandle[] = [];
  afterAll(async () => {
    for (const server of activeServers) {
      await server.stop();
    }
  });

  function makeArDailyBars(count: number, endSec = FIXED_NOW_SEC): Bar[] {
    return Array.from({ length: count }, (_, index) => {
      const declineEnd = Math.floor(count * 0.25);
      const base =
        index <= declineEnd
          ? 8_000 - (2_000 * index) / declineEnd
          : 6_000 + (3_000 * (index - declineEnd)) / (count - declineEnd);
      const close = base + Math.sin(index / 11) * 30;
      const volume = index === declineEnd + 1 ? 900_000 : 300_000 + (index * 1_000) % 50_000;
      return {
        time: endSec - (count - 1 - index) * 86_400,
        open: close - 20,
        high: close + 40,
        low: close - 40,
        close,
        volume,
        vw: close,
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

  it('US: sirve el mismo payload cacheado con anclas deterministas', async () => {
    const { loader } = makeOfflineBarsLoader();
    const runtime = new MarketRuntime({
      apiKey: 'http-auto-avwap-key',
      enableWs: false,
      nowMsFn: () => FIXED_NOW_MS,
      loadBarsFn: loader,
      fetchFn: (() => Promise.resolve({ ok: false, status: 404, headers: {}, text: '{}' })) as unknown as FetchFn,
    });
    const server = createHttpWsServer({
      runtime,
      host: '127.0.0.1',
      port: 0,
      startRuntimeWs: false,
      enableBackgroundWarmup: false,
    });
    activeServers.push(server);
    const { host, port } = await server.start();
    const base = `http://${host}:${String(port)}`;

    const res = await fetch(`${base}/api/bars?symbol=BACKX&timeframe=1D&visibleBars=220`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const anchors = body['autoAvwapAnchors'] as readonly Record<string, unknown>[];
    expect(Array.isArray(anchors)).toBe(true);
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    for (const anchor of anchors) {
      expect(['SUPPORT', 'RESISTANCE', 'EVENT']).toContain(anchor['role']);
      expect(Array.isArray(anchor['sources'])).toBe(true);
      expect(Number.isFinite(anchor['anchorTimeSec'])).toBe(true);
      expect(Number.isFinite(anchor['currentAvwap'])).toBe(true);
    }

    const resAgain = await fetch(`${base}/api/bars?symbol=BACKX&timeframe=1D&visibleBars=220`);
    const bodyAgain = (await resAgain.json()) as Record<string, unknown>;
    expect(bodyAgain['autoAvwapAnchors']).toEqual(anchors);
  });

  it('AR: Data912 diario agrega anclas PIVOT+RVOL (sin EVENT) y mantiene el 503 honesto', async () => {
    const ggalBars = makeArDailyBars(220);
    const mockFetch: FetchFn = (url) => {
      if (url.includes('/historical/stocks/GGAL')) {
        return Promise.resolve({ ok: true, status: 200, headers: {}, text: toData912Rows(ggalBars) });
      }
      return Promise.resolve({ ok: true, status: 200, headers: {}, text: '[]' });
    };
    const arRuntime = new ArgentinaMarketRuntime({
      fetchFn: mockFetch,
      minData912IntervalMs: 0,
      nowMsFn: () => FIXED_NOW_MS,
    });
    const usRuntime = new MarketRuntime({
      apiKey: 'ar-http-auto-avwap-key',
      enableWs: false,
      nowMsFn: () => FIXED_NOW_MS,
      loadBarsFn: makeOfflineBarsLoader().loader,
      fetchFn: (() => Promise.resolve({ ok: false, status: 404, headers: {}, text: '{}' })) as unknown as FetchFn,
    });
    const server = createHttpWsServer({
      runtime: usRuntime,
      arRuntime,
      host: '127.0.0.1',
      port: 0,
      startRuntimeWs: false,
      enableBackgroundWarmup: false,
    });
    activeServers.push(server);
    const { host, port } = await server.start();
    const base = `http://${host}:${String(port)}`;

    const res = await fetch(`${base}/api/bars?symbol=GGAL&market=AR&timeframe=1D`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['market']).toBe('AR');
    const anchors = body['autoAvwapAnchors'] as readonly Record<string, unknown>[];
    expect(Array.isArray(anchors)).toBe(true);
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    for (const anchor of anchors) {
      expect(anchor['sources']).not.toContain('EVENT');
      expect(anchor['eventLabel']).toBeNull();
    }

    const missing = await fetch(`${base}/api/bars?symbol=PAMP&market=AR&timeframe=1D`);
    expect(missing.status).toBe(503);
    const missingBody = (await missing.json()) as Record<string, unknown>;
    expect(missingBody['reason']).toBe('NO_BARS_DATA');

    // El cache diario AR reutiliza las anclas: segunda consulta idéntica sin recálculo observable.
    const resAgain = await fetch(`${base}/api/bars?symbol=GGAL&market=AR&timeframe=1D`);
    const bodyAgain = (await resAgain.json()) as Record<string, unknown>;
    expect(bodyAgain['autoAvwapAnchors']).toEqual(anchors);
  });
});

describe('Pieza 50.5 — guardas estructurales de StockDetailView.tsx', () => {
  const src = readFileSync(
    new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
    'utf-8',
  );

  it('incluye el modo Auto (Institucional) al inicio de los modos AVWAP', () => {
    expect(src).toContain("'AUTO_INSTITUTIONAL'");
    expect(src).toContain("label: 'Auto (Institucional)'");
    const autoIdx = src.indexOf("{ id: 'AUTO_INSTITUTIONAL', label: 'Auto (Institucional)' }");
    const sessionIdx = src.indexOf("{ id: 'SESSION_START', label: 'Inicio Sesión' }");
    expect(autoIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeGreaterThan(autoIdx);
  });

  it('refactoriza avwapRefs a diccionario de slots con las 8 series fijas', () => {
    expect(src).toContain('AvwapSlotKey');
    for (const slot of [
      'single_main',
      'single_u1',
      'single_l1',
      'single_u2',
      'single_l2',
      'auto_SUPPORT',
      'auto_RESISTANCE',
      'auto_EVENT',
    ]) {
      expect(src).toContain(`'${slot}'`);
    }
    expect(src).toContain('Partial<Record<AvwapSlotKey, ISeriesApi');
    expect(src).toContain("avwapRefs.current = {}");
  });

  it('usa createSeriesMarkers v5 con marcadores ordenados y detach en unmount', () => {
    expect(src).toContain('createSeriesMarkers');
    expect(src).toContain('markersPlugin.setMarkers([])');
    expect(src).toContain('markers.sort((a, b) => (a.time as number) - (b.time as number))');
    expect(src).toContain('.detach()');
    expect(src).not.toContain('candles.setMarkers(');
  });

  it('respeta la higiene visual Piezas 48–49.1 y variable de proyección Auto-AVWAP', () => {
    expect(src).not.toContain('backdrop-blur-');
    expect(src).not.toContain('animate-pulse');
    expect(src).not.toContain('animate-ping');
    expect(src).toContain('tabular-nums');
    expect(src).toContain('h-6');
    expect(src).toContain('resolveAutoAvwapBarIndex');
    expect(src).toContain('autoAnchorEnabled');
    expect(src).toContain('Auto-AVWAP');
    expect(src).toContain("'SUP'");
    expect(src).toContain("'RES'");
    expect(src).toContain("'EVT'");
  });
});
