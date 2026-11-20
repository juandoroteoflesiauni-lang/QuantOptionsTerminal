import React, { useId, useMemo, useState } from 'react';
import {
  evaluateWhatIfPoint,
  simulateWhatIfPayoffSurface,
  type WhatIfCurvePoint,
  type WhatIfOptionLeg,
} from '../../../../src/core/options/whatIfPayoff';
import {
  findBreakevens,
  formatBreakevenLabel,
  hoursToCloseEt,
  timeYearsFromHours,
} from '../../../../src/core/options/zeroDteFixes';

export interface WhatIfPayoffSimulatorProps {
  readonly structureLabel: string;
  readonly spot: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly horizonDte: number;
  readonly legs: readonly WhatIfOptionLeg[];
  readonly currencyPrefix?: '$' | 'US$';
  readonly contractMultiplier?: number;
  readonly contracts?: number;
  readonly callWallStrike?: number | null;
  readonly putWallStrike?: number | null;
  readonly zeroGammaSpot?: number | null;
  readonly breakevens?: readonly number[];
  /** Pieza 46.1: dte === 0 (calendario ET) -> slider en Horas restantes hasta 16:00 ET. */
  readonly zeroDte?: boolean;
}

function fmtSignedMoney(value: number, prefix: string): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0.005 ? '+' : value < -0.005 ? '-' : '';
  return `${sign}${prefix}${Math.abs(value).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtStrike(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return value >= 100
    ? value.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : value.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function fmtGreek(value: number, decimals = 2, suffix = ''): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 1e-6 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}${suffix}`;
}

function pnlToneClass(value: number): string {
  if (!Number.isFinite(value)) return 'text-slate-400';
  if (value > 0.01) return 'text-emerald-400';
  if (value < -0.01) return 'text-rose-400';
  return 'text-slate-200';
}

