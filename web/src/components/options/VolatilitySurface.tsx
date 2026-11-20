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
import { fmtNum, type OptionChainRow, type OptionExpiryGroup } from '../../data/marketData';
import { computeForwardIvTermStructure } from '../../../../src/core/options/volSurface';

const EXP_COLORS = ['#38BDF8', '#A855F7', '#F59E0B', '#10B981'] as const;
const SW = 760;
const SH = 320;
const SL = 52;
const SR = 740;
const ST = 22;
const SB = 262;
const M_LIMIT = 0.205;
const M_RANGE = 0.22;

function resolveContractIv(
  rows: readonly OptionChainRow[] | null,
  spot: number,
  k: number,
  days: number
): number {
  if (rows === null) return smileIv(spot, k, days);
  const row = rows.find((r) => Math.abs(r.strike - k) < 1e-6);
  if (!row) return Number.NaN;
  const primaryPct = k < spot ? row.putIV : row.callIV;
  if (Number.isFinite(primaryPct) && primaryPct > 0) return primaryPct / 100;
  const secondaryPct = k < spot ? row.callIV : row.putIV;
  if (Number.isFinite(secondaryPct) && secondaryPct > 0) return secondaryPct / 100;
  return Number.NaN;
}

const diagStyle = {
  Barata: { fg: '#00D592', bg: 'rgba(16,185,129,0.14)' },
  'En rango': { fg: '#94A3B8', bg: 'rgba(148,163,184,0.12)' },
  Cara: { fg: '#F59E0B', bg: 'rgba(245,158,11,0.14)' },
} as const;

function cellBg(p: number): string {
  if (!Number.isFinite(p)) return 'rgba(148,163,184,0.04)';
  if (p < 25) return `rgba(16,185,129,${(0.16 + ((25 - p) / 25) * 0.38).toFixed(2)})`;
  if (p > 75) return `rgba(245,158,11,${(0.16 + ((p - 75) / 25) * 0.38).toFixed(2)})`;
  return `rgba(148,163,184,${(0.05 + (Math.abs(p - 50) / 25) * 0.06).toFixed(2)})`;
}

