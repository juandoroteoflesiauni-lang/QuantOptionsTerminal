import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  BitmaskConflationEngine,
  DEFAULT_SOA_CAPACITY,
  DEFAULT_TRADE_RING_CAPACITY,
  DELTA_FRAME_BUFFER_BYTES,
  L2_VISUAL_PULSE_MS,
  MAX_DELTA_ITEMS_PER_FRAME,
  MarketStoreSoA,
  SOA_COL_ASK,
  SOA_COL_ASK_SIZE,
  SOA_COL_BID,
  SOA_COL_BID_SIZE,
  SOA_COL_DELTA,
  SOA_COL_GAMMA,
  SOA_COL_ID,
  SOA_COL_IV,
  SOA_COL_LAST,
  SOA_COL_TIMESTAMP,
  SOA_DELTA_STRIDE,
  TABLE_VISUAL_PULSE_MS,
  TradeRingBuffer,
  createDomCellRegistry,
  isDedicatedWorkerSupported,
  type DomAnimationLike,
  type DomFlashOverlayLike,
  type DomTextNodeLike,
} from '../web/src/store/marketStoreSoa.js';

interface SoaDeltaInput {
  readonly id: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly last: number | null;
  readonly bidSize: number | null;
  readonly askSize: number | null;
  readonly timestamp: number | null;
  readonly iv: number | null;
  readonly delta: number | null;
  readonly gamma: number | null;
}

interface SoaExpectedRow {
  readonly id: number;
  readonly symbol: string;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly last: number | null;
  readonly bidSize: number;
  readonly askSize: number;
  readonly timestamp: number | null;
  readonly iv: number | null;
  readonly delta: number | null;
  readonly gamma: number | null;
}

interface PerfPhase2ReferenceFixture {
  readonly meta: {
    readonly defaultSoaCapacity: number;
    readonly defaultTradeRingCapacity: number;
    readonly soaDeltaStride: number;
    readonly maxDeltaItemsPerFrame: number;
    readonly deltaFrameBufferBytes: number;
    readonly l2VisualPulseMs: number;
    readonly tableVisualPulseMs: number;
  };
  readonly soaCases: {
    readonly registrations: readonly {
      readonly raw: string;
      readonly normalized: string;
      readonly id: number;
    }[];
    readonly uniqueCount: number;
    readonly deltasBatch1: readonly SoaDeltaInput[];
    readonly deltasBatch2: readonly SoaDeltaInput[];
    readonly expectedApplied1: number;
    readonly expectedApplied2: number;
    readonly expectedRows: readonly SoaExpectedRow[];
  };
  readonly ringBufferCases: {
    readonly capacity: number;
    readonly totalPushes: number;
    readonly expectedCount: number;
    readonly queries: readonly {
      readonly offset: number;
      readonly maxCount: number;
      readonly expectedCount: number;
      readonly expected: readonly {
        readonly price: number;
        readonly size: number;
        readonly ts: number;
      }[];
    }[];
  };
  readonly bitmaskCases: {
    readonly selective: {
      readonly initialDirty: readonly number[];
      readonly visible1: readonly number[];
      readonly expectedFrame1: readonly number[];
      readonly expectedRemaining1: readonly number[];
      readonly visible2: readonly number[];
      readonly expectedFrame2: readonly number[];
      readonly expectedRemaining2: readonly number[];
    };
    readonly burstPagination: {
      readonly totalDirtyVisible: number;
      readonly expectedFrameCounts: readonly number[];
      readonly expectedHasMore: readonly boolean[];
      readonly maxFrameBytes: number;
    };
  };
  readonly domRegistryCases: {
    readonly initialValue: number;
    readonly initialText: string;
    readonly decimals: number;
    readonly prefix: string;
    readonly steps: readonly {
      readonly value: number | null;
      readonly expectMutated: boolean;
      readonly expectText: string;
      readonly expectDir: 'up' | 'down' | null;
    }[];
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(resolve(HERE, '../fixtures/perf_phase2_reference.json'), 'utf8'),
) as PerfPhase2ReferenceFixture;
const TOL = 1e-9;

function encodeDeltaBatch(rows: readonly SoaDeltaInput[], target: Float64Array): void {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    const base = i * SOA_DELTA_STRIDE;
    target[base + SOA_COL_ID] = row.id;
    target[base + SOA_COL_BID] = row.bid ?? Number.NaN;
    target[base + SOA_COL_ASK] = row.ask ?? Number.NaN;
    target[base + SOA_COL_LAST] = row.last ?? Number.NaN;
    target[base + SOA_COL_BID_SIZE] = row.bidSize ?? Number.NaN;
    target[base + SOA_COL_ASK_SIZE] = row.askSize ?? Number.NaN;
    target[base + SOA_COL_TIMESTAMP] = row.timestamp ?? Number.NaN;
    target[base + SOA_COL_IV] = row.iv ?? Number.NaN;
    target[base + SOA_COL_DELTA] = row.delta ?? Number.NaN;
    target[base + SOA_COL_GAMMA] = row.gamma ?? Number.NaN;
  }
}

