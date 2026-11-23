import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/pieza_m1_m2_reference.json' with { type: 'json' };
import {
  evaluateCclContemporaneity,
  parseTradierTimestamp,
  type CclMarketRegime,
  type TradierTimestampFieldHint,
} from '../src/core/temporalFeedIntegrity.js';
import { computeLiveFxFromQuotes } from '../src/core/realtimePropagation.js';
import { normalizeOptionChainSnapshot } from '../src/data/normalizeOptions.js';
import {
  fetchTradierOptionChain,
  fetchTradierQuotes,
  overlayTradierChainOnCanonicalContracts,
  resolveTradierConfig,
  TradierLiveManager,
  type TradierStreamTick,
} from '../src/server/tradierAdapter.js';
import { coalesceEventKey, enqueueCoalescedEvent } from '../src/server/httpWsServer.js';
import { resolveQuoteMid, type RuntimeWsBroadcast } from '../src/server/marketRuntime.js';
import { GgalTickStreamEngine, type GgalBarTickEvent } from '../src/server/ggalTickStream.js';

const ticker = 'GGAL261218C00050000';
const expiry = '2026-12-18';
const now = fixture.now;
const config = resolveTradierConfig({ TRADIER_TOKEN: 'fixture-token' }, 'tests/.env-not-present');

function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Falta un valor requerido en el replay');
  return value;
}

function expectDecimal(actual: number, reference: string | null): void {
  if (reference === null) {
    expect(Number.isNaN(actual)).toBe(true);
    return;
  }
  const expected = Number(reference);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
}

function canonicalOption() {
  const { bid, ask, midpoint, updatedAt, bidSize, askSize, gamma } = fixture.massive;
  const contract = requireValue(normalizeOptionChainSnapshot({ results: [{
    details: { ticker: 'O:' + ticker, expiration_date: expiry, contract_type: 'call', strike_price: 50, shares_per_contract: 100 },
    last_quote: { bid, ask, midpoint: Number(midpoint), bid_size: bidSize, ask_size: askSize, last_updated: updatedAt * 1_000 },
    greeks: { delta: 0.4, gamma: Number(gamma), theta: -0.02, vega: 0.1 },
    implied_volatility: 0.25,
    day: { volume: 3 },
    open_interest: 10,
  }] }).contracts[0]);
  return { ...contract, lastQuote: { ...contract.lastQuote, updatedAt } };
}

async function parseRestContract(raw: object) {
  const result = await fetchTradierOptionChain('GGAL', expiry, {
    config,
    nowMsFn: () => now * 1_000,
    httpFn: () => Promise.resolve({
      ok: true, status: 200,
      text: JSON.stringify({ options: { option: { symbol: ticker, option_type: 'call', strike: 50, expiration_date: expiry, ...raw } } }),
    }),
  });
  expect(result.contracts).toHaveLength(1);
  return requireValue(result.contracts[0]);
}

function stream(throttle = 0) {
  const events: GgalBarTickEvent[] = [];
  let nowSec = now;
  const engine = new GgalTickStreamEngine({ nowMsFn: () => nowSec * 1_000, emit: (event) => events.push(event), minEmitIntervalMs: throttle });
  return {
    engine, events,
    setClock: (timeSec: number) => { nowSec = timeSec; },
    minutes: (mode: GgalBarTickEvent['mode'] = 'ADR') => events.filter((event) => event.mode === mode && event.timeframe === '1m'),
  };
}

