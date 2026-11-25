import React, { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Layers, ShieldAlert } from 'lucide-react';
import {
  buildInstitutionalAvwapContextViewModel,
  type AvwapAnyTimeframe,
  type InstitutionalAvwapAnchorInput,
  type InstitutionalAvwapContextInput,
  type InstitutionalAvwapContextViewModel,
} from './avwapContextViewModel';

export interface InstitutionalAvwapContextPanelProps {
  readonly context: InstitutionalAvwapContextInput | null | undefined;
  readonly activeTimeframe: AvwapAnyTimeframe;
  readonly anchors?: readonly InstitutionalAvwapAnchorInput[];
  readonly opexResetMarkerDates?: readonly string[];
  readonly currencySymbol?: 'USD' | 'ARS';
  readonly focusedAnchorId?: string | null;
  readonly onSelectFocusAnchor?: (anchorId: string | null) => void;
  readonly showFocusedBands?: boolean;
  readonly onToggleFocusedBands?: (next: boolean) => void;
  readonly showOpexResetMarker?: boolean;
  readonly onToggleOpexResetMarker?: (next: boolean) => void;
  readonly defaultCollapsed?: boolean;
  readonly viewModelOverride?: InstitutionalAvwapContextViewModel;
}

export const InstitutionalAvwapContextPanel: React.FC<InstitutionalAvwapContextPanelProps> = ({
  context,
  activeTimeframe,
  anchors,
  opexResetMarkerDates,
  currencySymbol = 'USD',
  focusedAnchorId,
  onSelectFocusAnchor,
  showFocusedBands,
  onToggleFocusedBands,
  showOpexResetMarker,
  onToggleOpexResetMarker,
  defaultCollapsed = false,
  viewModelOverride,
}) => {
  const [internalCollapsed, setInternalCollapsed] = useState<boolean>(defaultCollapsed);
  const [internalFocusedId, setInternalFocusedId] = useState<string | null>(null);
  const [internalShowBands, setInternalShowBands] = useState<boolean>(false);
  const [internalShowOpex, setInternalShowOpex] = useState<boolean>(false);

  const effectiveFocusedId = focusedAnchorId !== undefined ? focusedAnchorId : internalFocusedId;
  const effectiveShowBands = showFocusedBands !== undefined ? showFocusedBands : internalShowBands;
  const effectiveShowOpex = showOpexResetMarker !== undefined ? showOpexResetMarker : internalShowOpex;

  const vm = useMemo(() => {
    if (viewModelOverride !== undefined) return viewModelOverride;
    return buildInstitutionalAvwapContextViewModel({
      context,
      activeTimeframe,
      ...(anchors !== undefined ? { anchors } : {}),
      ...(opexResetMarkerDates !== undefined ? { opexResetMarkerDates } : {}),
      preferences: {
        focusedAnchorId: effectiveFocusedId,
        showFocusedBands: effectiveShowBands,
        showOpexResetMarker: effectiveShowOpex,
      },
    });
  }, [
    viewModelOverride,
    context,
    activeTimeframe,
    anchors,
    opexResetMarkerDates,
    effectiveFocusedId,
    effectiveShowBands,
    effectiveShowOpex,
  ]);

  if (!vm.available) {
    return null;
  }

  const pxPrefix = currencySymbol === 'USD' ? 'US$ ' : '$ ';

  const handleSelectAnchor = (anchorId: string): void => {
    const next = effectiveFocusedId === anchorId ? null : anchorId;
    if (onSelectFocusAnchor !== undefined) {
      onSelectFocusAnchor(next);
    } else {
      setInternalFocusedId(next);
    }
  };

  const handleToggleBands = (): void => {
    const next = !effectiveShowBands;
    if (onToggleFocusedBands !== undefined) {
      onToggleFocusedBands(next);
    } else {
      setInternalShowBands(next);
    }
  };

  const handleToggleOpex = (): void => {
    const next = !effectiveShowOpex;
    if (onToggleOpexResetMarker !== undefined) {
      onToggleOpexResetMarker(next);
    } else {
      setInternalShowOpex(next);
    }
  };

  const gammaToneClass =
    vm.gammaBadge.tone === 'danger'
      ? 'border-[#FF5468]/45 bg-[#FF5468]/15 text-[#FF5468]'
      : vm.gammaBadge.tone === 'positive'
        ? 'border-[#2EDC7E]/40 bg-[#2EDC7E]/15 text-[#2EDC7E]'
        : vm.gammaBadge.tone === 'warning'
          ? 'border-[#F5B544]/40 bg-[#F5B544]/15 text-[#F5B544]'
          : 'border-[#2B2E3E] bg-[#161622] text-[#A2A8C2]';

  const volToneClass =
    vm.volRegimeBadge.tone === 'warning'
      ? 'border-[#F59E0B]/40 bg-[#F59E0B]/15 text-[#F59E0B]'
      : vm.volRegimeBadge.tone === 'info'
        ? 'border-[#38BDF8]/40 bg-[#38BDF8]/15 text-[#38BDF8]'
        : 'border-[#252536] bg-[#14141F] text-[#9CA3AF]';

  const focusedAnchor =
    vm.visibleAnchors.find((item) => item.anchorId === vm.focusedBands.focusedAnchorId) ?? null;

  const nonHazardDegradations = vm.degradationBadges.filter((item) => !item.isHazard);

  return (
    <section
      data-qot-panel="institutional-avwap-context"
      className="rounded-[12px] border border-[#1C1C24] bg-[#111116] px-4 py-3 text-[#E5E7EB]"
    >
      {/* Cabecera */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5 text-[#8B7CF6]" />
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[#E5E7EB]">
              Institutional AVWAP
            </h3>
          </div>
          <span className="rounded-full border border-[#2E3446] bg-[#14141F] px-2 py-0.5 font-mono-num text-[10px] font-medium text-[#A2A8C2]">
            Context Only
          </span>
          <span className="rounded-full border border-[#252536] bg-[#0B0B12] px-2 py-0.5 font-mono-num tabular-nums text-[10px] text-[#7E85A3]">
            {vm.timeframe} · máx {vm.effectiveMaxCurves}
          </span>
          <span
            title={vm.gammaBadge.detail}
            className={`rounded-full border px-2 py-0.5 font-mono-num text-[10px] font-semibold ${gammaToneClass}`}
          >
            {vm.gammaBadge.shortLabel}
          </span>
          <span className={`rounded-full border px-2 py-0.5 font-mono-num text-[10px] font-medium ${volToneClass}`}>
            {vm.volRegimeBadge.label}
          </span>
          {vm.shortGammaBounceHazard && (
            <span
              data-qot-hazard="SHORT_GAMMA_BOUNCE_HAZARD"
              className="inline-flex items-center gap-1 rounded-full border border-[#F59E0B]/50 bg-[#F59E0B]/15 px-2 py-0.5 font-mono-num text-[10px] font-semibold text-[#F5B544]"
            >
              <AlertTriangle className="h-3 w-3" />
              Short Gamma: rebotes degradados, prima expansión/ruptura
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setInternalCollapsed((prev) => !prev)}
          aria-expanded={!internalCollapsed}
          className="inline-flex items-center gap-1 rounded-[6px] border border-[#252536] bg-[#14141F] px-2 py-1 font-mono-num text-[10px] text-[#9CA3AF] hover:border-[#3A3A54] hover:text-white cursor-pointer"
        >
          {internalCollapsed ? (
            <>
              <span>Expandir</span>
              <ChevronDown className="h-3 w-3" />
            </>
          ) : (
            <>
              <span>Colapsar</span>
              <ChevronUp className="h-3 w-3" />
            </>
          )}
        </button>
      </div>

      {!internalCollapsed && (
        <div className="mt-3 flex flex-col gap-3">
          {/* Barras duales de Confluencia (0–100) + Niveles alineados */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="rounded-[10px] border border-[#1B1B28] bg-[#0B0B12] p-3">
              <div className="mb-2 flex items-center justify-between gap-2 text-[10px] font-mono-num tabular-nums">
                <span className="uppercase tracking-[0.05em] text-[#8E95B3]">
                  Confluencia Estructural (0–100)
                </span>
                <span className="text-[#CBD0E4]">
                  {vm.dominantConfluenceLabel} · g {vm.netGexNormalizedFormatted}
                </span>
              </div>

              <div className="space-y-2">
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] font-mono-num tabular-nums">
                    <span className={vm.dominantConfluence === 'BOUNCE' ? 'font-semibold text-[#2EDC7E]' : 'text-[#A2A8C2]'}>
                      Bounce / Absorption
                    </span>
                    <span className="font-bold text-[#F3F4F6]">{vm.bounceScoreFormatted}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#181826]">
                    <div
                      className="h-full rounded-full bg-[#2EDC7E]"
                      style={{ width: `${vm.bounceBarPct.toFixed(1)}%` }}
                    />
                  </div>
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] font-mono-num tabular-nums">
                    <span className={vm.dominantConfluence === 'BREAKOUT' ? 'font-semibold text-[#8B7CF6]' : 'text-[#A2A8C2]'}>
                      Breakout / Expansion
                    </span>
                    <span className="font-bold text-[#F3F4F6]">{vm.breakoutScoreFormatted}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#181826]">
                    <div
                      className="h-full rounded-full bg-[#8B7CF6]"
                      style={{ width: `${vm.breakoutBarPct.toFixed(1)}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-[10px] border border-[#1B1B28] bg-[#0B0B12] p-3">
              <div className="mb-2 flex items-center justify-between gap-2 text-[10px] font-mono-num">
                <span className="uppercase tracking-[0.05em] text-[#8E95B3]">
                  Niveles Estructurales Alineados
                </span>
                <span className="text-[#6B7280]">
                  {vm.alignedLevels.length} {vm.alignedLevels.length === 1 ? 'nivel' : 'niveles'}
                </span>
              </div>
              {vm.alignedLevels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {vm.alignedLevels.map((lvl, idx) => (
                    <span
                      key={`${lvl.levelType}:${idx}`}
                      className="rounded-full border border-[#252536] bg-[#14141F] px-2 py-0.5 font-mono-num tabular-nums text-[10px] text-[#CBD0E4]"
                    >
                      <span className="text-[#8B7CF6]">{lvl.label}</span> {pxPrefix}
                      {lvl.priceFormatted} · {lvl.distanceAtrFormatted}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="font-mono-num text-[11px] text-[#6B7280]">
                  Sin niveles estructurales próximos cargados
                </div>
              )}
            </div>
          </div>

          {/* Corredor PINCH activo */}
          {vm.pinchCorridor !== null && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-3 py-1.5 font-mono-num tabular-nums text-[11px] text-[#F5B544]">
              <span>
                <strong className="uppercase">PINCH Corridor</strong> · {vm.pinchCorridor.label}
              </span>
              <span>
                {pxPrefix}
                {vm.pinchCorridor.lowFormatted} – {pxPrefix}
                {vm.pinchCorridor.highFormatted} ({vm.pinchCorridor.spreadAtrFormatted})
              </span>
            </div>
          )}

          {/* Lista de Anclajes Activos (presupuesto duro) */}
          <div className="rounded-[10px] border border-[#1B1B28] bg-[#0B0B12] p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono-num">
              <span className="uppercase tracking-[0.05em] text-[#8E95B3]">
                Anclajes Activos (radio top-down ±{vm.budgetRule.topDownMaxDistAtr.toFixed(1)} ATR)
              </span>
              <span className="text-[#7E85A3]">
                {vm.visibleAnchors.length}/{vm.effectiveMaxCurves} slots
              </span>
            </div>

            {vm.visibleAnchors.length > 0 ? (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {vm.visibleAnchors.map((anchor) => {
                  const stateChipClass =
                    anchor.lifecycleState === 'PINCH_PAIR'
                      ? 'border-[#F59E0B]/45 bg-[#F59E0B]/15 text-[#F5B544]'
                      : anchor.lifecycleState === 'ACTIVE_PRIMARY'
                        ? 'border-[#38BDF8]/45 bg-[#38BDF8]/15 text-[#38BDF8]'
                        : anchor.lifecycleState === 'DECAYING'
                          ? 'border-[#475569]/50 bg-[#1E293B]/40 text-[#94A3B8]'
                          : 'border-[#A78BFA]/40 bg-[#A78BFA]/15 text-[#C4B5FD]';

                  return (
                    <button
                      key={anchor.anchorId}
                      type="button"
                      onClick={() => handleSelectAnchor(anchor.anchorId)}
                      data-qot-anchor={anchor.anchorId}
                      style={{ opacity: anchor.style.opacity }}
                      className={`flex flex-col gap-1.5 rounded-[8px] border px-3 py-2 text-left transition-colors cursor-pointer ${
                        anchor.isFocused
                          ? 'border-[#8B7CF6] bg-[#161626]'
                          : 'border-[#1E1E2B] bg-[#11111A] hover:border-[#2E3446]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="inline-block w-4"
                            style={{
                              borderTopWidth: `${anchor.style.lineWidth}px`,
                              borderTopStyle: anchor.style.lineStyle === 'DOTTED' ? 'dotted' : 'solid',
                              borderTopColor: anchor.style.color,
                            }}
                          />
                          <span className="text-[11px] font-semibold text-[#F3F4F6]">{anchor.label}</span>
                          {anchor.anchorDate !== null && (
                            <span className="font-mono-num text-[10px] text-[#7E85A3]">{anchor.anchorDate}</span>
                          )}
                        </div>
                        <span className={`rounded-full border px-1.5 py-0.5 font-mono-num text-[9px] font-semibold ${stateChipClass}`}>
                          {anchor.fsmBadgeLabel}
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-2 font-mono-num tabular-nums text-[10px] text-[#CBD0E4]">
                        <div>
                          <span className="text-[#6B7280]">AVWAP </span>
                          <span>
                            {pxPrefix}
                            {anchor.avwapFormatted}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#6B7280]">Dist </span>
                          <span>{anchor.distanceAtrFormatted}</span>
                        </div>
                        <div>
                          <span className="text-[#6B7280]">z-path </span>
                          <span>{anchor.zScorePathFormatted}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 font-mono-num tabular-nums text-[10px] text-[#9CA3AF]">
                        <span>
                          IASS <strong className="text-[#E5E7EB]">{anchor.iassConservativeFormatted}</strong> (
                          M:{anchor.iassPillarsFormatted.M} D:{anchor.iassPillarsFormatted.D} F:
                          {anchor.iassPillarsFormatted.F} S:{anchor.iassPillarsFormatted.S} · Cov{' '}
                          {anchor.iassCoveragePctFormatted})
                        </span>
                        <span>
                          S_cohort <strong className="text-[#E5E7EB]">{anchor.cohortSurvivalPctFormatted}</strong>
                          {anchor.floatIsNonPit && <span className="ml-1 text-[#F5B544]">(non-PIT)</span>}
                        </span>
                      </div>

                      {anchor.decayReasons.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {anchor.decayReasons.map((reason) => (
                            <span
                              key={reason.code}
                              className="rounded border border-[#334155] bg-[#0F172A] px-1.5 py-0.5 font-mono-num text-[9px] text-[#94A3B8]"
                            >
                              {reason.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="font-mono-num text-[11px] text-[#7E85A3]">
                Sin anclajes detallados dentro del presupuesto operativo ({vm.timeframe}). Contexto de confluencia y régimen activo.
              </div>
            )}
          </div>

          {/* Inspección cuantitativa + Bandas híbridas (±1σ, ±2σ, ±2.5σ) en foco */}
          {focusedAnchor !== null && (
            <div
              data-qot-focused-anchor={focusedAnchor.anchorId}
              className="rounded-[10px] border border-[#26263A] bg-[#0D0D16] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono-num">
                <span className="font-semibold uppercase tracking-[0.05em] text-[#C4B5FD]">
                  Detalle en foco · {focusedAnchor.label} ({focusedAnchor.fsmBadgeLabel})
                </span>
                <span className="text-[#9CA3AF]">{vm.focusedBands.calibratedExtremeNote}</span>
              </div>

              {vm.focusedBands.visible ? (
                <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
                  {vm.focusedBands.levels.map((band) => (
                    <div
                      key={band.key}
                      className={`rounded-[6px] border px-2 py-1 font-mono-num tabular-nums text-[10px] ${
                        band.isCalibratedExtreme
                          ? 'border-[#F59E0B]/45 bg-[#F59E0B]/10 text-[#F5B544]'
                          : 'border-[#1E1E2E] bg-[#09090F] text-[#CBD0E4]'
                      }`}
                    >
                      <div className="text-[9px] opacity-85">{band.label}</div>
                      <div className="font-semibold">
                        {pxPrefix}
                        {band.priceFormatted}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-1.5 font-mono-num text-[10px] text-[#7E85A3]">
                  {vm.focusedBands.hiddenReason === 'WEEKLY_HIDDEN_BY_DEFAULT'
                    ? 'Bandas híbridas (±1σ / ±2σ / ±2.5σ) ocultas por defecto en 1W.'
                    : 'Bandas híbridas desactivadas (activá "Bandas foco" para proyectarlas).'}
                </div>
              )}
            </div>
          )}

          {/* Referencias Macro en Eje (intradiario < 1.0 ATR) */}
          {vm.macroAxisRefs.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 font-mono-num tabular-nums text-[10px]">
              <span className="text-[#7E85A3]">Ref. Macro en Eje (&lt; 1.0 ATR):</span>
              {vm.macroAxisRefs.map((ref) => (
                <span
                  key={ref.anchorId}
                  className="rounded-full border border-[#2A2E3F] bg-[#14141F] px-2 py-0.5 text-[#CBD0E4]"
                >
                  {ref.shortLabel} · {pxPrefix}
                  {ref.avwapFormatted} ({ref.distanceAtrFormatted})
                </span>
              ))}
            </div>
          )}

          {/* Marcadores OpEx opcionales (solo OPEX_CYCLE_MARKER, nunca S/R) */}
          {vm.opexCycleMarkers.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 font-mono-num tabular-nums text-[10px]">
              <span className="text-[#7E85A3]">Marcador de ciclo OpEx (no S/R):</span>
              {vm.opexCycleMarkers.map((marker) => (
                <span
                  key={marker.id}
                  data-qot-marker-kind={marker.markerKind}
                  className="rounded-full border border-[#334155] bg-[#0F172A] px-2 py-0.5 text-[#94A3B8]"
                >
                  {marker.markerKind}
                  {marker.dateLabel !== null ? ` · ${marker.dateLabel}` : ''}
                  {marker.avwap !== null ? ` · ${pxPrefix}${marker.avwapFormatted}` : ''}
                </span>
              ))}
            </div>
          )}

          {/* Pie de transparencia */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#181822] pt-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {nonHazardDegradations.length > 0 ? (
                nonHazardDegradations.map((deg) => (
                  <span
                    key={deg.flag}
                    title={deg.flag}
                    className="inline-flex items-center gap-1 rounded-full border border-[#3B3022] bg-[#1A150E] px-2 py-0.5 font-mono-num text-[10px] text-[#F5B544]"
                  >
                    <ShieldAlert className="h-2.5 w-2.5" />
                    {deg.label}
                  </span>
                ))
              ) : (
                <span className="font-mono-num text-[10px] text-[#5F6682]">
                  Cobertura cuantitativa íntegra
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={handleToggleBands}
                className={`rounded-[6px] border px-2 py-0.5 font-mono-num text-[10px] transition-colors cursor-pointer ${
                  effectiveShowBands
                    ? 'border-[#8B7CF6]/60 bg-[#8B7CF6]/20 text-white'
                    : 'border-[#252536] bg-[#14141F] text-[#8E95B3] hover:text-white'
                }`}
              >
                Bandas foco
              </button>
              <button
                type="button"
                onClick={handleToggleOpex}
                className={`rounded-[6px] border px-2 py-0.5 font-mono-num text-[10px] transition-colors cursor-pointer ${
                  effectiveShowOpex
                    ? 'border-[#8B7CF6]/60 bg-[#8B7CF6]/20 text-white'
                    : 'border-[#252536] bg-[#14141F] text-[#8E95B3] hover:text-white'
                }`}
              >
                Marcador OpEx
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
