/**
 * Pieza 49 (Fase 2): Almacén Zero-Allocation Structure-of-Arrays (SoA),
 * Ring Buffer O(1) para cinta de trades, motor de conflación por bitmask
 * (`dirtyMask & visibleMask`) y registro imperativo de celdas DOM.
 *
 * Restricciones AGENTS.md / SPEC.md:
 * - TypeScript puro sin red, sin interfaz React ni globales DOM obligatorios.
 * - Política Zero Silent Fallbacks: valores no calculables se representan con `NaN`
 *   y se formatean como `"—"`.
 * - Cero asignaciones por tick en rutas calientes (`applyBinaryDelta`, `push`,
 *   `readRecentInto`, `packVisibleDirtyDelta`, `domCellRegistry.update`).
 */

export const DEFAULT_SOA_CAPACITY = 1_200;
export const DEFAULT_TRADE_RING_CAPACITY = 2_048;
export const SOA_DELTA_STRIDE = 10;
export const MAX_DELTA_ITEMS_PER_FRAME = 120;
export const DELTA_FRAME_BUFFER_BYTES =
  MAX_DELTA_ITEMS_PER_FRAME * SOA_DELTA_STRIDE * Float64Array.BYTES_PER_ELEMENT; // 9600 B < 10 KiB

export const L2_VISUAL_PULSE_MS = 100; // 10 Hz
export const TABLE_VISUAL_PULSE_MS = 220; // ~4.5 Hz (rango 200-250 ms)

export const SOA_COL_ID = 0;
export const SOA_COL_BID = 1;
export const SOA_COL_ASK = 2;
export const SOA_COL_LAST = 3;
export const SOA_COL_BID_SIZE = 4;
export const SOA_COL_ASK_SIZE = 5;
export const SOA_COL_TIMESTAMP = 6;
export const SOA_COL_IV = 7;
export const SOA_COL_DELTA = 8;
export const SOA_COL_GAMMA = 9;

export type SoaPriceField = 'bid' | 'ask' | 'last' | 'mid';
export type VisualPulseTier = 'l2' | 'table';

export interface DomTextNodeLike {
  nodeValue: string | null;
}

export interface DomAnimationLike {
  cancel(): void;
}

export interface DomFlashOverlayLike {
  readonly dataset?: Record<string, string | undefined> | undefined;
  animate?:
    | ((
        keyframes: { opacity: number }[],
        options: {
          duration: number;
          easing: string;
          fill: 'none';
        },
      ) => DomAnimationLike)
    | undefined;
}

export interface DomCellRegistrationOptions {
  readonly key: string;
  readonly textNode: DomTextNodeLike;
  readonly flashNode?: DomFlashOverlayLike | null | undefined;
  readonly symbol?: string | null | undefined;
  readonly field?: SoaPriceField | null | undefined;
  readonly pulseTier?: VisualPulseTier | undefined;
  readonly initialValue?: number | undefined;
  readonly decimals?: number | undefined;
  readonly prefix?: string | undefined;
  readonly suffix?: string | undefined;
  readonly formatFn?: ((value: number) => string) | undefined;
  readonly onMutate?: ((value: number, formatted: string) => void) | undefined;
}

export interface TradeRingSoaTarget {
  readonly prices: Float64Array;
  readonly sizes: Uint32Array;
  readonly timestamps: Float64Array;
}

export type TradeRingReadTarget = TradeRingSoaTarget | Float64Array;

export function normalizeSoaSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}

export function formatEsArPrice(
  value: number,
  decimals = 2,
  prefix = '',
  suffix = '',
): string {
  if (!Number.isFinite(value)) return '—';
  const safeDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : 2;
  const fixed = Math.abs(value).toFixed(safeDecimals);
  const dotIdx = fixed.indexOf('.');
  const intPart = dotIdx >= 0 ? fixed.slice(0, dotIdx) : fixed;
  const decPart = dotIdx >= 0 ? fixed.slice(dotIdx + 1) : '';
  const withDots = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = value < 0 ? '-' : '';
  const formatted = safeDecimals > 0 ? `${sign}${withDots},${decPart}` : `${sign}${withDots}`;
  return `${prefix}${formatted}${suffix}`;
}

