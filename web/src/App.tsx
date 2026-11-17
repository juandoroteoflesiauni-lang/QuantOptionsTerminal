import React, { useState, useEffect } from 'react';
import {
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Bell,
  RefreshCw,
  HelpCircle,
  Plus,
  Home,
  Landmark,
  Globe,
  Activity,
  Layers,
  TrendingUp,
  BarChart2,
  GitCompare,
  Briefcase,
  LayoutGrid,
  Settings,
  ChevronDown,
  ChevronRight,
  Sun,
  Moon,
  CheckCircle2,
  CandlestickChart,
  Scale,
} from 'lucide-react';
import {
  GLOBAL_INDICATORS,
  AR_STOCKS,
  INITIAL_POSITIONS,
  INITIAL_ALERTS,
  PortfolioPosition,
  AlertItem,
  fmtNum,
  fmtPctTable,
} from './data/marketData';
import { startLiveRuntimePolling, useLiveMarketState } from './data/liveRuntimeBridge';
import { HelpTooltip } from './components/DesignSystem';
import { OptionsModule, OptionsSubView } from './components/OptionsModule';
import { StockDetailView } from './components/StockDetailView';
import {
  HomeDashboard,
  MonitoringModule,
  MonitorSubPanel,
  MacroModule,
  USMarketModule,
  BondsCurveModule,
  FuturesModule,
  RatiosModule,
  PositionsModule,
  WorkspacesModule,
  AlertsModule,
  SettingsAndDesignSystemModule,
} from './components/MarketModules';
import { MarketTickerBar, MarketSessionState } from './components/MarketTickerBar';
import {
  OrderTicketDrawer,
  OrderTicketPreset,
  CommandPaletteModal,
  ShortcutsModal,
} from './components/Overlays';
import { GgalSpecialistModule } from './components/ggal/GgalSpecialistModule';

type PageId =
  | 'inicio'
  | 'macro'
  | 'eeuu'
  | 'monitoreo'
  | 'acciones'
  | 'opciones'
  | 'futuros'
  | 'bonos'
  | 'relaciones'
  | 'ggal-specialist'
  | 'posiciones'
  | 'espacios'
  | 'alertas'
  | 'configuracion';

