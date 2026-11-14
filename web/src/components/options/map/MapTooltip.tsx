import React, { memo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { fmtNum } from '../../../data/marketData';
import { FX_EASE, fk, signedMoney } from '../engine';
import { MapGeometry, PointerStore, TooltipInfo, usePointer } from './mapShared';

const pctTxt = (p: number) => `${Math.round(p * 100)}%`;
const moveTxt = (m: number) => `${m >= 0 ? '+' : '-'}${fmtNum(Math.abs(m), 1)}%`;

/** Capa SVG: mira horizontal/vertical, ícono de cursor y badge punteado en el eje. */
export const MapCrosshair: React.FC<{ store: PointerStore; geo: MapGeometry }> = memo(({ store, geo }) => {
  const p = usePointer(store);
  if (!p) return null;
  return (
    <g pointerEvents="none">
      <line x1={geo.L} y1={p.y} x2={geo.xStrip} y2={p.y} stroke="rgba(255,255,255,0.32)" strokeDasharray="2 3" />
      <line x1={p.x} y1={geo.T} x2={p.x} y2={geo.B} stroke="rgba(255,255,255,0.14)" strokeDasharray="2 3" />
      <circle cx={p.x} cy={p.y} r="6" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="1.2" />
      <line x1={p.x - 10} y1={p.y} x2={p.x - 3} y2={p.y} stroke="rgba(255,255,255,0.75)" />
      <line x1={p.x + 3} y1={p.y} x2={p.x + 10} y2={p.y} stroke="rgba(255,255,255,0.75)" />
      <line x1={p.x} y1={p.y - 10} x2={p.x} y2={p.y - 3} stroke="rgba(255,255,255,0.75)" />
      <line x1={p.x} y1={p.y + 3} x2={p.x} y2={p.y + 10} stroke="rgba(255,255,255,0.75)" />
      <g transform={`translate(${geo.xAxis - 58}, ${p.y - 10})`}>
        <rect width="58" height="20" rx="5" fill="#0B0E14" stroke="rgba(255,255,255,0.6)" strokeDasharray="3 2" />
        <text x="29" y="14" textAnchor="middle" fill="#FFFFFF" fontSize="11.5" fontWeight="700" className="font-mono-num">
          {fk(Math.round(p.price / 10) * 10)}
        </text>
      </g>
    </g>
  );
});
MapCrosshair.displayName = 'MapCrosshair';

/** Tooltip HTML que sigue al puntero sin re-renderizar al padre. */
export const MapTooltip: React.FC<{
  store: PointerStore;
  geo: MapGeometry;
  inspect: (price: number, elapsed: number) => TooltipInfo;
}> = memo(({ store, geo, inspect }) => {
  const p = usePointer(store);
  const info = p ? inspect(p.price, p.elapsed) : null;
  const flip = p ? p.x > geo.W * 0.62 : false;
  return (
    <AnimatePresence>
      {p && info && (
        <motion.div
          key="map-tip"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.16, ease: FX_EASE }}
          className="pointer-events-none absolute z-20 bg-[#121620]/95 backdrop-blur-md border border-white/10 p-2.5 rounded-lg shadow-2xl text-[12px] leading-[18px] whitespace-nowrap"
          style={{
            left: `${(p.x / geo.W) * 100}%`,
            top: `${(p.y / geo.H) * 100}%`,
            transform: `translate(${flip ? 'calc(-100% - 18px)' : '18px'}, -50%)`,
          }}
        >
          <div className="text-[#D1D4DC]">
            <span className="font-mono-num font-bold text-white">{fk(Math.round(info.price / 10) * 10)}</span> el{' '}
            {info.date}{' '}
            <span className={`font-mono-num ${info.movePct >= 0 ? 'text-[var(--fx-gain-2)]' : 'text-[var(--fx-loss-2)]'}`}>
              {moveTxt(info.movePct)}
            </span>
          </div>
          <div className="text-[#9CA3AF]">
            <span className="font-mono-num font-bold text-white">{pctTxt(info.prob)}</span> a terminar{' '}
            {info.above ? 'arriba' : 'abajo'} · la historia, <span className="font-mono-num">{pctTxt(info.probHist)}</span>
          </div>
          {info.strat && (
            <div className="text-[#9CA3AF]">
              «{info.strat.label}»:{' '}
              <span
                className={`font-mono-num font-bold ${
                  info.strat.pnl >= 0 ? 'text-[var(--fx-gain-2)]' : 'text-[var(--fx-loss-2)]'
                }`}
              >
                {signedMoney(info.strat.pnl)}
              </span>
              {info.strat.pctOfRisk != null && (
                <span className="font-mono-num ml-1.5">
                  {info.strat.pctOfRisk >= 0 ? '+' : '-'}
                  {fmtNum(Math.abs(info.strat.pctOfRisk) * 100, 0)}%
                </span>
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
});
MapTooltip.displayName = 'MapTooltip';

/** Frase de lectura bajo el mapa: sigue al puntero o, si no hay, describe tu objetivo. */
export const MapReadout: React.FC<{
  store: PointerStore;
  inspect: (price: number, elapsed: number) => TooltipInfo;
  fallback: React.ReactNode;
}> = memo(({ store, inspect, fallback }) => {
  const p = usePointer(store);
  if (!p) return <>{fallback}</>;
  const i = inspect(p.price, p.elapsed);
  return (
    <>
      {fk(Math.round(i.price / 10) * 10)} el {i.date}, {moveTxt(i.movePct)}:{' '}
      <strong className="text-white">{pctTxt(i.prob)}</strong> de terminar {i.above ? 'arriba' : 'abajo'} (la historia,{' '}
      {pctTxt(i.probHist)}).
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
});
MapReadout.displayName = 'MapReadout';
