import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Keyboard, Search, Sparkles, TrendingUp, X } from 'lucide-react';
import { DEFAULT_WATCHLIST_SYMBOLS } from '../data/marketData';
import type { NavSection } from './MarketModules';

const SECTION_ITEMS: ReadonlyArray<{
  id: NavSection;
  label: string;
  subtitle: string;
  shortcut: string;
}> = [
  {
    id: 'overview',
    label: 'Overview Ejecutivo',
    subtitle: 'Score de confluencia, contexto macro y flujo inusual',
    shortcut: '1',
  },
  {
    id: 'detail',
    label: 'Gráfico & Microestructura',
    subtitle: 'Velas @luxalgo/vela, subasta 04:00–10:30 ET, MTF, CVD y niveles',
    shortcut: '2',
  },
  {
    id: 'options',
    label: 'Opciones & GEX',
    subtitle: 'Cadena, GEX/DEX/Vanna/Charm, Superficie IV, Payoff y Flow',
    shortcut: '3',
  },
  {
    id: 'macro',
    label: 'Macro Rates & Volatilidad',
    subtitle: 'Curva UST, SOFR, VIX, CBOE SKEW y Breadth A/D Line',
    shortcut: '4',
  },
  {
    id: 'unusual',
    label: 'Unusual Options Flow',
    subtitle: 'Sweeps, bloques, ISO y prima inusual desde Massive',
    shortcut: '5',
  },
];