/**
 * Determina si el entorno dispone de Dedicated Web Workers.
 * Permite degradación limpia al transporte directo bajo Node/Vitest.
 */
export function isDedicatedWorkerSupported(): boolean {
  return typeof (globalThis as { readonly Worker?: unknown }).Worker === 'function';
}

export class MarketStoreSoA {
  public readonly capacity: number;
  public readonly bid: Float64Array;
  public readonly ask: Float64Array;
  public readonly last: Float64Array;
  public readonly timestamp: Float64Array;
  public readonly bidSize: Uint32Array;
  public readonly askSize: Uint32Array;
  public readonly iv: Float32Array;
  public readonly delta: Float32Array;
  public readonly gamma: Float32Array;

  private readonly symbolToId = new Map<string, number>();
  private readonly idToSymbol: (string | undefined)[];
  private nextId = 0;

  public constructor(capacity = DEFAULT_SOA_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`Invalid MarketStoreSoA capacity: ${String(capacity)}`);
    }
    this.capacity = capacity;
    this.bid = new Float64Array(capacity);
    this.ask = new Float64Array(capacity);
    this.last = new Float64Array(capacity);
    this.timestamp = new Float64Array(capacity);
    this.bidSize = new Uint32Array(capacity);
    this.askSize = new Uint32Array(capacity);
    this.iv = new Float32Array(capacity);
    this.delta = new Float32Array(capacity);
    this.gamma = new Float32Array(capacity);
    this.idToSymbol = new Array<string | undefined>(capacity);
    this.clearValues();
  }

  public clearValues(): void {
    this.bid.fill(Number.NaN);
    this.ask.fill(Number.NaN);
    this.last.fill(Number.NaN);
    this.timestamp.fill(Number.NaN);
    this.bidSize.fill(0);
    this.askSize.fill(0);
    this.iv.fill(Number.NaN);
    this.delta.fill(Number.NaN);
    this.gamma.fill(Number.NaN);
  }

  public resetAll(): void {
    this.symbolToId.clear();
    this.idToSymbol.fill(undefined);
    this.nextId = 0;
    this.clearValues();
  }

  public registerSymbol(rawSymbol: string): number {
    const symbol = normalizeSoaSymbol(rawSymbol);
    if (symbol === '') return -1;
    const existing = this.symbolToId.get(symbol);
    if (existing !== undefined) return existing;
    while (this.nextId < this.capacity && this.idToSymbol[this.nextId] !== undefined) {
      this.nextId += 1;
    }
    if (this.nextId >= this.capacity) return -1;
    const id = this.nextId;
    this.nextId += 1;
    this.symbolToId.set(symbol, id);
    this.idToSymbol[id] = symbol;
    return id;
  }

  public bindSymbolId(id: number, rawSymbol: string): boolean {
    if (!Number.isInteger(id) || id < 0 || id >= this.capacity) return false;
    const symbol = normalizeSoaSymbol(rawSymbol);
    if (symbol === '') return false;
    const prevIdForSym = this.symbolToId.get(symbol);
    if (prevIdForSym !== undefined && prevIdForSym !== id) {
      this.idToSymbol[prevIdForSym] = undefined;
    }
    const prevSymAtId = this.idToSymbol[id];
    if (prevSymAtId !== undefined && prevSymAtId !== symbol) {
      this.symbolToId.delete(prevSymAtId);
    }
    this.symbolToId.set(symbol, id);
    this.idToSymbol[id] = symbol;
    return true;
  }

  public getId(rawSymbol: string): number | undefined {
    const symbol = normalizeSoaSymbol(rawSymbol);
    if (symbol === '') return undefined;
    return this.symbolToId.get(symbol);
  }

  public getSymbol(id: number): string | undefined {
    if (!Number.isInteger(id) || id < 0 || id >= this.capacity) return undefined;
    return this.idToSymbol[id];
  }

  public getCount(): number {
    return this.symbolToId.size;
  }

  public writeQuoteInPlace(
    id: number,
    bidVal: number,
    askVal: number,
    lastVal: number,
    bidSizeVal: number,
    askSizeVal: number,
    timestampVal: number,
    ivVal = Number.NaN,
    deltaVal = Number.NaN,
    gammaVal = Number.NaN,
  ): boolean {
    if (!Number.isInteger(id) || id < 0 || id >= this.capacity) return false;
    if (!Number.isNaN(bidVal)) this.bid[id] = bidVal;
    if (!Number.isNaN(askVal)) this.ask[id] = askVal;
    if (!Number.isNaN(lastVal)) this.last[id] = lastVal;
    if (Number.isFinite(bidSizeVal) && bidSizeVal >= 0) {
      this.bidSize[id] = Math.trunc(bidSizeVal) >>> 0;
    }
    if (Number.isFinite(askSizeVal) && askSizeVal >= 0) {
      this.askSize[id] = Math.trunc(askSizeVal) >>> 0;
    }
    if (!Number.isNaN(timestampVal)) this.timestamp[id] = timestampVal;
    if (!Number.isNaN(ivVal)) this.iv[id] = ivVal;
    if (!Number.isNaN(deltaVal)) this.delta[id] = deltaVal;
    if (!Number.isNaN(gammaVal)) this.gamma[id] = gammaVal;
    return true;
  }

  /**
   * Aplica un lote binario empaquetado de `Float64Array` estrictamente in-place,
   * sin asignar objetos ni clonar colecciones. Los campos con `NaN` preservan
   * el valor previo almacenado.
   */
  public applyBinaryDelta(
    view: Float64Array,
    count: number,
    stride = SOA_DELTA_STRIDE,
  ): number {
    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(stride) || stride < SOA_DELTA_STRIDE) {
      return 0;
    }
    const maxRows = Math.min(count, Math.floor(view.length / stride));
    let applied = 0;
    for (let i = 0; i < maxRows; i += 1) {
      const base = i * stride;
      const rawId = view[base + SOA_COL_ID];
      if (rawId === undefined || !Number.isInteger(rawId) || rawId < 0 || rawId >= this.capacity) {
        continue;
      }
      const id = rawId;
      const bidVal = view[base + SOA_COL_BID];
      const askVal = view[base + SOA_COL_ASK];
      const lastVal = view[base + SOA_COL_LAST];
      const bidSizeVal = view[base + SOA_COL_BID_SIZE];
      const askSizeVal = view[base + SOA_COL_ASK_SIZE];
      const tsVal = view[base + SOA_COL_TIMESTAMP];
      const ivVal = view[base + SOA_COL_IV];
      const deltaVal = view[base + SOA_COL_DELTA];
      const gammaVal = view[base + SOA_COL_GAMMA];

      if (bidVal !== undefined && !Number.isNaN(bidVal)) this.bid[id] = bidVal;
      if (askVal !== undefined && !Number.isNaN(askVal)) this.ask[id] = askVal;
      if (lastVal !== undefined && !Number.isNaN(lastVal)) this.last[id] = lastVal;
      if (bidSizeVal !== undefined && Number.isFinite(bidSizeVal) && bidSizeVal >= 0) {
        this.bidSize[id] = Math.trunc(bidSizeVal) >>> 0;
      }
      if (askSizeVal !== undefined && Number.isFinite(askSizeVal) && askSizeVal >= 0) {
        this.askSize[id] = Math.trunc(askSizeVal) >>> 0;
      }
      if (tsVal !== undefined && !Number.isNaN(tsVal)) this.timestamp[id] = tsVal;
      if (ivVal !== undefined && !Number.isNaN(ivVal)) this.iv[id] = ivVal;
      if (deltaVal !== undefined && !Number.isNaN(deltaVal)) this.delta[id] = deltaVal;
      if (gammaVal !== undefined && !Number.isNaN(gammaVal)) this.gamma[id] = gammaVal;
      applied += 1;
    }
    return applied;
  }

  public getFieldValue(id: number, field: SoaPriceField): number {
    if (!Number.isInteger(id) || id < 0 || id >= this.capacity) return Number.NaN;
    if (field === 'bid') return this.bid[id] ?? Number.NaN;
    if (field === 'ask') return this.ask[id] ?? Number.NaN;
    if (field === 'last') return this.last[id] ?? Number.NaN;
    const b = this.bid[id] ?? Number.NaN;
    const a = this.ask[id] ?? Number.NaN;
    if (Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0) {
      return 0.5 * (b + a);
    }
    return this.last[id] ?? Number.NaN;
  }
}

