import React, { memo, useEffect, useLayoutEffect, useRef } from 'react';
import {
  DomCellRegistry,
  type SoaPriceField,
  type VisualPulseTier,
  createDomCellRegistry,
  domCellRegistry,
} from '../store/marketStoreSoa';

export { DomCellRegistry, createDomCellRegistry, domCellRegistry };

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface ImperativePriceCellProps {
  readonly cellKey: string;
  readonly value: number;
  readonly symbol?: string | null;
  readonly field?: SoaPriceField | null;
  readonly pulseTier?: VisualPulseTier;
  readonly decimals?: number;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly align?: 'left' | 'right';
  readonly className?: string;
  readonly textClassName?: string;
  readonly title?: string;
  readonly formatFn?: (value: number) => string;
  readonly onMutate?: (value: number, formatted: string) => void;
}

const ImperativePriceCellImpl: React.FC<ImperativePriceCellProps> = ({
  cellKey,
  value,
  symbol = null,
  field = null,
  pulseTier = 'table',
  decimals = 2,
  prefix = '',
  suffix = '',
  align = 'right',
  className = '',
  textClassName = '',
  title,
  formatFn,
  onMutate,
}) => {
  const textHostRef = useRef<HTMLSpanElement | null>(null);
  const flashRef = useRef<HTMLSpanElement | null>(null);
  const textNodeRef = useRef<Text | null>(null);
  const latestValueRef = useRef<number>(value);
  latestValueRef.current = value;
  const onMutateRef = useRef(onMutate);
  onMutateRef.current = onMutate;

  useIsomorphicLayoutEffect(() => {
    const host = textHostRef.current;
    if (host === null) return undefined;

    let textNode = textNodeRef.current;
    if (textNode === null || textNode.parentNode !== host) {
      host.textContent = '';
      textNode = document.createTextNode('—');
      host.appendChild(textNode);
      textNodeRef.current = textNode;
    }

    return domCellRegistry.register({
      key: cellKey,
      textNode,
      flashNode: flashRef.current,
      symbol,
      field,
      pulseTier,
      initialValue: latestValueRef.current,
      decimals,
      prefix,
      suffix,
      formatFn,
      onMutate: (nextVal, formatted) => {
        onMutateRef.current?.(nextVal, formatted);
      },
    });
  }, [cellKey, symbol, field, pulseTier, decimals, prefix, suffix, formatFn]);

  const alignClass = align === 'left' ? 'justify-start' : 'justify-end';

  return (
    <span
      title={title}
      className={`imperative-price-cell font-mono-num tabular-nums ${alignClass} ${className}`}
    >
      <span ref={flashRef} aria-hidden="true" className="cell-flash-overlay" />
      <span ref={textHostRef} className={`relative z-10 truncate ${textClassName}`} />
    </span>
  );
};

function areImperativeCellPropsEqual(
  prev: ImperativePriceCellProps,
  next: ImperativePriceCellProps,
): boolean {
  const structuralSame =
    prev.cellKey === next.cellKey &&
    prev.symbol === next.symbol &&
    prev.field === next.field &&
    prev.pulseTier === next.pulseTier &&
    prev.decimals === next.decimals &&
    prev.prefix === next.prefix &&
    prev.suffix === next.suffix &&
    prev.align === next.align &&
    prev.className === next.className &&
    prev.textClassName === next.textClassName &&
    prev.title === next.title &&
    prev.formatFn === next.formatFn;

  if (!structuralSame) {
    return false;
  }

  const prevNaN = Number.isNaN(prev.value);
  const nextNaN = Number.isNaN(next.value);
  if (!(prevNaN && nextNaN) && prev.value !== next.value) {
    domCellRegistry.stageUpdate(
      next.cellKey,
      next.value,
      next.pulseTier ?? 'table',
    );
  }
  return true;
}

export const ImperativePriceCell = memo(ImperativePriceCellImpl, areImperativeCellPropsEqual);