function expectNullableClose(actual: number | undefined, expected: number | null): void {
  if (expected === null) {
    expect(Number.isNaN(actual)).toBe(true);
    return;
  }
  expect(actual).toBeDefined();
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThanOrEqual(TOL);
}

describe('Pieza 49 — MarketStoreSoA (zero-allocation & in-place binary deltas)', () => {
  it('coincide con constantes de capacidad, pulso visual y tamaño < 10 KiB por frame', () => {
    expect(DEFAULT_SOA_CAPACITY).toBe(FIXTURE.meta.defaultSoaCapacity);
    expect(DEFAULT_TRADE_RING_CAPACITY).toBe(FIXTURE.meta.defaultTradeRingCapacity);
    expect(SOA_DELTA_STRIDE).toBe(FIXTURE.meta.soaDeltaStride);
    expect(MAX_DELTA_ITEMS_PER_FRAME).toBe(FIXTURE.meta.maxDeltaItemsPerFrame);
    expect(DELTA_FRAME_BUFFER_BYTES).toBe(FIXTURE.meta.deltaFrameBufferBytes);
    expect(DELTA_FRAME_BUFFER_BYTES).toBeLessThan(10 * 1024);
    expect(L2_VISUAL_PULSE_MS).toBe(FIXTURE.meta.l2VisualPulseMs);
    expect(TABLE_VISUAL_PULSE_MS).toBe(FIXTURE.meta.tableVisualPulseMs);
  });

  it('registra IDs determinísticos y aplica deltas binarios in-place preservando referencias de TypedArrays', () => {
    const store = new MarketStoreSoA(DEFAULT_SOA_CAPACITY);
    const bidRef = store.bid;
    const askRef = store.ask;
    const lastRef = store.last;
    const bidSizeRef = store.bidSize;
    const askSizeRef = store.askSize;
    const tsRef = store.timestamp;
    const ivRef = store.iv;
    const deltaRef = store.delta;
    const gammaRef = store.gamma;

    for (const reg of FIXTURE.soaCases.registrations) {
      const assigned = store.registerSymbol(reg.raw);
      expect(assigned).toBe(reg.id);
      expect(store.getId(reg.raw)).toBe(reg.id);
      expect(store.getSymbol(reg.id)).toBe(reg.normalized);
    }
    expect(store.getCount()).toBe(FIXTURE.soaCases.uniqueCount);

    const scratch = new Float64Array(
      Math.max(FIXTURE.soaCases.deltasBatch1.length, FIXTURE.soaCases.deltasBatch2.length) *
        SOA_DELTA_STRIDE,
    );

    encodeDeltaBatch(FIXTURE.soaCases.deltasBatch1, scratch);
    const applied1 = store.applyBinaryDelta(
      scratch,
      FIXTURE.soaCases.deltasBatch1.length,
      SOA_DELTA_STRIDE,
    );
    expect(applied1).toBe(FIXTURE.soaCases.expectedApplied1);

    encodeDeltaBatch(FIXTURE.soaCases.deltasBatch2, scratch);
    const applied2 = store.applyBinaryDelta(
      scratch,
      FIXTURE.soaCases.deltasBatch2.length,
      SOA_DELTA_STRIDE,
    );
    expect(applied2).toBe(FIXTURE.soaCases.expectedApplied2);

    // Identidad de buffers intacta (0 reallocaciones ni clones)
    expect(store.bid).toBe(bidRef);
    expect(store.ask).toBe(askRef);
    expect(store.last).toBe(lastRef);
    expect(store.bidSize).toBe(bidSizeRef);
    expect(store.askSize).toBe(askSizeRef);
    expect(store.timestamp).toBe(tsRef);
    expect(store.iv).toBe(ivRef);
    expect(store.delta).toBe(deltaRef);
    expect(store.gamma).toBe(gammaRef);

    for (const row of FIXTURE.soaCases.expectedRows) {
      expect(store.getSymbol(row.id)).toBe(row.symbol);
      expectNullableClose(store.bid[row.id], row.bid);
      expectNullableClose(store.ask[row.id], row.ask);
      expectNullableClose(store.last[row.id], row.last);
      expect(store.bidSize[row.id]).toBe(row.bidSize);
      expect(store.askSize[row.id]).toBe(row.askSize);
      expectNullableClose(store.timestamp[row.id], row.timestamp);
      expectNullableClose(store.iv[row.id], row.iv);
      expectNullableClose(store.delta[row.id], row.delta);
      expectNullableClose(store.gamma[row.id], row.gamma);
    }
  });

  it('respeta capacidad máxima y sincroniza bindSymbolId entre Worker y Main Thread', () => {
    const smallStore = new MarketStoreSoA(3);
    expect(smallStore.bindSymbolId(2, 'us:nvda')).toBe(true);
    expect(smallStore.registerSymbol('ar:ggal')).toBe(0);
    expect(smallStore.registerSymbol('us:spy')).toBe(1);
    expect(smallStore.registerSymbol('us:aapl')).toBe(-1);
    expect(smallStore.getSymbol(2)).toBe('US:NVDA');
    expect(smallStore.getId('US:AAPL')).toBeUndefined();
  });
});

