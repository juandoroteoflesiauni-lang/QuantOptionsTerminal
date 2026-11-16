import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Market,
  FX_EASE,
  TERM_STRUCTURE,
  HIST_MEDIAN_IV,
  smileIv,
  ivPercentile,
  diagnose,
  monotonePath,
  fk,
} from './engine';
import { fmtNum } from '../../data/marketData';

const EXP_COLORS = ['#38BDF8', '#A855F7', '#F59E0B'];
const SW = 760;
const SH = 320;
const SL = 52;
const SR = 740;
const ST = 22;
const SB = 262;
const M_RANGE = 0.16;
const IV_MIN = 0.47;
const IV_MAX = 0.61;

const diagStyle = {
  Barata: { fg: '#00D592', bg: 'rgba(16,185,129,0.14)' },
  'En rango': { fg: '#94A3B8', bg: 'rgba(148,163,184,0.12)' },
  Cara: { fg: '#F59E0B', bg: 'rgba(245,158,11,0.14)' },
} as const;

function cellBg(p: number) {
  if (p < 25) return `rgba(16,185,129,${(0.16 + ((25 - p) / 25) * 0.38).toFixed(2)})`;
  if (p > 75) return `rgba(245,158,11,${(0.16 + ((p - 75) / 25) * 0.38).toFixed(2)})`;
  return `rgba(148,163,184,${(0.05 + (Math.abs(p - 50) / 25) * 0.06).toFixed(2)})`;
}