export class TradeRingBuffer {
  public readonly capacity: number;
  public readonly prices: Float64Array;
  public readonly sizes: Uint32Array;
  public readonly timestamps: Float64Array;

  private head = 0;
  private count = 0;
  private totalPushed = 0;

  public constructor(capacity = DEFAULT_TRADE_RING_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`Invalid TradeRingBuffer capacity: ${String(capacity)}`);
    }
    this.capacity = capacity;
    this.prices = new Float64Array(capacity);
    this.sizes = new Uint32Array(capacity);
    this.timestamps = new Float64Array(capacity);
    this.clear();
  }

  public clear(): void {
    this.head = 0;
    this.count = 0;
    this.totalPushed = 0;
    this.prices.fill(Number.NaN);
    this.sizes.fill(0);
    this.timestamps.fill(Number.NaN);
  }

  public getCount(): number {
    return this.count;
  }

  public getTotalPushed(): number {
    return this.totalPushed;
  }

  /**
   * Inserción O(1) con sobrescritura circular sin `Array.shift()` ni asignaciones.
   */
  public push(price: number, size: number, ts: number): boolean {
    if (!Number.isFinite(price) || !Number.isFinite(ts)) return false;
    const cleanSize = Number.isFinite(size) && size >= 0 ? Math.trunc(size) >>> 0 : 0;
    const idx = this.head;
    this.prices[idx] = price;
    this.sizes[idx] = cleanSize;
    this.timestamps[idx] = ts;
    this.head = (idx + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count += 1;
    }
    this.totalPushed += 1;
    return true;
  }

  /**
   * Lee registros recientes en orden LIFO (0 = trade más reciente) directamente
   * sobre buffers preasignados (`TradeRingSoaTarget` o `Float64Array` stride-3)
   * sin asignar memoria.
   */
  public readRecentInto(
    offset: number,
    out: TradeRingReadTarget,
    maxCount?: number,
  ): number {
    if (!Number.isInteger(offset) || offset < 0 || offset >= this.count) {
      return 0;
    }
    const available = this.count - offset;
    const isFlatBuffer = out instanceof Float64Array;
    const outCapacity = isFlatBuffer
      ? Math.floor(out.length / 3)
      : Math.min(out.prices.length, out.sizes.length, out.timestamps.length);
    const boundedMax =
      maxCount !== undefined && Number.isInteger(maxCount) && maxCount >= 0
        ? maxCount
        : outCapacity;
    const toRead = Math.min(available, outCapacity, boundedMax);
    if (toRead <= 0) return 0;

    const cap = this.capacity;
    const newestIdx = (this.head - 1 + cap) % cap;
    for (let k = 0; k < toRead; k += 1) {
      const stepsBack = offset + k;
      const srcIdx = (((newestIdx - stepsBack) % cap) + cap) % cap;
      const p = this.prices[srcIdx] ?? Number.NaN;
      const s = this.sizes[srcIdx] ?? 0;
      const t = this.timestamps[srcIdx] ?? Number.NaN;
      if (isFlatBuffer) {
        const base = k * 3;
        out[base] = p;
        out[base + 1] = s;
        out[base + 2] = t;
      } else {
        out.prices[k] = p;
        out.sizes[k] = s;
        out.timestamps[k] = t;
      }
    }
    return toRead;
  }
}