export default function App() {
  // Estado principal de navegación
  const [activePage, setActivePage] = useState<PageId>('inicio');
  const [monitorPanel, setMonitorPanel] = useState<MonitorSubPanel>('acciones');
  const [optionsSubView, setOptionsSubView] = useState<OptionsSubView>('estrategias');
  const [selectedTicker, setSelectedTicker] = useState<string>('GGAL');
  const [selectedOptionsUnderlying, setSelectedOptionsUnderlying] = useState<string>('GGAL');

  // Estado de Shell y Diseño
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [monitorGroupOpen, setMonitorGroupOpen] = useState(true);
  const [optionsGroupOpen, setOptionsGroupOpen] = useState(true);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [density, setDensity] = useState<'densa' | 'normal' | 'comoda'>('normal');
  const [arMarketStatus, setArMarketStatus] = useState<MarketSessionState>('Abierto');
  const [liveTicksEnabled, setLiveTicksEnabled] = useState(true);

  // Modales y Drawers
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [orderDrawerOpen, setOrderDrawerOpen] = useState(false);
  const [orderPreset, setOrderPreset] = useState<OrderTicketPreset | null>(null);

  // Estado vivo desde backend real (/api/ar/*, /api/snapshot, /ws)
  const liveMarket = useLiveMarketState();
  const [positions, setPositions] = useState<PortfolioPosition[]>(INITIAL_POSITIONS);
  const [alerts, setAlerts] = useState<AlertItem[]>(INITIAL_ALERTS);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [clockStr, setClockStr] = useState(() => new Date().toTimeString().slice(0, 8));

  // Sincronizar atributo data-theme
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [theme]);

  // Reloj y polling / WebSocket en tiempo real (cero ticks simulados)
  useEffect(() => {
    const interval = setInterval(() => {
      setClockStr(new Date().toTimeString().slice(0, 8));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    return startLiveRuntimePolling(liveTicksEnabled);
  }, [liveTicksEnabled]);

  useEffect(() => {
    if (!liveMarket.marketState) return;
    if (liveMarket.marketState === 'ABIERTO') setArMarketStatus('Abierto');
    else if (liveMarket.marketState === 'SUBASTA' || liveMarket.marketState === 'PREMARKET') setArMarketStatus('Pre-Market');
    else setArMarketStatus('Cerrado');
  }, [liveMarket.marketState]);

  // Atajos de teclado globales (Ctrl+K, N, [, ?)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        // Pieza 36: dentro de Opciones, Ctrl+K pertenece al selector institucional.
        if (activePage === 'opciones') return;
        e.preventDefault();
        setCommandOpen((v) => !v);
        return;
      }
      if (isInput) return;

      if (e.key === '/') {
        if (activePage === 'opciones') return;
        e.preventDefault();
        setCommandOpen(true);
      } else if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setOrderDrawerOpen(true);
      } else if (e.key === '[') {
        e.preventDefault();
        setSidebarCollapsed((v) => !v);
      } else if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activePage]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 4200);
  };

  const handleOpenOrderTicket = (preset: OrderTicketPreset) => {
    setOrderPreset(preset);
    setOrderDrawerOpen(true);
  };

  const handleSelectStockDetail = (ticker: string) => {
    setSelectedTicker(ticker);
    setActivePage('acciones');
  };

  const cycleMarketStatus = (current: MarketSessionState): MarketSessionState => {
    const order: MarketSessionState[] = [
      'Abierto',
      'Pre-Market',
      'After-Hours',
      'Cerrado',
      'Feriado',
    ];
    return order[(order.indexOf(current) + 1) % order.length] ?? 'Abierto';
  };

  const routePathLabel: Record<PageId, string> = {
    inicio: '/inicio',
    macro: '/macro/argentina',
    eeuu: '/eeuu/wall-street',
    monitoreo: `/monitoreo/${monitorPanel}`,
    acciones: `/acciones/${selectedTicker}`,
    opciones: `/opciones/${selectedOptionsUnderlying}/${optionsSubView}`,
    futuros: '/futuros',
    bonos: '/bonos/curva-soberana',
    relaciones: '/relaciones',
    'ggal-specialist': '/ar/ggal-specialist',
    posiciones: '/posiciones',
    espacios: '/espacios',
    alertas: '/alertas',
    configuracion: '/configuracion',
  };

  const pageTitleMap: Record<PageId, string> = {
    inicio: 'Inicio · Panorama de Mercado en Vivo',
    macro: 'Macro Argentina y Condiciones Globales',
    eeuu: 'Mercado EE.UU. · S&P 500, VIX y Paridad CEDEARs',
    monitoreo: `Monitoreo en Vivo · ${
      monitorPanel === 'acciones'
        ? 'Acciones Líderes'
        : monitorPanel === 'bonos'
        ? 'Bonos y Letras'
        : monitorPanel === 'cedears'
        ? 'CEDEARs y ADRs'
        : 'Cauciones por Plazo'
    }`,
    acciones: `Ficha Técnica · ${selectedTicker} (Contado, ADR, 5 Puntas y VWAP)`,
    opciones: `Opciones · ${selectedOptionsUnderlying} (${optionsSubView.toUpperCase()})`,
    futuros: 'Futuros Rofex DLR y Sintéticos USD',
    bonos: 'Bonos Soberanos · Curva TIR vs. Duration',
    relaciones: 'Relaciones y Arbitraje Estadístico (Z-Score)',
    'ggal-specialist': 'GGAL Specialist · Dual BYMA / ADR / OPRA / IAMC',
    posiciones: 'Posiciones y Riesgo Agregado de Cartera',
    espacios: 'Espacios de Trabajo Multimonitor',
    alertas: 'Centro de Alertas Cuantitativas',
    configuracion: 'Configuración y Sistema de Diseño (Figma v1.0)',
  };

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg-app)] text-[var(--text-primary)]">
      {/* BARRA SUPERIOR DE MERCADO CON MARQUEE INFINITO (`MarketTickerBar`) */}
      <MarketTickerBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        marketStatus={arMarketStatus}
        feedStatus={liveMarket.feedStatus}
        onCycleMarketStatus={() => setArMarketStatus(cycleMarketStatus(arMarketStatus))}
        onSelectTicker={handleSelectStockDetail}
        onOpenCommandPalette={() => setCommandOpen(true)}
        onOpenAlerts={() => setActivePage('alertas')}
        hasUnreadAlerts={alerts.some((a) => a.status === 'Disparada')}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        liveFeedEnabled={liveTicksEnabled}
      />

      {/* Banner contextual si el usuario simula mercado cerrado / feriado */}
      {arMarketStatus !== 'Abierto' && (
        <div className="bg-[#35280F] border-b border-[#F5B544]/40 px-4 py-1.5 flex items-center justify-between text-[12px] text-[#F5B544]">
          <span>
            Estado BYMA ({liveMarket.feedStatus}): <strong>{arMarketStatus}</strong> — {liveMarket.marketStateLabel}
          </span>
          <button
            type="button"
            onClick={() => setArMarketStatus('Abierto')}
            className="underline font-semibold cursor-pointer"
          >
            Ocultar aviso
          </button>
        </div>
      )}

      {/* CUERPO PRINCIPAL: SIDEBAR (232 px / 64 px) + CONTENIDO */}
      <div className="flex-1 flex min-h-0">
        <aside
          className={`${
            sidebarCollapsed ? 'w-[64px]' : 'w-[232px]'
          } shrink-0 bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] flex flex-col justify-between p-2.5 transition-all duration-200 select-none`}
        >
          <div className="space-y-1">
            {/* Árbol de Navegación (14 módulos) */}
            <nav className="space-y-0.5 text-[12px]">
              {/* Inicio */}
              <button
                type="button"
                onClick={() => setActivePage('inicio')}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                  activePage === 'inicio'
                    ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <Home className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
                {!sidebarCollapsed && <span>Inicio</span>}
              </button>

              {/* Macro */}
              <button
                type="button"
                onClick={() => setActivePage('macro')}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                  activePage === 'macro'
                    ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <Landmark className="w-4 h-4 shrink-0 text-[#4BA3FF]" />
                {!sidebarCollapsed && <span>Macro (AR · Mundo)</span>}
              </button>

              {/* Mercado EE.UU. */}
              <button
                type="button"
                onClick={() => setActivePage('eeuu')}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                  activePage === 'eeuu'
                    ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <Globe className="w-4 h-4 shrink-0 text-[#2EDC7E]" />
                {!sidebarCollapsed && <span>Mercado EE.UU.</span>}
              </button>

              {/* Grupo Plegable: Monitoreo ▾ */}
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setActivePage('monitoreo');
                    if (!sidebarCollapsed) setMonitorGroupOpen((v) => !v);
                  }}
                  className={`w-full flex items-center justify-between px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                    activePage === 'monitoreo'
                      ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Activity className="w-4 h-4 shrink-0 text-[#F5B544]" />
                    {!sidebarCollapsed && <span>Monitoreo</span>}
                  </span>
                  {!sidebarCollapsed &&
                    (monitorGroupOpen ? (
                      <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5" />
                    ))}
                </button>
                {!sidebarCollapsed && monitorGroupOpen && (
                  <div className="pl-7 pr-1 py-1 space-y-0.5">
                    {(
                      [
                        { id: 'acciones', label: 'Acciones' },
                        { id: 'bonos', label: 'Bonos y letras' },
                        { id: 'cedears', label: 'CEDEARs' },
                        { id: 'cauciones', label: 'Cauciones' },
                      ] as const
                    ).map((sub) => (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() => {
                          setMonitorPanel(sub.id);
                          setActivePage('monitoreo');
                        }}
                        className={`w-full text-left px-2.5 py-1 rounded-[6px] text-[11px] font-medium cursor-pointer ${
                          activePage === 'monitoreo' && monitorPanel === sub.id
                            ? 'text-[var(--accent-primary)] font-bold bg-[var(--surface-2)]'
                            : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {sub.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Detalle de Acción */}
              <button
                type="button"
                onClick={() => setActivePage('acciones')}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                  activePage === 'acciones'
                    ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <CandlestickChart className="w-4 h-4 shrink-0 text-[#34D3C7]" />
                  {!sidebarCollapsed && <span>Detalle de acción</span>}
                </span>
                {!sidebarCollapsed && (
                  <span className="text-[10px] font-mono-num px-1.5 py-0.2 rounded bg-[var(--surface-3)] text-[var(--text-secondary)]">
                    {selectedTicker}
                  </span>
                )}
              </button>

              {/* Grupo Plegable: Opciones ▾ (6 vistas) */}
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setActivePage('opciones');
                    if (!sidebarCollapsed) setOptionsGroupOpen((v) => !v);
                  }}
                  className={`w-full flex items-center justify-between px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                    activePage === 'opciones'
                      ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Layers className="w-4 h-4 shrink-0 text-[#4BA3FF]" />
                    {!sidebarCollapsed && <span>Opciones</span>}
                  </span>
                  {!sidebarCollapsed &&
                    (optionsGroupOpen ? (
                      <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5" />
                    ))}
                </button>
                {!sidebarCollapsed && optionsGroupOpen && (
                  <div className="pl-7 pr-1 py-1 space-y-0.5">
                    {(
                      [
                        { id: 'mapa', label: 'Mapa' },
                        { id: 'estrategias', label: 'Estrategias' },
                        { id: 'spreads', label: 'Spreads' },
                        { id: 'flujo', label: 'Flujo' },
                        { id: 'cadena', label: 'Cadena completa' },
                        { id: 'volatilidad', label: 'Volatilidad' },
                        { id: 'armado', label: 'Armado a mano' },
                      ] as const
                    ).map((sub) => (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() => {
                          setOptionsSubView(sub.id);
                          setActivePage('opciones');
                        }}
                        className={`w-full text-left px-2.5 py-1 rounded-[6px] text-[11px] font-medium cursor-pointer ${
                          activePage === 'opciones' && optionsSubView === sub.id
                            ? 'text-[#4BA3FF] font-bold bg-[var(--surface-2)]'
                            : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {sub.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Futuros */}
              <button
                type="button"
                onClick={() => setActivePage('futuros')}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                  activePage === 'futuros'
                    ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <TrendingUp className="w-4 h-4 shrink-0 text-[#E5558F]" />
                {!sidebarCollapsed && <span>Futuros</span>}
              </button>

              {/* Bonos */}
              <button
                type="button"
                onClick={() => setActivePage('bonos')}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                  activePage === 'bonos'
                    ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <BarChart2 className="w-4 h-4 shrink-0 text-[#2EDC7E]" />
                {!sidebarCollapsed && <span>Bonos (renta fija)</span>}
              </button>

              {/* Relaciones */}
              <button
                type="button"
                onClick={() => setActivePage('relaciones')}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                  activePage === 'relaciones'
                    ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <GitCompare className="w-4 h-4 shrink-0 text-[#FF8A4C]" />
                {!sidebarCollapsed && <span>Relaciones</span>}
              </button>

              {/* GGAL Specialist */}
              <button
                type="button"
                onClick={() => setActivePage('ggal-specialist')}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                  activePage === 'ggal-specialist'
                    ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Scale className="w-4 h-4 shrink-0 text-[#8B7CF6]" />
                  {!sidebarCollapsed && <span>GGAL Specialist</span>}
                </span>
                {!sidebarCollapsed && (
                  <span className="text-[9.5px] font-mono-num px-1.5 py-0.2 rounded bg-[#211B3A] text-[#C4B5FD]">
                    AR·US
                  </span>
                )}
              </button>

              {/* Posiciones */}
              <button
                type="button"
                onClick={() => setActivePage('posiciones')}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                  activePage === 'posiciones'
                    ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Briefcase className="w-4 h-4 shrink-0 text-[#8B7CF6]" />
                  {!sidebarCollapsed && <span>Posiciones</span>}
                </span>
                {!sidebarCollapsed && (
                  <span className="text-[10px] font-mono-num px-1.5 py-0.2 rounded bg-[#0E2F20] text-[#2EDC7E]">
                    {positions.length}
                  </span>
                )}
              </button>

              {/* Espacios */}
              <button
                type="button"
                onClick={() => setActivePage('espacios')}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[8px] font-semibold transition-colors cursor-pointer ${
                  activePage === 'espacios'
                    ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/50'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <LayoutGrid className="w-4 h-4 shrink-0 text-[var(--text-secondary)]" />
                {!sidebarCollapsed && <span>Espacios</span>}
              </button>
            </nav>
          </div>

          {/* Pie de Sidebar: Tarjeta de Plan + Configuración */}
          <div className="space-y-2 pt-3 border-t border-[var(--border-subtle)]">
            {!sidebarCollapsed && (
              <div className="p-2.5 rounded-[10px] bg-[var(--surface-2)] border border-[var(--border-subtle)] space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-[var(--text-primary)]">
                    Plan Quant Pro
                  </span>
                  <span className="text-[9px] font-mono-num uppercase px-1.5 py-0.2 rounded bg-[var(--accent-subtle)] text-[var(--accent-primary)]">
                    DMA + OPEX
                  </span>
                </div>
                <p className="text-[10px] text-[var(--text-tertiary)] leading-tight">
                  Datos BYMA + Rofex + NYSE en tiempo real.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={() => setActivePage('configuracion')}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[8px] text-[12px] font-semibold transition-colors cursor-pointer ${
                activePage === 'configuracion'
                  ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]'
              }`}
            >
              <Settings className="w-4 h-4 shrink-0" />
              {!sidebarCollapsed && <span>Configuración & Tokens</span>}
            </button>
          </div>
        </aside>

        {/* CONTENIDO CENTRAL (max-width 1680 px) */}
        <main className="flex-1 min-w-0 p-4 md:p-6 overflow-y-auto">
          <div className="max-w-[1680px] mx-auto space-y-4">
            {/* Cabecera contextual de ruta + selector rápido de densidad */}
            <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
              <div>
                <div className="flex items-center gap-2 text-[11px] font-mono-num text-[var(--text-tertiary)]">
                  <span>Quant Core</span>
                  <span>/</span>
                  <span className="text-[var(--accent-primary)]">{routePathLabel[activePage]}</span>
                </div>
                <h1 className="text-[20px] md:text-[24px] font-extrabold tracking-tight text-[var(--text-primary)]">
                  {pageTitleMap[activePage]}
                </h1>
              </div>

              <div className="flex items-center gap-2">
                {(!liveMarket.isBackendConnected || liveMarket.warmupStatus === 'WARMING_UP') && (
                  <span
                    title={
                      !liveMarket.isBackendConnected
                        ? 'Reconectando con el servidor backend...'
                        : 'Precargando universo 24/7 EOD e indicadores...'
                    }
                    className="hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded-[8px] border border-[#2A3347] bg-[#121722] text-[#9CA3AF] text-[10.5px] font-mono-num"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-[#EAB308] animate-pulse" />
                    {!liveMarket.isBackendConnected ? 'CONECTANDO...' : 'PRECARGANDO EOD...'}
                  </span>
                )}
                <span
                  title={liveMarket.marketStateLabel}
                  className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] border text-[11px] font-mono-num font-semibold ${
                    liveMarket.feedStatus === 'LIVE'
                      ? 'bg-[#0D221E] text-[#22C55E] border-[#164E3F]'
                      : liveMarket.feedStatus === 'EOD_CIERRE'
                      ? 'bg-[#132033] text-[#38BDF8] border-[#1E3A5F]'
                      : liveMarket.feedStatus === 'DIFERIDO_20M' || liveMarket.feedStatus === 'PARTIAL'
                      ? 'bg-[#281E0E] text-[#F5B544] border-[#59411A]'
                      : 'bg-[#1A1318] text-[#F23645] border-[#4A2229]'
                  }`}
                >
                  {liveMarket.feedStatus === 'EOD_CIERRE' ? 'EOD · ÚLTIMO CIERRE' : liveMarket.feedStatus}
                </span>
                <div className="hidden sm:flex items-center gap-1 p-1 rounded-[8px] bg-[var(--bg-sidebar)] border border-[var(--border-subtle)] text-[11px]">
                  <span className="px-2 text-[var(--text-tertiary)]">Densidad:</span>
                  {(['densa', 'normal', 'comoda'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDensity(d)}
                      className={`px-2 py-0.5 rounded capitalize cursor-pointer ${
                        density === d
                          ? 'bg-[var(--surface-3)] text-[var(--text-primary)] font-semibold'
                          : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Renderizado del módulo activo */}
            {activePage === 'inicio' && (
              <HomeDashboard
                tickFlashes={liveMarket.tickFlashes}
                onSelectStock={handleSelectStockDetail}
                onNavigate={(p) => setActivePage(p as PageId)}
                onOpenOrderTicket={handleOpenOrderTicket}
              />
            )}

            {activePage === 'monitoreo' && (
              <MonitoringModule
                subPanel={monitorPanel}
                onSelectSubPanel={setMonitorPanel}
                density={density}
                tickFlashes={liveMarket.tickFlashes}
                onSelectStock={handleSelectStockDetail}
                onOpenOrderTicket={handleOpenOrderTicket}
              />
            )}

            {activePage === 'acciones' && (
              <StockDetailView
                ticker={selectedTicker}
                onSelectTicker={setSelectedTicker}
                onGoToOptions={(t) => {
                  setSelectedOptionsUnderlying(t === 'GGAL' ? 'GGAL' : t);
                  setActivePage('opciones');
                }}
                onBackToMonitor={() => {
                  setMonitorPanel('acciones');
                  setActivePage('monitoreo');
                }}
                onOpenOrderTicket={handleOpenOrderTicket}
              />
            )}

            {activePage === 'opciones' && (
              <OptionsModule
                activeSubView={optionsSubView}
                onSelectSubView={setOptionsSubView}
                selectedUnderlying={selectedOptionsUnderlying}
                onSelectUnderlying={setSelectedOptionsUnderlying}
                density={density}
                onOpenOrderTicket={handleOpenOrderTicket}
              />
            )}

            {activePage === 'macro' && <MacroModule />}
            {activePage === 'eeuu' && <USMarketModule onOpenOrderTicket={handleOpenOrderTicket} />}
            {activePage === 'bonos' && <BondsCurveModule />}
            {activePage === 'futuros' && <FuturesModule />}
            {activePage === 'relaciones' && <RatiosModule />}
            {activePage === 'ggal-specialist' && (
              <GgalSpecialistModule onOpenOrderTicket={handleOpenOrderTicket} />
            )}
            {activePage === 'posiciones' && (
              <PositionsModule
                positions={positions}
                onOpenOrderTicket={handleOpenOrderTicket}
              />
            )}
            {activePage === 'espacios' && (
              <WorkspacesModule onNavigate={(p) => setActivePage(p as PageId)} />
            )}
            {activePage === 'alertas' && (
              <AlertsModule
                alerts={alerts}
                onAddAlert={(newAlert) => {
                  setAlerts((prev) => [newAlert, ...prev]);
                  showToast(`Alerta creada para ${newAlert.ticker} (${newAlert.target})`);
                }}
              />
            )}
            {activePage === 'configuracion' && (
              <SettingsAndDesignSystemModule
                theme={theme}
                onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
                density={density}
                onChangeDensity={setDensity}
                liveTicksEnabled={liveTicksEnabled}
                onToggleLiveTicks={() => setLiveTicksEnabled((v) => !v)}
              />
            )}
          </div>
        </main>
      </div>

      {/* DRAWER DE TICKET DE ORDEN (380 px) */}
      <OrderTicketDrawer
        open={orderDrawerOpen}
        preset={orderPreset}
        onClose={() => setOrderDrawerOpen(false)}
        onSubmitOrder={(ord) => {
          showToast(
            `Orden simulada enviada: ${ord.side.toUpperCase()} ${ord.qty} ${ord.ticker} @ $ ${fmtNum(
              ord.price,
              2
            )} (${ord.settlement})`
          );
        }}
      />

      {/* PALETA DE COMANDOS (CTRL K) */}
      <CommandPaletteModal
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onSelectStock={handleSelectStockDetail}
        onNavigate={(p) => setActivePage(p as PageId)}
        onOpenNewOrder={() => setOrderDrawerOpen(true)}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />

      {/* MODAL DE ATAJOS (?) */}
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* TOAST DE CONFIRMACIÓN */}
      {toastMessage && (
        <div
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-[12px] bg-[#0E2F20] border border-[#2EDC7E] text-white text-[13px] font-semibold"
          style={{ boxShadow: 'var(--elev-3)' }}
        >
          <CheckCircle2 className="w-4 h-4 text-[#2EDC7E] shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
