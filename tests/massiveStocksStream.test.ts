import { describe, expect, it, vi } from 'vitest';
import type { FetchResponse } from '../src/data/types.js';
import type {
  MassiveWsClientOptions,
  WsAggBarEvent,
  WsClientSnapshot,
  WsTradeEvent,
} from '../src/data/wsTypes.js';
import {
  getMassiveBatchIntervalMs,
  getUsLiveSession,
  MassiveStocksStream,
  type MarketTickQuote,
  type MassiveStreamWsClient,
} from '../src/server/massiveStocksStream.js';
import {
  US_ADR_TICKERS,
  US_PANEL_TICKERS,
  US_STREAM_SYMBOLS,
} from '../src/server/marketRuntime.js';

// Miércoles 2026-01-14 15:00 UTC = 10:00 ET (EST) -> sesión RTH.
const RTH_NOW_MS = Date.UTC(2026, 0, 14, 15, 0, 0);
const DAY_T_SEC = Math.floor(RTH_NOW_MS / 1_000);
const PREV_DAY_T_SEC = Math.floor(Date.UTC(2026, 0, 13, 21, 0, 0) / 1_000); // cierre martes 16:00 ET

interface Harness {
  readonly stream: MassiveStocksStream;
  readonly createdOptions: readonly MassiveWsClientOptions[];
  pushEvents(events: readonly (WsTradeEvent | WsAggBarEvent)[]): void;
  setBatchBody(body: unknown): void;
  advanceMs(ms: number): void;
}

function stockSnapshotEntry(
  ticker: string,
  day: { readonly c: number; readonly v: number; readonly l: number; readonly h: number; readonly vw: number },
  prevDay: { readonly c: number },
): Record<string, unknown> {
  return {
    ticker,
    day: { c: day.c, v: day.v, l: day.l, h: day.h, vw: day.vw, t: DAY_T_SEC },
    prevDay: { c: prevDay.c, t: PREV_DAY_T_SEC },
    min: { c: day.c, t: DAY_T_SEC },
  };
}

function makeHarness(symbols: readonly string[]): Harness {
  let nowMs = RTH_NOW_MS;
  const createdOptions: MassiveWsClientOptions[] = [];
  let pushFn: ((events: readonly (WsTradeEvent | WsAggBarEvent)[]) => void) | null = null;
  let batchBody: unknown = { tickers: [] };

  const createWsClientFn = (options: MassiveWsClientOptions): MassiveStreamWsClient => {
    createdOptions.push(options);
    const onEvents = options.onEvents;
    pushFn = (events) => onEvents?.(events);
    return {
      connect: () => Promise.resolve(),
      subscribe: () => undefined,
      unsubscribe: () => undefined,
      close: () => undefined,
      getSnapshot: (): WsClientSnapshot => ({
        cluster: options.cluster,
        url: 'wss://socket.massive.com/stocks',
        state: 'ready',
        subscriptions:
          typeof options.initialSubscriptions === 'string'
            ? options.initialSubscriptions.split(',')
            : [...(options.initialSubscriptions ?? [])],
        activeQuoteSubscriptionCount: 0,
        queueDepth: 0,
        droppedQueueMessages: 0,
        reconnectAttempts: 0,
        totalMessagesReceived: 0,
        discardedPayloads: 0,
        lastError: null,
      }),
    };
  };

  const fetchFn = async (url: string): Promise<FetchResponse> => {
    await Promise.resolve();
    if (url.includes('/v2/snapshot/locale/us/markets/stocks/tickers')) {
      return { ok: true, status: 200, text: JSON.stringify(batchBody), headers: {} };
    }
    return { ok: true, status: 200, text: JSON.stringify({ results: [] }), headers: {} };
  };

  const stream = new MassiveStocksStream({
    apiKey: 'k_stream_test',
    symbols,
    fetchFn,
    createWsClientFn,
    nowMsFn: () => nowMs,
  });

  return {
    stream,
    createdOptions,
    pushEvents: (events) => {
      if (pushFn === null) throw new Error('WS client not created yet');
      pushFn(events);
    },
    setBatchBody: (body) => {
      batchBody = body;
    },
    advanceMs: (ms) => {
      nowMs += ms;
    },
  };
}

function makeTrade(symbol: string, price: number, size: number, timeSec: number): WsTradeEvent {
  return {
    ev: 'T',
    sym: symbol,
    price,
    size,
    timeSec,
    eventTimeMs: timeSec * 1_000,
  };
}

function makeAgg(
  symbol: string,
  bar: { readonly time: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number },
  accumulatedVolume: number,
): WsAggBarEvent {
  return {
    ev: 'A',
    sym: symbol,
    bar,
    startMs: bar.time * 1_000,
    endMs: (bar.time + 1) * 1_000,
    accumulatedVolume,
  };
}

