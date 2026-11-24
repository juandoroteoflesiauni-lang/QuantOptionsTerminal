import React, { memo, useId, useMemo, useState } from 'react';
import {
  buildWhatIfHeatmapAndAttribution,
  evaluateWhatIfPoint,
  simulateWhatIfPayoffSurface,
  WHAT_IF_HEATMAP_IV_SHIFT_STEPS,
  WHAT_IF_HEATMAP_SIGMA_STEPS,
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

// Pieza 50: formato compacto con signo para celdas de la matriz 7×7.
function fmtCompactSigned(value: number, prefix: string): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${sign}${prefix}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${prefix}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${prefix}${abs.toFixed(0)}`;
}

// Intensidad relativa respecto a max(|min|, |max|): verde P&L > 0, rojo P&L < 0.
function heatmapCellStyle(pnlUsd: number, maxAbs: number): React.CSSProperties {
  if (!Number.isFinite(pnlUsd) || !Number.isFinite(maxAbs) || maxAbs <= 0) {
    return { backgroundColor: 'rgba(107, 114, 128, 0.12)' };
  }
  const ratio = Math.min(1, Math.abs(pnlUsd) / maxAbs);
  const alpha = 0.12 + 0.58 * ratio;
  return {
    backgroundColor:
      pnlUsd >= 0
        ? `rgba(16, 185, 129, ${alpha.toFixed(3)})`
        : `rgba(244, 63, 94, ${alpha.toFixed(3)})`,
  };
}

export const WhatIfPayoffSimulator = memo(function WhatIfPayoffSimulator({
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
}: WhatIfPayoffSimulatorProps) {
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
  const [viewMode, setViewMode] = useState<'curves' | 'heatmap'>('curves');
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [hoveredCell, setHoveredCell] = useState<{ row: number; col: number } | null>(null);
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

  // Pieza 50: matriz 7×7 Spot × ΔIV + atribución de Taylor. `selectedCell` se pasa
  // dentro del input para que la función resuelva spotGrid[col] / ivShiftGridPts[row]
  // sin dependencia circular con este mismo useMemo.
  const heatmapData = useMemo(
    () =>
      buildWhatIfHeatmapAndAttribution({
        referenceSpot: spot,
        legs: effectiveLegs,
        rate,
        dividendYield,
        elapsedDays,
        horizonDte: safeMaxDte,
        targetSpot: hoveredSpot ?? spot,
        targetIvShiftPts: ivShiftPts,
        contracts,
        contractMultiplier,
        selectedCell,
      }),
    [
      spot,
      effectiveLegs,
      rate,
      dividendYield,
      elapsedDays,
      safeMaxDte,
      hoveredSpot,
      ivShiftPts,
      contracts,
      contractMultiplier,
      selectedCell,
    ],
  );

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

  // Pieza 50: delegación de eventos de la matriz 7×7 (un solo handler para las 49 celdas).
  const readHeatmapCell = (target: EventTarget | null): { row: number; col: number } | null => {
    const el = target instanceof HTMLElement ? target.closest('[data-cell]') : null;
    if (el === null) return null;
    const row = Number(el.getAttribute('data-row'));
    const col = Number(el.getAttribute('data-col'));
    if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
    if (row < 0 || row >= WHAT_IF_HEATMAP_IV_SHIFT_STEPS.length) return null;
    if (col < 0 || col >= WHAT_IF_HEATMAP_SIGMA_STEPS.length) return null;
    return { row, col };
  };

  const handleGridClick = (evt: React.MouseEvent<HTMLDivElement>): void => {
    const cell = readHeatmapCell(evt.target);
    if (cell === null) return;
    setSelectedCell((prev) =>
      prev !== null && prev.row === cell.row && prev.col === cell.col ? null : cell,
    );
  };

  const handleGridHover = (evt: React.MouseEvent<HTMLDivElement>): void => {
    const cell = readHeatmapCell(evt.target);
    setHoveredCell((prev) =>
      prev !== null && cell !== null && prev.row === cell.row && prev.col === cell.col
        ? prev
        : cell,
    );
  };

  const handleGridLeave = (): void => {
    setHoveredCell(null);
  };

  // Atribución de Griegas (Taylor 2.º orden) del punto objetivo.
  const attribution = heatmapData.attribution;
  const attributionComponents: readonly {
    readonly key: string;
    readonly value: number;
    readonly swatch: string;
  }[] = [
    { key: 'Delta', value: attribution.deltaPnl, swatch: 'bg-sky-400' },
    { key: 'Gamma', value: attribution.gammaPnl, swatch: 'bg-emerald-400' },
    { key: 'Theta', value: attribution.thetaPnl, swatch: 'bg-amber-400' },
    { key: 'Vega', value: attribution.vegaPnl, swatch: 'bg-cyan-300' },
    { key: 'Residuo', value: attribution.residualPnl, swatch: 'bg-fuchsia-400' },
  ];
  const attributionDenominator = attributionComponents.reduce(
    (acc, component) => acc + Math.abs(component.value),
    0,
  );
  const heatmapMaxAbs = Math.max(
    Math.abs(heatmapData.minPnlUsd),
    Math.abs(heatmapData.maxPnlUsd),
  );
  const selectedCellInfo =
    selectedCell !== null
      ? (heatmapData.cells[selectedCell.row]?.[selectedCell.col] ?? null)
      : null;
  const hoveredCellInfo =
    hoveredCell !== null ? (heatmapData.cells[hoveredCell.row]?.[hoveredCell.col] ?? null) : null;
  const focusCellInfo = hoveredCellInfo ?? selectedCellInfo;

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
          <div className="flex items-center gap-0.5 rounded border border-slate-700/70 bg-slate-900/70 p-0.5">
            {(['curves', 'heatmap'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`rounded px-2 py-0.5 font-mono transition ${
                  viewMode === mode
                    ? 'border border-cyan-500/60 bg-cyan-500/20 text-cyan-200'
                    : 'border border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {mode === 'curves' ? 'Curvas' : 'Matriz Spot × ΔIV'}
              </button>
            ))}
          </div>
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
      {viewMode === 'heatmap' ? (
        heatmapData.isValid && heatmapData.cells.length > 0 ? (
          <div className="rounded border border-slate-800/80 bg-[#06090F] p-2">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px]">
              <span className="font-mono text-slate-300 tabular-nums">
                Matriz 7×7 Spot × ΔIV · 1σ = ±{fmtStrike(heatmapData.oneSigmaMoveAbs)} · T+
                {String(heatmapData.attribution.elapsedDays)}d
              </span>
              <span className="text-slate-500">
                Clic en una celda para fijar el punto de atribución · clic de nuevo para soltar
              </span>
            </div>
            <div
              className="grid gap-px"
              style={{
                gridTemplateColumns: `46px repeat(${String(heatmapData.spotGrid.length)}, minmax(0, 1fr))`,
              }}
              onClick={handleGridClick}
              onMouseOver={handleGridHover}
              onMouseLeave={handleGridLeave}
            >
              <div className="text-[9px] font-mono text-slate-500" />
              {heatmapData.spotGrid.map((gridSpot, col) => (
                <div
                  key={`hcol-${String(col)}`}
                  className="text-center text-[9px] font-mono text-slate-400 tabular-nums"
                >
                  {col === 3 ? 'Spot' : `${String(WHAT_IF_HEATMAP_SIGMA_STEPS[col] ?? 0)}σ`}
                  <div className="text-[9px] text-slate-500">{fmtStrike(gridSpot)}</div>
                </div>
              ))}
              {heatmapData.cells.map((rowCells, row) => (
                <React.Fragment key={`hrow-${String(row)}`}>
                  <div className="flex items-center justify-end pr-1 text-[9px] font-mono text-slate-400 tabular-nums">
                    {(WHAT_IF_HEATMAP_IV_SHIFT_STEPS[row] ?? 0) > 0 ? '+' : ''}
                    {String(WHAT_IF_HEATMAP_IV_SHIFT_STEPS[row] ?? 0)}p
                  </div>
                  {rowCells.map((cell) => {
                    const isSelected =
                      selectedCell !== null &&
                      selectedCell.row === cell.rowIndex &&
                      selectedCell.col === cell.colIndex;
                    return (
                      <div
                        key={`hc-${String(cell.rowIndex)}-${String(cell.colIndex)}`}
                        data-cell
                        data-row={cell.rowIndex}
                        data-col={cell.colIndex}
                        style={heatmapCellStyle(cell.pnlUsd, heatmapMaxAbs)}
                        className={`flex min-h-9 cursor-pointer select-none flex-col items-center justify-center px-1 py-1 ${
                          isSelected ? 'outline outline-2 -outline-offset-2 outline-cyan-300' : ''
                        }`}
                      >
                        <span
                          className={`font-mono text-[10px] font-semibold tabular-nums ${pnlToneClass(
                            cell.pnlUsd,
                          )}`}
                        >
                          {fmtCompactSigned(cell.pnlUsd, currencyPrefix)}
                        </span>
                        {cell.ivClampedLegs > 0 && (
                          <span className="text-[8px] font-mono text-amber-300/90 tabular-nums">
                            piso {String(cell.ivClampedLegs)}p
                          </span>
                        )}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[10px] font-mono text-slate-400 tabular-nums">
              {focusCellInfo ? (
                <>
                  <span>Spot {fmtStrike(focusCellInfo.spot)}</span>
                  <span>
                    ΔIV {focusCellInfo.ivShiftPts > 0 ? '+' : ''}
                    {String(focusCellInfo.ivShiftPts)}p
                  </span>
                  <span className={pnlToneClass(focusCellInfo.pnlUsd)}>
                    P&L {fmtSignedMoney(focusCellInfo.pnlUsd, currencyPrefix)}
                  </span>
                </>
              ) : (
                <span className="text-slate-500">
                  Hover o clic sobre una celda para inspeccionar su P&amp;L.
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded border border-slate-800/80 bg-[#06090F] p-3 text-center text-xs text-slate-400">
            Matriz 2D Spot × ΔIV no calculable (—).
          </div>
        )
      ) : chartMetrics ? (
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

      {/* Pieza 50: Atribución de Griegas (Taylor 2.º orden) — visible en curvas y matriz */}
      <div className="rounded border border-slate-800/80 bg-[#0D131D] px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
          <span className="font-semibold text-slate-300">
            Atribución de Griegas (Taylor 2.º orden)
          </span>
          <span className="font-mono text-slate-400 tabular-nums">
            Objetivo: Spot {fmtStrike(attribution.targetSpot)} · ΔIV{' '}
            {attribution.deltaIvPts > 0 ? '+' : ''}
            {String(attribution.deltaIvPts)}p · T+{String(attribution.elapsedDays)}d
          </span>
        </div>
        <div className="mt-1.5 flex h-2 w-full overflow-hidden rounded bg-slate-800/80">
          {attributionComponents.map((component) =>
            Number.isFinite(component.value) && attributionDenominator > 0 ? (
              <div
                key={component.key}
                className={component.swatch}
                style={{
                  width: `${String((Math.abs(component.value) / attributionDenominator) * 100)}%`,
                }}
              />
            ) : null,
          )}
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-mono tabular-nums sm:grid-cols-5">
          {attributionComponents.map((component) => (
            <div
              key={component.key}
              className="flex items-center justify-between gap-2 rounded border border-slate-800/60 bg-slate-900/40 px-2 py-1"
            >
              <span className="inline-flex items-center gap-1.5 text-slate-400">
                <span className={`h-2 w-2 rounded-sm ${component.swatch}`} />
                {component.key}
              </span>
              <span className={pnlToneClass(component.value)}>
                {fmtSignedMoney(component.value, currencyPrefix)}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-400 tabular-nums">
          <span>
            Total BSM:{' '}
            <span className={pnlToneClass(attribution.totalBsmPnl)}>
              {fmtSignedMoney(attribution.totalBsmPnl, currencyPrefix)}
            </span>{' '}
            · P&amp;L posición:{' '}
            <span className={pnlToneClass(attribution.totalPositionPnl)}>
              {fmtSignedMoney(attribution.totalPositionPnl, currencyPrefix)}
            </span>
          </span>
          <span className="text-slate-500">Residuo ≈ Vanna/Volga/Charm y orden superior</span>
        </div>
      </div>
    </div>
  );
});
