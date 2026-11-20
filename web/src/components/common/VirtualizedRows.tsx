import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/**
 * Pieza 49.1: ventana de filas virtualizada reutilizable (div-based).
 *
 * - Solo monta las filas visibles + `overscan` dentro del contenedor de scroll,
 *   eliminando el pico de miles de nodos DOM en tablas largas (escalera de
 *   spreads, flujo por base).
 * - Alturas medidas con `ResizeObserver` vía `virtualizer.measureElement`
 *   (`data-index`), sin lecturas de layout en ticks de mercado ni en render.
 * - No aporta handlers propios: la delegación de clicks queda en el contenedor.
 */
export interface VirtualizedRowsProps<TItem> {
  /** Contenedor con `overflow: auto` que actúa de viewport del scroll. */
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  readonly items: readonly TItem[];
  /** Clave estable por fila (para reciclar mediciones entre renders). */
  readonly getKey: (item: TItem, index: number) => string;
  /** Altura estimada inicial (px) usada antes de la primera medición real. */
  readonly estimateSize: number | ((index: number, item: TItem) => number);
  readonly overscan?: number;
  readonly className?: string;
  readonly children: (item: TItem, index: number) => React.ReactNode;
}

export function VirtualizedRows<TItem>({
  scrollRef,
  items,
  getKey,
  estimateSize,
  overscan = 8,
  className = '',
  children,
}: VirtualizedRowsProps<TItem>): React.ReactElement {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = items[index];
      if (item === undefined) return 0;
      return typeof estimateSize === 'function' ? estimateSize(index, item) : estimateSize;
    },
    overscan,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? `idx-${String(index)}` : getKey(item, index);
    },
  });

  return (
    <div
      className={className}
      style={{
        height: `${String(virtualizer.getTotalSize())}px`,
        position: 'relative',
        width: '100%',
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index];
        if (item === undefined) return null;
        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${String(virtualRow.start)}px)`,
            }}
          >
            {children(item, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );
}
