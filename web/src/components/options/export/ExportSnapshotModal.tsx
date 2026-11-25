/**
 * Pieza EXPORT-1: Modal diferido de Exportar Snapshot Institucional US.
 *
 * Higiene UI estricta:
 * - `tabular-nums`, `font-mono-num`.
 * - Cero `backdrop-blur-*`, cero `animate-pulse`/`animate-ping`.
 * - CLS objetivo = 0 (dimensiones fijas / reservadas).
 * - Importado exclusivamente vía `React.lazy` desde cabecera US de `OptionsModule` y `StockDetailView`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, Download, FileText, X } from 'lucide-react';
import type {
  ExportUsOptionsSnapshotRequest,
  SnapshotExportResult,
  SnapshotMode,
  SwingChainFilterMode,
} from '../../../../../src/core/options/usOptionsIntelligenceExportTypes.js';
import { formatDteLabel } from '../../../../../src/core/options/zeroDteFixes.js';
import {
  cancelActiveSnapshotExport,
  exportUsOptionsSnapshot,
} from './usOptionsSnapshotCollector';

export interface ExportSnapshotExpiryOption {
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  readonly isLoaded: boolean;
}

export interface ExportSnapshotModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly ticker: string;
  readonly activeExpiryDate: string | null;
  readonly availableExpirations: readonly ExportSnapshotExpiryOption[];
  readonly initialChartTimeframe?: '15m' | '1h';
}

function isCompatibleWithMode(daysToExpiry: number, mode: SnapshotMode): boolean {
  if (!Number.isFinite(daysToExpiry)) return false;
  if (mode === 'intraday') return daysToExpiry >= 0 && daysToExpiry <= 1;
  return daysToExpiry >= 6 && daysToExpiry <= 17;
}

function inferDefaultMode(
  activeExpiryDate: string | null,
  availableExpirations: readonly ExportSnapshotExpiryOption[],
): SnapshotMode {
  const active = availableExpirations.find((e) => e.expirationDate === activeExpiryDate);
  if (active && active.daysToExpiry >= 0 && active.daysToExpiry <= 1) return 'intraday';
  if (active && active.daysToExpiry >= 6 && active.daysToExpiry <= 17) return 'swing';
  const hasIntraday = availableExpirations.some((e) => isCompatibleWithMode(e.daysToExpiry, 'intraday'));
  const hasSwing = availableExpirations.some((e) => isCompatibleWithMode(e.daysToExpiry, 'swing'));
  if (hasSwing && !hasIntraday) return 'swing';
  if (hasIntraday && !hasSwing) return 'intraday';
  return 'swing';
}

const ExportSnapshotModal: React.FC<ExportSnapshotModalProps> = ({
  open,
  onClose,
  ticker,
  activeExpiryDate,
  availableExpirations,
  initialChartTimeframe,
}) => {
  const cleanTicker = ticker.trim().toUpperCase();
  const [mode, setMode] = useState<SnapshotMode>(() =>
    inferDefaultMode(activeExpiryDate, availableExpirations),
  );
  const [swingFilter, setSwingFilter] = useState<SwingChainFilterMode>('DELTA_005_055');
  const [selectedExpirations, setSelectedExpirations] = useState<readonly string[]>([]);
  const [running, setRunning] = useState(false);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedOk, setCopiedOk] = useState(false);
  const [lastResult, setLastResult] = useState<SnapshotExportResult | null>(null);
  const [confirmOversized, setConfirmOversized] = useState(false);
  const activeRequestRef = useRef<ExportUsOptionsSnapshotRequest | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const compatibleExpirations = useMemo(
    () => availableExpirations.filter((e) => isCompatibleWithMode(e.daysToExpiry, mode)),
    [availableExpirations, mode],
  );

  // Sync defaults when opening or switching ticker/mode
  useEffect(() => {
    if (!open) return;
    const defaultMode = inferDefaultMode(activeExpiryDate, availableExpirations);
    setMode(defaultMode);
    setErrorMsg(null);
    setLastResult(null);
    setCopiedOk(false);
    setConfirmOversized(false);
  }, [open, cleanTicker, activeExpiryDate, availableExpirations]);

  useEffect(() => {
    const compatSet = new Set(compatibleExpirations.map((e) => e.expirationDate));
    setSelectedExpirations((prev) => {
      const kept = prev.filter((d) => compatSet.has(d)).slice(0, 2);
      if (kept.length > 0) return kept;
      if (activeExpiryDate && compatSet.has(activeExpiryDate)) return [activeExpiryDate];
      const first = compatibleExpirations[0]?.expirationDate;
      return first ? [first] : [];
    });
    setLastResult(null);
    setConfirmOversized(false);
  }, [compatibleExpirations, activeExpiryDate]);

  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [open]);

  const toggleExpiration = useCallback((expDate: string) => {
    setSelectedExpirations((prev) => {
      if (prev.includes(expDate)) {
        return prev.length > 1 ? prev.filter((d) => d !== expDate) : prev;
      }
      if (prev.length >= 2) {
        return [prev[1]!, expDate];
      }
      return [...prev, expDate];
    });
    setLastResult(null);
    setConfirmOversized(false);
  }, []);

  const runExport = useCallback(async (): Promise<SnapshotExportResult | null> => {
    if (selectedExpirations.length === 0) {
      setErrorMsg(`No hay vencimientos compatibles con modo ${mode.toUpperCase()} (${mode === 'intraday' ? '0–1 DTE' : '6–17 DTE'}).`);
      return null;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const req: ExportUsOptionsSnapshotRequest = {
      ticker: cleanTicker,
      expirations: selectedExpirations,
      mode,
      format: 'markdown',
      includeCharts: false,
      chartTimeframes: [initialChartTimeframe ?? (mode === 'intraday' ? '15m' : '1h')],
      ...(mode === 'swing' ? { swingChainFilter: swingFilter } : {}),
      allowExceedSizeBudget: confirmOversized,
    };
    activeRequestRef.current = req;
    setRunning(true);
    setErrorMsg(null);
    setProgressText('Recopilando estado congelado y validando integridad...');
    try {
      const result = await exportUsOptionsSnapshot(req, controller.signal);
      if (controller.signal.aborted) return null;
      setLastResult(result);
      setProgressText(
        `Listo en ${String(Math.round(result.timingsMs.totalMs))} ms · ${(result.markdownByteLength / 1024).toFixed(1)} KB · ${String(result.additionalRequestsCount)} req`,
      );
      return result;
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setProgressText('Exportación cancelada.');
        return null;
      }
      setErrorMsg(err instanceof Error ? err.message : 'Error al generar snapshot');
      setProgressText(null);
      return null;
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setRunning(false);
    }
  }, [cleanTicker, selectedExpirations, mode, initialChartTimeframe, swingFilter, confirmOversized]);

  const handleCopyMarkdown = useCallback(async () => {
    const result = lastResult ?? (await runExport());
    if (!result) return;
    if (result.exceedsTargetBudget && !confirmOversized) {
      setConfirmOversized(true);
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(result.markdown);
      setCopiedOk(true);
      setTimeout(() => setCopiedOk(false), 2_000);
    }
  }, [lastResult, runExport, confirmOversized]);

  const handleDownloadMarkdown = useCallback(async () => {
    const result = lastResult ?? (await runExport());
    if (!result) return;
    if (result.exceedsTargetBudget && !confirmOversized) {
      setConfirmOversized(true);
      return;
    }
    const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${cleanTicker}_${mode}_${selectedExpirations.join('_')}_${result.snapshotId.slice(-8)}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [lastResult, runExport, confirmOversized, cleanTicker, mode, selectedExpirations]);

  const handleCancelExport = useCallback(() => {
    abortRef.current?.abort();
    if (activeRequestRef.current) {
      cancelActiveSnapshotExport(activeRequestRef.current);
    }
    setRunning(false);
    setProgressText('Exportación cancelada por el usuario.');
  }, []);

  if (!open) return null;

  const activeObj = availableExpirations.find((e) => e.expirationDate === activeExpiryDate);
  const activeIncompatible =
    activeObj !== undefined && !isCompatibleWithMode(activeObj.daysToExpiry, mode);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Exportar Snapshot ${cleanTicker}`}
      data-qot-export-modal={cleanTicker}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 tabular-nums font-mono-num"
    >
      <div className="w-full max-w-[680px] rounded-[14px] border border-[#2A3042] bg-[#0E1118] text-[#EAECEF] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#1E222D] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <FileText className="h-4 w-4 text-[#8B7CF6]" />
            <div>
              <h2 className="text-[14px] font-bold text-white">
                Exportar Snapshot US — {cleanTicker} (USD)
              </h2>
              <p className="text-[11px] text-[#8E95B3]">
                Dossier cuantitativo congelado · Pieza EXPORT-1 (Markdown UTF-8)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar exportador"
            className="rounded-md border border-[#232733] bg-[#141824] p-1.5 text-[#9CA3AF] hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-[12px]">
          {/* Modo Intraday / Swing */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-[#787B86]">
                Modo operativo
              </div>
              <div className="grid grid-cols-2 gap-1.5 rounded-[10px] border border-[#232733] bg-[#0A0D13] p-1">
                {(['intraday', 'swing'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`rounded-[7px] py-1.5 text-[11.5px] font-bold transition-colors cursor-pointer ${
                      mode === m
                        ? 'bg-[#8B7CF6] text-white'
                        : 'text-[#9CA3AF] hover:text-white'
                    }`}
                  >
                    {m === 'intraday' ? 'Intraday (0–1 DTE)' : 'Swing (6–17 DTE)'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-[#787B86]">
                Formato e imágenes
              </div>
              <div className="flex items-center justify-between gap-2 rounded-[10px] border border-[#232733] bg-[#0A0D13] px-3 py-1.5">
                <span className="font-bold text-white">Markdown (.md)</span>
                <span
                  title="PDF diferido e imágenes PNG se habilitan en Pieza EXPORT-2"
                  className="rounded border border-[#2E3446] bg-[#141824] px-2 py-0.5 text-[10px] text-[#787B86]"
                >
                  PDF / PNG: EXPORT-2
                </span>
              </div>
            </div>
          </div>

          {activeIncompatible && activeObj && (
            <div className="flex items-start gap-2 rounded-[8px] border border-[#F5B544]/40 bg-[#F5B544]/10 px-3 py-2 text-[11px] text-[#F5B544]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                El vencimiento activo ({activeObj.expirationDate}, {formatDteLabel(activeObj.daysToExpiry)}) no pertenece al rango {mode === 'intraday' ? '0–1 DTE' : '6–17 DTE'}. No se amplía el rango DTE automáticamente; seleccioná fechas compatibles abajo.
              </span>
            </div>
          )}

          {/* Vencimientos compatibles (1 o 2) */}
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[10.5px] uppercase tracking-wider text-[#787B86]">
              <span>Vencimientos compatibles (máx. 2)</span>
              <span>{String(selectedExpirations.length)}/2 seleccionados</span>
            </div>
            {compatibleExpirations.length === 0 ? (
              <div className="rounded-[8px] border border-[#232733] bg-[#0A0D13] px-3 py-2.5 text-[11px] text-[#9CA3AF]">
                Sin vencimientos compatibles para modo {mode.toUpperCase()} en el catálogo actual.
              </div>
            ) : (
              <div className="grid max-h-[120px] grid-cols-1 sm:grid-cols-2 gap-1.5 overflow-y-auto pr-1">
                {compatibleExpirations.map((exp) => {
                  const checked = selectedExpirations.includes(exp.expirationDate);
                  return (
                    <button
                      key={exp.expirationDate}
                      type="button"
                      onClick={() => toggleExpiration(exp.expirationDate)}
                      className={`flex items-center justify-between rounded-[8px] border px-3 py-1.5 text-left text-[11.5px] transition-colors cursor-pointer ${
                        checked
                          ? 'border-[#8B7CF6]/70 bg-[#211B3A] text-white'
                          : 'border-[#232733] bg-[#0A0D13] text-[#9CA3AF] hover:border-[#3A4258] hover:text-white'
                      }`}
                    >
                      <span>
                        <span className="font-bold">{exp.expirationDate}</span>{' '}
                        <span className="text-[10.5px] text-[#787B86]">
                          ({formatDteLabel(exp.daysToExpiry)})
                        </span>
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9.5px] ${
                          exp.isLoaded
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-[#171B26] text-[#38BDF8]'
                        }`}
                      >
                        {exp.isLoaded ? 'En memoria (0 req)' : '1 req puntual'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Filtro explícito de cadena en modo Swing */}
          {mode === 'swing' && (
            <div>
              <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-[#787B86]">
                Filtro explícito de cadena Swing
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { id: 'DELTA_005_055' as const, label: 'Delta 0.05–0.55' },
                    { id: 'SIGMA_1_5' as const, label: 'Banda ±1.5σ' },
                    { id: 'SIGMA_2_0' as const, label: 'Banda ±2.0σ' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSwingFilter(opt.id)}
                    className={`rounded-[7px] border py-1.5 text-[11px] font-semibold transition-colors cursor-pointer ${
                      swingFilter === opt.id
                        ? 'border-[#8B7CF6]/70 bg-[#211B3A] text-white'
                        : 'border-[#232733] bg-[#0A0D13] text-[#9CA3AF] hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Barra reservada fija de estado/errores/tamaño (CLS = 0) */}
          <div className="min-h-[64px] rounded-[8px] border border-[#1E222D] bg-[#0A0D13] px-3 py-2 text-[11px]">
            {errorMsg ? (
              <div className="text-[#F23645]">{errorMsg}</div>
            ) : lastResult?.exceedsTargetBudget && !confirmOversized ? (
              <div className="space-y-1 text-[#F5B544]">
                <div>
                  El dossier completo mide {(lastResult.markdownByteLength / 1024).toFixed(1)} KB (supera el objetivo de 15.0 KB sin truncar filas). Volvé a presionar Copiar o Descargar para conservar el documento completo.
                </div>
              </div>
            ) : progressText ? (
              <div className="space-y-1 text-[#CBD0E4]">
                <div>{progressText}</div>
                {lastResult && lastResult.integrity.clockSkewWarnings.length > 0 && (
                  <div className="text-[10.5px] text-[#F5B544]">
                    Desfase/calidad: {lastResult.integrity.clockSkewWarnings.join(' · ')}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[#787B86]">
                Reutiliza estado congelado de memoria. Cancelable en cualquier momento sin modificar gráficos ni slices activos.
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1E222D] px-5 py-3">
          {running ? (
            <button
              type="button"
              onClick={handleCancelExport}
              className="rounded-full border border-[#F23645]/50 bg-[#F23645]/15 px-4 py-1.5 text-[12px] font-bold text-[#F23645] cursor-pointer"
            >
              Cancelar
            </button>
          ) : (
            <span className="text-[10.5px] text-[#787B86]">
              Schema v1.0.0 · ET / ART + UTC
            </span>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={running || compatibleExpirations.length === 0}
              onClick={() => void handleCopyMarkdown()}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#2E3446] bg-[#161B26] px-4 py-1.5 text-[12px] font-bold text-white hover:bg-[#1E2536] disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              {copiedOk ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copiedOk ? 'Copiado' : confirmOversized ? 'Confirmar Copiar MD' : 'Copiar MD'}</span>
            </button>
            <button
              type="button"
              disabled={running || compatibleExpirations.length === 0}
              onClick={() => void handleDownloadMarkdown()}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#8B7CF6] px-4 py-1.5 text-[12px] font-bold text-white hover:bg-[#7A6AE8] disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" />
              <span>{confirmOversized ? 'Confirmar Descargar .md' : 'Descargar .md'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ExportSnapshotModal;