export const VolatilitySurface: React.FC<{
  mkt: Market;
  expiries?: readonly OptionExpiryGroup[];
}> = ({ mkt, expiries }) => {
  const [visible, setVisible] = useState<boolean[]>([true, true, true]);
  const [hoverStrike, setHoverStrike] = useState<number | null>(null);
  const [hoverCell, setHoverCell] = useState<{ r: number; c: number } | null>(null);

  const term = useMemo(() => {
    if (expiries && expiries.length > 0) {
      return [...expiries]
        .sort((a, b) => a.daysToExpiry - b.daysToExpiry)
        .map((e) => ({
          days: e.daysToExpiry,
          label: e.id,
          atm: Number.isFinite(e.atmIV) && e.atmIV > 0 ? e.atmIV / 100 : Number.NaN,
          rows: e.rows as readonly OptionChainRow[] | null,
        }));
    }
    return TERM_STRUCTURE.map((t) => ({
      days: t.days,
      label: t.label,
      atm: t.atm,
      rows: null as readonly OptionChainRow[] | null,
    }));
  }, [expiries]);

  const strikes = useMemo(() => {
    if (!Number.isFinite(mkt.spot) || mkt.spot <= 0) return [];
    const unionSet = new Set<number>();
    let usedExpiryUnion = false;
    for (const t of term) {
      if (t.rows !== null && t.rows.length > 0) {
        usedExpiryUnion = true;
        for (const r of t.rows) {
          if (
            Number.isFinite(r.strike) &&
            Math.abs(r.strike / mkt.spot - 1) <= M_LIMIT &&
            ((Number.isFinite(r.callIV) && r.callIV > 0) || (Number.isFinite(r.putIV) && r.putIV > 0))
          ) {
            unionSet.add(r.strike);
          }
        }
      }
    }
    if (usedExpiryUnion && unionSet.size > 0) {
      return [...unionSet].sort((a, b) => a - b);
    }
    return mkt.strikes
      .filter((k) => Number.isFinite(k) && Math.abs(k / mkt.spot - 1) <= M_LIMIT)
      .sort((a, b) => a - b);
  }, [mkt.strikes, mkt.spot, term]);

  const rawSeries = useMemo(() => {
    if (!Number.isFinite(mkt.spot) || mkt.spot <= 0 || strikes.length === 0 || term.length === 0) {
      return [];
    }
    return term.map((t) =>
      strikes.map((k) => {
        const m = k / mkt.spot - 1;
        const iv = resolveContractIv(t.rows, mkt.spot, k, t.days);
        return { k, m, iv };
      })
    );
  }, [strikes, mkt.spot, term]);

  const isVisible = (idx: number): boolean => visible[idx] ?? true;

  const { ivMin, ivMax, yTicks } = useMemo(() => {
    const ivVals: number[] = [];
    rawSeries.forEach((row, idx) => {
      if (!(visible[idx] ?? true)) return;
      for (const pt of row) {
        if (Number.isFinite(pt.iv) && pt.iv > 0) ivVals.push(pt.iv);
      }
    });
    if (ivVals.length === 0) {
      for (const t of term) {
        if (Number.isFinite(t.atm) && t.atm > 0) ivVals.push(t.atm);
      }
    }
    if (Number.isFinite(HIST_MEDIAN_IV) && HIST_MEDIAN_IV > 0) {
      ivVals.push(HIST_MEDIAN_IV);
    }
    const minVal = ivVals.length > 0 ? Math.min(...ivVals) : 0.3;
    const maxVal = ivVals.length > 0 ? Math.max(...ivVals) : 0.7;
    const pad = Math.max(0.025, (maxVal - minVal) * 0.18);
    const lo = Math.max(0.01, Math.floor((minVal - pad) * 50) / 50);
    const hi = Math.ceil((maxVal + pad) * 50) / 50;
    const safeHi = hi > lo ? hi : lo + 0.1;
    const ticks: number[] = [];
    const steps = 6;
    for (let i = 0; i <= steps; i += 1) {
      ticks.push(lo + ((safeHi - lo) * i) / steps);
    }
    return { ivMin: lo, ivMax: safeHi, yTicks: ticks };
  }, [rawSeries, term, visible]);

  const mx = (m: number) => SL + ((m + M_RANGE) / (2 * M_RANGE)) * (SR - SL);
  const iy = (iv: number) => SB - ((iv - ivMin) / Math.max(1e-6, ivMax - ivMin)) * (SB - ST);

  const series = useMemo(
    () =>
      rawSeries.map((row) =>
        row
          .filter((pt) => Number.isFinite(pt.iv) && pt.iv > 0)
          .map((pt) => ({ ...pt, x: mx(pt.m), y: iy(pt.iv) }))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawSeries, ivMin, ivMax]
  );

  // Curva principal de lectura (vencimiento visible con mayor cobertura de bases en ±20%)
  const refCurveIdx = useMemo(() => {
    let bestIdx = 0;
    let bestLen = -1;
    series.forEach((s, idx) => {
      if ((visible[idx] ?? true) && s.length > bestLen) {
        bestLen = s.length;
        bestIdx = idx;
      }
    });
    if (bestLen <= 0) {
      series.forEach((s, idx) => {
        if (s.length > bestLen) {
          bestLen = s.length;
          bestIdx = idx;
        }
      });
    }
    return bestIdx;
  }, [series, visible]);

  const near = series[refCurveIdx] ?? [];
  const near0 = near[0];
  const hasSurfaceData =
    Number.isFinite(mkt.spot) &&
    mkt.spot > 0 &&
    strikes.length > 0 &&
    term.length > 0 &&
    near0 !== undefined &&
    near.length > 0;

  if (!hasSurfaceData || !near0) {
    return (
      <div className="rounded-[14px] bg-[var(--fx-panel)] border border-[var(--fx-line)] p-6 text-[13px] text-[#9CA3AF]">
        Esperando cotizaciones reales de opciones para construir la superficie de volatilidad de {mkt.ticker}.
      </div>
    );
  }

  // Lectura de skew sobre la curva líquida principal
  const atmPt = near.reduce((a, b) => (Math.abs(b.m) < Math.abs(a.m) ? b : a), near0);
  const otmCall = near.reduce((a, b) => (Math.abs(b.m - 0.1) < Math.abs(a.m - 0.1) ? b : a), near0);
  const otmPut = near.reduce((a, b) => (Math.abs(b.m + 0.1) < Math.abs(a.m + 0.1) ? b : a), near0);
  const callSkew = (otmCall.iv - atmPt.iv) * 100;
  const putSkew = (otmPut.iv - atmPt.iv) * 100;

  const validAtmTerms = term.filter((t) => Number.isFinite(t.atm) && t.atm > 0);
  const t0 = validAtmTerms[0];
  const t1 = validAtmTerms[1];
  const t2 = validAtmTerms[2];
  const spread1 = t0 && t1 ? (t1.atm - t0.atm) * 100 : Number.NaN;
  const spread2 = t1 && t2 ? (t2.atm - t1.atm) * 100 : Number.NaN;
  const regime = !Number.isFinite(spread1) ? '—' : spread1 >= 0 ? 'Contango' : 'Backwardation';

  const hoveredX = hoverStrike != null ? mx(hoverStrike / mkt.spot - 1) : null;
  const colorAt = (idx: number): string => EXP_COLORS[idx % EXP_COLORS.length] ?? '#38BDF8';
  const axisLabelStep = strikes.length > 12 ? Math.ceil(strikes.length / 10) : 1;
  const axisStrikes = strikes.filter((_, idx) => idx % axisLabelStep === 0 || idx === strikes.length - 1);

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
          <div className="flex items-center gap-1.5 flex-wrap">
            {term.map((t, i) => (
              <button
                key={`${t.days}-${i}`}
                type="button"
                onClick={() =>
                  setVisible((v) => {
                    const next = [...v];
                    while (next.length <= i) next.push(true);
                    next[i] = !(next[i] ?? true);
                    return next;
                  })
                }
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-[12px] font-bold cursor-pointer transition-all ${
                  isVisible(i)
                    ? 'border-[var(--fx-line-strong)] bg-[var(--fx-panel-2)] text-white'
                    : 'border-transparent text-[#6B7280]'
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: colorAt(i), opacity: isVisible(i) ? 1 : 0.3 }}
                />
                {t.label} · {t.days}d
              </button>
            ))}
          </div>
        </div>

        <div className="mx-5 mb-3 px-3.5 py-2 rounded-[10px] bg-[var(--fx-base-2)] border border-[var(--fx-line)] text-[12.5px] text-[#D1D4DC]">
          <span className="font-mono-num text-[10.5px] font-bold uppercase tracking-wider text-[var(--fx-target)] mr-2">
            Skew
          </span>
          Las bases OTM alcistas ({otmCall.m >= 0 ? '+' : ''}
          {fmtNum(otmCall.m * 100, 0)}% sobre spot) operan con{' '}
          <strong className="font-mono-num text-white">
            {Number.isFinite(callSkew) ? `${callSkew >= 0 ? '+' : ''}${fmtNum(callSkew, 1)} pts` : '—'}
          </strong>{' '}
          de VI sobre ATM; las OTM bajistas, con{' '}
          <strong className="font-mono-num text-white">
            {Number.isFinite(putSkew) ? `${putSkew >= 0 ? '+' : ''}${fmtNum(putSkew, 1)} pts` : '—'}
          </strong>
          .
        </div>

        <div className="relative px-2">
          <svg
            viewBox={`0 0 ${SW} ${SH}`}
            className="w-full h-auto select-none"
            onPointerMove={(e) => {
              if (strikes.length === 0) return;
              const svg = e.currentTarget;
              const pt = svg.createSVGPoint();
              pt.x = e.clientX;
              pt.y = e.clientY;
              const ctm = svg.getScreenCTM();
              if (!ctm) return;
              const p = pt.matrixTransform(ctm.inverse());
              if (p.x < SL - 10 || p.x > SR + 10) return setHoverStrike(null);
              let bestK: number | null = null;
              let bestDist = Infinity;
              for (const k of strikes) {
                const dist = Math.abs(mx(k / mkt.spot - 1) - p.x);
                if (dist < bestDist) {
                  bestDist = dist;
                  bestK = k;
                }
              }
              setHoverStrike(bestK);
            }}
            onPointerLeave={() => setHoverStrike(null)}
          >
            {yTicks.map((v, idx) => (
              <g key={idx}>
                <line x1={SL} y1={iy(v)} x2={SR} y2={iy(v)} stroke="rgba(255,255,255,0.05)" />
                <text x={SL - 8} y={iy(v) + 3.5} textAnchor="end" fill="#6B7280" fontSize="10.5" className="font-mono-num">
                  {fmtNum(v * 100, 0)}%
                </text>
              </g>
            ))}

            {/* Zona ATM */}
            <rect x={mx(-0.02)} y={ST} width={mx(0.02) - mx(-0.02)} height={SB - ST} fill="rgba(255,255,255,0.03)" />

            {/* Mediana histórica */}
            {Number.isFinite(HIST_MEDIAN_IV) && HIST_MEDIAN_IV >= ivMin && HIST_MEDIAN_IV <= ivMax && (
              <>
                <line
                  x1={SL}
                  y1={iy(HIST_MEDIAN_IV)}
                  x2={SR}
                  y2={iy(HIST_MEDIAN_IV)}
                  stroke="#94A3B8"
                  strokeDasharray="6 5"
                  strokeOpacity="0.7"
                />
                <rect
                  x={SL + 4}
                  y={iy(HIST_MEDIAN_IV) - 18}
                  width={158}
                  height={15}
                  rx={4}
                  fill="#090B0E"
                  fillOpacity="0.88"
                  stroke="#334155"
                  strokeWidth="0.6"
                />
                <text x={SL + 10} y={iy(HIST_MEDIAN_IV) - 7} textAnchor="start" fill="#CBD5E1" fontSize="10.5" fontWeight="600">
                  Mediana histórica {fmtNum(HIST_MEDIAN_IV * 100, 1)}%
                </text>
              </>
            )}

            {/* Curvas */}
            {series.map((s, i) => {
              const tItem = term[i];
              if (!isVisible(i) || !tItem || s.length === 0) return null;
              const strokeColor = colorAt(i);
              return (
                <g key={`${tItem.days}-${i}`}>
                  {s.length >= 2 && (
                    <motion.path
                      d={monotonePath(s)}
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth={i === refCurveIdx ? 2.6 : 2}
                      strokeDasharray={i === 2 ? '6 4' : undefined}
                      initial={{ pathLength: 0, opacity: 0 }}
                      animate={{ pathLength: 1, opacity: 1 }}
                      transition={{ duration: 0.9, ease: FX_EASE }}
                    />
                  )}
                  {s.map((q) => (
                    <g key={q.k}>
                      <circle
                        cx={q.x}
                        cy={q.y}
                        r={hoverStrike === q.k ? 5.5 : 3.8}
                        fill="#090B0E"
                        stroke={strokeColor}
                        strokeWidth="2"
                      />
                      {i === refCurveIdx && (s.length <= 14 || Math.abs(q.m) < 0.03 || hoverStrike === q.k) && (
                        <text x={q.x} y={q.y - 10} textAnchor="middle" fill="#E5E7EB" fontSize="10" className="font-mono-num">
                          {fmtNum(q.iv * 100, 1)}%
                        </text>
                      )}
                    </g>
                  ))}
                </g>
              );
            })}

            {hoveredX != null && (
              <line
                x1={hoveredX}
                y1={ST}
                x2={hoveredX}
                y2={SB}
                stroke="rgba(255,255,255,0.25)"
                strokeDasharray="2 3"
              />
            )}

            {/* Eje de moneyness (-20% a +20%) */}
            {[
              { m: -0.2, label: 'Deep OTM Put', sub: '−20%' },
              { m: -0.1, label: 'OTM Put', sub: '−10%' },
              { m: 0, label: 'ATM', sub: '0%' },
              { m: 0.1, label: 'OTM Call', sub: '+10%' },
              { m: 0.2, label: 'Deep OTM Call', sub: '+20%' },
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
            {axisStrikes.map((k) => (
              <text key={`k-${k}`} x={mx(k / mkt.spot - 1)} y={SB - 6} textAnchor="middle" fill="#4B5563" fontSize="9" className="font-mono-num">
                {fk(k)}
              </text>
            ))}
          </svg>

          <AnimatePresence>
            {hoverStrike != null && hoveredX != null && (
              <motion.div
                key="smile-tip"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.18, ease: FX_EASE }}
                className="pointer-events-none absolute top-3 z-10 px-3 py-2.5 rounded-[10px] bg-[rgba(13,17,23,0.94)] border border-[var(--fx-line-strong)] shadow-xl text-[12px] font-mono-num"
                style={
                  hoveredX > SW * 0.68
                    ? { right: `calc(${((SW - hoveredX) / SW) * 100}% + 12px)` }
                    : { left: `calc(${(hoveredX / SW) * 100}% + 12px)` }
                }
              >
                <div className="text-white font-bold mb-1">
                  Base {fk(hoverStrike)} · {fmtNum((hoverStrike / mkt.spot - 1) * 100, 1)}%
                </div>
                {series.map((s, i) => {
                  const pt = s.find((q) => Math.abs(q.k - hoverStrike) < 1e-6);
                  const tItem = term[i];
                  if (!isVisible(i) || !pt || !tItem) return null;
                  return (
                    <div key={i} className="flex items-center justify-between gap-4">
                      <span className="flex items-center gap-1.5 text-[#9CA3AF]">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colorAt(i) }} />
                        {tItem.label} {tItem.days}d
                      </span>
                      <span className="text-white font-bold">{fmtNum(pt.iv * 100, 1)}%</span>
                    </div>
                  );
                })}
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
                  {term.map((t, idx) => (
                    <th key={`${t.days}-${idx}`} className="py-1.5 px-2 text-center">
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
                    const iv = resolveContractIv(t.rows, mkt.spot, k, t.days);
                    const p = Number.isFinite(iv) ? ivPercentile(iv) : Number.NaN;
                    return { iv, p };
                  });
                  const finiteCells = cells.filter((c) => Number.isFinite(c.p));
                  const avg =
                    finiteCells.length > 0
                      ? Math.round(finiteCells.reduce((a, c) => a + c.p, 0) / finiteCells.length)
                      : Number.NaN;
                  const d = Number.isFinite(avg) ? diagnose(avg) : null;
                  const isAtm =
                    Number.isFinite(mkt.step) && mkt.step > 0
                      ? Math.abs(m) < mkt.step / mkt.spot / 2 + 0.005
                      : Math.abs(m) < 0.015;
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
                        const tCell = term[ci];
                        const cellDiag = Number.isFinite(c.p) ? diagnose(c.p) : null;
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
                              <span className="font-bold text-white">
                                {Number.isFinite(c.iv) ? `${fmtNum(c.iv * 100, 1)}%` : '—'}
                              </span>
                              <span className="ml-1.5 text-[10.5px] text-[#D1D4DC]/70">
                                {Number.isFinite(c.p) ? `P${c.p}` : ''}
                              </span>
                              <AnimatePresence>
                                {on && tCell && Number.isFinite(c.iv) && (
                                  <motion.div
                                    initial={{ opacity: 0, scale: 0.98, y: 4 }}
                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                    exit={{ opacity: 0, scale: 0.98 }}
                                    transition={{ duration: 0.18, ease: FX_EASE }}
                                    className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-20 w-max px-3 py-2 rounded-[10px] bg-[rgba(13,17,23,0.94)] border border-[var(--fx-line-strong)] text-left text-[11.5px] shadow-xl"
                                  >
                                    <div className="text-white font-bold">
                                      Base {fk(k)} · {tCell.label} {tCell.days}d
                                    </div>
                                    <div className="text-[#9CA3AF]">
                                      VI {fmtNum(c.iv * 100, 2)}%
                                      {Number.isFinite(c.p) ? ` · percentil ${c.p}` : ''}
                                    </div>
                                    {cellDiag && (
                                      <div style={{ color: diagStyle[cellDiag].fg }} className="font-bold">
                                        {cellDiag}
                                      </div>
                                    )}
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </motion.div>
                          </td>
                        );
                      })}
                      <td className="py-1.5 px-2">
                        {d && Number.isFinite(avg) ? (
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
                        ) : (
                          <span className="text-[#6B7280]">—</span>
                        )}
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

          <div className="flex items-baseline gap-2.5 flex-wrap">
            <span
              className={`text-[24px] font-extrabold ${
                !Number.isFinite(spread1)
                  ? 'text-[#9CA3AF]'
                  : spread1 >= 0
                    ? 'text-[var(--fx-target)]'
                    : 'text-[var(--fx-be)]'
              }`}
            >
              {regime}
            </span>
            <span className="font-mono-num text-[15px] font-bold text-white">
              {Number.isFinite(spread1) && t0 && t1
                ? `${spread1 >= 0 ? '+' : ''}${fmtNum(spread1, 1)} pts ${t1.label}/${t0.label}`
                : '—'}
            </span>
          </div>

          <svg viewBox="0 0 300 140" className="w-full h-[140px]">
            {(() => {
              const validTerm = term.filter((t) => Number.isFinite(t.atm) && t.atm > 0);
              const firstT = validTerm[0];
              const lastT = validTerm[validTerm.length - 1];
              if (!firstT || !lastT) return null;
              const daySpan = lastT.days - firstT.days;
              const x = (d: number) =>
                validTerm.length === 1 || daySpan <= 0 ? 150 : 24 + ((d - firstT.days) / daySpan) * 252;
              const atmVals = validTerm.map((t) => t.atm);
              if (Number.isFinite(HIST_MEDIAN_IV) && HIST_MEDIAN_IV > 0) atmVals.push(HIST_MEDIAN_IV);
              const tsMinRaw = Math.min(...atmVals);
              const tsMaxRaw = Math.max(...atmVals);
              const tsPad = Math.max(0.02, (tsMaxRaw - tsMinRaw) * 0.25);
              const tsLo = Math.max(0.01, tsMinRaw - tsPad);
              const tsHi = tsMaxRaw + tsPad;
              const y = (v: number) => 116 - ((v - tsLo) / Math.max(1e-6, tsHi - tsLo)) * 96;
              const line = validTerm.map((t) => `${x(t.days)},${y(t.atm)}`).join(' ');
              const startX = x(firstT.days);
              const endX = x(lastT.days);
              return (
                <>
                  {Number.isFinite(HIST_MEDIAN_IV) && (
                    <line
                      x1="24"
                      y1={y(HIST_MEDIAN_IV)}
                      x2="276"
                      y2={y(HIST_MEDIAN_IV)}
                      stroke="#94A3B8"
                      strokeDasharray="5 4"
                      strokeOpacity="0.6"
                    />
                  )}
                  {validTerm.length >= 2 && (
                    <>
                      <polygon points={`${startX},116 ${line} ${endX},116`} fill="#38BDF8" fillOpacity="0.08" />
                      <motion.polyline
                        points={line}
                        fill="none"
                        stroke="#38BDF8"
                        strokeWidth="2.4"
                        initial={{ pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={{ duration: 0.8, ease: FX_EASE }}
                      />
                    </>
                  )}
                  {validTerm.map((t, i) => (
                    <g key={`${t.days}-${i}`}>
                      <circle cx={x(t.days)} cy={y(t.atm)} r="4.5" fill="#090B0E" stroke={colorAt(i)} strokeWidth="2" />
                      <text
                        x={x(t.days)}
                        y={y(t.atm) - 10}
                        textAnchor="middle"
                        fill="#FFFFFF"
                        fontSize="11"
                        fontWeight="700"
                        className="font-mono-num"
                      >
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
            {computeForwardIvTermStructure(
              term
                .filter((t) => Number.isFinite(t.days) && t.days > 0 && Number.isFinite(t.atm) && t.atm > 0)
                .map((t) => ({
                  expiryCode: t.label,
                  dte: Math.round(t.days),
                  timeToExpiry: t.days / 365,
                  atmIv: t.atm,
                })),
            ).map((seg) => {
              const spreadPts = Number.isFinite(seg.farIv) && Number.isFinite(seg.nearIv)
                ? (seg.farIv - seg.nearIv) * 100
                : Number.NaN;
              const fwdPct = seg.forwardIv !== null && Number.isFinite(seg.forwardIv)
                ? seg.forwardIv * 100
                : null;
              return (
                <div
                  key={`${seg.nearExpiryCode ?? 'N'}-${seg.farExpiryCode ?? 'F'}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] bg-[var(--fx-base-2)] border border-[var(--fx-line)] px-3 py-2"
                >
                  <div className="flex flex-col">
                    <span className="text-[#D1D5DB] font-medium">
                      {seg.nearExpiryCode ?? 'T1'} → {seg.farExpiryCode ?? 'T2'}
                    </span>
                    <span className="text-[11px] font-mono-num text-[#9CA3AF]">
                      Spread:{' '}
                      <strong
                        className={
                          !Number.isFinite(spreadPts)
                            ? 'text-[#9CA3AF]'
                            : spreadPts >= 0
                              ? 'text-[var(--fx-target)]'
                              : 'text-[var(--fx-be)]'
                        }
                      >
                        {Number.isFinite(spreadPts) ? `${spreadPts >= 0 ? '+' : ''}${fmtNum(spreadPts, 1)} pts` : '—'}
                      </strong>
                    </span>
                  </div>
                  <div className="text-right font-mono-num">
                    {seg.calendarArbFlag ? (
                      <span className="inline-block px-2 py-0.5 rounded border border-rose-500/40 bg-rose-500/15 text-[10.5px] font-bold text-rose-300">
                        Arb. Calendario (σ²T↓)
                      </span>
                    ) : fwdPct !== null ? (
                      <div className="flex flex-col items-end">
                        <span className="text-[10px] uppercase tracking-wider text-[#6B7280]">Fwd IV</span>
                        <span className="text-[13px] font-bold text-[#38BDF8]">{fmtNum(fwdPct, 1)}%</span>
                      </div>
                    ) : (
                      <span className="text-[#9CA3AF]">—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[12px] leading-relaxed text-[#9CA3AF]">
            {!Number.isFinite(spread1)
              ? 'Se necesitan al menos dos vencimientos con VI ATM válida para medir la pendiente temporal.'
              : spread1 >= 0
                ? 'La curva está en contango suave: los plazos largos pagan más VI. Vender el corto y comprar el largo (calendario) cobra esa pendiente.'
                : 'La curva está invertida: el mercado paga más por cobertura inmediata. Señal de estrés de corto plazo.'}
          </p>
        </div>
      </div>
    </div>
  );
};