describe('Pieza 49 — TradeRingBuffer (capacidad 2048, wrap-around, LIFO y límites de offset)', () => {
  it('maneja wrap-around tras superar 2048 trades y lee LIFO zero-allocation en readRecentInto', () => {
    const ring = new TradeRingBuffer(FIXTURE.ringBufferCases.capacity);
    for (let i = 0; i < FIXTURE.ringBufferCases.totalPushes; i += 1) {
      const ok = ring.push(100.0 + i * 0.25, (i % 50) + 1, 1_794_580_000 + i);
      expect(ok).toBe(true);
    }
    expect(ring.getCount()).toBe(FIXTURE.ringBufferCases.expectedCount);
    expect(ring.getTotalPushed()).toBe(FIXTURE.ringBufferCases.totalPushes);

    const outSoa = {
      prices: new Float64Array(16),
      sizes: new Uint32Array(16),
      timestamps: new Float64Array(16),
    };
    const outFlat = new Float64Array(16 * 3);

    for (const q of FIXTURE.ringBufferCases.queries) {
      const countSoa = ring.readRecentInto(q.offset, outSoa, q.maxCount);
      const countFlat = ring.readRecentInto(q.offset, outFlat, q.maxCount);
      expect(countSoa).toBe(q.expectedCount);
      expect(countFlat).toBe(q.expectedCount);

      for (let idx = 0; idx < q.expectedCount; idx += 1) {
        const exp = q.expected[idx];
        expect(exp).toBeDefined();
        if (exp === undefined) continue;
        expect(Math.abs((outSoa.prices[idx] ?? Number.NaN) - exp.price)).toBeLessThanOrEqual(TOL);
        expect(outSoa.sizes[idx]).toBe(exp.size);
        expect(outSoa.timestamps[idx]).toBe(exp.ts);

        expect(Math.abs((outFlat[idx * 3] ?? Number.NaN) - exp.price)).toBeLessThanOrEqual(TOL);
        expect(outFlat[idx * 3 + 1]).toBe(exp.size);
        expect(outFlat[idx * 3 + 2]).toBe(exp.ts);
      }
    }

    expect(ring.push(Number.NaN, 10, 1_794_580_000)).toBe(false);
  });
});