export class BitmaskConflationEngine {
  public readonly capacity: number;
  public readonly wordCount: number;
  public readonly dirtyMask: Uint32Array;
  public readonly visibleMask: Uint32Array;
  private readonly tailWordMask: number;

  public constructor(capacity = DEFAULT_SOA_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`Invalid BitmaskConflationEngine capacity: ${String(capacity)}`);
    }
    this.capacity = capacity;
    this.wordCount = Math.ceil(capacity / 32);
    this.dirtyMask = new Uint32Array(this.wordCount);
    this.visibleMask = new Uint32Array(this.wordCount);
    const rem = capacity & 31;
    this.tailWordMask = rem === 0 ? 0xffffffff : ((1 << rem) - 1) >>> 0;
  }

  public markDirty(id: number): void {
    if (!Number.isInteger(id) || id < 0 || id >= this.capacity) return;
    const w = id >>> 5;
    const bitMask = (1 << (id & 31)) >>> 0;
    this.dirtyMask[w] = ((this.dirtyMask[w] ?? 0) | bitMask) >>> 0;
  }

  public clearDirty(id: number): void {
    if (!Number.isInteger(id) || id < 0 || id >= this.capacity) return;
    const w = id >>> 5;
    const bitMask = (1 << (id & 31)) >>> 0;
    this.dirtyMask[w] = ((this.dirtyMask[w] ?? 0) & ~bitMask) >>> 0;
  }

  public clearAllDirty(): void {
    this.dirtyMask.fill(0);
  }

  public isDirty(id: number): boolean {
    if (!Number.isInteger(id) || id < 0 || id >= this.capacity) return false;
    const w = id >>> 5;
    const bitMask = (1 << (id & 31)) >>> 0;
    return (((this.dirtyMask[w] ?? 0) & bitMask) >>> 0) !== 0;
  }

  public setVisible(id: number, visible: boolean): void {
    if (!Number.isInteger(id) || id < 0 || id >= this.capacity) return;
    const w = id >>> 5;
    const bitMask = (1 << (id & 31)) >>> 0;
    const prev = this.visibleMask[w] ?? 0;
    this.visibleMask[w] = visible ? ((prev | bitMask) >>> 0) : ((prev & ~bitMask) >>> 0);
  }

  public setVisibleIds(ids: ArrayLike<number>): void {
    this.visibleMask.fill(0);
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      if (id !== undefined && Number.isInteger(id) && id >= 0 && id < this.capacity) {
        const w = id >>> 5;
        const bitMask = (1 << (id & 31)) >>> 0;
        this.visibleMask[w] = ((this.visibleMask[w] ?? 0) | bitMask) >>> 0;
      }
    }
  }

  public setAllVisible(visible: boolean): void {
    if (!visible) {
      this.visibleMask.fill(0);
      return;
    }
    this.visibleMask.fill(0xffffffff);
    const lastIdx = this.wordCount - 1;
    if (lastIdx >= 0) {
      this.visibleMask[lastIdx] = this.tailWordMask;
    }
  }

  public isVisible(id: number): boolean {
    if (!Number.isInteger(id) || id < 0 || id >= this.capacity) return false;
    const w = id >>> 5;
    const bitMask = (1 << (id & 31)) >>> 0;
    return (((this.visibleMask[w] ?? 0) & bitMask) >>> 0) !== 0;
  }

  public hasVisibleDirty(): boolean {
    for (let w = 0; w < this.wordCount; w += 1) {
      if ((((this.dirtyMask[w] ?? 0) & (this.visibleMask[w] ?? 0)) >>> 0) !== 0) {
        return true;
      }
    }
    return false;
  }

  public countVisibleDirty(): number {
    let total = 0;
    for (let w = 0; w < this.wordCount; w += 1) {
      let mask = ((this.dirtyMask[w] ?? 0) & (this.visibleMask[w] ?? 0)) >>> 0;
      while (mask !== 0) {
        const lsb = (mask & -mask) >>> 0;
        mask = (mask ^ lsb) >>> 0;
        total += 1;
      }
    }
    return total;
  }

  /**
   * Empaqueta hasta `maxItems` instrumentos que estén simultáneamente en
   * `dirtyMask` y `visibleMask`, escribiendo en `outView` (buffers preasignados)
   * y limpiando exclusivamente los bits enviados en `dirtyMask`.
   */
  public packVisibleDirtyDelta(
    store: MarketStoreSoA,
    outView: Float64Array,
    maxItems = MAX_DELTA_ITEMS_PER_FRAME,
    stride = SOA_DELTA_STRIDE,
  ): number {
    if (!Number.isInteger(maxItems) || maxItems <= 0 || !Number.isInteger(stride) || stride < SOA_DELTA_STRIDE) {
      return 0;
    }
    const maxSlots = Math.min(maxItems, Math.floor(outView.length / stride));
    if (maxSlots <= 0) return 0;

    let count = 0;
    const limitWords = Math.min(this.wordCount, Math.ceil(store.capacity / 32));
    for (let w = 0; w < limitWords && count < maxSlots; w += 1) {
      let dirtyWord = this.dirtyMask[w] ?? 0;
      const visibleWord = this.visibleMask[w] ?? 0;
      let intersection = (dirtyWord & visibleWord) >>> 0;
      while (intersection !== 0 && count < maxSlots) {
        const lsb = (intersection & -intersection) >>> 0;
        const bit = 31 - Math.clz32(lsb);
        const id = (w << 5) + bit;
        dirtyWord = (dirtyWord & ~lsb) >>> 0;
        intersection = (intersection ^ lsb) >>> 0;
        if (id >= store.capacity) continue;

        const base = count * stride;
        outView[base + SOA_COL_ID] = id;
        outView[base + SOA_COL_BID] = store.bid[id] ?? Number.NaN;
        outView[base + SOA_COL_ASK] = store.ask[id] ?? Number.NaN;
        outView[base + SOA_COL_LAST] = store.last[id] ?? Number.NaN;
        outView[base + SOA_COL_BID_SIZE] = store.bidSize[id] ?? 0;
        outView[base + SOA_COL_ASK_SIZE] = store.askSize[id] ?? 0;
        outView[base + SOA_COL_TIMESTAMP] = store.timestamp[id] ?? Number.NaN;
        outView[base + SOA_COL_IV] = store.iv[id] ?? Number.NaN;
        outView[base + SOA_COL_DELTA] = store.delta[id] ?? Number.NaN;
        outView[base + SOA_COL_GAMMA] = store.gamma[id] ?? Number.NaN;
        count += 1;
      }
      this.dirtyMask[w] = dirtyWord;
    }
    return count;
  }
}