export const WhatIfPayoffSimulator: React.FC<WhatIfPayoffSimulatorProps> = ({
  structureLabel,
  spot,
  rate,
  dividendYield,
  horizonDte,
  legs,
  currencyPrefix = 'US$',
  contractMultiplier = 100,
  contracts = 1,
  callWallStrike = null,
  putWallStrike = null,
  zeroGammaSpot = null,
  breakevens = [],
  zeroDte = false,
}) => {
  // 0DTE: horizonte en horas reales hasta el cierre (16:00 ET), mínimo 0.25 h.
  const [startHours] = useState<number>(() => {
    const h = hoursToCloseEt(Date.now());
    return Math.max(0.25, Number.isFinite(h) && h > 0 ? h : 0.25);
  });
  const safeMaxDte = zeroDte
    ? startHours / 24
    : Math.max(1, Math.round(Number.isFinite(horizonDte) && horizonDte > 0 ? horizonDte : 1));
  const [hoursRemainingRaw, setHoursRemainingRaw] = useState<number>(() => startHours);
  const [ivShiftPts, setIvShiftPts] = useState<number>(0);
  const [elapsedDaysRaw, setElapsedDaysRaw] = useState<number>(() => Math.max(0, Math.round(safeMaxDte * 0.45)));
  const [hoveredSpot, setHoveredSpot] = useState<number | null>(null);
  const clipId = useId().replace(/:/g, '_');

  const hoursRemaining = Math.min(Math.max(0, hoursRemainingRaw), startHours);
  const elapsedDays = zeroDte
    ? (startHours - hoursRemaining) / 24
    : Math.min(Math.max(0, elapsedDaysRaw), safeMaxDte);

  // En 0DTE, alinear patas frontales a `startHours / (365 * 24)` para que T+n evalúe
  // exactamente en `T = hoursRemaining / (365 * 24)`.
  const effectiveLegs = useMemo(() => {
    if (!zeroDte) return legs;
    const t0Hours = timeYearsFromHours(startHours);
    return legs.map((leg) =>
      leg.timeToExpiry <= 1.01 / 365 ? { ...leg, timeToExpiry: t0Hours } : leg,
    );
  }, [zeroDte, legs, startHours]);

  const surface = useMemo(
    () =>
      simulateWhatIfPayoffSurface({
        referenceSpot: spot,
        legs: effectiveLegs,
        rate,
        dividendYield,
        ivShiftPts,
        elapsedDays,
        horizonDte: safeMaxDte,
        contracts,
        contractMultiplier,
        gridSteps: 85,
        extraSpots: [
          ...effectiveLegs.map((l) => l.strike),
          ...(callWallStrike !== null && callWallStrike > 0 ? [callWallStrike] : []),
          ...(putWallStrike !== null && putWallStrike > 0 ? [putWallStrike] : []),
          ...(zeroGammaSpot !== null && zeroGammaSpot > 0 ? [zeroGammaSpot] : []),
          ...breakevens.filter((b) => Number.isFinite(b) && b > 0),
        ],
      }),
    [
      spot,
      effectiveLegs,
      rate,
      dividendYield,
      ivShiftPts,
      elapsedDays,
      safeMaxDte,
      contracts,
      contractMultiplier,
      callWallStrike,
      putWallStrike,
      zeroGammaSpot,
      breakevens,
    ],
  );

  const activePoint = useMemo(() => {
    if (hoveredSpot === null || !Number.isFinite(hoveredSpot) || hoveredSpot <= 0) {
      return surface.atSpot;
    }
    return evaluateWhatIfPoint({
      spot: hoveredSpot,
      legs: effectiveLegs,
      rate,
      dividendYield,
      ivShiftPts,
      elapsedDays,
      horizonDte: safeMaxDte,
      contracts,
      contractMultiplier,
    });
  }, [
    hoveredSpot,
    surface.atSpot,
    effectiveLegs,
    rate,
    dividendYield,
    ivShiftPts,
    elapsedDays,
    safeMaxDte,
    contracts,
    contractMultiplier,
  ]);

  const chartMetrics = useMemo(() => {
    const pts = surface.curve;
    if (pts.length < 2) return null;
    const width = 620;
    const height = 220;
    const padL = 54;
    const padR = 16;
    const padT = 16;
    const padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const minX = pts[0]!.spot;
    const maxX = pts[pts.length - 1]!.spot;
    const xSpan = Math.max(1e-6, maxX - minX);

    let minY = 0;
    let maxY = 0;
    for (const p of pts) {
      minY = Math.min(minY, p.pnlT0, p.pnlTn, p.pnlExpiry);
      maxY = Math.max(maxY, p.pnlT0, p.pnlTn, p.pnlExpiry);
    }
    const yRangeRaw = Math.max(10, maxY - minY);
    const yPad = yRangeRaw * 0.12;
    const yLo = minY - yPad;
    const yHi = maxY + yPad;
    const ySpan = Math.max(1e-6, yHi - yLo);

    const toX = (s: number): number => padL + ((s - minX) / xSpan) * plotW;
    const toY = (v: number): number => padT + plotH - ((v - yLo) / ySpan) * plotH;

    const buildPath = (pick: (p: WhatIfCurvePoint) => number): string =>
      pts
        .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${toX(p.spot).toFixed(2)},${toY(pick(p)).toFixed(2)}`)
        .join(' ');

    const yZero = toY(0);
    return {
      width,
      height,
      padL,
      padR,
      padT,
      padB,
      plotW,
      plotH,
      minX,
      maxX,
      yLo,
      yHi,
      yZero,
      toX,
      toY,
      pathT0: buildPath((p) => p.pnlT0),
      pathTn: buildPath((p) => p.pnlTn),
      pathExpiry: buildPath((p) => p.pnlExpiry),
    };
  }, [surface.curve]);

  const breakevenLevels = useMemo(
    () =>
      findBreakevens(
        surface.curve.map((p) => p.spot),
        surface.curve.map((p) => p.pnlExpiry),
      ),
    [surface.curve],
  );

  const handleMouseMove = (evt: React.MouseEvent<SVGSVGElement>): void => {
    if (!chartMetrics || surface.curve.length === 0) return;
    const rect = evt.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((evt.clientX - rect.left) / rect.width) * chartMetrics.width;
    const clampedX = Math.max(
      chartMetrics.padL,
      Math.min(chartMetrics.padL + chartMetrics.plotW, svgX),
    );
    const ratio = (clampedX - chartMetrics.padL) / chartMetrics.plotW;
    const approxSpot = chartMetrics.minX + ratio * (chartMetrics.maxX - chartMetrics.minX);
    let bestSpot = surface.curve[0]!.spot;
    let bestDist = Infinity;
    for (const pt of surface.curve) {
      const dist = Math.abs(pt.spot - approxSpot);
      if (dist < bestDist) {
        bestDist = dist;
        bestSpot = pt.spot;
      }
    }
    setHoveredSpot(bestSpot);
  };

  if (legs.length === 0 || !Number.isFinite(spot) || spot <= 0) {
    return (
      <div className="rounded-lg border border-slate-800/80 bg-[#0B0F17] p-3 text-xs text-slate-400">
        Simulador What-If sin patas evaluables (<span className="font-mono text-slate-300">—</span>).
      </div>
    );
  }

  const activeSpotDisplay = Number.isFinite(activePoint.spot) ? activePoint.spot : spot;
  const remainingDteTn = Math.max(0, safeMaxDte - elapsedDays);

  return (
    <div className="space-y-3 rounded-lg border border-slate-800/90 bg-[#090D14] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/70 pb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
              Simulador Payoff What-If · BSM
            </span>
            <span className="rounded bg-slate-800/90 px-1.5 py-0.5 text-[10px] font-mono text-slate-300">
              {structureLabel}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] text-slate-400">
            3 curvas simultáneas ({String(contracts)}× contrato = {String(contractMultiplier)} acc/u) · Costo neto:{' '}
            <span className="font-mono text-slate-200">
              {fmtSignedMoney(surface.netEntryDebitUsd, currencyPrefix)}
            </span>{' '}
            ({surface.netEntryDebitPerUnit >= 0 ? 'Débito' : 'Crédito'})
          </p>
        </div>

        <div className="flex items-center gap-1.5 text-[10px]">
          {([-15, 0, 15] as const).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setIvShiftPts(preset)}
              className={`rounded px-2 py-0.5 font-mono transition ${
                ivShiftPts === preset
                  ? 'border border-cyan-500/60 bg-cyan-500/20 text-cyan-200'
                  : 'border border-slate-700/70 bg-slate-900/70 text-slate-400 hover:text-slate-200'
              }`}
            >
              ΔIV {preset > 0 ? `+${String(preset)}` : String(preset)}p
            </button>
          ))}
        </div>
      </div>

      {/* Controles reactivos: ΔIV (-30 a +30 pts) y T+n (0 a DTE) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded border border-slate-800/80 bg-[#0D131D] px-3 py-2">
          <div className="flex items-center justify-between text-[11px]">
            <label htmlFor={`${clipId}_iv`} className="font-medium text-slate-300">
              Shock Volatilidad (ΔIV)
            </label>
            <span
              className={`font-mono font-semibold ${
                ivShiftPts < 0
                  ? 'text-amber-300'
                  : ivShiftPts > 0
                    ? 'text-cyan-300'
                    : 'text-slate-200'
              }`}
            >
              {ivShiftPts > 0 ? `+${String(ivShiftPts)}` : String(ivShiftPts)} pts IV
            </span>
          </div>
          <input
            id={`${clipId}_iv`}
            type="range"
            min={-30}
            max={30}
            step={1}
            value={ivShiftPts}
            onChange={(e) => setIvShiftPts(Number(e.target.value))}
            className="mt-1.5 w-full accent-cyan-400"
          />
          <div className="mt-0.5 flex justify-between text-[9px] font-mono text-slate-500">
            <span>-30 pts (IV Crush)</span>
            <span>0</span>
            <span>+30 pts (Expansión)</span>
          </div>
        </div>

        <div className="rounded border border-slate-800/80 bg-[#0D131D] px-3 py-2">
          <div className="flex items-center justify-between text-[11px]">
            <label htmlFor={`${clipId}_days`} className="font-medium text-slate-300">
              {zeroDte ? 'Horas restantes' : 'Días transcurridos (T+n)'}
            </label>
            <span className="font-mono font-semibold text-amber-300">
              {zeroDte
                ? `${hoursRemaining.toFixed(2)} h (0DTE · cierre 16:00 ET)`
                : `T+${String(elapsedDays)}d (restan ${String(remainingDteTn)}d)`}
            </span>
          </div>
          {zeroDte ? (
            <>
              <input
                id={`${clipId}_days`}
                type="range"
                min={0}
                max={startHours}
                step={0.25}
                value={hoursRemaining}
                onChange={(e) => setHoursRemainingRaw(Number(e.target.value))}
                className="mt-1.5 w-full accent-amber-400"
              />
              <div className="mt-0.5 flex justify-between text-[9px] font-mono text-slate-500">
                <span>0 h (Vto)</span>
                <span>{(startHours / 2).toFixed(2)} h</span>
                <span>{startHours.toFixed(2)} h (Ahora)</span>
              </div>
            </>
          ) : (
            <>
              <input
                id={`${clipId}_days`}
                type="range"
                min={0}
                max={safeMaxDte}
                step={1}
                value={elapsedDays}
                onChange={(e) => setElapsedDaysRaw(Number(e.target.value))}
                className="mt-1.5 w-full accent-amber-400"
              />
              <div className="mt-0.5 flex justify-between text-[9px] font-mono text-slate-500">
                <span>T+0 (Hoy)</span>
                <span>T+{String(Math.round(safeMaxDte / 2))}d</span>
                <span>Vto ({String(safeMaxDte)}d)</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* KPIs en punto activo (Spot actual o hover) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded border border-slate-800/80 bg-[#0D131D] px-2.5 py-1.5">
          <div className="text-[10px] text-slate-400">
            Spot {hoveredSpot !== null ? 'Cursor' : 'Actual'}
          </div>
          <div className="font-mono text-xs font-semibold text-slate-100">
            {fmtStrike(activeSpotDisplay)}
          </div>
          <div className="text-[9px] font-mono text-slate-500">
            T+0: <span className={pnlToneClass(activePoint.pnlT0)}>{fmtSignedMoney(activePoint.pnlT0, currencyPrefix)}</span>
          </div>
        </div>

        <div className="rounded border border-cyan-500/30 bg-[#0D131D] px-2.5 py-1.5">
          <div className="text-[10px] text-cyan-300/90">
            P&amp;L {zeroDte ? `${hoursRemaining.toFixed(2)}h` : `T+${String(elapsedDays)}`} ({ivShiftPts >= 0 ? `+${String(ivShiftPts)}` : String(ivShiftPts)}p IV)
          </div>
          <div className={`font-mono text-xs font-semibold ${pnlToneClass(activePoint.pnlTn)}`}>
            {fmtSignedMoney(activePoint.pnlTn, currencyPrefix)}
          </div>
          <div className="text-[9px] font-mono text-slate-500">
            Vto:{' '}
            <span className={pnlToneClass(activePoint.pnlExpiry)}>
              {fmtSignedMoney(activePoint.pnlExpiry, currencyPrefix)}
            </span>
          </div>
        </div>

        <div className="rounded border border-slate-800/80 bg-[#0D131D] px-2.5 py-1.5">
          <div className="text-[10px] text-slate-400">Atribución IV Shock</div>
          <div
            className={`font-mono text-xs font-semibold ${pnlToneClass(
              activePoint.ivShockPnlAttribution,
            )}`}
          >
            {fmtSignedMoney(activePoint.ivShockPnlAttribution, currencyPrefix)}
          </div>
          <div className="text-[9px] font-mono text-slate-500">
            Theta decay: {fmtSignedMoney(activePoint.timeDecayPnlAttribution, currencyPrefix)}
          </div>
        </div>

        <div className="rounded border border-slate-800/80 bg-[#0D131D] px-2.5 py-1.5">
          <div className="text-[10px] text-slate-400">Griegas Proy. (T+{String(elapsedDays)})</div>
          <div className="mt-0.5 grid grid-cols-2 gap-x-2 text-[10px] font-mono">
            <span className="text-slate-300">Δ {fmtGreek(activePoint.greeksTn.deltaShares, 1)}</span>
            <span className="text-slate-300">Γ {fmtGreek(activePoint.greeksTn.gammaShares, 2)}</span>
            <span className="text-emerald-300">Θ {fmtSignedMoney(activePoint.greeksTn.thetaDailyUsd, currencyPrefix)}</span>
            <span className="text-cyan-300">ν {fmtSignedMoney(activePoint.greeksTn.vegaPer1PctUsd, currencyPrefix)}</span>
          </div>
        </div>
      </div>

      {/* Gráfico SVG interactivo de 3 curvas */}
      {chartMetrics ? (
        <div className="relative rounded border border-slate-800/80 bg-[#06090F] p-2">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px]">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-slate-300">
                <span className="h-0.5 w-3.5 rounded bg-sky-400" />
                T+0 (Hoy)
              </span>
              <span className="inline-flex items-center gap-1.5 text-amber-300">
                <span className="h-0.5 w-3.5 rounded bg-amber-400" />
                T+{String(elapsedDays)} ({ivShiftPts >= 0 ? `+${String(ivShiftPts)}` : String(ivShiftPts)} pts IV)
              </span>
              <span className="inline-flex items-center gap-1.5 text-emerald-300">
                <span className="h-0.5 w-3.5 border-b border-dashed border-emerald-400" />
                Vencimiento
              </span>
            </div>
            {activePoint.ivClampedLegs > 0 && (
              <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-300">
                Piso IV 0.5% aplicado en {String(activePoint.ivClampedLegs)} pata(s)
              </span>
            )}
          </div>

          <svg
            viewBox={`0 0 ${String(chartMetrics.width)} ${String(chartMetrics.height)}`}
            className="h-52 w-full select-none overflow-visible"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoveredSpot(null)}
          >
            <defs>
              <clipPath id={clipId}>
                <rect
                  x={chartMetrics.padL}
                  y={chartMetrics.padT}
                  width={chartMetrics.plotW}
                  height={chartMetrics.plotH}
                />
              </clipPath>
            </defs>

            {/* Línea P&L = 0 */}
            <line
              x1={chartMetrics.padL}
              y1={chartMetrics.yZero}
              x2={chartMetrics.padL + chartMetrics.plotW}
              y2={chartMetrics.yZero}
              stroke="#475569"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <text
              x={chartMetrics.padL - 5}
              y={chartMetrics.yZero + 3}
              textAnchor="end"
              fill="#94a3b8"
              fontSize="9"
              fontFamily="monospace"
            >
              0
            </text>
            <text
              x={chartMetrics.padL - 5}
              y={chartMetrics.padT + 8}
              textAnchor="end"
              fill="#34d399"
              fontSize="9"
              fontFamily="monospace"
            >
              {fmtSignedMoney(chartMetrics.yHi, currencyPrefix)}
            </text>
            <text
              x={chartMetrics.padL - 5}
              y={chartMetrics.padT + chartMetrics.plotH}
              textAnchor="end"
              fill="#fb7185"
              fontSize="9"
              fontFamily="monospace"
            >
              {fmtSignedMoney(chartMetrics.yLo, currencyPrefix)}
            </text>

            {/* Niveles estructurales opcionales (Spot, Call Wall, Put Wall, Zero Gamma) */}
            <line
              x1={chartMetrics.toX(spot)}
              y1={chartMetrics.padT}
              x2={chartMetrics.toX(spot)}
              y2={chartMetrics.padT + chartMetrics.plotH}
              stroke="#e2e8f0"
              strokeOpacity={0.45}
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            {callWallStrike !== null &&
              callWallStrike >= chartMetrics.minX &&
              callWallStrike <= chartMetrics.maxX && (
                <line
                  x1={chartMetrics.toX(callWallStrike)}
                  y1={chartMetrics.padT}
                  x2={chartMetrics.toX(callWallStrike)}
                  y2={chartMetrics.padT + chartMetrics.plotH}
                  stroke="#f43f5e"
                  strokeOpacity={0.35}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
              )}
            {putWallStrike !== null &&
              putWallStrike >= chartMetrics.minX &&
              putWallStrike <= chartMetrics.maxX && (
                <line
                  x1={chartMetrics.toX(putWallStrike)}
                  y1={chartMetrics.padT}
                  x2={chartMetrics.toX(putWallStrike)}
                  y2={chartMetrics.padT + chartMetrics.plotH}
                  stroke="#10b981"
                  strokeOpacity={0.35}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
              )}

            {/* Breakevens al vencimiento (cruces por cero) */}
            {breakevenLevels.map((be, idx) => {
              if (be < chartMetrics.minX || be > chartMetrics.maxX) return null;
              const xPos = chartMetrics.toX(be);
              const nearRight = xPos > chartMetrics.padL + chartMetrics.plotW - 72;
              return (
                <g key={`be-${be.toFixed(4)}`}>
                  <line
                    x1={xPos}
                    y1={chartMetrics.padT}
                    x2={xPos}
                    y2={chartMetrics.padT + chartMetrics.plotH}
                    stroke="#f59e0b"
                    strokeWidth={1.2}
                    strokeDasharray="3 3"
                  />
                  <text
                    x={nearRight ? xPos - 3 : xPos + 3}
                    y={chartMetrics.padT + (idx % 2 === 0 ? 10 : 21)}
                    textAnchor={nearRight ? 'end' : 'start'}
                    fill="#f59e0b"
                    fontSize="9"
                    fontFamily="monospace"
                  >
                    {formatBreakevenLabel(be)}
                  </text>
                </g>
              );
            })}

            {/* 3 Curvas simultáneas */}
            <g clipPath={`url(#${clipId})`}>
              <path
                d={chartMetrics.pathExpiry}
                fill="none"
                stroke="#10b981"
                strokeWidth={1.6}
                strokeDasharray="5 3"
              />
              <path
                d={chartMetrics.pathT0}
                fill="none"
                stroke="#38bdf8"
                strokeWidth={1.7}
                strokeOpacity={0.9}
              />
              <path d={chartMetrics.pathTn} fill="none" stroke="#fbbf24" strokeWidth={2.2} />
            </g>

            {/* Marcador cursor / spot */}
            {Number.isFinite(activeSpotDisplay) &&
              activeSpotDisplay >= chartMetrics.minX &&
              activeSpotDisplay <= chartMetrics.maxX && (
                <g>
                  <line
                    x1={chartMetrics.toX(activeSpotDisplay)}
                    y1={chartMetrics.padT}
                    x2={chartMetrics.toX(activeSpotDisplay)}
                    y2={chartMetrics.padT + chartMetrics.plotH}
                    stroke="#22d3ee"
                    strokeWidth={1}
                    strokeOpacity={0.7}
                  />
                  {Number.isFinite(activePoint.pnlT0) && (
                    <circle
                      cx={chartMetrics.toX(activeSpotDisplay)}
                      cy={chartMetrics.toY(activePoint.pnlT0)}
                      r={3}
                      fill="#38bdf8"
                    />
                  )}
                  {Number.isFinite(activePoint.pnlTn) && (
                    <circle
                      cx={chartMetrics.toX(activeSpotDisplay)}
                      cy={chartMetrics.toY(activePoint.pnlTn)}
                      r={3.8}
                      fill="#fbbf24"
                      stroke="#090D14"
                      strokeWidth={1}
                    />
                  )}
                  {Number.isFinite(activePoint.pnlExpiry) && (
                    <circle
                      cx={chartMetrics.toX(activeSpotDisplay)}
                      cy={chartMetrics.toY(activePoint.pnlExpiry)}
                      r={3}
                      fill="#10b981"
                    />
                  )}
                </g>
              )}

            {/* Etiquetas eje X */}
            <text
              x={chartMetrics.padL}
              y={chartMetrics.height - 6}
              textAnchor="start"
              fill="#64748b"
              fontSize="9"
              fontFamily="monospace"
            >
              {fmtStrike(chartMetrics.minX)}
            </text>
            <text
              x={chartMetrics.toX(spot)}
              y={chartMetrics.height - 6}
              textAnchor="middle"
              fill="#e2e8f0"
              fontSize="9"
              fontFamily="monospace"
            >
              Spot {fmtStrike(spot)}
            </text>
            <text
              x={chartMetrics.padL + chartMetrics.plotW}
              y={chartMetrics.height - 6}
              textAnchor="end"
              fill="#64748b"
              fontSize="9"
              fontFamily="monospace"
            >
              {fmtStrike(chartMetrics.maxX)}
            </text>
          </svg>
        </div>
      ) : (
        <div className="rounded border border-slate-800/80 bg-[#06090F] p-3 text-center text-xs text-slate-400">
          Curva What-If no calculable (—).
        </div>
      )}
    </div>
  );
};
