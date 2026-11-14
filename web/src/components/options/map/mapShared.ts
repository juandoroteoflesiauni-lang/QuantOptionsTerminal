import { useSyncExternalStore } from 'react';

/** Geometría del lienzo del mapa (coordenadas del viewBox). */
export interface MapGeometry {
  W: number;
  H: number;
  L: number;
  T: number;
  B: number;
  xToday: number;
  xExp: number;
  xStrip: number;
  xAxis: number;
  yMin: number;
  yMax: number;
  pToY: (p: number) => number;
  yToP: (y: number) => number;
  dayToX: (d: number) => number;
  xToDay: (x: number) => number;
}

/** Posición del puntero dentro del futuro del mapa. */
export interface MapPointer {
  x: number;
  y: number;
  price: number;
  elapsed: number;
}

export interface TooltipInfo {
  price: number;
  date: string;
  movePct: number;
  above: boolean;
  prob: number;
  probHist: number;
  strat?: { label: string; pnl: number; pctOfRisk: number | null };
}

export interface PointerStore {
  get: () => MapPointer | null;
  set: (p: MapPointer | null) => void;
  subscribe: (fn: () => void) => () => void;
}

/**
 * Store externo del puntero: los movimientos se agrupan en un frame (requestAnimationFrame)
 * y solo re-renderizan la mira y el tooltip, nunca el gráfico ni el contenedor.
 */
export function createPointerStore(): PointerStore {
  let state: MapPointer | null = null;
  let pending: MapPointer | null = null;
  let raf = 0;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (p) => {
      pending = p;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        state = pending;
        subs.forEach((fn) => fn());
      });
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export function usePointer(store: PointerStore): MapPointer | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