interface DomCellEntry {
  readonly key: string;
  readonly textNode: DomTextNodeLike;
  readonly flashNode: DomFlashOverlayLike | null;
  readonly symbol: string | null;
  readonly field: SoaPriceField | null;
  readonly pulseTier: VisualPulseTier;
  readonly formatFn: (value: number) => string;
  readonly onMutate: ((value: number, formatted: string) => void) | undefined;
  lastValue: number;
  lastFormatted: string;
  activeAnimation: DomAnimationLike | null;
}

const FLASH_KEYFRAMES: { opacity: number }[] = [
  { opacity: 0.42 },
  { opacity: 0 },
];
const FLASH_ANIMATION_OPTIONS: {
  duration: number;
  easing: string;
  fill: 'none';
} = {
  duration: 350,
  easing: 'ease-out',
  fill: 'none',
};

function valuesEqualForCell(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 1e-9;
}

export class DomCellRegistry {
  private readonly cells = new Map<string, DomCellEntry>();
  private readonly cellsBySymbol = new Map<string, Set<DomCellEntry>>();
  private readonly pendingL2 = new Map<string, number>();
  private readonly pendingTable = new Map<string, number>();
  private l2Timer: ReturnType<typeof setTimeout> | null = null;
  private tableTimer: ReturnType<typeof setTimeout> | null = null;