describe('MassiveStocksStream — universo US completo, suscripciones T.<símbolo> y fusión WS/batch', () => {
  it('declara el panel de 73 tickers, los 13 ADRs argentinos y el universo de stream deduplicado', () => {
    expect(US_PANEL_TICKERS).toHaveLength(73);
    expect(new Set(US_PANEL_TICKERS).size).toBe(73);
    expect(US_PANEL_TICKERS).toEqual(
      expect.arrayContaining(['AAPL', 'NVDA', 'GGAL', 'BMA', 'YPF', 'PAM', 'VIST', 'MELI', 'SPY', 'QQQ', 'IWM', 'DIA', 'XLF', 'EWZ']),
    );

    expect(US_ADR_TICKERS).toHaveLength(13);
    expect([...new Set(US_ADR_TICKERS)].length).toBe(13);
    expect(US_ADR_TICKERS).toEqual(
      expect.arrayContaining(['GGAL', 'YPF', 'PAM', 'BMA', 'SUPV', 'BBAR', 'CEPU', 'TGS', 'EDN', 'TEO', 'LOMA', 'CRESY', 'IRS']),
    );

    const expected = new Set([...US_PANEL_TICKERS, ...US_ADR_TICKERS, 'SPY', 'QQQ', 'IWM', 'DIA', 'I:VIX']);
    expect(US_STREAM_SYMBOLS).toHaveLength(expected.size); // 73 + 9 ADRs nuevos + SPY/QQQ/IWM/DIA/I:VIX
    for (const symbol of expected) {
      expect(US_STREAM_SYMBOLS).toContain(symbol);
    }
    expect(US_STREAM_SYMBOLS.filter((s) => s.startsWith('T.'))).toHaveLength(0);
  });

  it('suscribe canales explícitos T.<símbolo> por cada acción/ETF (sin wildcard T.*) conservando Q.*/AM.*', () => {
    const h = makeHarness(['AAPL', 'MSFT', 'SPY', 'I:VIX']);
    void h.stream.start();
    expect(h.createdOptions.length).toBe(1);
    const subs = (h.createdOptions[0]?.initialSubscriptions ?? []) as readonly string[];
    expect(subs).toContain('T.AAPL');
    expect(subs).toContain('T.MSFT');
    expect(subs).toContain('T.SPY');
    expect(subs).toContain('Q.*');
    expect(subs).toContain('AM.*');
    expect(subs).not.toContain('T.*');
    expect(subs.filter((s) => s.startsWith('T.')).sort()).toEqual(['T.AAPL', 'T.MSFT', 'T.SPY']);
    h.stream.stop();
  });

  it('aplica cadencia de batch 2500 ms RTH / 5000 ms extendida / 30000 ms cerrada', () => {
    expect(getUsLiveSession(RTH_NOW_MS)).toBe('RTH');
    expect(getMassiveBatchIntervalMs(RTH_NOW_MS)).toBe(2_500);
    const extendedMs = Date.UTC(2026, 0, 14, 13, 0, 0); // 08:00 ET
    expect(getUsLiveSession(extendedMs)).toBe('EXTENDED');
    expect(getMassiveBatchIntervalMs(extendedMs)).toBe(5_000);
    const closedMs = Date.UTC(2026, 0, 17, 15, 0, 0); // sábado
    expect(getUsLiveSession(closedMs)).toBe('CLOSED');
    expect(getMassiveBatchIntervalMs(closedMs)).toBe(30_000);
  });

  it('acumula volumen/turnover por trade solo con baseline real y actualiza extremos sin inventar datos', async () => {
    const h = makeHarness(['AAPL']);
    h.setBatchBody({
      tickers: [stockSnapshotEntry('AAPL', { c: 101, v: 1000, l: 99, h: 101, vw: 100.5 }, { c: 98 })],
    });
    await h.stream.start();
    await vi.waitFor(() => {
      expect(h.stream.getQuote('AAPL')).not.toBeNull();
    });
    const baseline = h.stream.getQuote('AAPL') as MarketTickQuote;
    expect(baseline.price).toBe(101);
    expect(baseline.previousClose).toBe(98);
    expect(baseline.volume).toBe(1000);
    expect(baseline.turnover).toBeCloseTo(100_500, 9);
    expect(baseline.dayLow).toBe(99);
    expect(baseline.dayHigh).toBe(101);
    expect(baseline.source).toBe('MASSIVE_BATCH');

    // Trade WS con baseline: precio, variación, volumen (+50) y turnover (+notional real).
    h.advanceMs(1_000);
    h.pushEvents([makeTrade('AAPL', 102, 50, DAY_T_SEC + 1)]);
    const afterTrade = h.stream.getQuote('AAPL') as MarketTickQuote;
    expect(afterTrade.price).toBe(102);
    expect(afterTrade.source).toBe('MASSIVE_WS');
    expect(afterTrade.volume).toBe(1050);
    expect(afterTrade.turnover).toBeCloseTo(105_600, 9);
    expect(afterTrade.dayHigh).toBe(102); // expande extremo
    expect(afterTrade.dayLow).toBe(99);
    expect(afterTrade.changePct).toBeCloseTo(((102 - 98) / 98) * 100, 9);

    // Agregado A: accumulatedVolume del proveedor es autoritativo y la vela aporta extremos.
    h.pushEvents([
      makeAgg('AAPL', { time: DAY_T_SEC + 30, open: 101, high: 103.5, low: 100.5, close: 103, volume: 300 }, 1500),
    ]);
    const afterAgg = h.stream.getQuote('AAPL') as MarketTickQuote;
    expect(afterAgg.price).toBe(103);
    expect(afterAgg.volume).toBe(1500);
    expect(afterAgg.dayHigh).toBe(103.5);
    expect(afterAgg.dayLow).toBe(99);
    h.stream.stop();
  });

  it('nunca inventa volumen desde un único trade sin baseline (queda null, UI muestra —)', async () => {
    const h = makeHarness(['TSLA']);
    await h.stream.start();
    h.pushEvents([makeTrade('TSLA', 250, 10, DAY_T_SEC)]);
    const quote = h.stream.getQuote('TSLA') as MarketTickQuote;
    expect(quote.price).toBe(250);
    expect(quote.volume).toBeNull();
    expect(quote.turnover).toBeNull();
    expect(quote.dayLow).toBeNull();
    expect(quote.dayHigh).toBeNull();
    expect(quote.previousClose).toBeNull();
    h.stream.stop();
  });

  it('un batch REST más viejo no pisa precio, volumen ni extremos frescos del WS', async () => {
    const h = makeHarness(['AAPL']);
    h.setBatchBody({
      tickers: [stockSnapshotEntry('AAPL', { c: 101, v: 1000, l: 99, h: 101, vw: 100.5 }, { c: 98 })],
    });
    await h.stream.start();
    await vi.waitFor(() => {
      expect(h.stream.getQuote('AAPL')).not.toBeNull();
    });
    h.advanceMs(1_000);
    h.pushEvents([makeTrade('AAPL', 102, 50, DAY_T_SEC + 1)]);

    // Batch REST 2 s después del trade (tick WS fresco): el batch sólo aporta
    // baseline faltante y unión de extremos; nunca retrocede precio ni volumen.
    h.advanceMs(2_000);
    h.setBatchBody({
      tickers: [stockSnapshotEntry('AAPL', { c: 100.5, v: 900, l: 98.5, h: 101, vw: 100 }, { c: 98 })],
    });
    h.stream.stop();
    await h.stream.start();
    await vi.waitFor(() => {
      expect((h.stream.getQuote('AAPL') as MarketTickQuote).dayLow).toBe(98.5);
    });
    const fresh = h.stream.getQuote('AAPL') as MarketTickQuote;
    expect(fresh.price).toBe(102); // precio WS fresco intacto
    expect(fresh.source).toBe('MASSIVE_WS');
    expect(fresh.volume).toBe(1050); // volumen WS intacto (no retrocede a 900)
    expect(fresh.turnover).toBeCloseTo(105_600, 9);
    expect(fresh.dayLow).toBe(98.5); // unión con extremo REST real
    expect(fresh.dayHigh).toBe(102);

    // Batch REST con tick WS ya viejo (>10 s): precio REST vigente; el volumen de
    // la misma rueda ET toma el mayor (nunca retrocede); extremos se unen.
    h.advanceMs(20_000);
    h.setBatchBody({
      tickers: [stockSnapshotEntry('AAPL', { c: 100.5, v: 1200, l: 97, h: 103, vw: 100 }, { c: 98 })],
    });
    h.stream.stop();
    await h.stream.start();
    await vi.waitFor(() => {
      expect((h.stream.getQuote('AAPL') as MarketTickQuote).source).toBe('MASSIVE_BATCH');
    });
    const merged = h.stream.getQuote('AAPL') as MarketTickQuote;
    expect(merged.price).toBe(100.5);
    expect(merged.volume).toBe(1200); // max(1050, 1200)
    expect(merged.turnover).toBeCloseTo(120_000, 9); // max(105600, 1200*100)
    expect(merged.dayLow).toBe(97);
    expect(merged.dayHigh).toBe(103);
    expect(merged.previousClose).toBe(98);
    h.stream.stop();
  });

  it('ignora símbolos fuera del universo configurado y eventos con timestamp regresivo', async () => {
    const h = makeHarness(['AAPL']);
    await h.stream.start();
    h.pushEvents([makeTrade('PLTR', 80, 100, DAY_T_SEC)]); // fuera del universo
    expect(h.stream.getQuote('PLTR')).toBeNull();

    h.pushEvents([makeTrade('AAPL', 102, 10, DAY_T_SEC + 5)]);
    expect((h.stream.getQuote('AAPL') as MarketTickQuote).price).toBe(102);
    // Trade con timestamp anterior: no regresa el precio.
    h.pushEvents([makeTrade('AAPL', 90, 10, DAY_T_SEC)]);
    expect((h.stream.getQuote('AAPL') as MarketTickQuote).price).toBe(102);
    h.stream.stop();
  });
});