describe('M1 · relojes de Tradier y sustitución atómica', () => {
  it.each(fixture.validTimestamps)('normaliza $value ($unit)', ({ value, hint, nativeMs, utcSec, unit }) => {
    expect(parseTradierTimestamp(value, hint as TradierTimestampFieldHint)).toEqual({
      ok: true, nativeMs, utcSec, unit, rejectReason: null,
    });
  });

  it.each(fixture.rejectedTimestamps)('rechaza $value ($reason)', ({ value, reason }) => {
    expect(parseTradierTimestamp(value, 'BID_DATE')).toEqual({
      ok: false, nativeMs: Number.NaN, utcSec: Number.NaN, unit: 'NONE', rejectReason: reason,
    });
  });

  it('rechaza una marca ausente', () => {
    expect(parseTradierTimestamp(undefined)).toEqual(parseTradierTimestamp(null));
  });

  it.each(fixture.overlays)('$name', async ({ raw, expected, count, accepted, greeksMissing }) => {
    const massive = { ...canonicalOption(), greeksMissing: greeksMissing === true };
    const row = await parseRestContract(raw);
    const result = overlayTradierChainOnCanonicalContracts([massive], [row], { nowSec: now });
    const contract = requireValue(result.contracts[0]);
    const { gamma, midpoint, ...bbo } = expected;
    expect(contract.lastQuote).toMatchObject(bbo);
    expectDecimal(contract.lastQuote.midpoint, midpoint);
    expectDecimal(resolveQuoteMid(contract), midpoint);
    expectDecimal(contract.greeks.gamma, gamma);
    expect(result.summary[count as keyof typeof result.summary]).toBe(1);
    expect(result.quoteSubstitutedTickers.has(massive.ticker)).toBe(accepted);
    expect(result.verifiedQuoteTimeTickers.has(massive.ticker)).toBe(accepted);
    if (accepted) {
      expect(contract.lastQuote).toMatchObject({
        source: 'TRADIER', quoteQuality: 'LIVE_ATOMIC', bidTimeUtcSec: now - 2, askTimeUtcSec: now - 1,
        receivedAtUtcSec: now, bidExchange: null, askExchange: null,
      });
      expect(row.tradeTimeUtcSec).toBe(now - 300);
      expect(row.tradeTimeNativeMs).toBe((now - 300) * 1_000);
    } else {
      expect(contract.lastQuote).toBe(massive.lastQuote);
    }
    if (count === 'rejectedInvalidTimestamp') {
      expect(row.bidTimeUtcSec).toBeNaN();
      expect(row.askTimeUtcSec).toBeNaN();
      expect(row.providerTimestampUtcSec).toBeNaN();
      expect(row.tradeTimeUtcSec).toBe(now - 1);
    }
    if (gamma !== fixture.massive.gamma) {
      expect(contract.greeksProvenance).toMatchObject({ source: 'TRADIER_ORATS', acceptedIndependentlyOfBbo: !accepted });
    }
    if (count === 'rejectedRowStructural' || count === 'rejectedCrossedBook') {
      expect(result.summary.overlaidGreeks).toBe(0);
      expect(result.summary.overlaidBidAsk).toBe(0);
      expect(contract).toBe(massive);
    }
  });

  it('impide la sustitución parcial al cambiar de fuente y el midpoint de un libro cruzado', async () => {
    const original = canonicalOption();
    const valid = await parseRestContract(requireValue(fixture.overlays.find((scenario) => scenario.accepted)).raw);
    const first = overlayTradierChainOnCanonicalContracts([original], [valid], { nowSec: now });
    const bad = await parseRestContract({ bid: 5, ask: 0 });
    const second = overlayTradierChainOnCanonicalContracts(first.contracts, [bad], { nowSec: now });
    expect(second.contracts[0]).toBe(first.contracts[0]);
    expect(resolveQuoteMid({ ...original, lastQuote: { ...original.lastQuote, bid: 4, ask: 2 } })).toBeNaN();
  });

  it('mantiene separado el timestamp de la última operación en quotes REST', async () => {
    const quotes = await fetchTradierQuotes(['GGAL', 'SPY'], {
      config, nowMsFn: () => (now + 2) * 1_000,
      httpFn: () => Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ quotes: { quote: [
        { symbol: 'GGAL', bid_date: now - 2, ask_date: (now - 1) * 1_000, trade_date: now, last: 50 },
        { symbol: 'SPY', trade_date: now, last: 100 },
      ] } }) }),
    });
    expect(quotes.quotes[0]).toMatchObject({
      tradeTimeUtcSec: now, providerTimestampUtcSec: now - 2, asOfUtcSec: now - 2, receivedAtUtcSec: now + 2,
    });
    expect(quotes.quotes[1]?.asOfUtcSec).toBeNaN();
  });

  it('filtra el BBO cruzado y el reloj inválido en WS y propaga la hora nativa del trade', () => {
    const ticks: TradierStreamTick[] = [];
    const manager = new TradierLiveManager({ config, nowMsFn: () => (now + 2) * 1_000, onTick: (tick) => ticks.push(tick) });
    const frame = (date: number, bid: number, ask: number) => ({ date, bid, ask, bidsz: 5, asksz: 6 });
    manager['ingestStreamEvent']('GGAL', 'quote', frame(now, 49, 51));
    manager['ingestStreamEvent']('GGAL', 'quote', frame(now + 1, 51, 49));
    manager['ingestStreamEvent']('GGAL', 'quote', frame(0, 48, 52));
    manager['ingestStreamEvent']('GGAL', 'timesale', { date: now * 1_000 + 789, price: 52, size: 3, seq: 7 });
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toMatchObject({ bid: 49, ask: 51, asOfUtcSec: now });
    expect(ticks[1]).toMatchObject({ asOfUtcSec: now, eventTimeMs: now * 1_000 + 789, sequence: 7 });
  });
});