describe('Pieza 49 — BitmaskConflationEngine (dirtyMask & visibleMask y buffer ping-pong)', () => {
  it('empaqueta exclusivamente instrumentos modificados y visibles limpiando solo los bits enviados', () => {
    const store = new MarketStoreSoA(DEFAULT_SOA_CAPACITY);
    const engine = new BitmaskConflationEngine(DEFAULT_SOA_CAPACITY);

    for (let id = 0; id < DEFAULT_SOA_CAPACITY; id += 1) {
      store.bindSymbolId(id, `SYM:${String(id)}`);
      store.writeQuoteInPlace(id, id + 0.1, id + 0.2, id + 0.15, 10 + id, 20 + id, 1_794_580_000 + id);
    }

    const sel = FIXTURE.bitmaskCases.selective;
    for (const id of sel.initialDirty) {
      engine.markDirty(id);
    }

    const pingBuf = new ArrayBuffer(DELTA_FRAME_BUFFER_BYTES);
    const pingView = new Float64Array(pingBuf);

    engine.setVisibleIds(sel.visible1);
    const packedCount1 = engine.packVisibleDirtyDelta(store, pingView);
    const packedIds1 = Array.from({ length: packedCount1 }, (_, idx) => pingView[idx * SOA_DELTA_STRIDE + SOA_COL_ID]);
    expect(packedIds1).toEqual(sel.expectedFrame1);
    expect(packedCount1 * SOA_DELTA_STRIDE * Float64Array.BYTES_PER_ELEMENT).toBeLessThan(10 * 1024);

    // Verificar bits restantes en dirtyMask tras el primer frame
    for (const sentId of sel.expectedFrame1) {
      expect(engine.isDirty(sentId)).toBe(false);
    }
    for (const pendingId of sel.expectedRemaining1) {
      expect(engine.isDirty(pendingId)).toBe(true);
    }

    // Al entrar nuevos instrumentos al viewport, los pendientes ocultos se empaquetan inmediatamente
    engine.setVisibleIds(sel.visible2);
    const pongBuf = new ArrayBuffer(DELTA_FRAME_BUFFER_BYTES);
    const pongView = new Float64Array(pongBuf);
    const packedCount2 = engine.packVisibleDirtyDelta(store, pongView);
    const packedIds2 = Array.from({ length: packedCount2 }, (_, idx) => pongView[idx * SOA_DELTA_STRIDE + SOA_COL_ID]);
    expect(packedIds2).toEqual(sel.expectedFrame2);

    for (const pendingId of sel.expectedRemaining2) {
      expect(engine.isDirty(pendingId)).toBe(true);
    }
  });

  it('limita cada frame por debajo de 10 KiB y recicla buffers ping-pong bajo ráfagas', () => {
    const store = new MarketStoreSoA(DEFAULT_SOA_CAPACITY);
    const engine = new BitmaskConflationEngine(DEFAULT_SOA_CAPACITY);
    const { totalDirtyVisible, expectedFrameCounts, expectedHasMore, maxFrameBytes } =
      FIXTURE.bitmaskCases.burstPagination;

    const visibleIds: number[] = [];
    for (let id = 0; id < totalDirtyVisible; id += 1) {
      store.bindSymbolId(id, `OPT:${String(id)}`);
      store.writeQuoteInPlace(id, 1 + id * 0.01, 1.1 + id * 0.01, 1.05 + id * 0.01, 5, 5, 1_794_581_000);
      engine.markDirty(id);
      visibleIds.push(id);
    }
    engine.setVisibleIds(visibleIds);

    const pool = [new ArrayBuffer(DELTA_FRAME_BUFFER_BYTES), new ArrayBuffer(DELTA_FRAME_BUFFER_BYTES)];
    const observedCounts: number[] = [];
    const observedHasMore: boolean[] = [];

    for (let frame = 0; frame < 3; frame += 1) {
      const buf = pool.shift();
      expect(buf).toBeDefined();
      if (buf === undefined) break;
      expect(buf.byteLength).toBe(maxFrameBytes);
      expect(buf.byteLength).toBeLessThan(10 * 1024);

      const view = new Float64Array(buf);
      const count = engine.packVisibleDirtyDelta(store, view, MAX_DELTA_ITEMS_PER_FRAME, SOA_DELTA_STRIDE);
      observedCounts.push(count);
      observedHasMore.push(engine.hasVisibleDirty());

      // Recicla el mismo ArrayBuffer (ping-pong)
      pool.push(buf);
    }

    expect(observedCounts).toEqual(expectedFrameCounts);
    expect(observedHasMore).toEqual(expectedHasMore);
    expect(engine.hasVisibleDirty()).toBe(false);
  });
});