export const VolatilitySurface: React.FC<{ mkt: Market }> = ({ mkt }) => {
  const [visible, setVisible] = useState<boolean[]>([true, true, false]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverCell, setHoverCell] = useState<{ r: number; c: number } | null>(null);

  const strikes = useMemo(
    () => mkt.strikes.filter((k) => Math.abs(k / mkt.spot - 1) <= M_RANGE),
    [mkt.strikes, mkt.spot]
  );

  const mx = (m: number) => SL + ((m + M_RANGE) / (2 * M_RANGE)) * (SR - SL);
  const iy = (iv: number) => SB - ((iv - IV_MIN) / (IV_MAX - IV_MIN)) * (SB - ST);

  const series = useMemo(
    () =>
      TERM_STRUCTURE.map((t) =>
        strikes.map((k) => {
          const m = k / mkt.spot - 1;
          const iv = smileIv(mkt.spot, k, t.days);
          return { k, m, iv, x: mx(m), y: iy(iv) };
        })
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strikes, mkt.spot]
  );

  // Lectura de skew: base OTM call más cercana a +10% vs ATM del vencimiento corto
  const near = series[0];
  const atmPt = near.reduce((a, b) => (Math.abs(b.m) < Math.abs(a.m) ? b : a), near[0]);
  const otmCall = near.reduce((a, b) => (Math.abs(b.m - 0.1) < Math.abs(a.m - 0.1) ? b : a), near[0]);
  const otmPut = near.reduce((a, b) => (Math.abs(b.m + 0.1) < Math.abs(a.m + 0.1) ? b : a), near[0]);
  const callSkew = (otmCall.iv - atmPt.iv) * 100;
  const putSkew = (otmPut.iv - atmPt.iv) * 100;

  const term = TERM_STRUCTURE;
  const spread1 = (term[1].atm - term[0].atm) * 100;
  const spread2 = (term[2].atm - term[1].atm) * 100;
  const regime = spread1 >= 0 ? 'Contango' : 'Backwardation';

  const hovered = hoverIdx != null ? strikes[hoverIdx] : null;

  return (
    <div className="space-y-4">
      {/* A) Skew & Smile dinámica */}
      <div className="rounded-[14px] bg-[var(--fx-panel)] border border-[var(--fx-line)] overflow-hidden">
        <div className="px-5 pt-5 pb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-[17px] font-extrabold tracking-tight text-white">Sonrisa de volatilidad por base</h3>
            <p className="text-[12.5px] text-[#9CA3AF]">
              VI de cada base contra su distancia al precio, con interpolación monótona entre bases.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {term.map((t, i) => (
              <button
                key={t.days}
                type="button"
                onClick={() => setVisible((v) => v.map((x, j) => (j === i ? !x : x)))}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-[12px] font-bold cursor-pointer transition-all ${
                  visible[i] ? 'border-[var(--fx-line-strong)] bg-[var(--fx-panel-2)] text-white' : 'border-transparent text-[#6B7280]'
                }`}
              >
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: EXP_COLORS[i], opacity: visible[i] ? 1 : 0.3 }} />
                {t.label} · {t.days}d
              </button>
            ))}
          </div>
        </div>

        <div className="mx-5 mb-3 px-3.5 py-2 rounded-[10px] bg-[var(--fx-base-2)] border border-[var(--fx-line)] text-[12.5px] text-[#D1D4DC]">
          <span className="font-mono-num text-[10.5px] font-bold uppercase tracking-wider text-[var(--fx-target)] mr-2">
            Skew
          </span>
          Las bases OTM alcistas (+{fmtNum(otmCall.m * 100, 0)}% sobre spot) operan con{' '}
          <strong className="font-mono-num text-white">
            {callSkew >= 0 ? '+' : ''}
            {fmtNum(callSkew, 1)} pts
          </strong>{' '}
          de VI sobre ATM; las OTM bajistas, con{' '}
          <strong className="font-mono-num text-white">
            {putSkew >= 0 ? '+' : ''}
            {fmtNum(putSkew, 1)} pts
          </strong>
          . Demanda especulativa de calls por encima de la de cobertura.
        </div>

        <div className="relative px-2">
          <svg
            viewBox={`0 0 ${SW} ${SH}`}
            className="w-full h-auto select-none"
            onPointerMove={(e) => {
              const svg = e.currentTarget;
              const pt = svg.createSVGPoint();
              pt.x = e.clientX;
              pt.y = e.clientY;
              const ctm = svg.getScreenCTM();
              if (!ctm) return;
              const p = pt.matrixTransform(ctm.inverse());
              if (p.x < SL - 10 || p.x > SR + 10) return setHoverIdx(null);
              let best = 0;
              series[0].forEach((q, i) => {
                if (Math.abs(q.x - p.x) < Math.abs(series[0][best].x - p.x)) best = i;
              });
              setHoverIdx(best);
            }}
            onPointerLeave={() => setHoverIdx(null)}
          >
            {[0.48, 0.5, 0.52, 0.54, 0.56, 0.58, 0.6].map((v) => (
              <g key={v}>
                <line x1={SL} y1={iy(v)} x2={SR} y2={iy(v)} stroke="rgba(255,255,255,0.05)" />
                <text x={SL - 8} y={iy(v) + 3.5} textAnchor="end" fill="#6B7280" fontSize="10.5" className="font-mono-num">
                  {fmtNum(v * 100, 0)}%
                </text>
              </g>
            ))}

            {/* Zona ATM */}
            <rect x={mx(-0.02)} y={ST} width={mx(0.02) - mx(-0.02)} height={SB - ST} fill="rgba(255,255,255,0.03)" />

            {/* Mediana histórica */}
            <line x1={SL} y1={iy(HIST_MEDIAN_IV)} x2={SR} y2={iy(HIST_MEDIAN_IV)} stroke="#94A3B8" strokeDasharray="6 5" strokeOpacity="0.7" />
            <text x={SR - 4} y={iy(HIST_MEDIAN_IV) - 7} textAnchor="end" fill="#94A3B8" fontSize="11" fontWeight="600">
              Mediana histórica {fmtNum(HIST_MEDIAN_IV * 100, 1)}%
            </text>

            {/* Curvas */}
            {series.map((s, i) =>
              visible[i] ? (
                <g key={term[i].days}>
                  <motion.path
                    d={monotonePath(s)}
                    fill="none"
                    stroke={EXP_COLORS[i]}
                    strokeWidth={i === 0 ? 2.6 : 2}
                    strokeDasharray={i === 2 ? '6 4' : undefined}
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{ duration: 0.9, ease: FX_EASE }}
                  />
                  {s.map((q, j) => (
                    <g key={q.k}>
                      <circle
                        cx={q.x}
                        cy={q.y}
                        r={hoverIdx === j ? 5.5 : 3.8}
                        fill="#090B0E"
                        stroke={EXP_COLORS[i]}
                        strokeWidth="2"
                      />
                      {i === 0 && (
                        <text x={q.x} y={q.y - 10} textAnchor="middle" fill="#E5E7EB" fontSize="10" className="font-mono-num">
                          {fmtNum(q.iv * 100, 1)}%
                        </text>
                      )}
                    </g>
                  ))}
                </g>
              ) : null
            )}

            {hoverIdx != null && (
              <line x1={series[0][hoverIdx].x} y1={ST} x2={series[0][hoverIdx].x} y2={SB} stroke="rgba(255,255,255,0.25)" strokeDasharray="2 3" />
            )}

            {/* Eje de moneyness */}
            {[
              { m: -0.15, label: 'Deep OTM Put', sub: '−15%' },
              { m: -0.075, label: 'OTM Put', sub: '−7,5%' },
              { m: 0, label: 'ATM', sub: '0%' },
              { m: 0.075, label: 'OTM Call', sub: '+7,5%' },
              { m: 0.15, label: 'Deep OTM Call', sub: '+15%' },
            ].map((t) => (
              <g key={t.m}>
                <line x1={mx(t.m)} y1={SB} x2={mx(t.m)} y2={SB + 5} stroke="#4B5563" />
                <text x={mx(t.m)} y={SB + 20} textAnchor="middle" fill={t.m === 0 ? '#FFFFFF' : '#9CA3AF'} fontSize="11" fontWeight={t.m === 0 ? 700 : 500}>
                  {t.label}
                </text>
                <text x={mx(t.m)} y={SB + 34} textAnchor="middle" fill="#6B7280" fontSize="10" className="font-mono-num">
                  {t.sub}
                </text>
              </g>
            ))}
            {series[0].map((q) => (
              <text key={`k-${q.k}`} x={q.x} y={SB - 6} textAnchor="middle" fill="#4B5563" fontSize="9" className="font-mono-num">
                {fk(q.k)}
              </text>
            ))}
          </svg>

          <AnimatePresence>
            {hoverIdx != null && hovered != null && (
              <motion.div
                key="smile-tip"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.18, ease: FX_EASE }}
                className="pointer-events-none absolute top-3 z-10 px-3 py-2.5 rounded-[10px] bg-[#0D1017]/70 backdrop-blur-md border border-[var(--fx-line-strong)] shadow-xl text-[12px] font-mono-num"
                style={{ left: `calc(${(series[0][hoverIdx].x / SW) * 100}% + 12px)` }}
              >
                <div className="text-white font-bold mb-1">
                  Base {fk(hovered)} · {fmtNum((hovered / mkt.spot - 1) * 100, 1)}%
                </div>
                {series.map((s, i) =>
                  visible[i] ? (
                    <div key={i} className="flex items-center justify-between gap-4">
                      <span className="flex items-center gap-1.5 text-[#9CA3AF]">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: EXP_COLORS[i] }} />
                        {term[i].label} {term[i].days}d
                      </span>
                      <span className="text-white font-bold">{fmtNum(s[hoverIdx].iv * 100, 1)}%</span>
                    </div>
                  ) : null
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* B) Superficie Base × Vencimiento + Estructura temporal */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.7fr_1fr] gap-4">
        <div className="rounded-[14px] bg-[var(--fx-panel)] border border-[var(--fx-line)] p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-[17px] font-extrabold tracking-tight text-white">Superficie base × vencimiento</h3>
              <p className="text-[12.5px] text-[#9CA3AF]">VI y percentil contra su propia historia. Pasá el mouse por una celda.</p>
            </div>
            <div className="flex items-center gap-3 text-[11.5px]">
              {(['Barata', 'En rango', 'Cara'] as const).map((d) => (
                <span key={d} className="inline-flex items-center gap-1.5" style={{ color: diagStyle[d].fg }}>
                  <span className="w-2.5 h-2.5 rounded-[3px]" style={{ backgroundColor: diagStyle[d].fg }} />
                  {d} {d === 'Barata' ? '< P25' : d === 'Cara' ? '> P75' : 'P25–P75'}
                </span>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-1 font-mono-num text-[12.5px]">
              <thead>
                <tr className="text-[10.5px] font-sans font-semibold uppercase tracking-wider text-[#787B86]">
                  <th className="py-1.5 px-2 text-left">Base / moneyness</th>
                  {term.map((t) => (
                    <th key={t.days} className="py-1.5 px-2 text-center">
                      {t.label} · {t.days}d
                    </th>
                  ))}
                  <th className="py-1.5 px-2 text-left">Diagnóstico</th>
                </tr>
              </thead>
              <tbody>
                {strikes.map((k, r) => {
                  const m = k / mkt.spot - 1;
                  const cells = term.map((t) => {
                    const iv = smileIv(mkt.spot, k, t.days);
                    return { iv, p: ivPercentile(iv) };
                  });
                  const avg = Math.round(cells.reduce((a, c) => a + c.p, 0) / cells.length);
                  const d = diagnose(avg);
                  const isAtm = Math.abs(m) < mkt.step / mkt.spot / 2 + 0.005;
                  return (
                    <tr key={k}>
                      <td className={`py-1.5 px-2 text-left ${isAtm ? 'text-white font-bold' : 'text-[#D1D4DC]'}`}>
                        {fk(k)}{' '}
                        <span className="text-[11px] text-[#6B7280]">
                          {isAtm ? 'ATM' : `${m > 0 ? '+' : ''}${fmtNum(m * 100, 1)}%`}
                        </span>
                      </td>
                      {cells.map((c, ci) => {
                        const on = hoverCell?.r === r && hoverCell?.c === ci;
                        return (
                          <td key={ci} className="p-0">
                            <motion.div
                              onMouseEnter={() => setHoverCell({ r, c: ci })}
                              onMouseLeave={() => setHoverCell(null)}
                              animate={{ scale: on ? 1.04 : 1 }}
                              transition={{ duration: 0.2, ease: FX_EASE }}
                              className="relative rounded-[6px] px-2 py-2 text-center cursor-default"
                              style={{ backgroundColor: cellBg(c.p), outline: on ? '1px solid rgba(255,255,255,0.35)' : 'none' }}
                            >
                              <span className="font-bold text-white">{fmtNum(c.iv * 100, 1)}%</span>
                              <span className="ml-1.5 text-[10.5px] text-[#D1D4DC]/70">P{c.p}</span>
                              <AnimatePresence>
                                {on && (
                                  <motion.div
                                    initial={{ opacity: 0, scale: 0.98, y: 4 }}
                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                    exit={{ opacity: 0, scale: 0.98 }}
                                    transition={{ duration: 0.18, ease: FX_EASE }}
                                    className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-20 w-max px-3 py-2 rounded-[10px] bg-[#0D1017]/75 backdrop-blur-md border border-[var(--fx-line-strong)] text-left text-[11.5px] shadow-xl"
                                  >
                                    <div className="text-white font-bold">
                                      Base {fk(k)} · {term[ci].label} {term[ci].days}d
                                    </div>
                                    <div className="text-[#9CA3AF]">
                                      VI {fmtNum(c.iv * 100, 2)}% · percentil {c.p}
                                    </div>
                                    <div style={{ color: diagStyle[diagnose(c.p)].fg }} className="font-bold">
                                      {diagnose(c.p)}
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </motion.div>
                          </td>
                        );
                      })}
                      <td className="py-1.5 px-2">
                        <div className="flex items-center gap-2.5">
                          <div className="relative w-16 h-1.5 rounded-full bg-[#1F2433] overflow-hidden">
                            <div className="absolute inset-y-0 left-[25%] right-[25%] bg-white/5" />
                            <motion.div
                              className="absolute top-1/2 -translate-y-1/2 w-1.5 h-2.5 rounded-full"
                              style={{ backgroundColor: diagStyle[d].fg }}
                              initial={{ left: '50%' }}
                              animate={{ left: `calc(${avg}% - 3px)` }}
                              transition={{ duration: 0.6, ease: FX_EASE }}
                            />
                          </div>
                          <span
                            className="px-2 py-0.5 rounded-[6px] text-[11px] font-sans font-bold"
                            style={{ color: diagStyle[d].fg, backgroundColor: diagStyle[d].bg }}
                          >
                            {d}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Monitor de estructura temporal */}
        <div className="rounded-[14px] bg-[var(--fx-panel)] border border-[var(--fx-line)] p-5 flex flex-col gap-4">
          <div>
            <h3 className="text-[17px] font-extrabold tracking-tight text-white">Estructura temporal</h3>
            <p className="text-[12.5px] text-[#9CA3AF]">VI ATM por vencimiento.</p>
          </div>

          <div className="flex items-baseline gap-2.5">
            <span className={`text-[24px] font-extrabold ${spread1 >= 0 ? 'text-[var(--fx-target)]' : 'text-[var(--fx-be)]'}`}>
              {regime}
            </span>
            <span className="font-mono-num text-[15px] font-bold text-white">
              {spread1 >= 0 ? '+' : ''}
              {fmtNum(spread1, 1)} pts {term[1].label}/{term[0].label}
            </span>
          </div>

          <svg viewBox="0 0 300 140" className="w-full h-[140px]">
            {(() => {
              const x = (d: number) => 24 + ((d - term[0].days) / (term[2].days - term[0].days)) * 252;
              const y = (v: number) => 116 - ((v - 0.5) / 0.06) * 96;
              const line = term.map((t) => `${x(t.days)},${y(t.atm)}`).join(' ');
              return (
                <>
                  <line x1="24" y1={y(HIST_MEDIAN_IV)} x2="276" y2={y(HIST_MEDIAN_IV)} stroke="#94A3B8" strokeDasharray="5 4" strokeOpacity="0.6" />
                  <polygon points={`24,116 ${line} 276,116`} fill="#38BDF8" fillOpacity="0.08" />
                  <motion.polyline
                    points={line}
                    fill="none"
                    stroke="#38BDF8"
                    strokeWidth="2.4"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.8, ease: FX_EASE }}
                  />
                  {term.map((t, i) => (
                    <g key={t.days}>
                      <circle cx={x(t.days)} cy={y(t.atm)} r="4.5" fill="#090B0E" stroke={EXP_COLORS[i]} strokeWidth="2" />
                      <text x={x(t.days)} y={y(t.atm) - 10} textAnchor="middle" fill="#FFFFFF" fontSize="11" fontWeight="700" className="font-mono-num">
                        {fmtNum(t.atm * 100, 1)}%
                      </text>
                      <text x={x(t.days)} y="134" textAnchor="middle" fill="#9CA3AF" fontSize="10.5" className="font-mono-num">
                        {t.label} {t.days}d
                      </text>
                    </g>
                  ))}
                </>
              );
            })()}
          </svg>

          <div className="space-y-2 text-[12.5px]">
            {[
              { label: `${term[1].label}/${term[0].label}`, v: spread1 },
              { label: `${term[2].label}/${term[1].label}`, v: spread2 },
            ].map((s) => (
              <div key={s.label} className="flex items-center justify-between rounded-[8px] bg-[var(--fx-base-2)] border border-[var(--fx-line)] px-3 py-2">
                <span className="text-[#9CA3AF]">Spread {s.label}</span>
                <span className={`font-mono-num font-bold ${s.v >= 0 ? 'text-[var(--fx-target)]' : 'text-[var(--fx-be)]'}`}>
                  {s.v >= 0 ? '+' : ''}
                  {fmtNum(s.v, 1)} pts
                </span>
              </div>
            ))}
          </div>
          <p className="text-[12px] leading-relaxed text-[#9CA3AF]">
            {spread1 >= 0
              ? `La curva está en contango suave: los plazos largos pagan más VI. Vender el corto y comprar el largo (calendario) cobra esa pendiente.`
              : `La curva está invertida: el mercado paga más por cobertura inmediata. Señal de estrés de corto plazo.`}
          </p>
        </div>
      </div>
    </div>
  );
};
