import React, { memo, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { fmtNum } from '../../../data/marketData';
import { FX_EASE, Market, MapMode, Sized, money, pct } from '../engine';
import { AnimatedNumber } from './AnimatedNumber';

export const BUDGETS = [50_000, 100_000, 250_000, 500_000];
export type RoleKey = 'seguido' | 'medio' | 'grande';
export const ROLES: { key: RoleKey; label: string }[] = [
  { key: 'seguido', label: 'Más seguido' },
  { key: 'medio', label: 'Al medio' },
  { key: 'grande', label: 'Más grande' },
];

const Pill: React.FC<{ on: boolean; layoutId: string; onClick: () => void; children: React.ReactNode }> = ({
  on,
  layoutId,
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`relative px-3 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer transition-colors ${
      on ? 'text-[#0B0E14]' : 'text-[#9CA3AF] hover:text-white'
    }`}
  >
    {on && (
      <motion.span layoutId={layoutId} className="absolute inset-0 rounded-full bg-[#EAECEF]" transition={{ duration: 0.35, ease: FX_EASE }} />
    )}
    <span className="relative">{children}</span>
  </button>
);

export const StrategyCards: React.FC<{
  mkt: Market;
  mode: MapMode;
  ready: boolean;
  three: Partial<Record<RoleKey, Sized>>;
  sized: Sized[];
  selectedId: string | null;
  onSelect: (key: string) => void;
  budget: number;
  isCustom: boolean;
  onBudget: (b: number, custom: boolean) => void;
}> = memo(({ mkt, mode, ready, three, sized, selectedId, onSelect, budget, isCustom, onBudget }) => {
  const [expanded, setExpanded] = useState(false);
  const [sortBy, setSortBy] = useState<'chance' | 'ganancia'>('chance');
  const [visible, setVisible] = useState(10);
  const [customText, setCustomText] = useState('');

  const sorted = useMemo(
    () => [...sized].sort((a, b) => (sortBy === 'chance' ? b.ev.pop - a.ev.pop || b.gain - a.gain : b.gain - a.gain)),
    [sized, sortBy]
  );
  const picks = ROLES.map((r) => ({ ...r, s: three[r.key] })).filter((p): p is typeof p & { s: Sized } => !!p.s);
  const gainHeader = mode === 'rango' ? 'Ganás adentro' : mode === 'mueve' ? 'Ganás si se va' : 'Ganás ahí';

  return (
    <div className="rounded-[14px] bg-[var(--fx-panel)] border border-[var(--fx-line)] p-5 flex flex-col gap-4">
      <h3 className="text-[16px] font-extrabold tracking-tight text-white">Tres maneras de jugarla</h3>

      {/* Capital disponible */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[12.5px] text-[#9CA3AF] mr-1">Ponés hasta</span>
        {BUDGETS.map((b) => (
          <Pill key={b} on={!isCustom && budget === b} layoutId="sc-budget" onClick={() => onBudget(b, false)}>
            ${fmtNum(b / 1000, 0)} mil
          </Pill>
        ))}
        <input
          value={isCustom ? customText : ''}
          onFocus={() => {
            setCustomText(String(budget));
            onBudget(budget, true);
          }}
          onChange={(e) => {
            setCustomText(e.target.value);
            const v = Number(e.target.value.replace(/\D/g, ''));
            if (v >= 1000) onBudget(v, true);
          }}
          placeholder="otro"
          className={`ml-1 w-[76px] px-2.5 py-1.5 rounded-[10px] bg-[var(--fx-base-2)] border font-mono-num text-[12.5px] text-white outline-none transition-colors ${
            isCustom ? 'border-[var(--fx-line-strong)]' : 'border-[var(--fx-line)]'
          }`}
        />
      </div>

      {!ready ? (
        <p className="text-[13px] text-[#9CA3AF] py-6 text-center">
          Marcá en el mapa a dónde va {mkt.ticker} y acá aparecen tres maneras de jugarla.
        </p>
      ) : picks.length === 0 ? (
        <p className="text-[13px] text-[#9CA3AF] py-6 text-center">
          Con ${fmtNum(budget, 0)} no hay nada que la cadena permita armar para eso. Probá con más capital o
          ajustá el objetivo.
        </p>
      ) : (
        <>
          <div>
            <div className="grid grid-cols-[1fr_124px_56px_104px] gap-3 px-3 pb-2 text-[11px] font-semibold text-[#787B86]">
              <span>Manera</span>
              <span className="text-right whitespace-nowrap">{gainHeader}</span>
              <span className="text-right">Chance</span>
              <span className="text-right">Arriesgás</span>
            </div>
            <div className="space-y-1">
              {picks.map((p) => {
                const on = selectedId === p.key || selectedId === p.s.ev.strategy.id;
                return (
                  <motion.button
                    key={p.key}
                    type="button"
                    layout
                    onClick={() => onSelect(p.key)}
                    whileHover={{ x: on ? 0 : 2 }}
                    transition={{ duration: 0.3, ease: FX_EASE }}
                    className={`relative w-full grid grid-cols-[1fr_124px_56px_104px] items-center gap-3 px-3 py-2.5 rounded-[10px] text-left cursor-pointer transition-colors ${
                      on ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    {on && (
                      <motion.span
                        layoutId="sc-selected"
                        className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-white"
                        transition={{ duration: 0.35, ease: FX_EASE }}
                      />
                    )}
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-bold text-white">{p.label}</span>
                      <span className="block text-[11.5px] text-[#9CA3AF] truncate">{p.s.ev.strategy.name}</span>
                    </span>
                    <AnimatedNumber value={p.s.gain} kind="money" className="text-right text-[13.5px] font-bold text-[var(--fx-gain-2)]" />
                    <AnimatedNumber value={p.s.ev.pop} kind="pct" className="text-right text-[13.5px] text-white" />
                    <AnimatedNumber value={p.s.risk} kind="risk" className="text-right text-[13.5px] text-[var(--fx-loss-2)]" />
                  </motion.button>
                );
              })}
            </div>
          </div>

          <div className="text-[12.5px] leading-relaxed text-[#9CA3AF] space-y-1">
            <p>
              De <strong className="font-mono-num text-white">{sized.length}</strong> que sirven, estos{' '}
              {picks.length === 3 ? 'tres' : picks.length}. La chance es la de las primas, no un pronóstico.
            </p>
            <p>
              Con lo que se movió {mkt.ticker} desde 2021, habrían ganado{' '}
              {picks.map((p, i) => (
                <React.Fragment key={p.key}>
                  <strong className="font-mono-num text-white">{Math.round(p.s.ev.popHist * 100)}</strong>
                  {i < picks.length - 2 ? ', ' : i === picks.length - 2 ? ' y ' : ''}
                </React.Fragment>
              ))}{' '}
              de cada 100.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                setExpanded((v) => !v);
                setVisible(10);
              }}
              className="px-3.5 py-1.5 rounded-[10px] bg-white/[0.07] hover:bg-white/[0.12] text-[12.5px] font-bold text-white cursor-pointer transition-colors"
            >
              {expanded ? 'Volver a las tres' : `Ver las ${sized.length}`}
            </button>
            <AnimatePresence>
              {expanded && (
                <motion.div
                  initial={{ opacity: 0, x: 6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 6 }}
                  transition={{ duration: 0.25, ease: FX_EASE }}
                  className="flex items-center gap-1"
                >
                  <Pill on={sortBy === 'chance'} layoutId="sc-sort" onClick={() => setSortBy('chance')}>
                    Más chance
                  </Pill>
                  <Pill on={sortBy === 'ganancia'} layoutId="sc-sort" onClick={() => setSortBy('ganancia')}>
                    Más ganancia
                  </Pill>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div
                key="sc-list"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.45, ease: FX_EASE }}
                className="overflow-hidden"
              >
                <div className="divide-y divide-[var(--fx-line)]">
                  {sorted.slice(0, visible).map((s) => {
                    const on = selectedId === s.ev.strategy.id;
                    return (
                      <button
                        key={s.ev.strategy.id}
                        type="button"
                        onClick={() => onSelect(s.ev.strategy.id)}
                        className={`w-full grid grid-cols-[1fr_124px_56px_104px] items-center gap-3 px-3 py-2 text-left font-mono-num text-[12.5px] cursor-pointer transition-colors ${
                          on ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                        }`}
                      >
                        <span className="font-sans text-[#D1D4DC] truncate">
                          {s.ev.strategy.name} <span className="text-[#6B7280]">· {s.units}u</span>
                        </span>
                        <span className="text-right text-[var(--fx-gain-2)]">{money(s.gain)}</span>
                        <span className="text-right text-white">{pct(s.ev.pop)}</span>
                        <span className="text-right text-[var(--fx-loss-2)]">{money(-s.risk)}</span>
                      </button>
                    );
                  })}
                </div>
                {visible < sorted.length && (
                  <button
                    type="button"
                    onClick={() => setVisible((v) => v + 10)}
                    className="mt-2 px-3 py-1.5 text-[12.5px] font-bold text-[#9CA3AF] hover:text-white cursor-pointer"
                  >
                    Diez más
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
});
StrategyCards.displayName = 'StrategyCards';
