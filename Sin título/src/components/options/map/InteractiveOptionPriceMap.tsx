import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Minus, Plus } from 'lucide-react';
import { fmtNum } from '../../../data/marketData';
import {
  FX_EASE,
  HIST_VOL,
  Market,
  MapGoal,
  MapMode,
  PricedLeg,
  atmIv,
  candidatesForGoal,
  dateAt,
  evaluate,
  fk,
  goalCenter,
  goalGain,
  goalReady,
  pickThree,
  probAbove,
  signedMoney,
  sizeForBudget,
} from '../engine';
import { createPointerStore, TooltipInfo } from './mapShared';
import { MapLayers, MapTiming, VolatilityMapChart, seededHistory, useMapGeometry } from './VolatilityMapChart';
import { MapReadout, MapTooltip } from './MapTooltip';
import { ROLES, StrategyCards } from './StrategyCards';
import { StrategyDetailPanel } from './StrategyDetailPanel';

const MODES: { id: MapMode; label: string; prompt: string }[] = [
  { id: 'precio', label: 'Un precio', prompt: 'Tocá a qué precio llega y para cuándo. Arrastrá el punto para afinarlo.' },
  { id: 'rango', label: 'Un rango', prompt: 'Tocá los dos bordes, o arrastrá de uno al otro.' },
  { id: 'mueve', label: 'Se mueve', prompt: 'Tocá cuánto se va a mover, para cualquier lado.' },
];

const Seg: React.FC<{ on: boolean; layoutId: string; onClick: () => void; children: React.ReactNode }> = ({
  on,
  layoutId,
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`relative px-3.5 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer transition-colors ${
      on ? 'text-[#0B0E14]' : 'text-[#9CA3AF] hover:text-white'
    }`}
  >
    {on && (
      <motion.span layoutId={layoutId} className="absolute inset-0 rounded-full bg-[#EAECEF]" transition={{ duration: 0.38, ease: FX_EASE }} />
    )}
    <span className="relative">{children}</span>
  </button>
);

