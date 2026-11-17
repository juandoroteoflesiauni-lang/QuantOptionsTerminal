import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadBars } from '../src/data/loader.js';
import type { FetchFn } from '../src/data/types.js';
import {
  applyAvwapAccumulation,
  applyGgalTickToBar,
  avwapPointFromState,
  deriveGgalCclPrice,
  GgalTickStreamEngine,
  ggalTickBucketStartSec,
  type GgalBarTickEvent,
  type GgalTickMinuteBar,
} from '../src/server/ggalTickStream.js';
import {
  deepHistoryFromUtcSec,
  isGgalDeepHistoryTimeframe,
  mergeDeepHistoryBars,
} from '../src/server/ggalDeepHistory.js';
import { BmbFeedAdapter } from '../src/server/bmbFeedAdapter.js';

interface FixtureBucketCase {
  readonly name: string;
  readonly timeSec: number;
  readonly timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
  readonly expected: number | null;
}

interface FixtureTickBar {
  readonly timeSec: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

interface FixtureTickBarCase {
  readonly name: string;
  readonly priorBar: FixtureTickBar | null;
  readonly bucketSec: number;
  readonly price: number;
  readonly size: number;
  readonly expected: FixtureTickBar;
}

interface FixtureCclCase {
  readonly name: string;
  readonly arsPrice: number;
  readonly adrPrice: number;
  readonly expected: number | null;
}

interface FixtureAvwapBar {
  readonly timeSec: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

interface FixtureDeepHistoryBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

interface FixtureRoot {
  readonly bucketCases: readonly FixtureBucketCase[];
  readonly tickBarCases: readonly FixtureTickBarCase[];
  readonly cclCases: readonly FixtureCclCase[];
  readonly avwapCase: {
    readonly anchorSec: number;
    readonly bars: readonly FixtureAvwapBar[];
    readonly expectedPoints: readonly {
      readonly timeSec: number;
      readonly avwap: number | null;
      readonly plus1Sigma: number | null;
      readonly minus1Sigma: number | null;
    }[];
  };
  readonly deepHistoryCase: {
    readonly pages: readonly (readonly FixtureDeepHistoryBar[])[];
    readonly maxBars: number;
    readonly expectedBars: readonly FixtureDeepHistoryBar[];
    readonly coversElectoralGap: boolean;
    readonly duplicateLastWins: boolean;
    readonly expectedCount: number;
  };
  readonly deepHistoryCapCase: {
    readonly maxBars: number;
    readonly expectedCount: number;
    readonly expectedFirstTime: number | null;
  };
  readonly deepWindowCase: {
    readonly nowSec: number;
    readonly months: number;
    readonly expectedFromUtcSec: number;
  };
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/ggal_tick_stream.json', import.meta.url), 'utf-8'),
) as FixtureRoot;

describe('Pieza 39 — primitivas del motor tick (referencia Python independiente)', () => {
  it('bucketStartSec coincide con la referencia', () => {
    for (const caseItem of fixture.bucketCases) {
      const actual = ggalTickBucketStartSec(caseItem.timeSec, caseItem.timeframe);
      if (caseItem.expected === null) {
        expect(Number.isNaN(actual)).toBe(true);
      } else {
        expect(actual).toBe(caseItem.expected);
      }
    }
  });

  it('applyGgalTickToBar muta la vela exactamente como la referencia', () => {
    for (const caseItem of fixture.tickBarCases) {
      const actual = applyGgalTickToBar(caseItem.priorBar, caseItem.bucketSec, caseItem.price, caseItem.size);
      expect(actual, `case ${caseItem.name}`).toEqual(caseItem.expected);
    }
  });

  it('deriveGgalCclPrice = ARS * 10 / ADR con NaN ante entradas inválidas', () => {
    for (const caseItem of fixture.cclCases) {
      const actual = deriveGgalCclPrice(caseItem.arsPrice, caseItem.adrPrice);
      if (caseItem.expected === null) {
        expect(Number.isNaN(actual)).toBe(true);
      } else {
        expect(actual).toBeCloseTo(caseItem.expected, 9);
      }
    }
  });

  it('AVWAP anclado replica computeAnchoredVwapSeries (Welford HLC3, vol<=0 no acumula)', () => {
    let state = { anchorSec: fixture.avwapCase.anchorSec, cumPv: 0, cumVol: 0, mean: 0, m2: 0 };
    for (let index = 0; index < fixture.avwapCase.bars.length; index += 1) {
      const bar = fixture.avwapCase.bars[index];
      const expected = fixture.avwapCase.expectedPoints[index];
      if (bar === undefined || expected === undefined) {
        throw new Error('fixture index fuera de rango');
      }
      const typical = (bar.high + bar.low + bar.close) / 3;
      const nextState = applyAvwapAccumulation({ ...state }, typical, bar.volume);
      if (nextState === null) {
        throw new Error('estado AVWAP no debe ser null durante la acumulación');
      }
      state = nextState;
      const point = avwapPointFromState({ ...state });
      if (expected.avwap === null) {
        expect(point.avwap).toBeNull();
        continue;
      }
      if (point.avwap === null || point.plus1Sigma === null || point.minus1Sigma === null) {
        throw new Error('punto AVWAP esperado finito');
      }
      const expectedPlus1 = expected.plus1Sigma;
      const expectedMinus1 = expected.minus1Sigma;
      if (expectedPlus1 === null || expectedMinus1 === null) {
        throw new Error('referencia AVWAP esperada finita');
      }
      expect(point.avwap).toBeCloseTo(expected.avwap, 9);
      expect(point.plus1Sigma).toBeCloseTo(expectedPlus1, 9);
      expect(point.minus1Sigma).toBeCloseTo(expectedMinus1, 9);
    }
  });

  it('mergeDeepHistoryBars deduplica, ordena asc y cubre el gap electoral', () => {
    const caseItem = fixture.deepHistoryCase;
    const merged = mergeDeepHistoryBars(caseItem.pages, caseItem.maxBars);
    expect(merged).toHaveLength(caseItem.expectedCount);
    expect(merged).toEqual(caseItem.expectedBars);
    expect(caseItem.coversElectoralGap).toBe(true);
    expect(caseItem.duplicateLastWins).toBe(true);
    const capped = mergeDeepHistoryBars(caseItem.pages, fixture.deepHistoryCapCase.maxBars);
    expect(capped).toHaveLength(fixture.deepHistoryCapCase.expectedCount);
    expect(capped[0]?.time).toBe(fixture.deepHistoryCapCase.expectedFirstTime);
  });

  it('deepHistoryFromUtcSec retrocede 14 meses con clamp de fin de mes', () => {
    const caseItem = fixture.deepWindowCase;
    expect(deepHistoryFromUtcSec(caseItem.nowSec, caseItem.months)).toBe(caseItem.expectedFromUtcSec);
    expect(deepHistoryFromUtcSec(caseItem.nowSec, caseItem.months)).toBeLessThan(caseItem.nowSec);
  });

  it('isGgalDeepHistoryTimeframe: 5m/15m/1h profundos; 1m/4h/1D no', () => {
    expect(isGgalDeepHistoryTimeframe('5m')).toBe(true);
    expect(isGgalDeepHistoryTimeframe('15m')).toBe(true);
    expect(isGgalDeepHistoryTimeframe('1h')).toBe(true);
    expect(isGgalDeepHistoryTimeframe('1m')).toBe(false);
    expect(isGgalDeepHistoryTimeframe('4h')).toBe(false);
    expect(isGgalDeepHistoryTimeframe('1D')).toBe(false);
  });
});

describe('Pieza 39 — paginación histórica profunda de GGAL ADR (gap electoral, 15m y 1H)', () => {
  const NOW_SEC = 1_794_925_805; // 2026-11-17T14:30:05Z (sintético)
  const ELECTORAL_GAP_SEC = 1_760_391_600; // ~13 Oct 2025 (sintético)
  const FROM_SEC = deepHistoryFromUtcSec(NOW_SEC, 14);

  function deepFetchFn(
    pages: readonly { readonly results: readonly Record<string, number>[]; readonly nextUrl?: string }[],
    requests: string[],
  ): FetchFn {
    return (url: string): Promise<{ ok: boolean; status: number; text: string; headers: Record<string, string> }> => {
      requests.push(url);
      const page = pages[requests.length - 1];
      if (page === undefined) {
        throw new Error('unexpected request');
      }
      const body: Record<string, unknown> = { status: 'OK', results: page.results };
      if (page.nextUrl !== undefined) {
        body['next_url'] = page.nextUrl;
      }
      return Promise.resolve({ ok: true, status: 200, text: JSON.stringify(body), headers: {} });
    };
  }

  function wireRow(bar: FixtureDeepHistoryBar): Record<string, number> {
    return {
      t: bar.time * 1_000,
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume,
      vw: bar.close,
    };
  }

  async function runDeepLoad(timeframe: '15m' | '1h'): Promise<{ readonly requests: string[]; readonly bars: readonly { readonly time: number }[] }> {
    const step = timeframe === '15m' ? 900 : 3_600;
    const electoral = [
      { time: ELECTORAL_GAP_SEC, open: 42.1, high: 42.6, low: 41.9, close: 42.4, volume: 5_000 },
      { time: ELECTORAL_GAP_SEC + step, open: 42.4, high: 43.0, low: 42.3, close: 42.9, volume: 4_200 },
      { time: ELECTORAL_GAP_SEC + 2 * step, open: 42.9, high: 43.2, low: 42.7, close: 43.1, volume: 3_900 },
    ];
    const recent = [
      { time: NOW_SEC - 2 * step, open: 64.4, high: 64.7, low: 64.2, close: 64.5, volume: 3_100 },
      { time: NOW_SEC - step, open: 64.5, high: 64.9, low: 64.3, close: 64.78, volume: 2_800 },
    ];
    const requests: string[] = [];
    const fetchFn = deepFetchFn(
      [
        { results: electoral.map(wireRow), nextUrl: 'https://api.massive.com/v2/aggs/ticker/GGAL/range/next' },
        { results: recent.map(wireRow) },
      ],
      requests,
    );
    const result = await loadBars({
      provider: 'massive',
      symbol: 'GGAL',
      timeframe,
      visibleBars: 15_000,
      warmupBars: 0,
      rthOnly: false,
      maxPages: 8,
      now: NOW_SEC,
      apiKey: 'FIXTURE_API_KEY',
      fetchFn,
      window: { from: FROM_SEC, to: NOW_SEC },
      sort: 'asc',
      pageLimit: 5_000,
    });
    return { requests, bars: result.bars };
  }

  it('15m: sort=asc&limit=5000&window=14m siguiendo next_url hasta cubrir el gap electoral', async () => {
    const { requests, bars } = await runDeepLoad('15m');
    expect(requests).toHaveLength(2);
    const firstUrl = new URL(requests[0] as string);
    expect(firstUrl.searchParams.get('sort')).toBe('asc');
    expect(firstUrl.searchParams.get('limit')).toBe('5000');
    expect(firstUrl.searchParams.get('adjusted')).toBe('true');
    expect(firstUrl.pathname).toContain('/v2/aggs/ticker/GGAL/range/15/minute/');
    expect(requests[1]).toContain('next');
    expect(bars.length).toBe(5);
    expect(bars[0]?.time).toBe(ELECTORAL_GAP_SEC);
    const times = bars.map((bar) => bar.time);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(bars[0]?.time).toBeLessThan(Date.UTC(2025, 10, 1) / 1_000);
    expect(bars[bars.length - 1]?.time).toBe(NOW_SEC - 900);
  });

  it('1H: la paginación cubre el gap electoral dentro de la ventana de 14 meses', async () => {
    const { bars } = await runDeepLoad('1h');
    expect(bars.length).toBe(5);
    expect(bars[0]?.time).toBe(ELECTORAL_GAP_SEC);
    expect(bars[0]?.time).toBeLessThan(Date.UTC(2025, 10, 1) / 1_000);
  });

  it('la ventana de 14 meses comienza antes del gap electoral de octubre 2025', () => {
    expect(FROM_SEC).toBeLessThan(ELECTORAL_GAP_SEC);
    expect(FROM_SEC).toBeGreaterThan(0);
  });
});

describe('Pieza 39 — motor tick-by-tick: vela abierta, indicadores y eventos ggal_bar_tick', () => {
  const NOW_SEC = 1_794_925_805; // martes 2026-11-17T14:30:05Z (sintético)
  const SEED_CLOSES = Array.from({ length: 60 }, (_, index) => 60 + index * 0.05);

  function seedBars(): GgalTickMinuteBar[] {
    const bucketSec = 900;
    const lastBucket = Math.floor(NOW_SEC / bucketSec) * bucketSec - bucketSec;
    return SEED_CLOSES.map((close, index) => ({
      timeSec: lastBucket - (SEED_CLOSES.length - 1 - index) * bucketSec,
      open: close - 0.02,
      high: close + 0.05,
      low: close - 0.06,
      close,
      volume: 1_000,
      vw: close,
    }));
  }

  function collect(events: GgalBarTickEvent[]): (event: GgalBarTickEvent) => void {
    return (event) => events.push(event);
  }

  it('applyAdrMinute emite las 6 temporalidades con la vela abierta mutada e idempotente', () => {
    const events: GgalBarTickEvent[] = [];
    const engine = new GgalTickStreamEngine({
      nowMsFn: () => NOW_SEC * 1_000,
      emit: collect(events),
      minEmitIntervalMs: 0,
    });
    engine.seedHistory('ADR', '15m', seedBars());

    const minute1: GgalTickMinuteBar = {
      timeSec: NOW_SEC,
      open: 64.5,
      high: 64.9,
      low: 64.3,
      close: 64.78,
      volume: 2_800,
      vw: 64.6,
    };
    engine.applyAdrMinute(minute1);

    // Una emisión por timeframe (1m..1D) al primer tick del bucket.
    const byTimeframe = new Map(events.map((event) => [event.timeframe, event]));
    expect(events).toHaveLength(6);
    for (const timeframe of ['1m', '5m', '15m', '1h', '4h', '1D']) {
      expect(byTimeframe.get(timeframe as never)?.mode).toBe('ADR');
      expect(byTimeframe.get(timeframe as never)?.symbol).toBe('GGAL');
    }

    // La vela 15m adopta el bucket del minuto y su OHLCV.
    const tick15m = byTimeframe.get('15m') as GgalBarTickEvent;
    expect(tick15m.bar.timeSec).toBe(ggalTickBucketStartSec(minute1.timeSec, '15m'));
    expect(tick15m.bar.open).toBe(minute1.open);
    expect(tick15m.bar.high).toBe(minute1.high);
    expect(tick15m.bar.low).toBe(minute1.low);
    expect(tick15m.bar.close).toBe(minute1.close);
    expect(tick15m.bar.volume).toBe(minute1.volume);

    // UPSERT idempotente: el mismo minuto con el mismo close+volume no re-emit.
    const eventsAfterDup = events.length;
    engine.applyAdrMinute({ ...minute1 });
    expect(events.length).toBe(eventsAfterDup);

    // Minuto siguiente dentro del MISMO bucket 15m: volumen acumulado.
    const minute2: GgalTickMinuteBar = {
      timeSec: NOW_SEC + 60,
      open: 64.78,
      high: 65.1,
      low: 64.6,
      close: 65.02,
      volume: 1_500,
      vw: 64.9,
    };
    engine.applyAdrMinute(minute2);
    const tick15mAfter = events.filter((event) => event.timeframe === '15m')[1] as GgalBarTickEvent;
    expect(tick15mAfter.bar.timeSec).toBe(tick15m.bar.timeSec);
    expect(tick15mAfter.bar.open).toBe(minute1.open);
    expect(tick15mAfter.bar.high).toBe(65.1);
    expect(tick15mAfter.bar.low).toBe(64.3);
    expect(tick15mAfter.bar.close).toBe(minute2.close);
    expect(tick15mAfter.bar.volume).toBe(minute1.volume + minute2.volume);
  });

  it('EMA en vivo = alpha·precio + (1-alpha)·EMA_cerrada y el fold actualiza el estado', () => {
    const events: GgalTickEventRecord[] = [];
    type GgalTickEventRecord = GgalBarTickEvent;
    const engine = new GgalTickStreamEngine({
      nowMsFn: () => NOW_SEC * 1_000,
      emit: collect(events),
      minEmitIntervalMs: 0,
    });
    engine.seedHistory('ADR', '15m', seedBars());
    const seedEma21 = calculateExpectedEma(seedBars().map((bar) => bar.close), 21);

    const minute1: GgalTickMinuteBar = {
      timeSec: NOW_SEC,
      open: 64.5,
      high: 64.9,
      low: 64.3,
      close: 64.78,
      volume: 2_800,
      vw: 64.6,
    };
    engine.applyAdrMinute(minute1);
    const tick15m = events.filter((event) => event.timeframe === '15m')[0] as GgalBarTickEvent;
    const alpha21 = 2 / 22;
    expect(tick15m.indicatorsPoint.ema21).not.toBeNull();
    expect(tick15m.indicatorsPoint.ema21 as number).toBeCloseTo(
      alpha21 * minute1.close + (1 - alpha21) * seedEma21,
      9,
    );

    // Roll al siguiente bucket 15m: la vela cerrada alimenta la EMA persistente.
    const nextBucketSec = ggalTickBucketStartSec(NOW_SEC, '15m') + 900;
    const minuteNextBucket: GgalTickMinuteBar = {
      timeSec: nextBucketSec + 5,
      open: 65.02,
      high: 65.4,
      low: 64.9,
      close: 65.3,
      volume: 1_800,
      vw: 65.1,
    };
    engine.applyAdrMinute(minuteNextBucket);
    const tick15mNext = events.filter((event) => event.timeframe === '15m')[1] as GgalBarTickEvent;
    const foldedEma21 = alpha21 * minute1.close + (1 - alpha21) * seedEma21;
    expect(tick15mNext.indicatorsPoint.ema21 as number).toBeCloseTo(
      alpha21 * minuteNextBucket.close + (1 - alpha21) * foldedEma21,
      9,
    );
    expect(tick15mNext.bar.timeSec).toBe(nextBucketSec);
  });

  it('ARS y CCL derivado: ggal_bar_tick para mode ARS y CCL = ARS * 10 / ADR', () => {
    const events: GgalBarTickEvent[] = [];
    const engine = new GgalTickStreamEngine({
      nowMsFn: () => NOW_SEC * 1_000,
      emit: collect(events),
      minEmitIntervalMs: 0,
    });
    engine.seedHistory('ADR', '15m', seedBars());
    engine.applyAdrMinute({
      timeSec: NOW_SEC,
      open: 64.5,
      high: 64.9,
      low: 64.3,
      close: 64.52,
      volume: 2_800,
      vw: 64.6,
    });
    engine.applyArsTick({ price: 6_450.5, size: 120, timeSec: NOW_SEC });

    const arsEvents = events.filter((event) => event.mode === 'ARS');
    const cclEvents = events.filter((event) => event.mode === 'CCL');
    expect(arsEvents.length).toBe(6);
    expect(cclEvents.length).toBe(6);
    const ars15m = arsEvents.find((event) => event.timeframe === '15m') as GgalBarTickEvent;
    expect(ars15m.bar.close).toBe(6_450.5);
    expect(ars15m.bar.volume).toBe(120);
    const ccl15m = cclEvents.find((event) => event.timeframe === '15m') as GgalBarTickEvent;
    expect(ccl15m.bar.close).toBeCloseTo((6_450.5 * 10) / 64.52, 9);
    expect(ccl15m.bar.volume).toBe(0);
  });
});

function calculateExpectedEma(closes: readonly number[], period: number): number {
  // Referencia espejo del SPEC punto 2: alpha = 2/(N+1), semilla SMA de los
  // primeros N cierres, luego recursión sobre el resto.
  const alpha = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < closes.length; index += 1) {
    const close = closes[index];
    if (close === undefined) {
      throw new Error('indice fuera de rango');
    }
    ema = alpha * close + (1 - alpha) * ema;
  }
  return ema;
}

describe('Pieza 39 — ticks ARS desde el bridge BMB (trades GGAL por secuencia)', () => {
  const ENV = {
    BMB_DNI: '20123456789',
    BMB_USER: 'fake_user',
    BMB_PASS: 'fake_password',
    BMB_ACCOUNT: 'fake_account',
    BMB_BROKER_ID: '153',
  } as const satisfies NodeJS.ProcessEnv;
  const NOW_MS = Date.UTC(2026, 10, 17, 14, 0, 0); // martes 11:00 ART -> sesión BYMA

  function snapshotBody(sequenceFrom: number, sequenceTo: number): string {
    const trades = [];
    for (let sequence = sequenceFrom; sequence <= sequenceTo; sequence += 1) {
      trades.push({
        sequence,
        symbol: 'GGAL',
        timeSec: Math.floor(NOW_MS / 1_000) + sequence,
        price: 6_450 + sequence * 0.5,
        size: 100 * sequence,
        side: 'BUY',
        buyVolume: 100 * sequence,
        sellVolume: 0,
        attributableToLast: true,
      });
    }
    return JSON.stringify({
      status: 'CONNECTED_L2',
      brokerId: 153,
      accountLabel: null,
      pyhomebrokerInstalled: true,
      passwordConfigured: true,
      asOfUtcSec: Math.floor(NOW_MS / 1_000),
      error: null,
      cauciones: [],
      orderBooksBySymbol: {},
      options: [],
      tradesBySymbol: { GGAL: trades },
    });
  }

  it('setGgalArsTickListener recibe cada trade nuevo por secuencia y deduplica', async () => {
    let body = snapshotBody(1, 3);
    let nowMs = NOW_MS;
    const adapter = new BmbFeedAdapter({
      env: ENV,
      manageProcess: false,
      nowMsFn: () => nowMs,
      fetchFn: () =>
        Promise.resolve({ ok: true, status: 200, text: body, headers: {} }),
    });
    const ticks: { readonly price: number; readonly size: number; readonly timeSec: number }[] = [];
    adapter.setGgalArsTickListener((tick) => ticks.push(tick));
    await adapter.getSnapshot('GGAL', null, true);
    expect(ticks).toHaveLength(3);
    expect(ticks[0]?.price).toBe(6_450.5);
    expect(ticks[0]?.size).toBe(100);

    // Mismo snapshot otra vez: sin trades nuevos -> sin ticks repetidos.
    nowMs += 1_600;
    await adapter.getSnapshot('GGAL', null, true);
    expect(ticks).toHaveLength(3);

    // Trades nuevos (secuencias 4-5) -> solo los nuevos emiten.
    nowMs += 1_600;
    body = snapshotBody(4, 5);
    await adapter.getSnapshot('GGAL', null, true);
    expect(ticks).toHaveLength(5);
    expect(ticks[3]?.price).toBe(6_452);
    adapter.setGgalArsTickListener(null);
    adapter.stop();
  });
});
