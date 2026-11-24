import React, { memo, useCallback, useState, useEffect, useMemo, useRef } from 'react';
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
  AR_GENERAL_PANEL_STOCKS,
  INITIAL_POSITIONS,
  INITIAL_ALERTS,
  PortfolioPosition,
  AlertItem,
  fmtNum,
  fmtPctTable,
} from './data/marketData';
import { startLiveRuntimePolling, useLiveBridgeSelector, useLiveMarketStatus } from './data/liveRuntimeBridge';
import { useMarketViewScope } from './api/useMarketLiveStream';
import { parseOptionsUnderlyingKey } from './data/optionsUnderlying';
import { resolveStockDetailRoute } from './components/stock-detail/stockDetailRouting';
import { HelpTooltip } from './components/DesignSystem';
import { HomeDashboard } from './components/HomeDashboard';
import type { OptionsSubView } from './components/OptionsModule';
import type { MonitorSubPanel } from './components/MarketModules';
import { MarketTickerBar, MarketSessionState } from './components/MarketTickerBar';
import { useFeedsHealthConnection, useGlobalConnectivityProviders } from './data/feedsHealthStore';
import { resolveGlobalConnectivityStatus } from '../../src/core/stockDetailStability';
import type { OrderTicketPreset } from './components/Overlays';
import {
  createPrefetchHandlers,
  createRegisteredLazyModule,
  prefetchModule,
  schedulePostStartupIdleWarmup,
  type RoutedModuleId,
} from './perf/moduleRegistry';
import { ModuleLoadErrorBoundary } from './components/common/ModuleLoadErrorBoundary';
import {
  ModuleViewFallback,
  type FallbackLayoutVariant,
} from './components/common/ModuleViewFallback';

let marketModulesPromise: Promise<typeof import('./components/MarketModules')> | null = null;
function loadMarketModules(): Promise<typeof import('./components/MarketModules')> {
  if (marketModulesPromise === null) {
    marketModulesPromise = import('./components/MarketModules')
      .then((mod) => {
        queueMicrotask(() => {
          void LazyMonitoringModule.preload();
          void LazyMacroModule.preload();
          void LazyUSMarketModule.preload();
          void LazyBondsCurveModule.preload();
          void LazyFuturesModule.preload();
          void LazyRatiosModule.preload();
          void LazyPositionsModule.preload();
          void LazyWorkspacesModule.preload();
          void LazyAlertsModule.preload();
          void LazySettingsAndDesignSystemModule.preload();
        });
        return mod;
      })
      .catch((err: unknown) => {
        marketModulesPromise = null;
        throw err;
      });
  }
  return marketModulesPromise;
}

let overlaysPromise: Promise<typeof import('./components/Overlays')> | null = null;
function loadOverlays(): Promise<typeof import('./components/Overlays')> {
  if (overlaysPromise === null) {
    overlaysPromise = import('./components/Overlays')
      .then((mod) => {
        queueMicrotask(() => {
          void LazyOrderTicketDrawer.preload();
          void LazyCommandPaletteModal.preload();
          void LazyShortcutsModal.preload();
        });
        return mod;
      })
      .catch((err: unknown) => {
        overlaysPromise = null;
        throw err;
      });
  }
  return overlaysPromise;
}

const LazyStockDetailView = createRegisteredLazyModule('acciones', () =>
  import('./components/StockDetailView').then((m) => ({ default: m.StockDetailView })),
);
const LazyOptionsModule = createRegisteredLazyModule('opciones', () =>
  import('./components/OptionsModule').then((m) => ({ default: m.OptionsModule })),
);
const LazyGgalSpecialistModule = createRegisteredLazyModule('ggal-specialist', () =>
  import('./components/ggal/GgalSpecialistModule').then((m) => ({ default: m.GgalSpecialistModule })),
);

