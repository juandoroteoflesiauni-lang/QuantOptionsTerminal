import React, { memo, useEffect, useRef, useState } from 'react';
import { animate, useMotionValue } from 'motion/react';
import { FX_EASE, money, pct, signedMoney } from '../engine';

export type NumberKind = 'money' | 'signed' | 'pct' | 'risk';

const FORMATS: Record<NumberKind, (v: number) => string> = {
  money: (v) => money(v),
  signed: (v) => signedMoney(v),
  pct: (v) => pct(v),
  risk: (v) => money(-Math.abs(v)),
};

/**
 * Número tipo odómetro: interpola el valor y escribe directo en el DOM (sin re-renders),
 * con cifras tabulares para que no tiemble.
 */
export const AnimatedNumber: React.FC<{ value: number; kind: NumberKind; className?: string }> = memo(
  ({ value, kind, className = '' }) => {
    const ref = useRef<HTMLSpanElement>(null);
    const mv = useMotionValue(value);
    const [initial] = useState(() => FORMATS[kind](value));

    useEffect(
      () =>
        mv.on('change', (v) => {
          if (ref.current) ref.current.textContent = FORMATS[kind](v);
        }),
      [mv, kind]
    );
    useEffect(() => {
      const c = animate(mv, value, { duration: 0.55, ease: FX_EASE });
      return () => c.stop();
    }, [mv, value]);

    return (
      <span ref={ref} className={`font-mono-num tabular-nums ${className}`}>
        {initial}
      </span>
    );
  }
);
AnimatedNumber.displayName = 'AnimatedNumber';