  public size(): number {
    return this.cells.size;
  }

  public has(key: string): boolean {
    return this.cells.has(key);
  }

  public register(options: DomCellRegistrationOptions): () => void {
    const key = options.key.trim();
    if (key === '') return () => undefined;
    if (this.cells.has(key)) {
      this.unregister(key);
    }

    const decimals = options.decimals ?? 2;
    const prefix = options.prefix ?? '';
    const suffix = options.suffix ?? '';
    const formatFn =
      options.formatFn ??
      ((v: number): string => formatEsArPrice(v, decimals, prefix, suffix));

    const rawInit = options.initialValue ?? Number.NaN;
    const initVal = Number.isFinite(rawInit) ? rawInit : Number.NaN;
    const initText = formatFn(initVal);
    options.textNode.nodeValue = initText;

    const cleanSymbol =
      options.symbol !== undefined && options.symbol !== null && options.symbol.trim() !== ''
        ? normalizeSoaSymbol(options.symbol)
        : null;
    const field = options.field ?? null;

    const entry: DomCellEntry = {
      key,
      textNode: options.textNode,
      flashNode: options.flashNode ?? null,
      symbol: cleanSymbol,
      field,
      pulseTier: options.pulseTier ?? 'table',
      formatFn,
      onMutate: options.onMutate,
      lastValue: initVal,
      lastFormatted: initText,
      activeAnimation: null,
    };
    this.cells.set(key, entry);

    if (cleanSymbol !== null && field !== null) {
      let symSet = this.cellsBySymbol.get(cleanSymbol);
      if (symSet === undefined) {
        symSet = new Set();
        this.cellsBySymbol.set(cleanSymbol, symSet);
      }
      symSet.add(entry);
    }

    return () => {
      this.unregisterEntry(entry);
    };
  }

