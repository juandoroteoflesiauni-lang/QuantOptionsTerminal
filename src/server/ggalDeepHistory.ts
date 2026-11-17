/**
 * Historial profundo de GGAL ADR (Pieza 39): cubre el gap electoral de octubre
 * 2025 en temporalidades intradía para el AVWAP Anclado.
 *
 * Contrato (Zero Silent Fallbacks):
 * - Ventana explícita de 14 meses hacia atrás desde ahora (antes del gap
 *   electoral) o tope de 15.000 barras en `5m`/`15m`/`1h`.
 * - Paginación `next_url` con `sort=asc&limit=5000` (el corte por `maxPages`
   nunca deja fuera el borde electoral: se pagina desde el anillo más antiguo).
 * - Caché LRU en memoria + snapshot en disco (`.cache/ggal-deep-history/`) para
   que las consultas posteriores respondan en <15 ms. DuckDB no es dependencia
   del repo: el snapshot en disco es JSON con validación estricta de entrada.
 * - Sin datos simulados: si la carga falla, no hay filas de respaldo.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

export const GGAL_DEEP_HISTORY_MONTHS = 14;
export const GGAL_DEEP_HISTORY_MAX_BARS = 15_000;
export const GGAL_DEEP_HISTORY_SYMBOL = 'GGAL';
export const GGAL_DEEP_HISTORY_TIMEFRAMES = ['5m', '15m', '1h'] as const;
export type GgalDeepHistoryTimeframe = (typeof GGAL_DEEP_HISTORY_TIMEFRAMES)[number];

/** Edad máxima de un snapshot (memoria o disco) antes de recargar. */
export const GGAL_DEEP_HISTORY_TTL_MS = 30 * 60 * 1_000;
/** Edad mínima obligatoria entre recargas completas (incluye forceRefresh). */
export const GGAL_DEEP_HISTORY_MIN_REFRESH_AGE_MS = 10 * 60 * 1_000;

export type TimeframeForDeep = '5m' | '15m' | '1h' | '4h' | '1D' | '1m';

export function isGgalDeepHistoryTimeframe(timeframe: TimeframeForDeep): boolean {
  return (GGAL_DEEP_HISTORY_TIMEFRAMES as readonly string[]).includes(timeframe);
}

/**
 * Borde histórico de la ventana profunda: `months` meses calendario UTC hacia
 * atrás desde `nowSec` (con clamp de fin de mes, p. ej. 31 mar -> 28/29 feb).
 */
