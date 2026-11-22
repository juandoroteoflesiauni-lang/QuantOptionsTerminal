/**
 * Pieza 50.7 (Bloque B) — anclas temporales YTD/MTD/SESSION/CLICKED y 1W.
 *
 * Referencia independiente: `tools/gen_avwap_anchors_pieza50_7.py`
 * (zoneinfo New_York/Buenos_Aires; `fixtures/avwap_anchors_pieza50_7_reference.json`).
 * Cubre cambio de año/mes cerca de medianoche UTC, DST, sesión premarket/RTH,
 * fechas AR, feriados, histórico completo/parcial/insuficiente, clic fuera de
 * rango, extremos de 60 barras y la proyección 1W sin volumen anterior al ancla.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeSingleAnchorAvwapOverlayPure,
  projectDailyAvwapToWeeklyPure,
  resolveSingleAnchorAvwapPure,
  type AvwapAnchorCoverage,
  type MinimalOhlcvBar,
  type TemporalAvwapAnchorMode,
} from '../web/src/components/stock-detail/stockDetailMath.js';

interface AnchorCase {
  readonly name: string;
  readonly mode: TemporalAvwapAnchorMode;
  readonly market: 'US' | 'AR';
  readonly clickedTimeSec: number | null;
  readonly bars: readonly (readonly [number, number, number])[];
  readonly expected: {
    readonly anchorTimeSec: number | null;
    readonly anchorIndex: number;
    readonly coverage: AvwapAnchorCoverage;
  };
}

interface ProjectionCase {
  readonly name: string;
  readonly mode: 'MONTH_START' | 'YEAR_START';
  readonly market: 'US' | 'AR';
  readonly weeklyBars: readonly number[];
  readonly dailyBars: readonly (readonly [number, number, number])[];
  readonly expected: {
    readonly anchorWeeklyTimeSec: number | null;
    readonly anchorDailyTimeSec: number | null;
    readonly coverage: AvwapAnchorCoverage;
    readonly weeklyValueIndices: readonly number[];
    readonly dailyAnchorIndex: number;
  };
}

interface AnchorsFixture {
  readonly anchorCases: readonly AnchorCase[];
  readonly projectionCases: readonly ProjectionCase[];
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures', 'avwap_anchors_pieza50_7_reference.json'), 'utf-8'),
) as AnchorsFixture;

function toBar(time: number, low: number, high: number, close = low): MinimalOhlcvBar {
  return { time, open: low, high, low, close, volume: 10 };
}

function caseByName(name: string): AnchorCase {
  const found = fixture.anchorCases.find((item) => item.name === name);
  if (found === undefined) throw new Error(`Anchor case not found: ${name}`);
  return found;
}

describe('Pieza 50.7 Bloque B — anclas temporales con fechas civiles del mercado', () => {
  it('coincide con la referencia en ancla, índice y cobertura para todos los modos', () => {
    for (const item of fixture.anchorCases) {
      const bars = item.bars.map(([time, low, high]) => toBar(time, low, high));
      const resolution = resolveSingleAnchorAvwapPure(
        bars,
        item.mode,
        item.market,
        item.clickedTimeSec,
      );
      expect(resolution.anchorIndex, item.name).toBe(item.expected.anchorIndex);
      expect(resolution.anchorTimeSec, item.name).toBe(item.expected.anchorTimeSec);
      expect(resolution.coverage, item.name).toBe(item.expected.coverage);
    }
  });

  it('acerca de medianoche UTC no roba la rueda del período anterior (US y AR)', () => {
    // La barra 31-dic 20:00 ET (01:00Z del 1-ene) NO pertenece al año 2025.
    const yearCase = caseByName('us_year_change_medianoche_utc');
    expect(yearCase.expected.anchorIndex).toBe(1);
    const monthCase = caseByName('us_month_change_medianoche_utc');
    expect(monthCase.expected.anchorIndex).toBe(1);
    const arYear = caseByName('ar_year_change');
    expect(arYear.expected.anchorIndex).toBe(1);
    const arMonth = caseByName('ar_month_change');
    expect(arMonth.expected.anchorIndex).toBe(1);

    // Cobertura: el buffer incluye una barra anterior al inicio del período.
    for (const name of ['us_year_change_medianoche_utc', 'ar_year_change', 'ar_month_change']) {
      expect(caseByName(name).expected.coverage).toBe('complete');
    }
    expect(caseByName('us_historico_parcial').expected.coverage).toBe('partial');
    expect(caseByName('vacio').expected.anchorIndex).toBe(-1);
  });

  it('SESSION US exige RTH: premarket indisponible, 09:35 parcial y 09:30 completa', () => {
    expect(caseByName('us_session_premarket').expected.coverage).toBe('unavailable');
    expect(caseByName('us_session_rth_parcial').expected.coverage).toBe('partial');
    expect(caseByName('us_session_rth_completa').expected.coverage).toBe('complete');
    // AR conserva la primera barra de la fecha local.
    expect(caseByName('ar_session_local').expected.anchorIndex).toBe(0);
  });

  it('CLICKED no convierte un objetivo fuera del histórico en ancla de borde', () => {
    expect(caseByName('clicked_dentro').expected.anchorIndex).toBe(1);
    expect(caseByName('clicked_exacto').expected.anchorIndex).toBe(1);
    expect(caseByName('clicked_antes').expected.coverage).toBe('unavailable');
    expect(caseByName('clicked_despues').expected.coverage).toBe('unavailable');
    expect(caseByName('clicked_empate').expected.anchorIndex).toBe(0);
  });

  it('RANGE_LOW/HIGH siguen resolviendo sobre las últimas 60 barras', () => {
    expect(caseByName('range_low_60').expected.anchorIndex).toBe(65);
    expect(caseByName('range_high_60').expected.anchorIndex).toBe(62);
    expect(fixture.anchorCases.find((c) => c.name === 'range_low_60')?.bars.length).toBe(70);
  });
});

describe('Pieza 50.7 Bloque B — proyección 1W de YTD/MTD sin volumen anterior al ancla', () => {
  it('coincide con la referencia en máscara, coordenada semanal y fecha real del ancla', () => {
    for (const item of fixture.projectionCases) {
      const weeklyBars = item.weeklyBars.map((time) => toBar(time, 100, 101));
      const dailyBars = item.dailyBars.map(([time, low, high]) => toBar(time, low, high));
      const projected = projectDailyAvwapToWeeklyPure(
        weeklyBars,
        dailyBars,
        item.mode,
        item.market,
      );
      expect(projected.anchorWeeklyTimeSec, item.name).toBe(item.expected.anchorWeeklyTimeSec);
      expect(projected.anchorDailyTimeSec, item.name).toBe(item.expected.anchorDailyTimeSec);
      expect(projected.coverage, item.name).toBe(item.expected.coverage);
      const valueIndices: number[] = [];
      projected.vwap.forEach((value, index) => {
        if (Number.isFinite(value)) valueIndices.push(index);
      });
      expect(valueIndices, item.name).toEqual([...item.expected.weeklyValueIndices]);
    }
  });

  it('la semana que cruza enero excluye el volumen previo al ancla', () => {
    const item = fixture.projectionCases.find((c) => c.name === 'semana_cruza_enero_completa');
    expect(item).toBeDefined();
    if (item === undefined) return;
    const weeklyBars = item.weeklyBars.map((time) => toBar(time, 100, 101));
    // Cierres y volúmenes variables para que el volumen precruzado sea observable.
    const dailyBars = item.dailyBars.map(([time], index) => ({
      time,
      open: 100,
      high: 100 + index,
      low: 99,
      close: 100 + index,
      volume: 100 + index * 10,
    }));
    const projected = projectDailyAvwapToWeeklyPure(weeklyBars, dailyBars, item.mode, item.market);
    const fromAnchor = computeSingleAnchorAvwapOverlayPure(dailyBars, item.expected.dailyAnchorIndex);
    const fromBoundary = computeSingleAnchorAvwapOverlayPure(dailyBars, 0);
    expect(projected.vwap[0]).toBeCloseTo(fromAnchor.vwap[3] ?? Number.NaN, 9);
    expect(projected.vwap[0]).not.toBeCloseTo(fromBoundary.vwap[3] ?? Number.NaN, 9);
    expect(Number.isNaN(fromAnchor.vwap[0] ?? Number.NaN)).toBe(true);
    expect(Number.isNaN(fromAnchor.vwap[1] ?? Number.NaN)).toBe(true);
    expect(projected.coverage).toBe('complete');
  });

  it('la vista usa la proyección 1W y conserva el clic al cambiar temporalidad', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );
    expect(src).toContain('projectDailyAvwapToWeeklyPure(bars, dailySource, avwapMode, market)');
    expect(src).toContain(
      'isArMarket ? (arBars1dResp?.bars ?? []) : (usBars1dResp?.bars ?? [])',
    );
    expect(src).toContain('resolveSingleAnchorAvwapPure(');
    // Aviso explícito de parcialidad y fecha real del ancla (1W usa la rueda diaria).
    expect(src).toContain("' (AVWAP parcial)'");
    expect(src).toContain('chartBundle.avwapAnchorDateSec');
    // El clic se limpia solo al cambiar de instrumento; el modo conserva su regla.
    expect(src).toContain('if (clickedAnchorStockKeyRef.current !== currentStockKey) {');
    expect(src).toContain("if (event.target.value !== 'CLICKED_CANDLE') setClickedAnchorTimeSec(null);");
    expect(src).not.toContain('localStorage');
  });
});
