import React, { memo, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowRight, Check, Share2 } from 'lucide-react';
import { fmtNum } from '../../../data/marketData';
import { FX_EASE, Market, MapGoal, PricedLeg, Sized, dateAt, fk, money, signedMoney } from '../engine';

/** Ficha desglosada de la estrategia elegida en "Tres maneras". */
export const StrategyDetailPanel: React.FC<{
  mkt: Market;
  goal: MapGoal;
  sized: Sized | null;
  label: string;
  onGoToBuilder: (legs: PricedLeg[], units: number) => void;
  onGoToSheet: () => void;
}> = memo(({ mkt, goal, sized, label, onGoToBuilder, onGoToSheet }) => {
  const [copied, setCopied] = useState(false);

  const data = useMemo(() => {
    if (!sized) return null;
    const { ev, units } = sized;
    const total = (ev.cash - ev.commission) * units;
    const maxLoss = ev.maxLoss != null ? ev.maxLoss * units : null;
    const riskCopy =
      total < 0
        ? maxLoss != null && Math.abs(maxLoss + total) < Math.abs(total) * 0.02
          ? `Pagás ${money(-total)} con comisiones, y es lo más que podés perder.`
          : `Pagás ${money(-total)} con comisiones. Podés perder hasta ${maxLoss == null ? 'sin techo' : money(maxLoss)}.`
        : `Cobrás ${money(total)} neto de comisiones. ${
            maxLoss == null ? 'La pérdida no tiene techo.' : `Podés perder hasta ${money(maxLoss)}.`
          }`;

    const rows: { label: string; price: number; be?: boolean }[] = [];
    if (goal.mode === 'precio' && goal.price != null) rows.push({ label: 'En tu precio', price: goal.price });
    if (goal.mode === 'rango' && goal.range) {
      rows.push({ label: 'Borde de arriba', price: goal.range[1] }, { label: 'Borde de abajo', price: goal.range[0] });
    }
    if (goal.mode === 'mueve' && goal.move != null) {
      rows.push({ label: 'Si sube a', price: mkt.spot + goal.move }, { label: 'Si baja a', price: mkt.spot - goal.move });
    }
    const bes = [...ev.breakevens].sort((a, b) => b - a);
    bes.forEach((b, i) =>
      rows.push({ label: bes.length === 1 ? 'Empate' : i === 0 ? 'Empate de arriba' : 'Empate de abajo', price: b, be: true })
    );
    rows.push({ label: 'Si no se mueve', price: mkt.spot });
    return { ev, units, riskCopy, rows: rows.sort((a, b) => b.price - a.price) };
  }, [sized, goal, mkt.spot]);

  const share = async () => {
    if (!data) return;
    const text = [
      `${label}: ${data.ev.strategy.name} (${mkt.ticker} · vence ${mkt.expiryLabel})`,
      ...data.ev.legs.map(
        (l) => `${l.side > 0 ? 'Comprás' : 'Vendés'} ${l.ratio * data.units} ${l.code} a $${fmtNum(l.premium, 2)}`
      ),
      data.riskCopy,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="rounded-[14px] bg-[var(--fx-panel)] border border-[var(--fx-line)] p-5 min-h-[280px]">
      <AnimatePresence mode="wait">
        {!data ? (
          <motion.p
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full min-h-[240px] flex items-center justify-center text-center text-[13px] text-[#6B7280]"
          >
            Elegí una manera para ver cómo se arma, cuánto pagás y qué te queda en cada escenario.
          </motion.p>
        ) : (
          <motion.div
            key={data.ev.strategy.id + data.units}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.35, ease: FX_EASE }}
            className="space-y-4"
          >
            <div>
              <h3 className="text-[16px] font-extrabold tracking-tight text-white">
                {label}: {data.ev.strategy.name}
              </h3>
              <p className="text-[12.5px] text-[#9CA3AF]">
                Vence el {mkt.expiryLabel}, en {mkt.days} días.
              </p>
            </div>

            <div className="divide-y divide-[var(--fx-line)] text-[13.5px]">
              {data.ev.legs.map((l, i) => (
                <div key={`${l.code}-${i}`} className="py-2 grid grid-cols-[80px_1fr_auto] items-center gap-3">
                  <span className={`font-bold ${l.side > 0 ? 'text-[var(--fx-gain-2)]' : 'text-[var(--fx-loss-2)]'}`}>
                    {l.side > 0 ? 'Comprás' : 'Vendés'}
                  </span>
                  <span className="font-mono-num text-white">
                    {l.ratio * data.units} {l.code}
                  </span>
                  <span className="font-mono-num text-[#D1D4DC]">a ${fmtNum(l.premium, 2)}</span>
                </div>
              ))}
            </div>

            <p className="text-[13px] text-white">{data.riskCopy}</p>

            <div>
              <div className="grid grid-cols-[1fr_90px_130px] gap-3 pb-1.5 text-[11px] font-semibold text-[#787B86] border-b border-[var(--fx-line)]">
                <span>El {dateAt(mkt, mkt.days)}</span>
                <span className="text-right">{mkt.ticker}</span>
                <span className="text-right">Te queda</span>
              </div>
              {data.rows.map((r) => {
                const v = r.be ? 0 : data.ev.pnl(r.price) * data.units;
                return (
                  <div key={r.label} className="grid grid-cols-[1fr_90px_130px] gap-3 py-2 text-[13px] border-b border-[var(--fx-line)] last:border-0">
                    <span className="text-[#D1D4DC]">{r.label}</span>
                    <span className="text-right font-mono-num text-[#9CA3AF]">{fk(Math.round(r.price))}</span>
                    <span
                      className={`text-right font-mono-num font-bold ${
                        r.be ? 'text-white' : v >= 0 ? 'text-[var(--fx-gain-2)]' : 'text-[var(--fx-loss-2)]'
                      }`}
                    >
                      {r.be ? '$0' : signedMoney(v)}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => onGoToBuilder(data.ev.legs, data.units)}
                className="inline-flex items-center gap-1.5 text-[13px] font-extrabold text-white hover:text-[var(--fx-target)] cursor-pointer"
              >
                Ir al armador <ArrowRight className="w-4 h-4" />
              </motion.button>
              <button type="button" onClick={onGoToSheet} className="text-[13px] font-bold text-[#9CA3AF] hover:text-white cursor-pointer">
                Ir a la planilla →
              </button>
              <span className="w-px h-4 bg-[var(--fx-line-strong)]" />
              <button
                type="button"
                onClick={share}
                title={copied ? 'Copiado' : 'Copiar el armado para compartir'}
                className="inline-flex items-center gap-1 text-[12.5px] text-[#9CA3AF] hover:text-white cursor-pointer"
              >
                {copied ? <Check className="w-4 h-4 text-[var(--fx-gain-2)]" /> : <Share2 className="w-4 h-4" />}
                {copied && 'Copiado'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
StrategyDetailPanel.displayName = 'StrategyDetailPanel';