describe('M2 · contemporaneidad y buckets GGAL', () => {
  it.each(fixture.ccl)('clasifica $cclQuality ($rejectReason)', ({ input, value, ...expected }) => {
    const result = evaluateCclContemporaneity({ ...input, marketRegime: input.marketRegime as CclMarketRegime });
    expect(result).toMatchObject(expected);
    expectDecimal(result.value, value);
  });

  it('publica CCL con la hora de la pata más antigua y degrada una rueda cruzada', () => {
    for (const scenario of fixture.ccl.slice(0, 2)) {
      const { engine, minutes } = stream();
      const { byma, adr } = scenario.input;
      engine.applyArsTick({ ...byma, timeSec: byma.timeSec, size: 1 });
      engine.applyAdrTick({ ...adr, timeSec: requireValue(adr.timeSec), size: 1 });
      const result = engine.getLastCclValuation();
      expect(result).toMatchObject({ legSkewSec: scenario.legSkewSec, cclQuality: scenario.cclQuality });
      if (scenario.livePublishable) {
        expect(minutes('CCL')).toHaveLength(1);
        expect(minutes('CCL')[0]?.cclMeta?.valuationTimestamp).toBe(scenario.valuationTimestamp);
      } else {
        expect(minutes('CCL')).toHaveLength(0);
        const fx = computeLiveFxFromQuotes([
          { market: 'AR', symbol: 'GGAL', price: byma.price, asOfUtcSec: byma.timeSec },
          { market: 'US', symbol: 'GGAL', price: adr.price, asOfUtcSec: adr.timeSec },
        ], now);
        expect(fx.cclImplicitGgal).toBeNull();
        expect(fx.cclGgalTemporal?.rejectReason).toBe(scenario.rejectReason);
      }
    }
  });

  it('mantiene la vela activa y versiona los buckets históricos incluso dentro del throttle', () => {
    const { engine, minutes } = stream(200);
    for (const tick of fixture.late.ticks) engine.applyAdrTick(tick);
    const [active, first, second] = minutes();
    expect(active).toMatchObject({ bar: fixture.late.active, streamSeq: 1, bucketRevision: 1, updateKind: 'ACTIVE' });
    expect(first).toMatchObject({ bar: fixture.late.revision, isRevision: true, streamSeq: 2, bucketRevision: 1 });
    expect(second).toMatchObject({ bar: fixture.late.revision2, isRevision: true, streamSeq: 3, bucketRevision: 2 });
    const pending = new Map<string, RuntimeWsBroadcast>();
    for (const event of [first, second, active, first].map(requireValue)) enqueueCoalescedEvent(pending, coalesceEventKey(event), event);
    expect([...pending.values()]).toEqual([second, active]);

    engine.applyArsTick({ price: 6000, size: 2, timeSec: now });
    expectDecimal(requireValue(engine.getLastCclValuation()).value, requireValue(fixture.ccl[0]).value);
  });

  it.each(fixture.intrabucket)('agrega por tiempo y secuencia aunque llegue fuera de orden', ({ ticks, expected }) => {
    for (const order of [ticks, [...ticks].reverse()]) {
      const { engine, minutes } = stream();
      for (const tick of order) engine.applyAdrTick(tick);
      expect(minutes().at(-1)?.bar).toEqual(expected);
    }
  });

  it('deduplica por ID, secuencia o huella exacta', () => {
    const { engine, minutes } = stream();
    for (const tick of fixture.duplicates.ticks) {
      engine.applyAdrTick(tick);
      engine.applyAdrTick(tick);
    }
    expect(minutes().at(-1)).toMatchObject({ bucketRevision: 3, bar: { volume: fixture.duplicates.expectedVolume } });
    expect(engine.getMetrics()).toMatchObject({ duplicatesIgnored: 3, fallbackFingerprintDedupes: 1 });
  });

  it('suma solo los incrementos acreditados del contador acumulado', () => {
    const { engine, minutes } = stream();
    for (const tick of fixture.cumulative.ticks) engine.applyAdrTick({ ...tick, volumeMode: 'CUMULATIVE_SESSION' });
    expect(minutes().at(-1)?.bar.volume).toBe(fixture.cumulative.expectedVolume);
  });

  it('mantiene el VWAP en el cambio de día UTC y reinicia al abrir la siguiente rueda NY', () => {
    const { engine, minutes, setClock } = stream();
    for (const tick of fixture.session.ticks) {
      setClock(tick.timeSec);
      engine.applyAdrTick(tick);
    }
    expect(minutes()).toHaveLength(fixture.session.expectedVwaps.length);
    minutes().forEach((event, i) => {
      expectDecimal(event.indicatorsPoint.sessionVwap ?? Number.NaN, requireValue(fixture.session.expectedVwaps[i]));
    });
    expect(engine.getMetrics().lateEventsOutOfWindow).toBe(1);
  });

  it('descarta un trade vencido para 1m preservando el bucket activo', () => {
    const { engine, minutes } = stream();
    for (const tick of fixture.outOfWindow.ticks) engine.applyAdrTick(tick);
    expect(minutes()).toHaveLength(1);
    expect(minutes()[0]?.bar).toEqual(fixture.late.active);
    expect(engine.getMetrics().lateEventsOutOfWindow).toBe(fixture.outOfWindow.expectedLateCount);
  });
});