  public unregister(key: string): boolean {
    const entry = this.cells.get(key);
    if (entry === undefined) return false;
    this.unregisterEntry(entry);
    return true;
  }

  private unregisterEntry(entry: DomCellEntry): void {
    const current = this.cells.get(entry.key);
    if (current !== entry) return;
    this.cells.delete(entry.key);
    this.pendingL2.delete(entry.key);
    this.pendingTable.delete(entry.key);
    if (entry.symbol !== null) {
      const symSet = this.cellsBySymbol.get(entry.symbol);
      if (symSet !== undefined) {
        symSet.delete(entry);
        if (symSet.size === 0) {
          this.cellsBySymbol.delete(entry.symbol);
        }
      }
    }
    this.cancelEntryAnimation(entry);
  }

  private cancelEntryAnimation(entry: DomCellEntry): void {
    const anim = entry.activeAnimation;
    entry.activeAnimation = null;
    if (anim !== null) {
      try {
        anim.cancel();
      } catch {
        // Ignora errores en nodos desconectados durante desmontaje.
      }
    }
  }

  /**
   * Muta directamente `textNode.nodeValue` y dispara flash WAAPI solo de `opacity`
   * cuando el valor numérico cambia. Devuelve `false` si fue deduplicado.
   */
  public update(key: string, nextValue: number): boolean {
    const entry = this.cells.get(key);
    if (entry === undefined) return false;

    const normalizedNext = Number.isFinite(nextValue) ? nextValue : Number.NaN;
    if (valuesEqualForCell(entry.lastValue, normalizedNext)) {
      return false;
    }

    const prev = entry.lastValue;
    entry.lastValue = normalizedNext;
    const formatted = entry.formatFn(normalizedNext);
    if (formatted !== entry.lastFormatted || entry.textNode.nodeValue !== formatted) {
      entry.lastFormatted = formatted;
      entry.textNode.nodeValue = formatted;
      entry.onMutate?.(normalizedNext, formatted);
    }

    if (Number.isFinite(prev) && Number.isFinite(normalizedNext) && Math.abs(normalizedNext - prev) > 1e-9) {
      const dir = normalizedNext > prev ? 'up' : 'down';
      const flashNode = entry.flashNode;
      if (flashNode !== null) {
        if (flashNode.dataset !== undefined) {
          flashNode.dataset['dir'] = dir;
        }
        this.cancelEntryAnimation(entry);
        if (typeof flashNode.animate === 'function') {
          try {
            entry.activeAnimation = flashNode.animate(
              FLASH_KEYFRAMES,
              FLASH_ANIMATION_OPTIONS,
            );
          } catch {
            entry.activeAnimation = null;
          }
        }
      }
    }
    return true;
  }

