/**
 * Pieza 50.8 (Bloque A) — identidad calendario y timestamps live 1D/1W.
 *
 * Referencia independiente: `tools/gen_live_calendar_pieza50_8.py`
 * (zoneinfo New_York/Buenos_Aires; `fixtures/live_calendar_pieza50_8_reference.json`).
 * Cubre EST/EDT, eventos a ambos lados de medianoche UTC, actualizaciones
 * sucesivas de la misma rueda, períodos anteriores, rueda/semana nueva con y
 * sin etiqueta acreditable, lunes feriado, semana incompleta, rollover
 * semanal/anual, AR explícito y convención Data912; paridad intradía exacta.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  projectLiveCandle,
  resolveLivePeriodIdentity,
  type LiveCalendarProjection,
  type LiveChartBar,
} from '../src/core/realtimePropagation.js';

interface IdentityCase {
  readonly name: string;
  readonly timeSec: number;
  readonly market: 'US' | 'AR';
  readonly timeframe: '1D' | '1W';
  readonly expected: { readonly key: string; readonly openingTimeSec: number | null };
}

interface ProjectionCase {
  readonly name: string;
  readonly bar: LiveChartBar;
  readonly tick: { readonly price: number; readonly timeSec: number; readonly volumeDelta?: number };
  readonly calendar: LiveCalendarProjection;
  readonly expected: LiveChartBar | null;
}

interface LiveCalendarFixture {
  readonly meta: { readonly generator: string };
  readonly identityCases: readonly IdentityCase[];
  readonly projectionCases: readonly ProjectionCase[];
}

interface RealtimeFixture {
  readonly candle: {
    readonly bar: LiveChartBar;
    readonly sameBucketTick: { readonly price: number; readonly timeSec: number; readonly volumeDelta: number };
    readonly sameBucketBarSeconds: number;
    readonly expectedSameBucket: LiveChartBar;
    readonly newBucketTick: { readonly price: number; readonly timeSec: number; readonly volumeDelta: number };
    readonly newBucketBarSeconds: number;
    readonly expectedNewBucket: LiveChartBar;
  };
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures', 'live_calendar_pieza50_8_reference.json'), 'utf-8'),
) as LiveCalendarFixture;
const realtimeFixture = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures', 'realtime_propagation_reference.json'), 'utf-8'),
) as RealtimeFixture;

function expectBar(actual: LiveChartBar | null, expected: LiveChartBar | null, label: string): void {
  if (expected === null) {
    expect(actual, label).toBeNull();
    return;
  }
  expect(actual, label).not.toBeNull();
  if (actual === null) return;
  expect(actual.timeSec, `${label}.timeSec`).toBe(expected.timeSec);
  expect(actual.open, `${label}.open`).toBeCloseTo(expected.open, 12);
  expect(actual.high, `${label}.high`).toBeCloseTo(expected.high, 12);
  expect(actual.low, `${label}.low`).toBeCloseTo(expected.low, 12);
  expect(actual.close, `${label}.close`).toBeCloseTo(expected.close, 12);
  expect(actual.volume, `${label}.volume`).toBeCloseTo(expected.volume, 12);
}

describe('Pieza 50.8 Bloque A — identidad calendario', () => {
  it('coincide con la referencia en clave y etiqueta EOD (EST/EDT, AR, 1W)', () => {
    for (const item of fixture.identityCases) {
      const identity = resolveLivePeriodIdentity(item.timeSec, {
        market: item.market,
        timeframe: item.timeframe,
      });
      expect(identity, item.name).not.toBeNull();
      expect(identity?.key, item.name).toBe(item.expected.key);
      expect(identity?.openingTimeSec, item.name).toBe(item.expected.openingTimeSec);
    }
    expect(resolveLivePeriodIdentity(-1, { market: 'US', timeframe: '1D' })).toBeNull();
    expect(resolveLivePeriodIdentity(1.5, { market: 'US', timeframe: '1D' })).toBeNull();
  });

  it('no usa medianoche UTC como identidad de rueda (eventos a ambos lados)', () => {
    const identity = (name: string): string | undefined =>
      fixture.identityCases.find((item) => item.name === name)?.expected.key;
    // 01:00Z y 04:30Z del 16-ene pertenecen a la rueda civil del 15-ene (EST).
    expect(identity('us_1d_tras_medianoche_utc')).toBe('2025-01-15');
    expect(identity('us_1d_pre_medianoche_utc')).toBe('2025-01-15');
    expect(identity('us_1d_edt')).toBe('2025-06-10');
    // 20:00Z del 10-mar es 17:00 AR del mismo día.
    expect(identity('ar_1d_data912')).toBe('2025-03-10');
    // 1W: lunes civil del mercado (incluido lunes feriado).
    expect(identity('us_1w_lunes_feriado')).toBe('2025-01-20');
  });
});

describe('Pieza 50.8 Bloque A — proyección live 1D/1W', () => {
  it('coincide con la referencia en cada escenario de proyección', () => {
    for (const item of fixture.projectionCases) {
      const projected = projectLiveCandle(item.bar, item.tick, 86_400, item.calendar);
      expectBar(projected, item.expected, item.name);
    }
  });

  it('misma rueda: conserva timestamp y apertura; ninguna actualización duplica la vela', () => {
    const item = fixture.projectionCases.find((c) => c.name === 'us_1d_misma_rueda_est');
    expect(item).toBeDefined();
    if (item === undefined) return;
    const first = projectLiveCandle(item.bar, item.tick, 86_400, item.calendar);
    expect(first?.timeSec).toBe(item.bar.timeSec);
    expect(first?.open).toBe(item.bar.open);
    // Segunda actualización sucesiva de la misma rueda: mismo timestamp, sin clon.
    const second = projectLiveCandle(
      first ?? item.bar,
      { price: 106, timeSec: item.tick.timeSec + 3_600, volumeDelta: 25 },
      86_400,
      item.calendar,
    );
    expect(second?.timeSec).toBe(item.bar.timeSec);
    expect(second?.open).toBe(item.bar.open);
    expect(second?.high).toBe(106);
  });

  it('período anterior se descarta y el posterior exige etiqueta acreditable', () => {
    const requireCase = (name: string): ProjectionCase => {
      const found = fixture.projectionCases.find((c) => c.name === name);
      if (found === undefined) throw new Error(`Projection case not found: ${name}`);
      return found;
    };
    const previous = requireCase('us_1d_periodo_anterior');
    expect(projectLiveCandle(previous.bar, previous.tick, 86_400, previous.calendar)).toBeNull();
    // AR sin etiqueta: espera una barra fuente.
    const arNoLabel = requireCase('ar_1d_nueva_sin_etiqueta');
    expect(projectLiveCandle(arNoLabel.bar, arNoLabel.tick, 86_400, arNoLabel.calendar)).toBeNull();
    // 1W sin primera diaria conocida: espera una barra fuente.
    const weekNoSource = requireCase('us_1w_semana_nueva_sin_fuente');
    expect(
      projectLiveCandle(weekNoSource.bar, weekNoSource.tick, 604_800, weekNoSource.calendar),
    ).toBeNull();
  });

  it('mantiene la paridad intradía exacta sin la ruta de calendario', () => {
    const same = projectLiveCandle(
      realtimeFixture.candle.bar,
      realtimeFixture.candle.sameBucketTick,
      realtimeFixture.candle.sameBucketBarSeconds,
    );
    expectBar(same, realtimeFixture.candle.expectedSameBucket, 'intradia.sameBucket');
    const next = projectLiveCandle(
      realtimeFixture.candle.bar,
      realtimeFixture.candle.newBucketTick,
      realtimeFixture.candle.newBucketBarSeconds,
    );
    expectBar(next, realtimeFixture.candle.expectedNewBucket, 'intradia.newBucket');
  });

  it('la vista usa la temporalidad efectiva en la proyección live (guardas estructurales)', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );
    expect(src).toContain("timeframe === '1D' || timeframe === '1W'");
    expect(src).toContain('? { market, timeframe }');
    expect(src).toContain('timeframe={effectiveChartTimeframe}');
  });
});
