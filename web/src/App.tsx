import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart2,
  CandlestickChart,
  Command,
  Globe,
  HelpCircle,
  Home,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Zap,
} from 'lucide-react';
import {
  NULL_DISPLAY,
  TerminalApiError,
  fetchBars,
  fetchSnapshot,
  fetchUnusual,
  fmtUsd,
  fmtUtcTimeET,
  isFiniteNum,
  useRuntimeWebSocket,
  type RuntimeWsBroadcast,
  type TerminalBarsResponse,
  type TerminalSnapshotResponse,
  type TerminalUnusualResponse,
  type Timeframe,
} from './api/terminalClient';
import { DEFAULT_WATCHLIST_SYMBOLS, resolveSymbolMeta } from './data/marketData';
import { StatusBadge } from './components/DesignSystem';
import { MarketTickerBar } from './components/MarketTickerBar';
import {
  MacroRatesModule,
  OverviewModule,
  UnusualFlowModule,
  type NavSection,
} from './components/MarketModules';
import { OptionsModule, type OptionsSubView } from './components/OptionsModule';
import { CommandPaletteModal, ShortcutsModal } from './components/Overlays';
import { StockDetailView } from './components/StockDetailView';

const NAV_ITEMS: ReadonlyArray<{
  id: NavSection;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'overview', label: 'Overview', shortLabel: 'Home', icon: Home },
  { id: 'detail', label: 'Gráfico & Micro', shortLabel: 'Gráfico', icon: CandlestickChart },
  { id: 'options', label: 'Opciones & GEX', shortLabel: 'Opciones', icon: Layers },
  { id: 'macro', label: 'Macro UST/VIX', shortLabel: 'Macro', icon: Globe },
  { id: 'unusual', label: 'Unusual Flow', shortLabel: 'Flow', icon: Zap },
];

