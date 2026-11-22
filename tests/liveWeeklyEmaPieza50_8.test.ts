/**
 * Pieza 50.8 (Bloque B2) — semana activa desde diarias y EMA live.
 *
 * Referencia independiente: `tools/gen_weekly_live_pieza50_8.py`
 * (`fixtures/weekly_live_pieza50_8_reference.json`). Verifica la reconstrucción
 * de la semana activa (lunes feriado, semana incompleta, EST/EDT, cierre de
 * año, rollover viernes→lunes), la ausencia de duplicación, y que la proyección
 * EMA live coincida con el recálculo puro de la serie reconciliada (1e-9).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calculateEma } from '../src/core/ema.js';
import {
  reconstructFormingWeeklyBar,
  upsertDailyBar,
} from '../src/core/liveBarReconciler.js';
import { projectLiveEma } from '../src/core/ema.js';
import type { LiveChartBar } from '../src/core/realtimePropagation.js';

interface WeeklyCase {
  readonly name: string;
  readonly dailies: readonly LiveChartBar[];
  readonly expected: (LiveChartBar & { readonly weekKey: string }) | null;
}

interface EmaCase {
  readonly name: string;
  readonly period: number;
  readonly closed: readonly number[];
  readonly provisionalClose: number;
  readonly expectedBase: number | null;
  readonly expectedLive: number | null;
}

interface WeeklyFixture {
  readonly weeklyCases: readonly WeeklyCase[];
  readonly emaCases: readonly EmaCase[];
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures', 'weekly_live_pieza50_8_reference.json'), 'utf-8'),
) as WeeklyFixture;

describe('Pieza 50.8 Bloque B2 — semana activa desde diarias', () => {
  it('coincide con la referencia en timestamp, OHLC y volumen de la semana activa', () => {
    for (const item of fixture.weeklyCases) {
      const weekly = reconstructFormingWeeklyBar(item.dailies, 'America/New_York');
      if (item.expected === null) {
        expect(weekly, item.name).toBeNull();
        continue;
      }
      expect(weekly, item.name).not.toBeNull();
      if (weekly === null) continue;
      expect(weekly.timeSec, `${item.name}.timeSec`).toBe(item.expected.timeSec);
      expect(weekly.open, `${item.name}.open`).toBeCloseTo(item.expected.open, 12);
      expect(weekly.high, `${item.name}.high`).toBeCloseTo(item.expected.high, 12);
      expect(weekly.low, `${item.name}.low`).toBeCloseTo(item.expected.low, 12);
      expect(weekly.close, `${item.name}.close`).toBeCloseTo(item.expected.close, 12);
      expect(weekly.volume, `${item.name}.volume`).toBeCloseTo(item.expected.volume, 12);
    }
  });

  it('reemplaza la diaria y reagrupa sin duplicar semana en el rollover', () => {
    const base = fixture.weeklyCases.find((c) => c.name === 'semana_lunes_viernes')?.dailies ?? [];
    const sameWeek = upsertDailyBar(base, {
      timeSec: base[base.length - 1]?.timeSec ?? 0,
      open: 109,
      high: 115,
      low: 108,
      close: 114,
      volume: 2000,
    });
    const weeklySame = reconstructFormingWeeklyBar(sameWeek, 'America/New_York');
    expect(weeklySame?.timeSec).toBe(base[0]?.timeSec);
    expect(weeklySame?.close).toBe(114);
    // Volumen recalculado desde las diarias (sin acumular sobre el anterior).
    expect(weeklySame?.volume).toBe(6600);

    const monday = { timeSec: 1736744400, open: 120, high: 121, low: 119, close: 120.5, volume: 500 };
    const nextWeek = upsertDailyBar(base, monday);
    const weeklyNext = reconstructFormingWeeklyBar(nextWeek, 'America/New_York');
    // Una sola semana nueva no duplicada: misma clave que la diaria insertada.
    if (weeklyNext === null) throw new Error('weekly rollover must exist');
    expect(weeklyNext.timeSec).toBe(monday.timeSec);
  });

  it('conserva el timestamp de la primera rueda real (lunes feriado)', () => {
    const holiday = fixture.weeklyCases.find((c) => c.name === 'semana_lunes_feriado');
    expect(holiday?.expected?.timeSec).toBe(holiday?.dailies[0]?.timeSec);
    const full = fixture.weeklyCases.find((c) => c.name === 'semana_lunes_viernes');
    expect(holiday?.expected?.timeSec).not.toBe(full?.expected?.timeSec);
  });
});

describe('Pieza 50.8 Bloque B2 — EMA live contra recálculo puro', () => {
  it('la proyección live coincide con el recálculo puro (1e-9)', () => {
    for (const item of fixture.emaCases) {
      const base = calculateEma(item.closed, item.period);
      const baseLast = base[base.length - 1] ?? Number.NaN;
      if (item.expectedBase === null) {
        expect(Number.isNaN(baseLast), item.name).toBe(true);
        const projected = projectLiveEma(baseLast, item.provisionalClose, item.period);
        expect(Number.isNaN(projected), item.name).toBe(true);
        continue;
      }
      expect(baseLast, item.name).toBeCloseTo(item.expectedBase, 9);
      const projected = projectLiveEma(baseLast, item.provisionalClose, item.period);
      expect(projected, item.name).toBeCloseTo(item.expectedLive ?? Number.NaN, 9);
    }
  });

  it('múltiples cierres provisionales se proyectan desde la última cerrada, sin encadenar', () => {
    const closed = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5));
    for (const period of [9, 21, 50]) {
      const base = calculateEma(closed, period);
      const baseLast = base[base.length - 1] ?? Number.NaN;
      for (const provisional of [101, 99.5, 104.25, 98]) {
        expect(projectLiveEma(baseLast, provisional, period)).toBeCloseTo(
          calculateEma([...closed, provisional], period)[closed.length] ?? Number.NaN,
          9,
        );
      }
    }
  });

  it('la vista reconstruye la semana activa desde sus diarias (guardas estructurales)', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );
    expect(src).toContain('reconstructFormingWeeklyBar(');
    expect(src).toContain('upsertDailyBar(liveWeeklyDailyBarsRef.current, state.bar)');
    expect(src).toContain('bundle.dailyBarsForWeekly');
    expect(src).toContain("timeframe === '1W' ? '1D' : timeframe");
    expect(src).toContain('paintFormingBar(weekly, currentForming)');
    // Un único punto de promoción EMA por pintado (nunca doble promoción).
    expect(src.split('if (nextBar.timeSec > currentForming.timeSec)').length - 1).toBe(1);
    expect(src).toContain('projectLiveEma(prevClosed, nextBar.close, p)');
  });
});
