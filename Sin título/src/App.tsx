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

  // Estado vivo de cartera, alertas, ticks y notificaciones
  const [positions, setPositions] = useState<PortfolioPosition[]>(INITIAL_POSITIONS);
  const [alerts, setAlerts] = useState<AlertItem[]>(INITIAL_ALERTS);
  const [tickFlashes, setTickFlashes] = useState<Record<string, 'up' | 'down' | null>>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [clockStr, setClockStr] = useState('15:42:18');

  // Sincronizar atributo data-theme
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [theme]);

  // Reloj y motor de destello de ticks (600ms)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setClockStr(
        now.toTimeString().slice(0, 8)
      );
      if (!liveTicksEnabled || arMarketStatus === 'Cerrado' || arMarketStatus === 'Feriado') return;

      // Elegir 2 tickers al azar para parpadear
      const sample = ['GGAL', 'YPFD', 'PAMP', 'BMA', 'VISTA', 'SUPV', 'TGSU2'];
      const pick1 = sample[Math.floor(Math.random() * sample.length)];
      const pick2 = sample[Math.floor(Math.random() * sample.length)];
      const dir1: 'up' | 'down' = Math.random() > 0.42 ? 'up' : 'down';
      const dir2: 'up' | 'down' = Math.random() > 0.45 ? 'up' : 'down';

      setTickFlashes({ [pick1]: dir1, [pick2]: dir2 });
      setTimeout(() => {
        setTickFlashes({});
      }, 620);
    }, 2400);

    return () => clearInterval(interval);
  }, [liveTicksEnabled, arMarketStatus]);

  // Atajos de teclado globales (Ctrl+K, N, [, ?)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((v) => !v);
        return;
      }
      if (isInput) return;

      if (e.key === '/') {
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
  }, []);

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
    return order[(order.indexOf(current) + 1) % order.length];
  };

  const routePathLabel: Record<PageId, string> = {
    inicio: '/inicio',
    macro: '/macro/argentina',
    eeuu: '/eeuu/wall-street',
    monitoreo: `/monitoreo/${monitorPanel}`,
    acciones: `/acciones/${selectedTicker}`,
    opciones: `/opciones/${selectedTicker}/${optionsSubView}`,
    futuros: '/futuros',
    bonos: '/bonos/curva-soberana',
    relaciones: '/relaciones',
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
    opciones: `Opciones · ${selectedTicker} (${optionsSubView.toUpperCase()})`,
    futuros: 'Futuros Rofex DLR y Sintéticos USD',
    bonos: 'Bonos Soberanos · Curva TIR vs. Duration',
    relaciones: 'Relaciones y Arbitraje Estadístico (Z-Score)',
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
            Estado simulado BYMA: <strong>{arMarketStatus}</strong> — Mostrando precios de cierre de rueda y curvas de
            referencia para análisis fuera de horario.
          </span>
          <button
            type="button"
            onClick={() => setArMarketStatus('Abierto')}
            className="underline font-semibold cursor-pointer"
          >
            Volver a Rueda En Vivo
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
                tickFlashes={tickFlashes}
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
                tickFlashes={tickFlashes}
                onSelectStock={handleSelectStockDetail}
                onOpenOrderTicket={handleOpenOrderTicket}
              />
            )}

            {activePage === 'acciones' && (
              <StockDetailView
                ticker={selectedTicker}
                onSelectTicker={setSelectedTicker}
                onGoToOptions={(t) => {
                  setSelectedTicker(t);
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
                selectedUnderlying={selectedTicker}
                onSelectUnderlying={setSelectedTicker}
                density={density}
                onOpenOrderTicket={handleOpenOrderTicket}
              />
            )}

            {activePage === 'macro' && <MacroModule />}
            {activePage === 'eeuu' && <USMarketModule onOpenOrderTicket={handleOpenOrderTicket} />}
            {activePage === 'bonos' && <BondsCurveModule />}
            {activePage === 'futuros' && <FuturesModule />}
            {activePage === 'relaciones' && <RatiosModule />}
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
