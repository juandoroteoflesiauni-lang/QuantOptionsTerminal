/**
 * Pieza 50.8 (Bloque B1) — reductor determinista de eventos live 1D/1W.
 *
 * Referencia independiente: `tools/gen_live_reconciler_pieza50_8.py`
 * (`fixtures/live_reconciler_pieza50_8_reference.json`). Cubre dos extremos en
 * un mismo rAF, duplicados, atrasados, revisión con progreso demostrable,
 * volumen acumulado vs snapshot, solapamiento histórico/live, reconexión,
 * cambio de sesión, separación US/AR y ausencia de retrocesos; además verifica
 * la integración (cola + rAF solo pinta) y la conservación intradía.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createLiveFrameState,
  liveFrameVolume,
  reduceMinuteSnapshot,
  reduceQuoteTick,
  type LiveFrameState,
  type LiveMinuteSnapshot,
  type LiveReduceOutcome,
} from '../src/core/liveBarReconciler.js';
import { projectLiveCandle, type LiveCalendarProjection, type LiveChartBar } from '../src/core/realtimePropagation.js';

interface FixtureEvent {
  readonly kind: 'minute' | 'quote';
  readonly snapshot?: LiveMinuteSnapshot;
  readonly price?: number;
  readonly timeSec?: number;
}

interface ReconcilerCase {
  readonly name: string;
  readonly bar: LiveChartBar;
  readonly calendar: LiveCalendarProjection;
  readonly events: readonly FixtureEvent[];
  readonly expectedOutcomes: readonly LiveReduceOutcome[];
  readonly expectedBar: LiveChartBar;
}

interface ReconcilerFixture {
  readonly cases: readonly ReconcilerCase[];
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures', 'live_reconciler_pieza50_8_reference.json'), 'utf-8'),
) as ReconcilerFixture;

function runCase(item: ReconcilerCase): { outcomes: LiveReduceOutcome[]; state: LiveFrameState } {
  let state = createLiveFrameState(item.bar);
  const outcomes: LiveReduceOutcome[] = [];
  for (const event of item.events) {
    if (event.kind === 'minute') {
      const snapshot = event.snapshot;
      if (snapshot === undefined) throw new Error(`minute event without snapshot in ${item.name}`);
      const result = reduceMinuteSnapshot(state, snapshot, item.calendar);
      outcomes.push(result.outcome);
      state = result.state;
    } else {
      const result = reduceQuoteTick(
        state,
        { price: event.price ?? Number.NaN, timeSec: event.timeSec ?? Number.NaN },
        item.calendar,
      );
      outcomes.push(result.outcome);
      state = result.state;
    }
  }
  return { outcomes, state };
}

function caseByName(name: string): ReconcilerCase {
  const found = fixture.cases.find((item) => item.name === name);
  if (found === undefined) throw new Error(`Reconciler case not found: ${name}`);
  return found;
}

function expectBar(actual: LiveChartBar, expected: LiveChartBar, label: string): void {
  expect(actual.timeSec, `${label}.timeSec`).toBe(expected.timeSec);
  expect(actual.open, `${label}.open`).toBeCloseTo(expected.open, 12);
  expect(actual.high, `${label}.high`).toBeCloseTo(expected.high, 12);
  expect(actual.low, `${label}.low`).toBeCloseTo(expected.low, 12);
  expect(actual.close, `${label}.close`).toBeCloseTo(expected.close, 12);
  expect(actual.volume, `${label}.volume`).toBeCloseTo(expected.volume, 12);
}

describe('Pieza 50.8 Bloque B1 — reductor de eventos live (referencia Python)', () => {
  it('coincide con la referencia en desenlaces y vela final de cada caso', () => {
    for (const item of fixture.cases) {
      const { outcomes, state } = runCase(item);
      expect(outcomes, item.name).toEqual([...item.expectedOutcomes]);
      expectBar(state.bar, item.expectedBar, item.name);
    }
  });

  it('conserva máximos y mínimos legítimos de dos eventos en un mismo rAF', () => {
    const highs = runCase(caseByName('dos_maximos'));
    expect(highs.state.bar.high).toBe(108);
    const lows = runCase(caseByName('dos_minimos'));
    expect(lows.state.bar.low).toBe(93);
  });

  it('deduplica, descarta atrasados y solo acepta revisiones con progreso demostrable', () => {
    expect(runCase(caseByName('duplicado')).outcomes).toEqual(['accepted', 'duplicate']);
    const delayed = runCase(caseByName('atrasado'));
    expect(delayed.outcomes).toEqual(['accepted', 'stale']);
    // El evento atrasado no revierte el cierre vigente.
    expect(delayed.state.bar.close).toBe(107);
    const revision = runCase(caseByName('revision'));
    expect(revision.outcomes).toEqual(['accepted', 'revision']);
    expect(revision.state.bar.close).toBe(106);
    const noRevert = runCase(caseByName('sin_retroceso'));
    expect(noRevert.outcomes).toEqual(['accepted', 'revision', 'stale']);
    expect(noRevert.state.bar.close).toBe(106);
    expect(noRevert.state.bar.high).toBe(107);
  });

  it('no suma dos veces el mismo minuto ni el solapamiento histórico/live', () => {
    const overlap = runCase(caseByName('solapamiento'));
    // Histórico 1000 conservado; el primer minuto (línea base) no suma; el
    // segundo minuto suma una sola vez.
    expect(overlap.state.bar.volume).toBe(1020);
    expect(liveFrameVolume(overlap.state)).toBe(1020);
    const reconnection = runCase(caseByName('reconexion'));
    // (Re)conexión a mitad de rueda: el primer snapshot no altera el volumen.
    expect(reconnection.state.bar.volume).toBe(1000);
    expect(reconnection.state.bar.close).toBe(108);
  });

  it('el contador de quote US se excluye y AR conserva su volumen conocido', () => {
    expect(runCase(caseByName('contador_quote_us')).outcomes).toEqual(['deferred']);
    const arQuote = runCase(caseByName('ar_quote_misma_rueda'));
    expect(arQuote.outcomes).toEqual(['accepted']);
    expect(arQuote.state.bar.close).toBe(302);
    expect(arQuote.state.bar.volume).toBe(800);
    expect(runCase(caseByName('ar_minuto_deferred')).outcomes).toEqual(['deferred']);
    expect(runCase(caseByName('ar_semana_minuto_deferred')).outcomes).toEqual(['deferred']);
    expect(runCase(caseByName('ar_quote_rueda_nueva')).outcomes).toEqual(['deferred']);
    expect(runCase(caseByName('ar_quote_anterior')).outcomes).toEqual(['stale']);
  });

  it('cambio de sesión: pre/after no contaminan y la rueda nueva abre con etiqueta', () => {
    const session = runCase(caseByName('cambio_sesion'));
    expect(session.outcomes).toEqual(['out-of-session', 'accepted']);
    expect(session.state.bar.open).toBe(110);
    expect(session.state.bar.volume).toBe(0);
    expect(session.state.bar.timeSec).toBeGreaterThan(caseByName('cambio_sesion').bar.timeSec);
    const holidayWeek = runCase(caseByName('us_1w_lunes_feriado'));
    expect(holidayWeek.outcomes).toEqual(['accepted', 'stale']);
    expect(holidayWeek.state.bar.timeSec).toBe(caseByName('us_1w_lunes_feriado').bar.timeSec);
  });

  it('mantiene la paridad intradía exacta (la ruta de calendario no interviene)', () => {
    const bar: LiveChartBar = { timeSec: 900, open: 100, high: 101, low: 99, close: 100, volume: 10 };
    const same = projectLiveCandle(bar, { price: 102, timeSec: 1_030, volumeDelta: 5 }, 300);
    expect(same).not.toBeNull();
    expectBar(same ?? bar, { timeSec: 900, open: 100, high: 102, low: 99, close: 102, volume: 15 }, 'same');
    const next = projectLiveCandle(bar, { price: 103, timeSec: 1_230, volumeDelta: 5 }, 300);
    expect(next).not.toBeNull();
    expectBar(next ?? bar, { timeSec: 1_200, open: 103, high: 103, low: 103, close: 103, volume: 5 }, 'next');
  });

  it('la vista encola todos los eventos y solo pinta en rAF (guardas estructurales)', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );
    expect(src).not.toContain('pendingLiveTickRef');
    expect(src).toContain('pendingLiveEventsRef');
    expect(src).toContain('for (const event of queue)');
    expect(src).toContain('reduceMinuteSnapshot(state, event.snapshot, calendar)');
    expect(src).toContain('reduceQuoteTick(state, { price: event.price, timeSec: event.timeSec }, calendar)');
    expect(src).toContain("if (market !== 'US') return;");
    expect(src).toContain('paintFormingBar');
    expect(src).toContain('window.requestAnimationFrame(flushLiveTick)');
  });
});