export const CommandPaletteModal: React.FC<{
  open: boolean;
  activeSymbol: string;
  onClose: () => void;
  onSelectSymbol: (symbol: string) => void;
  onSelectSection: (section: NavSection) => void;
}> = ({ open, activeSymbol, onClose, onSelectSymbol, onSelectSection }) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 10);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const normalizedQuery = query.trim().toUpperCase();

  const matchingSymbols = useMemo(() => {
    if (!normalizedQuery) return DEFAULT_WATCHLIST_SYMBOLS;
    return DEFAULT_WATCHLIST_SYMBOLS.filter(
      (item) =>
        item.ticker.toUpperCase().includes(normalizedQuery) ||
        item.name.toUpperCase().includes(normalizedQuery) ||
        item.venue.toUpperCase().includes(normalizedQuery),
    );
  }, [normalizedQuery]);

  const matchingSections = useMemo(() => {
    if (!normalizedQuery) return SECTION_ITEMS;
    return SECTION_ITEMS.filter(
      (sec) =>
        sec.label.toUpperCase().includes(normalizedQuery) ||
        sec.subtitle.toUpperCase().includes(normalizedQuery),
    );
  }, [normalizedQuery]);

  const canLaunchCustomTicker =
    normalizedQuery.length > 0 &&
    /^[A-Z0-9.:^-]{1,16}$/.test(normalizedQuery) &&
    !DEFAULT_WATCHLIST_SYMBOLS.some((s) => s.ticker === normalizedQuery);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-[2px] pt-[12vh] px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[580px] rounded-[14px] bg-[var(--bg-sidebar)] border border-[var(--border-strong)] overflow-hidden"
        style={{ boxShadow: 'var(--elev-3)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--surface-1)]">
          <Search className="w-4 h-4 text-[var(--accent-primary)] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (canLaunchCustomTicker) {
                  onSelectSymbol(normalizedQuery);
                  onClose();
                } else if (matchingSymbols[0]) {
                  onSelectSymbol(matchingSymbols[0].ticker);
                  onClose();
                } else if (matchingSections[0]) {
                  onSelectSection(matchingSections[0].id);
                  onClose();
                }
              }
            }}
            placeholder="Buscar ticker US (SPY, QQQ, I:SPX, NVDA…) o módulo…"
            className="flex-1 bg-transparent text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none"
          />
          <kbd className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-[var(--surface-2)] text-[var(--text-tertiary)] border border-[var(--border-subtle)]">
            ESC
          </kbd>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar paleta de comandos"
            className="p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[420px] overflow-y-auto p-3 space-y-4">
          {canLaunchCustomTicker && (
            <div>
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[var(--text-tertiary)] px-2 mb-1.5">
                Cargar ticker desde servidor local
              </div>
              <button
                type="button"
                onClick={() => {
                  onSelectSymbol(normalizedQuery);
                  onClose();
                }}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-[10px] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--accent-primary)]/40 text-left cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  <Sparkles className="w-4 h-4 text-[var(--accent-primary)]" />
                  <span className="font-mono-num font-bold text-[13px] text-[var(--text-primary)]">
                    {normalizedQuery}
                  </span>
                  <span className="text-[12px] text-[var(--text-secondary)]">
                    Consultar snapshot, barras y cadena de opciones en vivo
                  </span>
                </div>
                <ArrowRight className="w-4 h-4 text-[var(--accent-primary)]" />
              </button>
            </div>
          )}

          {matchingSymbols.length > 0 && (
            <div>
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[var(--text-tertiary)] px-2 mb-1.5">
                Activos disponibles
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {matchingSymbols.map((item) => {
                  const isActive = item.ticker === activeSymbol;
                  return (
                    <button
                      key={item.ticker}
                      type="button"
                      onClick={() => {
                        onSelectSymbol(item.ticker);
                        onClose();
                      }}
                      className={`flex items-center justify-between px-3 py-2 rounded-[9px] border text-left transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-[#2A2444] border-[#6E56CF] text-[var(--text-primary)]'
                          : 'bg-[var(--surface-1)] border-[var(--border-subtle)] hover:bg-[var(--surface-2)] text-[var(--text-primary)]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: item.accentColor }}
                          />
                          <span className="font-mono-num font-bold text-[12.5px]">
                            {item.ticker}
                          </span>
                          <span className="text-[10px] font-mono-num uppercase text-[var(--text-tertiary)]">
                            {item.assetType}
                          </span>
                        </div>
                        <div className="text-[11px] text-[var(--text-secondary)] truncate pl-4">
                          {item.name}
                        </div>
                      </div>
                      <span className="text-[10px] font-mono-num text-[var(--text-tertiary)] ml-2 shrink-0">
                        {item.venue}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {matchingSections.length > 0 && (
            <div>
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[var(--text-tertiary)] px-2 mb-1.5">
                Módulos de terminal
              </div>
              <div className="space-y-1">
                {matchingSections.map((sec) => (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => {
                      onSelectSection(sec.id);
                      onClose();
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-[9px] bg-[var(--surface-1)] hover:bg-[var(--surface-2)] border border-[var(--border-subtle)] text-left cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <TrendingUp className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                          {sec.label}
                        </div>
                        <div className="text-[11px] text-[var(--text-secondary)] truncate">
                          {sec.subtitle}
                        </div>
                      </div>
                    </div>
                    <kbd className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-[var(--surface-2)] text-[var(--text-tertiary)] border border-[var(--border-subtle)]">
                      {sec.shortcut}
                    </kbd>
                  </button>
                ))}
              </div>
            </div>
          )}

          {matchingSymbols.length === 0 &&
            matchingSections.length === 0 &&
            !canLaunchCustomTicker && (
              <div className="py-8 text-center text-[12px] text-[var(--text-tertiary)]">
                Sin coincidencias para "{query.trim()}".
              </div>
            )}
        </div>
      </div>
    </div>
  );
};

export const ShortcutsModal: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const shortcuts: ReadonlyArray<{ keys: string; desc: string }> = [
    { keys: 'Ctrl / Cmd + K', desc: 'Abrir paleta de búsqueda y cambio rápido de símbolo' },
    { keys: '1 – 5', desc: 'Cambiar de módulo (Overview, Gráfico, Opciones, Macro, Flow)' },
    { keys: 'R', desc: 'Refrescar snapshot, barras y unusual flow desde servidor' },
    { keys: '?', desc: 'Mostrar u ocultar esta ayuda de atajos' },
    { keys: 'ESC', desc: 'Cerrar modales activos' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px] px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[460px] rounded-[14px] bg-[var(--bg-sidebar)] border border-[var(--border-strong)] p-5 space-y-4"
        style={{ boxShadow: 'var(--elev-3)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-[var(--accent-primary)]" />
            <h3 className="text-[14px] font-bold text-[var(--text-primary)]">
              Atajos e Integridad de Datos
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar ventana de atajos"
            className="p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-2">
          {shortcuts.map((row) => (
            <div
              key={row.keys}
              className="flex items-center justify-between gap-3 py-1.5 border-b border-[var(--border-subtle)] last:border-b-0"
            >
              <span className="text-[12px] text-[var(--text-secondary)]">{row.desc}</span>
              <kbd className="text-[11px] font-mono-num px-2 py-0.5 rounded bg-[var(--surface-2)] text-[var(--text-primary)] border border-[var(--border-subtle)] shrink-0">
                {row.keys}
              </kbd>
            </div>
          ))}
        </div>

        <div className="rounded-[10px] bg-[var(--surface-1)] border border-[var(--border-subtle)] p-3 text-[11px] text-[var(--text-secondary)] space-y-1">
          <div className="font-semibold text-[var(--text-primary)]">
            Política Zero Silent Fallbacks
          </div>
          <div>
            Todos los cálculos cuantitativos corren en servidor puro TypeScript sobre feeds
            Massive en segundos UTC enteros. Cualquier métrica no calculable se renderiza como{' '}
            <span className="font-mono-num text-[#6D6D84]">—</span> sin valores sintéticos de respaldo.
          </div>
        </div>
      </div>
    </div>
  );
};