const LazyMonitoringModule = createRegisteredLazyModule('monitoreo', () =>
  loadMarketModules().then((m) => ({ default: m.MonitoringModule })),
);
const LazyMacroModule = createRegisteredLazyModule('macro', () =>
  loadMarketModules().then((m) => ({ default: m.MacroModule })),
);
const LazyUSMarketModule = createRegisteredLazyModule('eeuu', () =>
  loadMarketModules().then((m) => ({ default: m.USMarketModule })),
);
const LazyBondsCurveModule = createRegisteredLazyModule('bonos', () =>
  loadMarketModules().then((m) => ({ default: m.BondsCurveModule })),
);
const LazyFuturesModule = createRegisteredLazyModule('futuros', () =>
  loadMarketModules().then((m) => ({ default: m.FuturesModule })),
);
const LazyRatiosModule = createRegisteredLazyModule('relaciones', () =>
  loadMarketModules().then((m) => ({ default: m.RatiosModule })),
);
const LazyPositionsModule = createRegisteredLazyModule('posiciones', () =>
  loadMarketModules().then((m) => ({ default: m.PositionsModule })),
);
const LazyWorkspacesModule = createRegisteredLazyModule('espacios', () =>
  loadMarketModules().then((m) => ({ default: m.WorkspacesModule })),
);
const LazyAlertsModule = createRegisteredLazyModule('alertas', () =>
  loadMarketModules().then((m) => ({ default: m.AlertsModule })),
);
const LazySettingsAndDesignSystemModule = createRegisteredLazyModule('configuracion', () =>
  loadMarketModules().then((m) => ({ default: m.SettingsAndDesignSystemModule })),
);

const LazyOrderTicketDrawer = createRegisteredLazyModule('overlay:order-ticket', () =>
  loadOverlays().then((m) => ({ default: m.OrderTicketDrawer })),
);
const LazyCommandPaletteModal = createRegisteredLazyModule('overlay:command-palette', () =>
  loadOverlays().then((m) => ({ default: m.CommandPaletteModal })),
);
const LazyShortcutsModal = createRegisteredLazyModule('overlay:shortcuts', () =>
  loadOverlays().then((m) => ({ default: m.ShortcutsModal })),
);

type DeferredPageId = Exclude<PageId, 'inicio'>;

const SIDEBAR_PREFETCH: Record<DeferredPageId, ReturnType<typeof createPrefetchHandlers>> = {
  macro: createPrefetchHandlers('macro'),
  eeuu: createPrefetchHandlers('eeuu'),
  monitoreo: createPrefetchHandlers('monitoreo'),
  acciones: createPrefetchHandlers('acciones'),
  opciones: createPrefetchHandlers('opciones'),
  futuros: createPrefetchHandlers('futuros'),
  bonos: createPrefetchHandlers('bonos'),
  relaciones: createPrefetchHandlers('relaciones'),
  'ggal-specialist': createPrefetchHandlers('ggal-specialist'),
  posiciones: createPrefetchHandlers('posiciones'),
  espacios: createPrefetchHandlers('espacios'),
  alertas: createPrefetchHandlers('alertas'),
  configuracion: createPrefetchHandlers('configuracion'),
};

function createOptionsSubViewPrefetchHandlers(subId: OptionsSubView) {
  const base = createPrefetchHandlers('opciones');
  const subModule: RoutedModuleId | null =
    subId === 'mapa'
      ? 'opciones:mapa'
      : subId === 'cadena'
        ? 'opciones:cadena'
        : subId === 'volatilidad'
          ? 'opciones:volatilidad'
          : null;
  if (subModule === null) return base;
  let hoverSubTimer: ReturnType<typeof setTimeout> | null = null;
  const triggerBoth = (): void => {
    void prefetchModule('opciones', 'intent').then((loaded) => {
      if (loaded) void prefetchModule(subModule, 'intent');
    });
  };
  return {
    onPointerEnter: () => {
      base.onPointerEnter();
      if (hoverSubTimer !== null) clearTimeout(hoverSubTimer);
      hoverSubTimer = setTimeout(() => {
        hoverSubTimer = null;
        triggerBoth();
      }, 60);
    },
    onPointerLeave: () => {
      base.onPointerLeave();
      if (hoverSubTimer !== null) {
        clearTimeout(hoverSubTimer);
        hoverSubTimer = null;
      }
    },
    onFocus: () => {
      base.onFocus();
      triggerBoth();
    },
  };
}