export function deepHistoryFromUtcSec(nowSec: number, months: number = GGAL_DEEP_HISTORY_MONTHS): number {
  if (!Number.isInteger(nowSec) || nowSec <= 0 || !Number.isInteger(months) || months <= 0) {
    return Number.NaN;
  }
  const date = new Date(nowSec * 1_000);
  const targetYear = date.getUTCFullYear();
  const targetMonthZero = date.getUTCMonth() - months;
  const totalMonths = targetYear * 12 + targetMonthZero;
  const year = Math.floor(totalMonths / 12);
  const monthZero = ((totalMonths % 12) + 12) % 12;
  const day = date.getUTCDate();
  const daysInTargetMonth = new Date(Date.UTC(year, monthZero + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  return Math.floor(Date.UTC(year, monthZero, clampedDay, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()) / 1_000);
}

/**
 * Fusión de páginas del proveedor: dedupe por `time` (la última ocurrencia
 * gana), orden ascendente y recorte a las `maxBars` más recientes.
 */
export function mergeDeepHistoryBars(
  pages: readonly (readonly {
    readonly time: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
    readonly vw?: number;
  }[])[],
  maxBars: number = GGAL_DEEP_HISTORY_MAX_BARS,
): readonly {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly vw?: number;
}[] {
  if (!Number.isInteger(maxBars) || maxBars <= 0) {
    return [];
  }
  const byTime = new Map<
    number,
    { readonly time: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number; readonly vw?: number }
  >();
  for (const page of pages) {
    for (const bar of page) {
      if (
        !Number.isInteger(bar.time) ||
        bar.time <= 0 ||
        !Number.isFinite(bar.open) ||
        !Number.isFinite(bar.high) ||
        !Number.isFinite(bar.low) ||
        !Number.isFinite(bar.close) ||
        !Number.isFinite(bar.volume)
      ) {
        continue;
      }
      byTime.set(bar.time, bar);
    }
  }
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  return sorted.length > maxBars ? sorted.slice(sorted.length - maxBars) : sorted;
}

export interface DeepHistoryDiskSnapshot {
  readonly fetchedAtUtcSec: number;
  readonly bars: readonly {
    readonly time: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
    readonly vw?: number;
  }[];
}

export interface DeepHistoryFsLike {
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly mkdir: (path: string, options: { readonly recursive: true }) => Promise<string | undefined>;
}

export interface GgalAdrDeepHistoryEntry {
  readonly bars: readonly {
    readonly time: number;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
    readonly vw?: number;
  }[];
  readonly fetchedAtMs: number;
}

export interface GgalAdrDeepHistoryDeps {
  readonly nowMsFn?: () => number;
  readonly ttlMs?: number;
  readonly minRefreshAgeMs?: number;
  /** `null` desactiva el snapshot en disco (p. ej. en tests sin filesystem). */
  readonly cacheDir?: string | null;
  readonly fs?: DeepHistoryFsLike | null;
}

const MAX_LRU_ENTRIES = 6;

export class GgalAdrDeepHistoryStore {
  private readonly nowMsFn: () => number;
  private readonly ttlMs: number;
  private readonly minRefreshAgeMs: number;
  private readonly cacheDir: string | null;
  private readonly fs: DeepHistoryFsLike | null;
  private readonly entries = new Map<string, GgalAdrDeepHistoryEntry>();
  private readonly inflight = new Map<string, Promise<readonly { readonly time: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number; readonly vw?: number }[]>>();

  public constructor(deps: GgalAdrDeepHistoryDeps = {}) {
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.ttlMs = deps.ttlMs ?? GGAL_DEEP_HISTORY_TTL_MS;
    this.minRefreshAgeMs = deps.minRefreshAgeMs ?? GGAL_DEEP_HISTORY_MIN_REFRESH_AGE_MS;
    this.cacheDir =
      deps.cacheDir === null
        ? null
        : deps.cacheDir ?? resolvePath(process.cwd(), '.cache', 'ggal-deep-history');
    this.fs =
      deps.fs === null
        ? null
        : deps.fs ?? {
            readFile: async (path: string) => await readFile(path, 'utf-8'),
            writeFile: async (path: string, data: string) => {
              await writeFile(path, data, 'utf-8');
            },
            mkdir: async (dirPath: string, options: { readonly recursive: true }) => {
              await mkdir(dirPath, options);
              return undefined;
            },
          };
  }

  /** Consulta instantánea de la caché (<15 ms): solo entradas frescas. */
  public peek(timeframe: GgalDeepHistoryTimeframe): readonly { readonly time: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number; readonly vw?: number }[] | null {
    const entry = this.entries.get(timeframe);
    if (entry === undefined) {
      return null;
    }
    if (this.nowMsFn() - entry.fetchedAtMs > this.ttlMs) {
      return null;
    }
    this.touch(timeframe, entry);
    return entry.bars;
  }

  private touch(timeframe: GgalDeepHistoryTimeframe, entry: GgalAdrDeepHistoryEntry): void {
    this.entries.delete(timeframe);
    this.entries.set(timeframe, entry);
    while (this.entries.size > MAX_LRU_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  private diskPath(timeframe: GgalDeepHistoryTimeframe): string | null {
    if (this.cacheDir === null || this.fs === null) {
      return null;
    }
    return resolvePath(this.cacheDir, `GGAL-${timeframe}.json`);
  }

  private async readDisk(timeframe: GgalDeepHistoryTimeframe): Promise<GgalAdrDeepHistoryEntry | null> {
    const path = this.diskPath(timeframe);
    const fs = this.fs;
    if (path === null || fs === null) {
      return null;
    }
    try {
      const raw = await fs.readFile(path);
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      const record = parsed as { fetchedAtUtcSec?: unknown; bars?: unknown };
      const fetchedAtUtcSec = record['fetchedAtUtcSec'];
      const bars = record['bars'];
      if (!Number.isFinite(fetchedAtUtcSec) || (fetchedAtUtcSec as number) <= 0 || !Array.isArray(bars)) {
        return null;
      }
      const entry: GgalAdrDeepHistoryEntry = {
        fetchedAtMs: (fetchedAtUtcSec as number) * 1_000,
        bars: bars as DeepHistoryDiskSnapshot['bars'],
      };
      return entry.bars.length > 0 ? entry : null;
    } catch {
      return null;
    }
  }

  private async writeDisk(
    timeframe: GgalDeepHistoryTimeframe,
    bars: readonly {
      readonly time: number;
      readonly open: number;
      readonly high: number;
      readonly low: number;
      readonly close: number;
      readonly volume: number;
      readonly vw?: number;
    }[],
  ): Promise<void> {
    const dir = this.cacheDir;
    const fs = this.fs;
    const path = this.diskPath(timeframe);
    if (dir === null || fs === null || path === null || bars.length === 0) {
      return;
    }
    try {
      await fs.mkdir(dir, { recursive: true });
      const snapshot: DeepHistoryDiskSnapshot = {
        fetchedAtUtcSec: Math.floor(this.nowMsFn() / 1_000),
        bars,
      };
      await fs.writeFile(path, JSON.stringify(snapshot));
    } catch {
      // El snapshot en disco es best-effort: nunca bloquea la carga.
    }
  }

  /**
   * Devuelve la serie profunda (cache-first). `loadFn` solo se invoca si no
   * hay caché fresca en memoria ni en disco, o si la más reciente supera
   * `minRefreshAgeMs` (incluido `forceRefresh: true`).
   */
  public async ensure(
    timeframe: GgalDeepHistoryTimeframe,
    opts: {
      readonly loadFn: () => Promise<readonly { readonly time: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number; readonly vw?: number }[]>;
      readonly forceRefresh?: boolean;
    },
  ): Promise<readonly { readonly time: number; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number; readonly vw?: number }[]> {
    const nowMs = this.nowMsFn();
    const memoryEntry = this.entries.get(timeframe);
    if (memoryEntry !== undefined) {
      const ageMs = nowMs - memoryEntry.fetchedAtMs;
      if (ageMs <= this.ttlMs && (!opts.forceRefresh || ageMs <= this.minRefreshAgeMs)) {
        this.touch(timeframe, memoryEntry);
        return memoryEntry.bars;
      }
    }
    if (memoryEntry === undefined) {
      const diskEntry = await this.readDisk(timeframe);
      if (diskEntry !== null) {
        const ageMs = nowMs - diskEntry.fetchedAtMs;
        if (ageMs <= this.ttlMs && (!opts.forceRefresh || ageMs <= this.minRefreshAgeMs)) {
          this.touch(timeframe, diskEntry);
          return diskEntry.bars;
        }
      }
    }
    const inflight = this.inflight.get(timeframe);
    if (inflight !== undefined) {
      return inflight;
    }
    const load = (async () => {
      try {
        const bars = await opts.loadFn();
        if (bars.length === 0) {
          return memoryEntry?.bars ?? [];
        }
        const entry: GgalAdrDeepHistoryEntry = { fetchedAtMs: this.nowMsFn(), bars };
        this.touch(timeframe, entry);
        await this.writeDisk(timeframe, bars);
        return bars;
      } finally {
        this.inflight.delete(timeframe);
      }
    })();
    this.inflight.set(timeframe, load);
    return load;
  }
}