export const InteractiveOptionPriceMap: React.FC<{
  mkt: Market;
  onGoToBuilder: (legs: PricedLeg[], units: number) => void;
  onGoToSheet: () => void;
}> = ({ mkt, onGoToBuilder, onGoToSheet }) => {
  const [goal, setGoal] = useState<MapGoal>({ mode: 'precio', price: null, range: null, move: null });
  const [timing, setTiming] = useState<MapTiming>('vto');
  const [targetDate, setTargetDate] = useState<number>(mkt.days);
  const [showPayoff, setShowPayoff] = useState(true);
  const [layers, setLayers] = useState<MapLayers>({ gain: true, loss: true, cone: true, hist: true });
  const [zoom, setZoom] = useState(1);
  const [budget, setBudget] = useState(250_000);
  const [isCustom, setIsCustom] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('medio');

  const store = useMemo(() => createPointerStore(), []);
  const history = useMemo(() => seededHistory(mkt.spot), [mkt.spot]);
  const geo = useMapGeometry(mkt, history, zoom);

  useEffect(() => setTargetDate((d) => Math.min(d, mkt.days)), [mkt.days]);

  /* --------- Ranking de candidatas (diferido: no bloquea el arrastre) --------- */
  const dGoal = useDeferredValue(goal);
  const dBudget = useDeferredValue(budget);
  const ready = goalReady(dGoal);
  const readyNow = goalReady(goal);

  const evaluations = useMemo(
    () => (ready ? candidatesForGoal(mkt, dGoal).map((s) => evaluate(mkt, s, goalCenter(mkt, dGoal))) : []),
    [mkt, dGoal, ready]
  );
  const sized = useMemo(
    () => sizeForBudget(evaluations, dBudget, (ev) => goalGain(mkt, dGoal, ev.pnl)),
    [evaluations, dBudget, mkt, dGoal]
  );
  const three = useMemo(() => pickThree(sized), [sized]);

  const role = ROLES.find((r) => r.key === selectedId);
  const byId = role ? undefined : sized.find((s) => s.ev.strategy.id === selectedId);
  const selected = (role ? three[role.key] : byId) ?? three.medio ?? null;
  const selectedLabel = role ? role.label : byId ? 'Elegida' : 'Al medio';

  // Evaluación de la estrategia elegida en el horizonte del mapa (vencimiento o la fecha del pin)
  const chartEv = useMemo(() => {
    if (!selected || !readyNow) return null;
    if (goal.mode === 'precio' && timing === 'antes' && goal.price != null)
      return evaluate(mkt, selected.ev.strategy, goal.price, targetDate);
    return selected.ev;
  }, [selected, readyNow, goal.mode, goal.price, timing, targetDate, mkt]);

  const inspect = useCallback(
    (price: number, elapsed: number): TooltipInfo => {
      const sig = atmIv(mkt.days);
      const above = price >= mkt.spot;
      const pa = probAbove(mkt, price, elapsed, sig, mkt.rate);
      const ph = probAbove(mkt, price, elapsed, HIST_VOL, 0);
      const info: TooltipInfo = {
        price,
        date: dateAt(mkt, elapsed),
        movePct: (price / mkt.spot - 1) * 100,
        above,
        prob: above ? pa : 1 - pa,
        probHist: above ? ph : 1 - ph,
      };
      if (chartEv && selected) {
        const pnl = chartEv.pnlAt(price, elapsed) * selected.units;
        info.strat = { label: selectedLabel, pnl, pctOfRisk: selected.risk > 0 ? pnl / selected.risk : null };
      }
      return info;
    },
    [mkt, chartEv, selected, selectedLabel]
  );

  /* --------- Lectura en palabras de tu objetivo (cuando no hay hover) --------- */
  const fallback = useMemo(() => {
    const sig = atmIv(mkt.days);
    const pctT = (p: number) => `${Math.round(p * 100)}%`;
    if (goal.mode === 'precio' && goal.price != null) {
      const el = timing === 'antes' ? targetDate : mkt.days;
      const i = inspect(goal.price, el);
      return (
        <>
          {fk(goal.price)} el {i.date}, {i.movePct >= 0 ? '+' : '-'}
          {fmtNum(Math.abs(i.movePct), 1)}%: <strong className="text-white">{pctT(i.prob)}</strong> de terminar{' '}
          {i.above ? 'arriba' : 'abajo'} (la historia, {pctT(i.probHist)}).
          {i.strat && (
            <>
              {' '}
              «{i.strat.label}»:{' '}
              <strong className={i.strat.pnl >= 0 ? 'text-[var(--fx-gain-2)]' : 'text-[var(--fx-loss-2)]'}>
                {signedMoney(i.strat.pnl)}
              </strong>
              .
            </>
          )}
        </>
      );
    }
    if (goal.mode === 'rango' && goal.range && goal.range[1] > goal.range[0]) {
      const [lo, hi] = goal.range;
      const pin = probAbove(mkt, lo, mkt.days, sig, mkt.rate) - probAbove(mkt, hi, mkt.days, sig, mkt.rate);
      const hin = probAbove(mkt, lo, mkt.days, HIST_VOL, 0) - probAbove(mkt, hi, mkt.days, HIST_VOL, 0);
      return (
        <>
          Entre {fk(lo)} y {fk(hi)} el {mkt.expiryLabel}: <strong className="text-white">{pctT(pin)}</strong> de quedar
          adentro (la historia, {pctT(hin)}).
        </>
      );
    }
    if (goal.mode === 'mueve' && goal.move != null) {
      const m = goal.move;
      const p =
        probAbove(mkt, mkt.spot + m, mkt.days, sig, mkt.rate) + 1 - probAbove(mkt, mkt.spot - m, mkt.days, sig, mkt.rate);
      const h = probAbove(mkt, mkt.spot + m, mkt.days, HIST_VOL, 0) + 1 - probAbove(mkt, mkt.spot - m, mkt.days, HIST_VOL, 0);
      return (
        <>
          Que se mueva más de ±${fk(m)} (±{fmtNum((m / mkt.spot) * 100, 1)}%) al {mkt.expiryLabel}:{' '}
          <strong className="text-white">{pctT(p)}</strong> (la historia, {pctT(h)}).
        </>
      );
    }
    return <span className="text-[#6B7280]">Pasá el mouse por el cono para ver la chance de cada precio.</span>;
  }, [goal, timing, targetDate, mkt, inspect]);

  const mode = MODES.find((m) => m.id === goal.mode)!;
  const clear = () => {
    setGoal((g) => ({ mode: g.mode, price: null, range: null, move: null }));
    setSelectedId('medio');
  };
  const legend: { k: keyof MapLayers; label: string; swatch: React.ReactNode; needsPayoff: boolean }[] = [
    { k: 'gain', label: 'ganás', needsPayoff: true, swatch: <span className="w-3 h-3 rounded-[3px] bg-[#10B981]/40 border border-[#10B981]" /> },
    {
      k: 'loss',
      label: 'perdés',
      needsPayoff: true,
      swatch: (
        <span
          className="w-3 h-3 rounded-[3px] border border-[#EF4444]"
          style={{ background: 'repeating-linear-gradient(45deg, rgba(239,68,68,0.45) 0 2px, transparent 2px 4px)' }}
        />
      ),
    },
    { k: 'cone', label: 'chance según las primas', needsPayoff: false, swatch: <span className="w-3 h-3 rounded-[3px] bg-white/25" /> },
    { k: 'hist', label: 'según la historia', needsPayoff: false, swatch: <span className="w-3 h-3 rounded-[3px] border border-dashed border-white/70" /> },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-[16px] bg-[#0B0E14] border border-[var(--fx-line)] overflow-hidden">
        {/* Encabezado + controles */}
        <div className="px-5 pt-5 pb-3 space-y-3">
          <div>
            <h2 className="text-[18px] font-extrabold tracking-tight text-white">¿A dónde va {mkt.ticker}?</h2>
            <motion.p
              key={goal.mode}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: FX_EASE }}
              className="text-[13px] text-[#9CA3AF]"
            >
              {mode.prompt}
            </motion.p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1">
              {MODES.map((m) => (
                <Seg
                  key={m.id}
                  on={goal.mode === m.id}
                  layoutId="vm-mode"
                  onClick={() => {
                    setGoal((g) => ({ ...g, mode: m.id }));
                    store.set(null);
                  }}
                >
                  {m.label}
                </Seg>
              ))}
              {readyNow && (
                <motion.div
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.35, ease: FX_EASE }}
                  className="flex items-center gap-1"
                >
                  <button
                    type="button"
                    onClick={() => setShowPayoff((v) => !v)}
                    className={`ml-1 px-3.5 py-1.5 rounded-full text-[12.5px] font-bold border cursor-pointer transition-colors ${
                      showPayoff
                        ? 'border-[var(--fx-line-strong)] bg-white/[0.08] text-white'
                        : 'border-transparent text-[#9CA3AF] hover:text-white'
                    }`}
                  >
                    Ganás o perdés
                  </button>
                  {goal.mode === 'precio' && (
                    <>
                      <span className="w-px h-5 bg-[var(--fx-line-strong)] mx-1.5" />
                      <Seg on={timing === 'vto'} layoutId="vm-timing" onClick={() => setTiming('vto')}>
                        Al vencimiento
                      </Seg>
                      <Seg
                        on={timing === 'antes'}
                        layoutId="vm-timing"
                        onClick={() => {
                          setTiming('antes');
                          setTargetDate(Math.round(mkt.days / 2));
                        }}
                      >
                        Antes
                      </Seg>
                    </>
                  )}
                </motion.div>
              )}
            </div>
            <div className="flex items-center gap-1 text-[#9CA3AF]">
              <button
                type="button"
                title="Alejar"
                onClick={() => setZoom((z) => Math.max(0.6, z / 1.25))}
                className="p-1.5 rounded-[8px] hover:text-white hover:bg-white/[0.06] cursor-pointer"
              >
                <Minus className="w-4 h-4" />
              </button>
              <button
                type="button"
                title="Acercar"
                onClick={() => setZoom((z) => Math.min(2.4, z * 1.25))}
                className="p-1.5 rounded-[8px] hover:text-white hover:bg-white/[0.06] cursor-pointer"
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={clear}
                className="ml-1 px-2.5 py-1 rounded-[8px] text-[12.5px] font-bold hover:text-white hover:bg-white/[0.06] cursor-pointer"
              >
                Borrar
              </button>
            </div>
          </div>
        </div>

        {/* Lienzo + tooltip desacoplado */}
        <div className="relative px-3">
          <VolatilityMapChart
            mkt={mkt}
            geo={geo}
            history={history}
            goal={goal}
            timing={timing}
            targetDate={targetDate}
            showPayoff={showPayoff}
            layers={layers}
            ev={chartEv}
            units={selected?.units ?? 1}
            store={store}
            onGoal={setGoal}
            onTargetDate={setTargetDate}
          />
          <MapTooltip store={store} geo={geo} inspect={inspect} />
        </div>

        {/* Leyenda */}
        <div className="px-5 pt-2 pb-1 flex flex-wrap items-center justify-center gap-1.5 text-[12px]">
          {legend
            .filter((l) => !l.needsPayoff || (readyNow && showPayoff))
            .map((l) => (
              <button
                key={l.k}
                type="button"
                onClick={() => setLayers((s) => ({ ...s, [l.k]: !s[l.k] }))}
                className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full cursor-pointer transition-opacity ${
                  layers[l.k] ? 'text-[#D1D4DC]' : 'text-[#6B7280] opacity-60'
                }`}
              >
                {l.swatch}
                {l.label}
              </button>
            ))}
        </div>
        <p className="px-5 pb-5 pt-1 text-[13px] text-[#9CA3AF] font-mono-num" aria-live="polite">
          <MapReadout store={store} inspect={inspect} fallback={fallback} />
        </p>
      </div>

      {/* Panel inferior sincronizado */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <StrategyCards
          mkt={mkt}
          mode={dGoal.mode}
          ready={ready}
          three={three}
          sized={sized}
          selectedId={selectedId}
          onSelect={setSelectedId}
          budget={budget}
          isCustom={isCustom}
          onBudget={(b, custom) => {
            setBudget(b);
            setIsCustom(custom);
          }}
        />
        <StrategyDetailPanel
          mkt={mkt}
          goal={dGoal}
          sized={ready ? selected : null}
          label={selectedLabel}
          onGoToBuilder={onGoToBuilder}
          onGoToSheet={onGoToSheet}
        />
      </div>
    </div>
  );
};