const OPTIONS_SIDEBAR_SUB_PREFETCH: Record<OptionsSubView, ReturnType<typeof createPrefetchHandlers>> = {
  mapa: createOptionsSubViewPrefetchHandlers('mapa'),
  estrategias: createOptionsSubViewPrefetchHandlers('estrategias'),
  spreads: createOptionsSubViewPrefetchHandlers('spreads'),
  flujo: createOptionsSubViewPrefetchHandlers('flujo'),
  cadena: createOptionsSubViewPrefetchHandlers('cadena'),
  volatilidad: createOptionsSubViewPrefetchHandlers('volatilidad'),
  armado: createOptionsSubViewPrefetchHandlers('armado'),
};

function fallbackVariantForPage(page: DeferredPageId): FallbackLayoutVariant {
  if (page === 'acciones') return 'chart-deck';
  if (page === 'ggal-specialist') return 'dual-chart';
  if (page === 'opciones') return 'options-suite';
  return 'table-grid';
}

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

const EMPTY_TICK_FLASHES: Readonly<Record<string, 'up' | 'down' | null>> = Object.freeze({});

function cycleMarketStatus(current: MarketSessionState): MarketSessionState {
  const order: readonly MarketSessionState[] = ['Abierto', 'Pre-Market', 'After-Hours', 'Cerrado', 'Feriado'];
  return order[(order.indexOf(current) + 1) % order.length] ?? 'Abierto';
}

const MarketClosedBanner = memo(function MarketClosedBanner({
  arMarketStatus, onDismiss,
}: { readonly arMarketStatus: MarketSessionState; readonly onDismiss: () => void }) {
  const liveMarket = useLiveMarketStatus();
  return (
    <div className="fixed left-0 right-0 top-[50px] z-30 bg-[#35280F] border-b border-[#F5B544]/40 px-4 py-1.5 flex items-center justify-between text-[12px] text-[#F5B544] shadow-[0_4px_16px_-6px_rgba(0,0,0,0.6)]">
      <span>
        Estado BYMA ({liveMarket.feedStatus}): <strong>{arMarketStatus}</strong> — {liveMarket.marketStateLabel}
      </span>
      <button type="button" onClick={onDismiss} className="underline font-semibold cursor-pointer">
        Ocultar aviso
      </button>
    </div>
  );
});

const AppMarketChrome = memo(function AppMarketChrome(props: React.ComponentProps<typeof MarketTickerBar>) {
  const [arMarketStatus, setArMarketStatus] = useState<MarketSessionState>('Abierto');
  const marketState = useLiveBridgeSelector(['status'], (snapshot) => snapshot.marketState);
  useEffect(() => {
    if (!marketState) return;
    if (marketState === 'ABIERTO') setArMarketStatus('Abierto');
    else if (marketState === 'SUBASTA' || marketState === 'PREMARKET') setArMarketStatus('Pre-Market');
    else setArMarketStatus('Cerrado');
  }, [marketState]);

  const handleCycleMarketStatus = useCallback(() => setArMarketStatus(cycleMarketStatus), []);
  const handleDismiss = useCallback(() => setArMarketStatus('Abierto'), []);
  return (
    <>
      <MarketTickerBar {...props} marketStatus={arMarketStatus} onCycleMarketStatus={handleCycleMarketStatus} />
      {arMarketStatus !== 'Abierto' && (
        <MarketClosedBanner arMarketStatus={arMarketStatus} onDismiss={handleDismiss} />
      )}
    </>
  );
});

