/**
 * Suite Vitest Sub-fase 2 · Pieza 6 (`S2-3` — Capa opcional de gatillos OHLCV):
 *  1) Paridad `<= 1e-9` contra el oráculo independiente en Python (`Decimal(prec=50)`)
 *     en `fixtures/intraday_triggers_sweeps_fvg_ifvg.json`.
 *  2) Máquina de estados FVG / IFVG (6 estados exactos), tope determinista de 3 zonas
 *     activas, exclusión de velas en formación e invariancia causal de prefijo.
 *  3) Detector causal de Liquidity Sweeps contra PDH/PDL, PMH/PML, ORH/ORL, CALL_WALL/PUT_WALL
 *     y degradación honesta ante niveles ausentes / NaN / PROVISIONAL / UNAVAILABLE.
 *  4) Avance incremental únicamente al cierre de barra `1m`/`5m` (cero recálculo intravela).
 *  5) Exclusión explícita de Order Blocks / OTE y guardas estructurales de UI (`OFF` por defecto,
 *     solo `1m`/`5m`, `autoscaleInfo(): null`, cero `localStorage`, cero work en `flushLiveTick`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  advanceIntradayTriggersLiveOnClosed1m,
  buildSweepReferenceLevelsFromSession,
  computeIntradayTriggers,
  createIntradayTriggersLiveState,
  serializeIntradayTriggersResult,
  type FvgLifecycleState,
  type IntradayTriggerZone,
  type IntradayTriggersOptions,
  type LiquiditySweepEvent,
  type SweepReferenceLevelInput,
} from '../src/core/microstructure/intradayTriggers.js';
import type { SessionLevel } from '../src/core/sessionKeyLevels.js';
import type { Bar } from '../src/core/types.js';
import { PanoramicBandsPrimitive } from '../web/src/components/stock-detail/PanoramicBandsPrimitive.js';

interface FixtureZone {
  readonly id: string;
  readonly timeframe: '1m' | '5m';
  readonly methodology: 'OHLCV';
  readonly state: FvgLifecycleState;
  readonly initialDirection: 'BULLISH' | 'BEARISH';
  readonly activeDirection: 'BULLISH' | 'BEARISH';
  readonly isInverted: boolean;
  readonly anchorStartTime: number;
  readonly formedAtTime: number;
  readonly formedAtBarIndex: number;
  readonly gapLow: number;
  readonly gapHigh: number;
  readonly gapWidth: number;
  readonly midpoint: number;
  readonly mitigationRatio: number;
  readonly ifvgMitigationRatio: number;
  readonly mitigatedAtTime: number | null;
  readonly invertedAtTime: number | null;
  readonly invertedAtBarIndex: number | null;
  readonly ifvgMitigatedAtTime: number | null;
  readonly expiredAtTime: number | null;
  readonly distanceToPrice: number | null;
}

interface FixtureSweep {
  readonly id: string;
  readonly timeframe: '1m' | '5m';
  readonly methodology: 'OHLCV';
  readonly provenanceLabel: 'OHLCV_WICK_CLOSE_RECOVERY';
  readonly levelId: SweepReferenceLevelInput['id'];
  readonly levelSide: 'HIGH' | 'LOW';
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly levelPrice: number;
  readonly barTime: number;
  readonly barIndex: number;
  readonly wickExtreme: number;
  readonly closePrice: number;
  readonly wickExcursion: number;
  readonly closeRecovery: number;
}

interface ScenarioFixture {
  readonly name: string;
  readonly bars: readonly Bar[];
  readonly options: {
    readonly timeframe: string;
    readonly asOfUtcSec: number;
    readonly referenceLevels?: readonly SweepReferenceLevelInput[];
    readonly maxZoneAgeBars?: number;
    readonly maxActiveZones?: number;
    readonly sweepCooldownBars?: number;
  };
  readonly expected: {
    readonly status: 'OK' | 'UNSUPPORTED_TIMEFRAME' | 'NO_CLOSED_BARS';
    readonly methodology: 'OHLCV';
    readonly timeframe: '1m' | '5m' | null;
    readonly barSeconds: number | null;
    readonly asOfUtcSec: number;
    readonly closedBarCount: number;
    readonly excludedFormingOrFutureCount: number;
    readonly referencePrice: number | null;
    readonly activeZones: readonly FixtureZone[];
    readonly allZones: readonly FixtureZone[];
    readonly visibleSweeps: readonly FixtureSweep[];
    readonly allSweeps: readonly FixtureSweep[];
  };
}

interface TriggersFixture {
  readonly meta: {
    readonly generator: string;
    readonly decimalPrecision: number;
    readonly tolerance: number;
    readonly methodology: 'OHLCV';
  };
  readonly scenarios: readonly ScenarioFixture[];
}

const fixturePath = join(
  process.cwd(),
  'fixtures',
  'intraday_triggers_sweeps_fvg_ifvg.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as TriggersFixture;
const TOL = fixture.meta.tolerance;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function expectClose(actual: number, expected: number | null, label: string): void {
  if (expected === null) {
    expect(Number.isNaN(actual), label).toBe(true);
    return;
  }
  expect(Number.isFinite(actual), label).toBe(true);
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(
    TOL * Math.max(1, Math.abs(expected)),
  );
}

function assertZonesMatch(
  actual: readonly IntradayTriggerZone[],
  expected: readonly FixtureZone[],
  prefix: string,
): void {
  expect(actual.length, `${prefix}.length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    expect(a).toBeDefined();
    expect(e).toBeDefined();
    if (a === undefined || e === undefined) continue;
    const tag = `${prefix}[${String(i)}:${e.id}]`;
    expect(a.id, `${tag}.id`).toBe(e.id);
    expect(a.timeframe, `${tag}.timeframe`).toBe(e.timeframe);
    expect(a.methodology, `${tag}.methodology`).toBe('OHLCV');
    expect(a.state, `${tag}.state`).toBe(e.state);
    expect(a.initialDirection, `${tag}.initialDirection`).toBe(e.initialDirection);
    expect(a.activeDirection, `${tag}.activeDirection`).toBe(e.activeDirection);
    expect(a.isInverted, `${tag}.isInverted`).toBe(e.isInverted);
    expect(a.anchorStartTime, `${tag}.anchorStartTime`).toBe(e.anchorStartTime);
    expect(a.formedAtTime, `${tag}.formedAtTime`).toBe(e.formedAtTime);
    expect(a.formedAtBarIndex, `${tag}.formedAtBarIndex`).toBe(e.formedAtBarIndex);
    expectClose(a.gapLow, e.gapLow, `${tag}.gapLow`);
    expectClose(a.gapHigh, e.gapHigh, `${tag}.gapHigh`);
    expectClose(a.gapWidth, e.gapWidth, `${tag}.gapWidth`);
    expectClose(a.midpoint, e.midpoint, `${tag}.midpoint`);
    expectClose(a.mitigationRatio, e.mitigationRatio, `${tag}.mitigationRatio`);
    expectClose(a.ifvgMitigationRatio, e.ifvgMitigationRatio, `${tag}.ifvgMitigationRatio`);
    expect(a.mitigatedAtTime, `${tag}.mitigatedAtTime`).toBe(e.mitigatedAtTime);
    expect(a.invertedAtTime, `${tag}.invertedAtTime`).toBe(e.invertedAtTime);
    expect(a.invertedAtBarIndex, `${tag}.invertedAtBarIndex`).toBe(e.invertedAtBarIndex);
    expect(a.ifvgMitigatedAtTime, `${tag}.ifvgMitigatedAtTime`).toBe(e.ifvgMitigatedAtTime);
    expect(a.expiredAtTime, `${tag}.expiredAtTime`).toBe(e.expiredAtTime);
    expectClose(a.distanceToPrice, e.distanceToPrice, `${tag}.distanceToPrice`);
  }
}

function assertSweepsMatch(
  actual: readonly LiquiditySweepEvent[],
  expected: readonly FixtureSweep[],
  prefix: string,
): void {
  expect(actual.length, `${prefix}.length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    expect(a).toBeDefined();
    expect(e).toBeDefined();
    if (a === undefined || e === undefined) continue;
    const tag = `${prefix}[${String(i)}:${e.id}]`;
    expect(a.id, `${tag}.id`).toBe(e.id);
    expect(a.timeframe, `${tag}.timeframe`).toBe(e.timeframe);
    expect(a.methodology, `${tag}.methodology`).toBe('OHLCV');
    expect(a.provenanceLabel, `${tag}.provenanceLabel`).toBe('OHLCV_WICK_CLOSE_RECOVERY');
    expect(a.levelId, `${tag}.levelId`).toBe(e.levelId);
    expect(a.levelSide, `${tag}.levelSide`).toBe(e.levelSide);
    expect(a.direction, `${tag}.direction`).toBe(e.direction);
    expect(a.barTime, `${tag}.barTime`).toBe(e.barTime);
    expect(a.barIndex, `${tag}.barIndex`).toBe(e.barIndex);
    expectClose(a.levelPrice, e.levelPrice, `${tag}.levelPrice`);
    expectClose(a.wickExtreme, e.wickExtreme, `${tag}.wickExtreme`);
    expectClose(a.closePrice, e.closePrice, `${tag}.closePrice`);
    expectClose(a.wickExcursion, e.wickExcursion, `${tag}.wickExcursion`);
    expectClose(a.closeRecovery, e.closeRecovery, `${tag}.closeRecovery`);
  }
}

describe('S2-3 — Motor causal OHLCV de Liquidity Sweeps y FVG/IFVG', () => {
  it('reproduce todos los escenarios del oráculo Python Decimal(50) con tolerancia <= 1e-9 e inmutabilidad', () => {
    expect(fixture.scenarios.length).toBeGreaterThanOrEqual(4);
    for (const scenario of fixture.scenarios) {
      const frozenBars = deepFreeze(structuredClone(scenario.bars));
      const frozenOpts = deepFreeze(structuredClone(scenario.options)) as IntradayTriggersOptions;
      const actual = computeIntradayTriggers(frozenBars, frozenOpts);

      expect(actual.status, `${scenario.name}.status`).toBe(scenario.expected.status);
      expect(actual.methodology, `${scenario.name}.methodology`).toBe('OHLCV');
      expect(actual.timeframe, `${scenario.name}.timeframe`).toBe(scenario.expected.timeframe);
      expect(actual.closedBarCount, `${scenario.name}.closedBarCount`).toBe(
        scenario.expected.closedBarCount,
      );
      expect(
        actual.excludedFormingOrFutureCount,
        `${scenario.name}.excludedFormingOrFutureCount`,
      ).toBe(scenario.expected.excludedFormingOrFutureCount);
      expectClose(
        actual.referencePrice,
        scenario.expected.referencePrice,
        `${scenario.name}.referencePrice`,
      );

      assertZonesMatch(actual.allZones, scenario.expected.allZones, `${scenario.name}.allZones`);
      assertZonesMatch(
        actual.activeZones,
        scenario.expected.activeZones,
        `${scenario.name}.activeZones`,
      );
      assertSweepsMatch(
        actual.allSweeps,
        scenario.expected.allSweeps,
        `${scenario.name}.allSweeps`,
      );
      assertSweepsMatch(
        actual.visibleSweeps,
        scenario.expected.visibleSweeps,
        `${scenario.name}.visibleSweeps`,
      );
    }
  });

  it('cubre exactamente los 6 estados de la FSM FVG/IFVG y respeta el tope de 3 zonas activas', () => {
    const s0 = fixture.scenarios.find((s) => s.name === 'fsm_all_six_states_bullish_and_bearish_1m');
    expect(s0).toBeDefined();
    if (s0 !== undefined) {
      const res0 = computeIntradayTriggers(s0.bars, s0.options);
      const observedStates = new Set(res0.allZones.map((z) => z.state));
      expect(observedStates).toEqual(
        new Set<FvgLifecycleState>([
          'ACTIVE_UNMITIGATED',
          'ACTIVE_PARTIALLY_MITIGATED',
          'MITIGATED_FILLED',
          'INVERTED_IFVG_ACTIVE',
          'IFVG_MITIGATED',
          'EXPIRED',
        ]),
      );
    }

    const s1 = fixture.scenarios.find((s) => s.name === 'active_zones_cap_max_3_priority_5m');
    expect(s1).toBeDefined();
    if (s1 !== undefined) {
      const res1 = computeIntradayTriggers(s1.bars, s1.options);
      expect(res1.allZones.length).toBeGreaterThanOrEqual(5);
      expect(res1.activeZones.length).toBe(3);
      for (let i = 1; i < res1.activeZones.length; i += 1) {
        const prev = res1.activeZones[i - 1];
        const curr = res1.activeZones[i];
        expect(prev).toBeDefined();
        expect(curr).toBeDefined();
        if (prev !== undefined && curr !== undefined) {
          expect(prev.distanceToPrice).toBeLessThanOrEqual(curr.distanceToPrice + 1e-12);
        }
      }
    }
  });

  it('degrada limpiamente sin falsas barridas ante niveles NaN/null/UNAVAILABLE/PROVISIONAL y rechaza 15m/1h/4h/1D/1W', () => {
    for (const tf of ['15m', '1h', '4h', '1D', '1W']) {
      const res = computeIntradayTriggers(
        [{ time: 1781098200, open: 100, high: 101, low: 99, close: 100.5, volume: 100 }],
        { timeframe: tf, asOfUtcSec: 1781199999 },
      );
      expect(res.status, tf).toBe('UNSUPPORTED_TIMEFRAME');
      expect(res.activeZones, tf).toEqual([]);
      expect(res.visibleSweeps, tf).toEqual([]);
    }

    // Simula símbolo AR/BYMA sin PMH/PML y sin walls: buildSweepReferenceLevelsFromSession los omite limpiamente
    const sessionLvls: readonly SessionLevel[] = [
      { id: 'PDH', value: 510, status: 'DEFINITIVE', sessionDate: '2026-06-09', start: 1, endExclusive: 1781098200 },
      { id: 'PDL', value: Number.NaN, status: 'UNAVAILABLE', sessionDate: '2026-06-09', start: 1, endExclusive: 1781098200 },
      { id: 'PMH', value: Number.NaN, status: 'UNAVAILABLE', sessionDate: '2026-06-10', start: 1, endExclusive: 1781098200 },
      { id: 'PML', value: Number.NaN, status: 'UNAVAILABLE', sessionDate: '2026-06-10', start: 1, endExclusive: 1781098200 },
      { id: 'ORH', value: 505, status: 'PROVISIONAL', sessionDate: '2026-06-10', start: 1781098200, endExclusive: 1781099100 },
      { id: 'ORL', value: 500, status: 'PROVISIONAL', sessionDate: '2026-06-10', start: 1781098200, endExclusive: 1781099100 },
    ];
    const refLevels = buildSweepReferenceLevelsFromSession({
      sessionLevels: sessionLvls,
      callWall: null,
      putWall: Number.NaN,
      wallsActiveFromUtcSec: 1781098200,
    });
    const out = computeIntradayTriggers(
      [
        { time: 1781098200, open: 504, high: 506, low: 499, close: 503, volume: 100 },
        { time: 1781098260, open: 509, high: 511, low: 508, close: 509.2, volume: 200 },
      ],
      { timeframe: '1m', asOfUtcSec: 1781098320, referenceLevels: refLevels },
    );
    expect(out.allSweeps.map((s) => s.levelId)).toEqual(['PDH']);
  });

  it('mantiene equivalencia exacta incremental vs batch en 1m y 5m y excluye barras futuras/en formación', () => {
    const s0 = fixture.scenarios[0];
    expect(s0).toBeDefined();
    if (s0 !== undefined) {
      const seedBars = s0.bars.slice(0, 6);
      const restBars = s0.bars.slice(6);
      const lastSeedTime = seedBars[seedBars.length - 1]?.time ?? 0;
      let state = createIntradayTriggersLiveState(seedBars, {
        timeframe: '1m',
        asOfUtcSec: lastSeedTime + 60,
        maxZoneAgeBars: 12,
        maxActiveZones: 3,
      });
      expect(state).not.toBeNull();
      for (const bar of restBars) {
        if (state === null) break;
        // Intentar inyectar barra aún abierta NO debe avanzar estado
        const ignoredOpen = advanceIntradayTriggersLiveOnClosed1m(state, bar, bar.time + 30);
        expect(ignoredOpen).toBe(state);
        state = advanceIntradayTriggersLiveOnClosed1m(state, bar, bar.time + 60);
      }
      const batch = computeIntradayTriggers(s0.bars, s0.options);
      expect(state).not.toBeNull();
      if (state !== null) {
        expect(serializeIntradayTriggersResult(state.result)).toEqual(
          serializeIntradayTriggersResult(batch),
        );
      }
    }

    // Modo 5m: minutos intermedios :01..:03 NO disparan recálculo 5m hasta cerrar :04
    const t0 = 1781098200; // 13:30:00Z múltiplo exacto de 300s
    const bars1mFor5m: readonly Bar[] = [
      // 3 velas 5m (0..14) + 1 bucket parcial
      ...Array.from({ length: 15 }, (_, idx) => {
        const b = Math.floor(idx / 5);
        const basePrice = b === 0 ? 100 : b === 1 ? 103 : 106;
        return {
          time: t0 + idx * 60,
          open: basePrice,
          high: basePrice + (b === 1 ? 2.2 : 0.4),
          low: basePrice - 0.1,
          close: basePrice + (b === 1 ? 2.0 : 0.3),
          volume: 100,
        };
      }),
    ];
    const bars5mInit: readonly Bar[] = [
      { time: t0, open: 100, high: 100.4, low: 99.9, close: 100.3, volume: 500 },
      { time: t0 + 300, open: 103, high: 105.2, low: 102.9, close: 105.0, volume: 500 },
    ];
    let state5m = createIntradayTriggersLiveState(bars5mInit, {
      timeframe: '5m',
      asOfUtcSec: t0 + 600,
    });
    expect(state5m).not.toBeNull();
    const minSlice = bars1mFor5m.slice(10, 14);
    for (const mBar of minSlice) {
      if (state5m === null) break;
      state5m = advanceIntradayTriggersLiveOnClosed1m(state5m, mBar, mBar.time + 60);
      // Antes del cierre :04, closedBarCount de 5m sigue en 2
      expect(state5m.closedBarCount).toBe(2);
    }
    const closing5mMin = bars1mFor5m[14];
    expect(closing5mMin).toBeDefined();
    if (closing5mMin !== undefined && state5m !== null) {
      state5m = advanceIntradayTriggersLiveOnClosed1m(
        state5m,
        closing5mMin,
        closing5mMin.time + 60,
      );
      expect(state5m.closedBarCount).toBe(3);
      expect(state5m.result.activeZones.length).toBe(1);
    }
  });

  it('prohíbe explícitamente Order Blocks (OB) y OTE en S2-3 y preserva guardas de UI', () => {
    const engineSrc = readFileSync(
      join(process.cwd(), 'src/core/microstructure/intradayTriggers.ts'),
      'utf-8',
    );
    const primSrc = readFileSync(
      join(process.cwd(), 'web/src/components/stock-detail/PanoramicBandsPrimitive.ts'),
      'utf-8',
    );
    const viewSrc = readFileSync(
      join(process.cwd(), 'web/src/components/StockDetailView.tsx'),
      'utf-8',
    );

    for (const src of [engineSrc, primSrc]) {
      expect(src).not.toMatch(/\border\s*block\b/i);
      expect(src).not.toMatch(/\boptimal\s*trade\s*entry\b/i);
      expect(src).not.toMatch(/\bOTE\b/);
    }

    // OFF por defecto en memoria de sesión, cero localStorage, solo 1m/5m
    expect(viewSrc).toContain('const [intradayTriggersEnabled, setIntradayTriggersEnabled] = useState<boolean>(false);');
    expect(viewSrc).toContain("{(effectiveChartTimeframe === '1m' || effectiveChartTimeframe === '5m') && (");
    expect(viewSrc).toContain('label="Sweeps/FVG"');
    expect(viewSrc).not.toContain('localStorage');

    // Cero recálculo de S2-3 dentro de flushLiveTick
    const flushTickBody = viewSrc.slice(
      viewSrc.indexOf('const flushLiveTick ='),
      viewSrc.indexOf('const scheduleFlush ='),
    );
    expect(flushTickBody).not.toContain('intradayTriggers');
    expect(flushTickBody).not.toContain('Sweeps');

    // Primitive siempre retorna autoscaleInfo(): null
    const prim = new PanoramicBandsPrimitive({
      enabled: true,
      tickSize: 1,
      hvnZones: [],
      lvnZones: [],
      triggersEnabled: true,
      triggerZones: [
        {
          id: 'fvg:test',
          timeframe: '1m',
          methodology: 'OHLCV',
          state: 'ACTIVE_UNMITIGATED',
          initialDirection: 'BULLISH',
          activeDirection: 'BULLISH',
          isInverted: false,
          anchorStartTime: 1781098200,
          formedAtTime: 1781098320,
          formedAtBarIndex: 2,
          gapLow: 1,
          gapHigh: 999999,
          gapWidth: 999998,
          midpoint: 500000,
          mitigationRatio: 0,
          ifvgMitigationRatio: 0,
          mitigatedAtTime: null,
          invertedAtTime: null,
          invertedAtBarIndex: null,
          ifvgMitigatedAtTime: null,
          expiredAtTime: null,
          distanceToPrice: 0,
        },
      ],
      sweepMarkers: [],
    });
    expect(prim.autoscaleInfo()).toBeNull();
  });
});