function formatApiErrorMessage(err: TerminalApiError | Error | null): string | null {
  if (err === null) {
    return null;
  }
  if (err instanceof TerminalApiError) {
    return `${err.reason}: ${err.detail}`;
  }
  return err.message;
}

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSection>('detail');
  const [optionsSubView, setOptionsSubView] = useState<OptionsSubView>('chain');
  const [selectedSymbol, setSelectedSymbol] = useState<string>('SPY');
  const [timeframe, setTimeframe] = useState<Timeframe>('5m');
  const [rthOnly, setRthOnly] = useState<boolean>(true);

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [commandOpen, setCommandOpen] = useState<boolean>(false);
  const [shortcutsOpen, setShortcutsOpen] = useState<boolean>(false);
  const [quickTickerInput, setQuickTickerInput] = useState<string>('');

  const [snapshot, setSnapshot] = useState<TerminalSnapshotResponse | null>(null);
  const [barsData, setBarsData] = useState<TerminalBarsResponse | null>(null);
  const [unusual, setUnusual] = useState<TerminalUnusualResponse | null>(null);

  const [snapshotLoading, setSnapshotLoading] = useState<boolean>(true);
  const [barsLoading, setBarsLoading] = useState<boolean>(true);
  const [unusualLoading, setUnusualLoading] = useState<boolean>(true);

  const [snapshotError, setSnapshotError] = useState<TerminalApiError | Error | null>(null);
  const [barsError, setBarsError] = useState<TerminalApiError | Error | null>(null);
  const [unusualError, setUnusualError] = useState<TerminalApiError | Error | null>(null);

  const [liveWsEvent, setLiveWsEvent] = useState<RuntimeWsBroadcast | null>(null);
  const [refreshNonce, setRefreshNonce] = useState<number>(0);
  const forceRefreshRef = useRef<boolean>(false);
  const [unusualFilter, setUnusualFilter] = useState<{
    readonly root?: string;
    readonly minPremium?: number;
  }>({});

  const triggerRefresh = useCallback((forceServerRefresh = true) => {
    forceRefreshRef.current = forceServerRefresh;
    setRefreshNonce((prev) => prev + 1);
  }, []);

  const handleSelectSymbol = useCallback((nextSymbol: string) => {
    const clean = nextSymbol.trim().toUpperCase();
    if (clean === '') {
      return;
    }
    setSelectedSymbol(clean);
    setLiveWsEvent(null);
    setUnusualFilter({});
  }, []);

  // Fetch Snapshot
  useEffect(() => {
    const controller = new AbortController();
    const forceRefresh = forceRefreshRef.current;
    setSnapshotLoading(true);
    setSnapshotError(null);

    void fetchSnapshot(selectedSymbol, {
      refresh: forceRefresh,
      signal: controller.signal,
    })
      .then((res) => {
        if (controller.signal.aborted) return;
        setSnapshot(res);
        setSnapshotError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setSnapshot(null);
        setSnapshotError(
          err instanceof Error ? err : new Error('Error desconocido cargando snapshot'),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setSnapshotLoading(false);
        }
      });

    return () => controller.abort();
  }, [selectedSymbol, refreshNonce]);

  // Fetch OHLCV Bars & Indicators
  useEffect(() => {
    const controller = new AbortController();
    const forceRefresh = forceRefreshRef.current;
    setBarsLoading(true);
    setBarsError(null);
    setLiveWsEvent(null);

    void fetchBars(
      {
        symbol: selectedSymbol,
        timeframe,
        visibleBars: 240,
        rthOnly,
        refresh: forceRefresh,
      },
      controller.signal,
    )
      .then((res) => {
        if (controller.signal.aborted) return;
        setBarsData(res);
        setBarsError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setBarsData(null);
        setBarsError(
          err instanceof Error ? err : new Error('Error desconocido cargando barras'),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setBarsLoading(false);
        }
      });

    return () => controller.abort();
  }, [selectedSymbol, timeframe, rthOnly, refreshNonce]);

  // Fetch Unusual Options Flow
  useEffect(() => {
    const controller = new AbortController();
    const forceRefresh = forceRefreshRef.current;
    forceRefreshRef.current = false;
    setUnusualLoading(true);
    setUnusualError(null);

    void fetchUnusual(
      {
        symbol: selectedSymbol,
        ...(unusualFilter.root !== undefined ? { root: unusualFilter.root } : {}),
        ...(unusualFilter.minPremium !== undefined
          ? { minPremium: unusualFilter.minPremium }
          : {}),
        limit: 100,
        refresh: forceRefresh,
      },
      controller.signal,
    )
      .then((res) => {
        if (controller.signal.aborted) return;
        setUnusual(res);
        setUnusualError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setUnusual(null);
        setUnusualError(
          err instanceof Error ? err : new Error('Error desconocido cargando unusual flow'),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setUnusualLoading(false);
        }
      });

    return () => controller.abort();
  }, [selectedSymbol, unusualFilter, refreshNonce]);

  // Live Runtime WebSocket subscription
  const wsSymbols = useMemo(() => {
    const base = new Set<string>(['SPY', 'QQQ', 'I:SPX', selectedSymbol]);
    return Array.from(base);
  }, [selectedSymbol]);

  const handleWsBroadcast = useCallback(
    (event: RuntimeWsBroadcast) => {
      if (event.type === 'bar_update') {
        if (event.symbol === selectedSymbol) {
          setLiveWsEvent(event);
        }
        const barPrice = event.formingBar?.close ?? event.lastClosedBar?.close ?? null;
        if (isFiniteNum(barPrice)) {
          setSnapshot((prev) => {
            if (prev === null) return prev;
            let touched = false;
            const updatedQuotes = prev.marketContext.unifiedQuotes.map((q) => {
              if (q.ticker !== event.symbol) return q;
              touched = true;
              const prevClose = q.previousClose;
              const nextChange = isFiniteNum(prevClose) ? barPrice - prevClose : q.change;
              const nextChangePct =
                isFiniteNum(prevClose) && prevClose > 0
                  ? ((barPrice - prevClose) / prevClose) * 100
                  : q.changePct;
              return {
                ...q,
                price: barPrice,
                change: nextChange,
                changePct: nextChangePct,
              };
            });
            if (!touched) return prev;
            return {
              ...prev,
              marketContext: {
                ...prev.marketContext,
                unifiedQuotes: updatedQuotes,
              },
            };
          });
        }
        return;
      }

      if (event.type === 'trade') {
        if (event.symbol === selectedSymbol) {
          setLiveWsEvent(event);
        }
        if (isFiniteNum(event.price)) {
          setSnapshot((prev) => {
            if (prev === null) return prev;
            let touched = false;
            const updatedQuotes = prev.marketContext.unifiedQuotes.map((q) => {
              if (q.ticker !== event.symbol) return q;
              touched = true;
              const prevClose = q.previousClose;
              const nextChange = isFiniteNum(prevClose) ? event.price - prevClose : q.change;
              const nextChangePct =
                isFiniteNum(prevClose) && prevClose > 0
                  ? ((event.price - prevClose) / prevClose) * 100
                  : q.changePct;
              return {
                ...q,
                price: event.price,
                change: nextChange,
                changePct: nextChangePct,
              };
            });
            if (!touched) return prev;
            return {
              ...prev,
              marketContext: {
                ...prev.marketContext,
                unifiedQuotes: updatedQuotes,
              },
            };
          });
        }
        return;
      }

      if (event.type === 'quote' && event.symbol === selectedSymbol) {
        setLiveWsEvent(event);
      }
    },
    [selectedSymbol],
  );

  const wsState = useRuntimeWebSocket(wsSymbols, handleWsBroadcast);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((prev) => !prev);
        return;
      }

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase() ?? '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }

      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen((prev) => !prev);
      } else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        triggerRefresh(true);
      } else if (e.key === '1') {
        setActiveSection('overview');
      } else if (e.key === '2') {
        setActiveSection('detail');
      } else if (e.key === '3') {
        setActiveSection('options');
      } else if (e.key === '4') {
        setActiveSection('macro');
      } else if (e.key === '5') {
        setActiveSection('unusual');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [triggerRefresh]);

  const activeMeta = useMemo(() => resolveSymbolMeta(selectedSymbol), [selectedSymbol]);
  const snapshotSpot = snapshot?.envelope.snapshot.metrics.spot ?? null;
  const anyLoading = snapshotLoading || barsLoading || unusualLoading;
  const snapshotErrorDetail = formatApiErrorMessage(snapshotError);

  const effectiveTopStatus: 'OK' | 'PARTIAL' | 'NO_DATA' =
    snapshot === null && snapshotError !== null
      ? 'NO_DATA'
      : snapshot?.status === 'PARTIAL' || barsData?.status === 'PARTIAL'
        ? 'PARTIAL'
        : snapshot !== null || barsData !== null
          ? 'OK'
          : 'NO_DATA';

  return (
    <div className="min-h-screen flex bg-[var(--bg-app)] text-[var(--text-primary)]">
      {/* Left Navigation Sidebar */}
      <aside
        className={`hidden md:flex flex-col shrink-0 bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] transition-all duration-150 ${
          sidebarCollapsed ? 'w-[68px]' : 'w-[228px]'
        }`}
      >
        {/* Brand Header */}
        <div className="h-12 px-3 flex items-center justify-between border-b border-[var(--border-subtle)]">
          {!sidebarCollapsed && (
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-[8px] qc-cta-primary flex items-center justify-center shrink-0">
                <Activity className="w-4 h-4 text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-[12.5px] font-bold tracking-tight truncate">
                  QuantOptions
                </div>
                <div className="text-[10px] font-mono-num text-[var(--text-tertiary)] truncate">
                  US TERMINAL
                </div>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            title={sidebarCollapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral'}
            className="p-1.5 rounded-[7px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] cursor-pointer mx-auto"
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="p-2 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
                title={item.label}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[9px] text-[12.5px] font-semibold transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#2A2444] text-[#F3F3F9] border border-[#6E56CF]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-1)] border border-transparent'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-[#8B7CF6]' : ''}`} />
                {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* Watchlist Strip */}
        {!sidebarCollapsed && (
          <div className="mt-2 px-3 pt-3 border-t border-[var(--border-subtle)] flex-1 overflow-y-auto">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono-num uppercase tracking-wider text-[var(--text-tertiary)]">
                Watchlist US
              </span>
              <BarChart2 className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
            </div>
            <div className="space-y-1">
              {DEFAULT_WATCHLIST_SYMBOLS.map((item) => {
                const isSelected = item.ticker === selectedSymbol;
                const matchedQuote = snapshot?.marketContext.unifiedQuotes.find(
                  (q) => q.ticker === item.ticker,
                );
                return (
                  <button
                    key={item.ticker}
                    type="button"
                    onClick={() => handleSelectSymbol(item.ticker)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-[8px] text-[12px] font-mono-num transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--surface-2)] text-[var(--text-primary)] border border-[var(--border-strong)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-1)] border border-transparent'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: item.accentColor }}
                      />
                      <span className="font-semibold truncate">{item.ticker}</span>
                    </span>
                    <span className="text-[11px] text-[#A4A4BA]">
                      {matchedQuote && isFiniteNum(matchedQuote.price)
                        ? fmtUsd(matchedQuote.price)
                        : item.venue}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Sidebar Footer */}
        <div className="p-2 border-t border-[var(--border-subtle)] mt-auto">
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            className="w-full flex items-center justify-center gap-2 px-2.5 py-2 rounded-[8px] text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-1)] cursor-pointer"
          >
            <HelpCircle className="w-4 h-4 shrink-0" />
            {!sidebarCollapsed && <span>Atajos & Política (?)</span>}
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Live Ticker Bar */}
        <MarketTickerBar
          activeSymbol={selectedSymbol}
          marketContext={snapshot?.marketContext ?? null}
          asOfUtcSec={snapshot?.asOfUtcSec ?? barsData?.asOfUtcSec ?? null}
          wsStatus={wsState.connectionStatus}
          onSelectSymbol={handleSelectSymbol}
        />

        {/* Top Header */}
        <header className="h-12 px-3 sm:px-4 bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: activeMeta.accentColor }}
              />
              <span className="font-mono-num font-bold text-[15px] text-[var(--text-primary)]">
                {selectedSymbol}
              </span>
              <span className="hidden lg:inline text-[12px] text-[var(--text-tertiary)] truncate max-w-[200px]">
                {activeMeta.name}
              </span>
            </div>

            <span className="hidden sm:inline font-mono-num text-[13px] font-semibold text-[#F3F3F9] px-2 py-0.5 rounded bg-[var(--surface-1)] border border-[var(--border-subtle)]">
              {isFiniteNum(snapshotSpot) ? fmtUsd(snapshotSpot) : NULL_DISPLAY}
            </span>

            {effectiveTopStatus === 'PARTIAL' && <StatusBadge status="PARTIAL" />}
            {effectiveTopStatus === 'NO_DATA' && !anyLoading && <StatusBadge status="NO_DATA" />}
          </div>

          <div className="flex items-center gap-2">
            {/* Inline Ticker Switcher */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (quickTickerInput.trim() !== '') {
                  handleSelectSymbol(quickTickerInput);
                  setQuickTickerInput('');
                }
              }}
              className="hidden sm:flex items-center bg-[var(--surface-1)] border border-[var(--border-subtle)] rounded-[8px] px-2 py-1"
            >
              <Search className="w-3.5 h-3.5 text-[var(--text-tertiary)] mr-1.5" />
              <input
                type="text"
                value={quickTickerInput}
                onChange={(e) => setQuickTickerInput(e.target.value)}
                placeholder="Ticker (SPY, I:SPX…)"
                className="w-32 bg-transparent text-[12px] font-mono-num uppercase text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none"
              />
            </form>

            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] bg-[var(--surface-1)] hover:bg-[var(--surface-2)] border border-[var(--border-subtle)] text-[12px] text-[var(--text-secondary)] cursor-pointer"
            >
              <Command className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
              <span className="hidden md:inline">Buscar</span>
              <kbd className="hidden lg:inline text-[10px] font-mono-num px-1 rounded bg-[var(--surface-2)] text-[var(--text-tertiary)]">
                Ctrl+K
              </kbd>
            </button>

            <button
              type="button"
              onClick={() => triggerRefresh(true)}
              title="Recargar datos desde servidor (R)"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] bg-[var(--surface-1)] hover:bg-[var(--surface-2)] border border-[var(--border-subtle)] text-[12px] text-[var(--text-primary)] cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${anyLoading ? 'animate-spin' : ''}`} />
              <span className="hidden md:inline">Actualizar</span>
            </button>

            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              aria-label="Atajos e integridad"
              className="p-1.5 rounded-[8px] bg-[var(--surface-1)] hover:bg-[var(--surface-2)] border border-[var(--border-subtle)] text-[var(--text-secondary)] cursor-pointer"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Mobile Bottom/Top Compact Nav */}
        <div className="flex md:hidden items-center gap-1 px-2 py-1.5 bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] overflow-x-auto no-scrollbar">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[7px] text-[11.5px] font-semibold whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-[#2A2444] text-[#F3F3F9] border border-[#6E56CF]'
                    : 'text-[var(--text-secondary)]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{item.shortLabel}</span>
              </button>
            );
          })}
        </div>

        {/* Workspace Canvas */}
        <main className="flex-1 p-3 sm:p-4 lg:p-5 max-w-[1680px] w-full mx-auto">
          {activeSection === 'overview' && (
            <OverviewModule
              symbol={selectedSymbol}
              snapshot={snapshot}
              unusual={unusual}
              loading={snapshotLoading}
              error={snapshotError}
              onSelectSymbol={handleSelectSymbol}
              onNavigate={setActiveSection}
              onRetry={() => triggerRefresh(true)}
            />
          )}

          {activeSection === 'detail' && (
            <StockDetailView
              symbol={selectedSymbol}
              timeframe={timeframe}
              rthOnly={rthOnly}
              snapshot={snapshot}
              barsData={barsData}
              snapshotLoading={snapshotLoading}
              barsLoading={barsLoading}
              snapshotError={snapshotError}
              barsError={barsError}
              liveWsEvent={liveWsEvent}
              onBack={() => setActiveSection('overview')}
              onSelectSymbol={handleSelectSymbol}
              onTimeframeChange={setTimeframe}
              onRthToggle={setRthOnly}
              onOpenOptions={(sym) => {
                handleSelectSymbol(sym);
                setActiveSection('options');
              }}
              onRetry={() => triggerRefresh(true)}
            />
          )}

          {activeSection === 'options' && (
            <OptionsModule
              symbol={selectedSymbol}
              snapshot={snapshot}
              unusual={unusual}
              loading={snapshotLoading}
              errorDetail={snapshotErrorDetail}
              subView={optionsSubView}
              onSubViewChange={setOptionsSubView}
              onRetry={() => triggerRefresh(true)}
            />
          )}

          {activeSection === 'macro' && (
            <MacroRatesModule
              symbol={selectedSymbol}
              snapshot={snapshot}
              loading={snapshotLoading}
              error={snapshotError}
              onRetry={() => triggerRefresh(true)}
            />
          )}

          {activeSection === 'unusual' && (
            <UnusualFlowModule
              symbol={selectedSymbol}
              unusual={unusual}
              loading={unusualLoading}
              error={unusualError}
              onRefresh={(opts) => {
                setUnusualFilter(opts);
                triggerRefresh(true);
              }}
            />
          )}
        </main>

        {/* Truthful Server & Engine Footer */}
        <footer className="px-4 py-2 bg-[var(--bg-sidebar)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-num text-[var(--text-tertiary)]">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              WS:{' '}
              <strong
                className={
                  wsState.connectionStatus === 'connected'
                    ? 'text-[#2EDC7E]'
                    : wsState.connectionStatus === 'connecting'
                      ? 'text-[#F5B544]'
                      : 'text-[#FF5C63]'
                }
              >
                {wsState.connectionStatus.toUpperCase()}
              </strong>
            </span>
            <span>
              Last WS Sync:{' '}
              {wsState.lastServerTimeSec !== null
                ? fmtUtcTimeET(wsState.lastServerTimeSec)
                : NULL_DISPLAY}
            </span>
            {wsState.lastStatusMessage !== null && (
              <span className="truncate max-w-[420px] text-[#A4A4BA]">
                {wsState.lastStatusMessage}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span>Chart Engine: @luxalgo/vela</span>
            <span>Policy: Zero Silent Fallbacks (NaN → —)</span>
          </div>
        </footer>
      </div>

      {/* Modals */}
      <CommandPaletteModal
        open={commandOpen}
        activeSymbol={selectedSymbol}
        onClose={() => setCommandOpen(false)}
        onSelectSymbol={handleSelectSymbol}
        onSelectSection={setActiveSection}
      />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