const AppConnectivityBadges = memo(function AppConnectivityBadges() {
  const liveMarket = useLiveMarketStatus();
  const providers = useGlobalConnectivityProviders();
  const globalConnectivity = resolveGlobalConnectivityStatus({
    isBackendConnected: liveMarket.isBackendConnected,
    feedStatus: liveMarket.feedStatus,
    providers,
  });
  return (
    <>
    {/* Pieza 49.1: slot de altura/ancho reservado (invisible al conectar) → CLS 0 */}
    <span
      title={
        !liveMarket.isBackendConnected
          ? 'Reconectando con el servidor backend...'
          : liveMarket.warmupStatus === 'WARMING_UP'
            ? 'Precargando universo 24/7 EOD e indicadores...'
            : 'Backend conectado y warmup completo'
      }
      className={`hidden sm:inline-flex items-center justify-center gap-1.5 min-w-[148px] px-2 py-1 rounded-[8px] border border-[#2A3347] bg-[#121722] text-[#9CA3AF] text-[10.5px] font-mono-num ${
        !liveMarket.isBackendConnected || liveMarket.warmupStatus === 'WARMING_UP' ? '' : 'invisible'
      }`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-[#EAB308]" />
      {!liveMarket.isBackendConnected ? 'CONECTANDO...' : 'PRECARGANDO EOD...'}
    </span>
    <span
      title={liveMarket.marketStateLabel}
      className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] border text-[11px] font-mono-num font-semibold ${
        globalConnectivity.tone === 'LIVE'
          ? 'bg-[#0D221E] text-[#22C55E] border-[#164E3F]'
          : globalConnectivity.tone === 'EOD'
          ? 'bg-[#132033] text-[#38BDF8] border-[#1E3A5F]'
          : globalConnectivity.tone === 'PARTIAL'
          ? 'bg-[#281E0E] text-[#F5B544] border-[#59411A]'
          : 'bg-[#1A1318] text-[#F23645] border-[#4A2229]'
      }`}
    >
      {globalConnectivity.label}
    </span>
    </>
  );
});

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
  const [liveTicksEnabled, setLiveTicksEnabled] = useState(true);

  // Modales y Drawers
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandEverOpened, setCommandEverOpened] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutsEverOpened, setShortcutsEverOpened] = useState(false);
  const [orderDrawerOpen, setOrderDrawerOpen] = useState(false);
  const [orderDrawerEverOpened, setOrderDrawerEverOpened] = useState(false);
  const [orderPreset, setOrderPreset] = useState<OrderTicketPreset | null>(null);

  useEffect(() => {
    if (commandOpen) setCommandEverOpened(true);
  }, [commandOpen]);
  useEffect(() => {
    if (shortcutsOpen) setShortcutsEverOpened(true);
  }, [shortcutsOpen]);
  useEffect(() => {
    if (orderDrawerOpen) setOrderDrawerEverOpened(true);
  }, [orderDrawerOpen]);
  useEffect(() => schedulePostStartupIdleWarmup(), []);

  // Estado de conectividad/warmup ligero (sin precios calientes en el árbol raíz)
  useFeedsHealthConnection();

  const viewScope = useMemo((): {
    readonly view: string;
    readonly focusSymbol: string | null;
    readonly focusMarket: 'AR' | 'US' | null;
  } => {
    if (activePage === 'acciones') {
      const cleanRaw = selectedTicker.trim().toUpperCase() || 'GGAL';
      const route = resolveStockDetailRoute({
        rawTicker: cleanRaw,
        isArLocalSymbol:
          AR_STOCKS.some((stock) => stock.ticker === cleanRaw) ||
          AR_GENERAL_PANEL_STOCKS.some((stock) => stock.ticker === cleanRaw),
      });
      return {
        view: 'stock_detail',
        focusSymbol: route?.providerSymbol ?? cleanRaw,
        focusMarket: route?.market ?? 'AR',
      };
    }
    if (activePage === 'opciones') {
      const sel = parseOptionsUnderlyingKey(selectedOptionsUnderlying);
      return {
        view: 'options',
        focusSymbol: sel.symbol,
        focusMarket: sel.market,
      };
    }
    if (activePage === 'ggal-specialist') {
      return { view: 'ggal_specialist', focusSymbol: 'GGAL', focusMarket: 'AR' };
    }
    if (activePage === 'monitoreo') {
      return { view: 'monitoring', focusSymbol: null, focusMarket: 'AR' };
    }
    if (activePage === 'eeuu') {
      return { view: 'us_market', focusSymbol: null, focusMarket: 'US' };
    }
    if (activePage === 'inicio') {
      return { view: 'home', focusSymbol: null, focusMarket: null };
    }
    return { view: activePage, focusSymbol: null, focusMarket: null };
  }, [activePage, selectedOptionsUnderlying, selectedTicker]);

  useMarketViewScope(viewScope.view, viewScope.focusSymbol, viewScope.focusMarket);

  const [positions, setPositions] = useState<PortfolioPosition[]>(INITIAL_POSITIONS);
  const [alerts, setAlerts] = useState<AlertItem[]>(INITIAL_ALERTS);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Sincronizar atributo data-theme
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [theme]);

  useEffect(() => {
    return startLiveRuntimePolling(liveTicksEnabled);
  }, [liveTicksEnabled]);

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

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      setToastMessage(null);
    }, 4_200);
  }, []);

  const handleOpenOrderTicket = useCallback((preset: OrderTicketPreset) => {
    setOrderPreset(preset);
    setOrderDrawerOpen(true);
  }, []);

  const handleSelectStockDetail = useCallback((ticker: string) => {
    setSelectedTicker(ticker);
    setActivePage('acciones');
  }, []);

  const handleToggleSidebar = useCallback(() => setSidebarCollapsed((v) => !v), []);
  const handleOpenCommandPalette = useCallback(() => setCommandOpen(true), []);
  const handleOpenAlerts = useCallback(() => setActivePage('alertas'), []);
  const handleOpenShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const handleToggleTheme = useCallback(() => setTheme((t) => t === 'dark' ? 'light' : 'dark'), []);
  const handleNavigate = useCallback((page: string) => setActivePage(page as PageId), []);
  const handleGoToOptions = useCallback((ticker: string) => {
    setSelectedOptionsUnderlying(ticker);
    setActivePage('opciones');
  }, []);
  const handleBackToMonitor = useCallback(() => {
    setMonitorPanel('acciones');
    setActivePage('monitoreo');
  }, []);

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
      <AppMarketChrome
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={handleToggleSidebar}
        onSelectTicker={handleSelectStockDetail}
        onOpenCommandPalette={handleOpenCommandPalette}
        onOpenAlerts={handleOpenAlerts}
        hasUnreadAlerts={alerts.some((a) => a.status === 'Disparada')}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onOpenShortcuts={handleOpenShortcuts}
        liveFeedEnabled={liveTicksEnabled}
      />


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
                {...SIDEBAR_PREFETCH.macro}
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
                {...SIDEBAR_PREFETCH.eeuu}
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
                  {...SIDEBAR_PREFETCH.monitoreo}
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
                        {...SIDEBAR_PREFETCH.monitoreo}
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
                {...SIDEBAR_PREFETCH.acciones}
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
                  {...SIDEBAR_PREFETCH.opciones}
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
                        {...OPTIONS_SIDEBAR_SUB_PREFETCH[sub.id]}
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
                {...SIDEBAR_PREFETCH.futuros}
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
                {...SIDEBAR_PREFETCH.bonos}
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
                {...SIDEBAR_PREFETCH.relaciones}
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
                {...SIDEBAR_PREFETCH['ggal-specialist']}
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
                {...SIDEBAR_PREFETCH.posiciones}
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
                {...SIDEBAR_PREFETCH.espacios}
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
              {...SIDEBAR_PREFETCH.configuracion}
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
                <AppConnectivityBadges />
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
            {activePage === 'inicio' ? (
              <HomeDashboard
                tickFlashes={EMPTY_TICK_FLASHES}
                onSelectStock={handleSelectStockDetail}
                onNavigate={handleNavigate}
                onOpenOrderTicket={handleOpenOrderTicket}
              />
            ) : (
              <ModuleLoadErrorBoundary
                moduleId={activePage}
                resetKey={activePage}
                variant={fallbackVariantForPage(activePage)}
              >
                <React.Suspense
                  fallback={
                    <ModuleViewFallback
                      moduleId={activePage}
                      variant={fallbackVariantForPage(activePage)}
                    />
                  }
                >
                  <div data-qot-module-ready={activePage}>
                    {activePage === 'monitoreo' && (
                      <LazyMonitoringModule.Component
                        subPanel={monitorPanel}
                        onSelectSubPanel={setMonitorPanel}
                        density={density}
                        tickFlashes={EMPTY_TICK_FLASHES}
                        onSelectStock={handleSelectStockDetail}
                        onOpenOrderTicket={handleOpenOrderTicket}
                      />
                    )}

                    {activePage === 'acciones' && (
                      <LazyStockDetailView.Component
                        ticker={selectedTicker}
                        onSelectTicker={setSelectedTicker}
                        onGoToOptions={handleGoToOptions}
                        onBackToMonitor={handleBackToMonitor}
                        onOpenOrderTicket={handleOpenOrderTicket}
                      />
                    )}

                    {activePage === 'opciones' && (
                      <LazyOptionsModule.Component
                        activeSubView={optionsSubView}
                        onSelectSubView={setOptionsSubView}
                        selectedUnderlying={selectedOptionsUnderlying}
                        onSelectUnderlying={setSelectedOptionsUnderlying}
                        density={density}
                        onOpenOrderTicket={handleOpenOrderTicket}
                      />
                    )}

                    {activePage === 'macro' && <LazyMacroModule.Component />}
                    {activePage === 'eeuu' && (
                      <LazyUSMarketModule.Component onOpenOrderTicket={handleOpenOrderTicket} />
                    )}
                    {activePage === 'bonos' && <LazyBondsCurveModule.Component />}
                    {activePage === 'futuros' && <LazyFuturesModule.Component />}
                    {activePage === 'relaciones' && <LazyRatiosModule.Component />}
                    {activePage === 'ggal-specialist' && (
                      <LazyGgalSpecialistModule.Component onOpenOrderTicket={handleOpenOrderTicket} />
                    )}
                    {activePage === 'posiciones' && (
                      <LazyPositionsModule.Component
                        positions={positions}
                        onOpenOrderTicket={handleOpenOrderTicket}
                      />
                    )}
                    {activePage === 'espacios' && (
                      <LazyWorkspacesModule.Component onNavigate={handleNavigate} />
                    )}
                    {activePage === 'alertas' && (
                      <LazyAlertsModule.Component
                        alerts={alerts}
                        onAddAlert={(newAlert) => {
                          setAlerts((prev) => [newAlert, ...prev]);
                          showToast(`Alerta creada para ${newAlert.ticker} (${newAlert.target})`);
                        }}
                      />
                    )}
                    {activePage === 'configuracion' && (
                      <LazySettingsAndDesignSystemModule.Component
                        theme={theme}
                        onToggleTheme={handleToggleTheme}
                        density={density}
                        onChangeDensity={setDensity}
                        liveTicksEnabled={liveTicksEnabled}
                        onToggleLiveTicks={() => setLiveTicksEnabled((v) => !v)}
                      />
                    )}
                  </div>
                </React.Suspense>
              </ModuleLoadErrorBoundary>
            )}
          </div>
        </main>
      </div>

      {/* DRAWER DE TICKET DE ORDEN (380 px) */}
      {(orderDrawerEverOpened || orderDrawerOpen) && (
        <React.Suspense fallback={null}>
          <LazyOrderTicketDrawer.Component
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
        </React.Suspense>
      )}

      {/* PALETA DE COMANDOS (CTRL K) */}
      {(commandEverOpened || commandOpen) && (
        <React.Suspense fallback={null}>
          <LazyCommandPaletteModal.Component
            open={commandOpen}
            onClose={() => setCommandOpen(false)}
            onSelectStock={handleSelectStockDetail}
            onNavigate={handleNavigate}
            onOpenNewOrder={() => setOrderDrawerOpen(true)}
            onToggleTheme={handleToggleTheme}
          />
        </React.Suspense>
      )}

      {/* MODAL DE ATAJOS (?) */}
      {(shortcutsEverOpened || shortcutsOpen) && (
        <React.Suspense fallback={null}>
          <LazyShortcutsModal.Component open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        </React.Suspense>
      )}

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