describe('Pieza 49 — domCellRegistry (mutación directa, deduplicación, WAAPI opacity y cleanup)', () => {
  it('deduplica valores iguales, muta nodeValue directo, anima opacity WAAPI y cancela en cleanup', () => {
    const registry = createDomCellRegistry();
    const textNode: DomTextNodeLike = { nodeValue: null };

    const animRecords: {
      readonly keyframes: { opacity: number }[];
      readonly options: { duration: number; easing: string; fill: 'none' };
      readonly cancelSpy: ReturnType<typeof vi.fn>;
    }[] = [];

    const dataset: Record<string, string | undefined> = {};
    const flashNode: DomFlashOverlayLike = {
      dataset,
      animate: (keyframes, options): DomAnimationLike => {
        const cancelSpy = vi.fn();
        animRecords.push({ keyframes, options, cancelSpy });
        return { cancel: cancelSpy };
      },
    };

    const mutations: { readonly val: number; readonly formatted: string }[] = [];
    const unregister = registry.register({
      key: 'US:NVDA:LAST',
      textNode,
      flashNode,
      symbol: 'US:NVDA',
      field: 'last',
      pulseTier: 'table',
      initialValue: FIXTURE.domRegistryCases.initialValue,
      decimals: FIXTURE.domRegistryCases.decimals,
      prefix: FIXTURE.domRegistryCases.prefix,
      onMutate: (val, formatted) => {
        mutations.push({ val, formatted });
      },
    });

    expect(registry.size()).toBe(1);
    expect(registry.has('US:NVDA:LAST')).toBe(true);
    expect(textNode.nodeValue).toBe(FIXTURE.domRegistryCases.initialText);

    let expectedAnimations = 0;
    for (const step of FIXTURE.domRegistryCases.steps) {
      const changed = registry.update('US:NVDA:LAST', step.value ?? Number.NaN);
      expect(changed).toBe(step.expectMutated);
      expect(textNode.nodeValue).toBe(step.expectText);
      if (step.expectDir !== null) {
        expectedAnimations += 1;
        expect(dataset['dir']).toBe(step.expectDir);
        expect(animRecords).toHaveLength(expectedAnimations);
        const latestAnim = animRecords[animRecords.length - 1];
        expect(latestAnim?.keyframes).toEqual([{ opacity: 0.42 }, { opacity: 0 }]);
        expect(latestAnim?.options).toEqual({
          duration: 350,
          easing: 'ease-out',
          fill: 'none',
        });
      }
    }

    // La segunda animación debe haber cancelado la primera antes de reproducirse
    expect(animRecords[0]?.cancelSpy).toHaveBeenCalledTimes(1);
    expect(animRecords[1]?.cancelSpy).toHaveBeenCalledTimes(0);

    // Cleanup cancela animación activa y desregistra la celda de forma idempotente
    unregister();
    expect(animRecords[1]?.cancelSpy).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
    expect(registry.has('US:NVDA:LAST')).toBe(false);
    expect(registry.update('US:NVDA:LAST', 150)).toBe(false);
    unregister();
    expect(animRecords[1]?.cancelSpy).toHaveBeenCalledTimes(1);
    expect(mutations.length).toBe(4);
  });

  it('conflaciona pulsos visuales (100 ms L2 vs 220 ms tablas) y propaga batches SoA sin React', async () => {
    vi.useFakeTimers();
    try {
      const registry = createDomCellRegistry();
      const store = new MarketStoreSoA(16);
      const ggalId = store.registerSymbol('AR:GGAL');
      const nvdaId = store.registerSymbol('US:NVDA');

      const l2Node: DomTextNodeLike = { nodeValue: null };
      const tblNode: DomTextNodeLike = { nodeValue: null };

      const unsubL2 = registry.register({
        key: 'L2:GGAL:BID:0',
        textNode: l2Node,
        symbol: 'AR:GGAL',
        field: 'bid',
        pulseTier: 'l2',
        initialValue: 7000,
      });
      const unsubTbl = registry.register({
        key: 'MON:US:NVDA:LAST',
        textNode: tblNode,
        symbol: 'US:NVDA',
        field: 'last',
        pulseTier: 'table',
        initialValue: 140,
      });

      const batch = new Float64Array(2 * SOA_DELTA_STRIDE);
      batch[SOA_COL_ID] = ggalId;
      batch[SOA_COL_BID] = 7050.5;
      batch[SOA_COL_ASK] = Number.NaN;
      batch[SOA_COL_LAST] = Number.NaN;
      batch[SOA_COL_BID_SIZE] = Number.NaN;
      batch[SOA_COL_ASK_SIZE] = Number.NaN;
      batch[SOA_COL_TIMESTAMP] = 1_794_581_000;
      batch[SOA_COL_IV] = Number.NaN;
      batch[SOA_COL_DELTA] = Number.NaN;
      batch[SOA_COL_GAMMA] = Number.NaN;

      batch[SOA_DELTA_STRIDE + SOA_COL_ID] = nvdaId;
      batch[SOA_DELTA_STRIDE + SOA_COL_BID] = Number.NaN;
      batch[SOA_DELTA_STRIDE + SOA_COL_ASK] = Number.NaN;
      batch[SOA_DELTA_STRIDE + SOA_COL_LAST] = 144.25;
      batch[SOA_DELTA_STRIDE + SOA_COL_BID_SIZE] = Number.NaN;
      batch[SOA_DELTA_STRIDE + SOA_COL_ASK_SIZE] = Number.NaN;
      batch[SOA_DELTA_STRIDE + SOA_COL_TIMESTAMP] = 1_794_581_000;
      batch[SOA_DELTA_STRIDE + SOA_COL_IV] = Number.NaN;
      batch[SOA_DELTA_STRIDE + SOA_COL_DELTA] = Number.NaN;
      batch[SOA_DELTA_STRIDE + SOA_COL_GAMMA] = Number.NaN;

      store.applyBinaryDelta(batch, 2, SOA_DELTA_STRIDE);
      registry.applySoaDeltaBatch(store, batch, 2, SOA_DELTA_STRIDE);

      // Antes de 100 ms ninguno debe haberse mutado todavía
      expect(l2Node.nodeValue).toBe('7.000,00');
      expect(tblNode.nodeValue).toBe('140,00');

      // A los 100 ms solo dispara el pulso L2; la tabla espera 220 ms
      await vi.advanceTimersByTimeAsync(L2_VISUAL_PULSE_MS);
      expect(l2Node.nodeValue).toBe('7.050,50');
      expect(tblNode.nodeValue).toBe('140,00');

      // Al completar 220 ms dispara el pulso de tabla
      await vi.advanceTimersByTimeAsync(TABLE_VISUAL_PULSE_MS - L2_VISUAL_PULSE_MS);
      expect(tblNode.nodeValue).toBe('144,25');

      unsubL2();
      unsubTbl();
      registry.clear();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Pieza 49 — Compatibilidad Node/Vitest (degradación sin Worker) y LoAF opt-in', () => {
  it('detecta cleanly typeof Worker === "undefined" y resguarda LoAF bajo VITE_ENABLE_PERF_TELEMETRY', () => {
    expect(typeof (globalThis as { readonly Worker?: unknown }).Worker).toBe('undefined');
    expect(isDedicatedWorkerSupported()).toBe(false);

    const streamSrc = readFileSync(
      new URL('../web/src/api/useMarketLiveStream.ts', import.meta.url),
      'utf-8',
    );
    expect(streamSrc).toContain("typeof Worker === 'undefined'");
    expect(streamSrc).toContain('isDedicatedWorkerSupported()');
    expect(streamSrc).toContain('connectDirectSocket()');

    const loafSrc = readFileSync(
      new URL('../web/src/perf/loafTelemetry.ts', import.meta.url),
      'utf-8',
    );
    expect(loafSrc).toContain("import.meta.env.VITE_ENABLE_PERF_TELEMETRY !== 'true'");
  });
});