  public stageUpdate(
    key: string,
    nextValue: number,
    pulseTier?: VisualPulseTier,
  ): void {
    const entry = this.cells.get(key);
    if (entry === undefined) return;
    const normalizedNext = Number.isFinite(nextValue) ? nextValue : Number.NaN;
    const tier = pulseTier ?? entry.pulseTier;
    const pendingMap = tier === 'l2' ? this.pendingL2 : this.pendingTable;

    if (!pendingMap.has(key) && valuesEqualForCell(entry.lastValue, normalizedNext)) {
      return;
    }
    pendingMap.set(key, normalizedNext);

    if (tier === 'l2') {
      if (this.l2Timer === null) {
        this.l2Timer = setTimeout(() => {
          this.l2Timer = null;
          this.flushPulse('l2');
        }, L2_VISUAL_PULSE_MS);
      }
    } else if (this.tableTimer === null) {
      this.tableTimer = setTimeout(() => {
        this.tableTimer = null;
        this.flushPulse('table');
      }, TABLE_VISUAL_PULSE_MS);
    }
  }

  public flushPulse(tier?: VisualPulseTier): number {
    let flushed = 0;
    if (tier === undefined || tier === 'l2') {
      if (this.l2Timer !== null) {
        clearTimeout(this.l2Timer);
        this.l2Timer = null;
      }
      if (this.pendingL2.size > 0) {
        for (const [key, value] of this.pendingL2) {
          if (this.update(key, value)) flushed += 1;
        }
        this.pendingL2.clear();
      }
    }
    if (tier === undefined || tier === 'table') {
      if (this.tableTimer !== null) {
        clearTimeout(this.tableTimer);
        this.tableTimer = null;
      }
      if (this.pendingTable.size > 0) {
        for (const [key, value] of this.pendingTable) {
          if (this.update(key, value)) flushed += 1;
        }
        this.pendingTable.clear();
      }
    }
    return flushed;
  }

  /**
   * Propaga directamente desde un delta binario aplicado al `MarketStoreSoA`
   * hacia todas las celdas registradas por `(symbol, field)` respetando el pulso
   * visual (L2 100 ms / Tablas 220 ms) sin pasar por React.
   */
  public applySoaDeltaBatch(
    store: MarketStoreSoA,
    view: Float64Array,
    count: number,
    stride = SOA_DELTA_STRIDE,
  ): number {
    if (this.cellsBySymbol.size === 0 || count <= 0 || stride < SOA_DELTA_STRIDE) return 0;
    const maxRows = Math.min(count, Math.floor(view.length / stride));
    let stagedCount = 0;
    for (let i = 0; i < maxRows; i += 1) {
      const rawId = view[i * stride + SOA_COL_ID];
      if (rawId === undefined || !Number.isInteger(rawId) || rawId < 0 || rawId >= store.capacity) {
        continue;
      }
      const symbol = store.getSymbol(rawId);
      if (symbol === undefined) continue;
      const entries = this.cellsBySymbol.get(symbol);
      if (entries === undefined) continue;
      for (const entry of entries) {
        if (entry.field === null) continue;
        const val = store.getFieldValue(rawId, entry.field);
        this.stageUpdate(entry.key, val, entry.pulseTier);
        stagedCount += 1;
      }
    }
    return stagedCount;
  }

  public clear(): void {
    if (this.l2Timer !== null) {
      clearTimeout(this.l2Timer);
      this.l2Timer = null;
    }
    if (this.tableTimer !== null) {
      clearTimeout(this.tableTimer);
      this.tableTimer = null;
    }
    this.pendingL2.clear();
    this.pendingTable.clear();
    for (const entry of this.cells.values()) {
      this.cancelEntryAnimation(entry);
    }
    this.cells.clear();
    this.cellsBySymbol.clear();
  }
}

export function createDomCellRegistry(): DomCellRegistry {
  return new DomCellRegistry();
}

export const domCellRegistry = new DomCellRegistry();
