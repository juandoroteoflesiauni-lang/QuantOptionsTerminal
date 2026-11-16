import React, { useEffect, useState, useSyncExternalStore, memo } from 'react';
import {
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Bell,
  Sun,
  Moon,
  HelpCircle,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';

/* ============================================================================
   1. INTERFACES Y TIPOS ESTRICTOS
   ============================================================================ */
export type TickerCategory =
  | 'MACRO_ETF'
  | 'VOLATILITY_YIELD'
  | 'TOP_GAINER'
  | 'TOP_LOSER'
  | 'RISK_ON_FX';

export type MarketSessionState = 'Abierto' | 'Pre-Market' | 'After-Hours' | 'Cerrado' | 'Feriado';

export interface TickerItem {
  id: string;
  symbol: string;
  displayName: string;
  category: TickerCategory;
  categoryTag?: string;
  price: number;
  changePct: number;
  decimals: number;
  prefix?: string;
  suffix?: string;
  lastTickDir?: 'up' | 'down' | null;
  lastTickTs?: number;
}

export interface MarketTickerBarProps {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  marketStatus?: MarketSessionState;
  onCycleMarketStatus?: () => void;
  onSelectTicker?: (symbol: string) => void;
  onOpenCommandPalette?: () => void;
  onOpenAlerts?: () => void;
  hasUnreadAlerts?: boolean;
  theme?: 'dark' | 'light';
  onToggleTheme?: () => void;
  onOpenShortcuts?: () => void;
  marqueeDurationSeconds?: number;
  liveFeedEnabled?: boolean;
}

/* ============================================================================
   2. MOCK INICIAL DE DATOS DE MERCADO (ETFs, VIX, US10Y, GAINERS, LOSERS, DXY/BTC)
   ============================================================================ */
const INITIAL_TICKER_ITEMS: TickerItem[] = [
  // 1. ETFs Macro & Volatilidad
  {
    id: 'SPY',
    symbol: 'SPY',
    displayName: 'S&P 500 ETF',
    category: 'MACRO_ETF',
    price: 598.42,
    changePct: 0.78,
    decimals: 2,
    prefix: '$',
  },
  {
    id: 'QQQ',
    symbol: 'QQQ',
    displayName: 'Nasdaq 100',
    category: 'MACRO_ETF',
    price: 518.90,
    changePct: 1.14,
    decimals: 2,
    prefix: '$',
  },
  {
    id: 'IWM',
    symbol: 'IWM',
    displayName: 'Russell 2000',
    category: 'MACRO_ETF',
    price: 224.15,
    changePct: 0.62,
    decimals: 2,
    prefix: '$',
  },
  {
    id: 'VIX',
    symbol: 'VIX',
    displayName: 'Volatilidad 30d',
    category: 'VOLATILITY_YIELD',
    price: 13.85,
    changePct: -4.15,
    decimals: 2,
  },
  {
    id: 'US10Y',
    symbol: 'US10Y',
    displayName: 'UST 10Y Yield',
    category: 'VOLATILITY_YIELD',
    price: 4.24,
    changePct: -0.95,
    decimals: 2,
    suffix: '%',
  },

  // 2. Top Gainers del día
  {
    id: 'SUPV',
    symbol: 'SUPV',
    displayName: 'Top Gainer',
    category: 'TOP_GAINER',
    categoryTag: 'GAINER',
    price: 2890.00,
    changePct: 4.52,
    decimals: 2,
    prefix: '$',
  },
  {
    id: 'GGAL',
    symbol: 'GGAL',
    displayName: 'Top Gainer',
    category: 'TOP_GAINER',
    categoryTag: 'GAINER',
    price: 6480.00,
    changePct: 4.18,
    decimals: 2,
    prefix: '$',
  },
  {
    id: 'NVDA',
    symbol: 'NVDA',
    displayName: 'Top Gainer',
    category: 'TOP_GAINER',
    categoryTag: 'GAINER',
    price: 142.80,
    changePct: 2.95,
    decimals: 2,
    prefix: '$',
  },

  // 3. Top Losers del día
  {
    id: 'SMCI',
    symbol: 'SMCI',
    displayName: 'Top Loser',
    category: 'TOP_LOSER',
    categoryTag: 'LOSER',
    price: 38.40,
    changePct: -3.48,
    decimals: 2,
    prefix: '$',
  },
  {
    id: 'INTC',
    symbol: 'INTC',
    displayName: 'Top Loser',
    category: 'TOP_LOSER',
    categoryTag: 'LOSER',
    price: 23.15,
    changePct: -2.14,
    decimals: 2,
    prefix: '$',
  },
  {
    id: 'TXAR',
    symbol: 'TXAR',
    displayName: 'Top Loser',
    category: 'TOP_LOSER',
    categoryTag: 'LOSER',
    price: 912.00,
    changePct: -1.40,
    decimals: 2,
    prefix: '$',
  },

  // 4. Macro / Risk-on & Referencias Locales
  {
    id: 'DXY',
    symbol: 'DXY',
    displayName: 'Índice Dólar',
    category: 'RISK_ON_FX',
    price: 104.12,
    changePct: -0.28,
    decimals: 2,
  },
  {
    id: 'BTC',
    symbol: 'BTC/USD',
    displayName: 'Bitcoin',
    category: 'RISK_ON_FX',
    price: 91420.00,
    changePct: 2.64,
    decimals: 0,
    prefix: '$',
  },
  {
    id: 'MEP',
    symbol: 'Dólar MEP',
    displayName: 'AL30 T+1',
    category: 'RISK_ON_FX',
    price: 1142.50,
    changePct: -0.64,
    decimals: 2,
    prefix: '$ ',
  },
  {
    id: 'CCL',
    symbol: 'Dólar CCL',
    displayName: ' Implícito ADR',
    category: 'RISK_ON_FX',
    price: 1168.80,
    changePct: -0.42,
    decimals: 2,
    prefix: '$ ',
  },
  {
    id: 'EMBI',
    symbol: 'Riesgo País',
    displayName: 'EMBI+ AR',
    category: 'RISK_ON_FX',
    price: 742,
    changePct: -2.35,
    decimals: 0,
    suffix: ' pb',
  },
];

const TICKER_ORDER_IDS: readonly string[] = INITIAL_TICKER_ITEMS.map((item) => item.id);

/* ============================================================================
   3. STORE DE SUSCRIPCIÓN ATÓMICA POR SÍMBOLO
   Garantiza que las actualizaciones de precio en tiempo real solo re-rendericen
   el chip afectado sin re-renderizar jamás el contenedor de la animación CSS.
   ============================================================================ */
type Listener = () => void;

class TickerFeedStore {
  private itemsMap = new Map<string, TickerItem>();
  private listenersMap = new Map<string, Set<Listener>>();

  constructor(initialItems: TickerItem[]) {
    initialItems.forEach((item) => {
      this.itemsMap.set(item.id, item);
    });
  }

  public getItem = (id: string): TickerItem => {
    return this.itemsMap.get(id)!;
  };

  public subscribe = (id: string, listener: Listener): (() => void) => {
    let set = this.listenersMap.get(id);
    if (!set) {
      set = new Set();
      this.listenersMap.set(id, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  };

  public applySimulatedTick = (): void => {
    // Seleccionar entre 1 y 2 instrumentos al azar por pulso de mercado
    const count = Math.random() > 0.45 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const randomId = TICKER_ORDER_IDS[Math.floor(Math.random() * TICKER_ORDER_IDS.length)];
      const current = this.itemsMap.get(randomId);
      if (!current) continue;

      const direction: 'up' | 'down' = Math.random() > 0.47 ? 'up' : 'down';
      const pctStep = (Math.random() * 0.14 + 0.02) * (direction === 'up' ? 1 : -1);
      const rawNewPrice = current.price * (1 + pctStep / 100);
      const newPrice = Number(rawNewPrice.toFixed(current.decimals));
      const newChangePct = Number((current.changePct + pctStep * 0.65).toFixed(2));

      const updated: TickerItem = {
        ...current,
        price: newPrice,
        changePct: newChangePct,
        lastTickDir: direction,
        lastTickTs: Date.now(),
      };

      this.itemsMap.set(randomId, updated);
      const listeners = this.listenersMap.get(randomId);
      listeners?.forEach((fn) => fn());
    }
  };
}

const globalTickerStore = new TickerFeedStore(INITIAL_TICKER_ITEMS);

/* ============================================================================
   4. FORMATEADORES NUMÉRICOS (TABULAR-NUMS)
   ============================================================================ */
function formatPriceEsAr(value: number, decimals: number): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const withDots = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return decimals > 0 ? `${withDots},${decPart}` : withDots;
}

function formatChangePct(val: number): string {
  const sign = val > 0 ? '+' : val < 0 ? '-' : '';
  const absFixed = Math.abs(val).toFixed(2).replace('.', ',');
  return `${sign}${absFixed} %`;
}

/* ============================================================================
   5. COMPONENTE DE CHIP INDIVIDUAL MEMOIZADO (`React.memo`)
   ============================================================================ */
interface TickerChipProps {
  tickerId: string;
  onSelectTicker?: (symbol: string) => void;
}

const MemoizedTickerChip: React.FC<TickerChipProps> = memo(({ tickerId, onSelectTicker }) => {
  const item = useSyncExternalStore(
    (cb) => globalTickerStore.subscribe(tickerId, cb),
    () => globalTickerStore.getItem(tickerId)
  );

  const [flashClass, setFlashClass] = useState<string>('');

  useEffect(() => {
    if (!item.lastTickDir || !item.lastTickTs) return;
    setFlashClass(item.lastTickDir === 'up' ? 'qc-chip-flash-up' : 'qc-chip-flash-down');
    const timer = setTimeout(() => {
      setFlashClass('');
    }, 560);
    return () => clearTimeout(timer);
  }, [item.lastTickTs, item.lastTickDir]);

  const isPositive = item.changePct > 0;
  const isNegative = item.changePct < 0;

  const clickableSymbol = ['GGAL', 'SUPV', 'TXAR', 'YPFD', 'PAMP', 'BMA'].includes(item.symbol)
    ? item.symbol
    : 'GGAL';

  return (
    <button
      type="button"
      onClick={() => onSelectTicker?.(clickableSymbol)}
      title={`${item.symbol} (${item.displayName}) — Click para inspeccionar`}
      className={`group inline-flex items-center gap-2 px-2.5 h-[30px] rounded-[8px] bg-[#131722] hover:bg-[#1A1F2C] border border-[#2A2E3D] hover:border-[#3D4358] transition-colors shrink-0 cursor-pointer select-none ${flashClass}`}
    >
      {/* Símbolo / Nombre en gris neutro #787B86 / #9CA3AF */}
      <span className="text-[11.5px] font-semibold text-[#8A8F9E] group-hover:text-[#D1D4DC] transition-colors whitespace-nowrap">
        {item.symbol}
      </span>

      {/* Precio actual formateado en blanco/gris claro #D1D4DC con tabular-nums */}
      <span className="font-mono-num text-[12px] font-bold text-[#ECEDF2] whitespace-nowrap">
        {item.prefix ?? ''}
        {formatPriceEsAr(item.price, item.decimals)}
        {item.suffix ?? ''}
      </span>

      {/* Variación porcentual directa en verde #22C55E o rojo #F23645 sin borde ni cápsula */}
      <span
        className={`inline-flex items-center font-mono-num text-[11.5px] font-semibold whitespace-nowrap ${
          isPositive
            ? 'text-[#22C55E]'
            : isNegative
            ? 'text-[#F23645]'
            : 'text-[#787B86]'
        }`}
      >
        <span>{formatChangePct(item.changePct)}</span>
      </span>
    </button>
  );
});

MemoizedTickerChip.displayName = 'MemoizedTickerChip';

/* ============================================================================
   6. PISTA INFINITA MEMOIZADA (NUNCA SE RE-RENDERIZA CON LOS TICKS)
   ============================================================================ */
const SeamlessMarqueeTrack: React.FC<{
  durationSeconds: number;
  onSelectTicker?: (symbol: string) => void;
}> = memo(({ durationSeconds, onSelectTicker }) => {
  return (
    <div className="qc-marquee-viewport flex-1 min-w-0 py-1">
      <div
        className="qc-marquee-track"
        style={{ '--marquee-duration': `${durationSeconds}s` } as React.CSSProperties}
      >
        {/* Mitad A (Original) */}
        <div className="flex items-center gap-2 pr-2 shrink-0">
          {TICKER_ORDER_IDS.map((id) => (
            <MemoizedTickerChip
              key={`seq-a-${id}`}
              tickerId={id}
              onSelectTicker={onSelectTicker}
            />
          ))}
        </div>

        {/* Mitad B (Clon exacto para loop continuo al -50%) */}
        <div className="flex items-center gap-2 pr-2 shrink-0" aria-hidden="true">
          {TICKER_ORDER_IDS.map((id) => (
            <MemoizedTickerChip
              key={`seq-b-${id}`}
              tickerId={id}
              onSelectTicker={onSelectTicker}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

SeamlessMarqueeTrack.displayName = 'SeamlessMarqueeTrack';

/* ============================================================================
   7. COMPONENTE PRINCIPAL: `MarketTickerBar`
   Layout: [Extremo Izquierdo Fijo] + [Marquee Central Infinito] + [Extremo Derecho Fijo]
   ============================================================================ */
export const MarketTickerBar: React.FC<MarketTickerBarProps> = ({
  sidebarCollapsed = false,
  onToggleSidebar,
  marketStatus = 'Abierto',
  onCycleMarketStatus,
  onSelectTicker,
  onOpenCommandPalette,
  onOpenAlerts,
  hasUnreadAlerts = true,
  theme = 'dark',
  onToggleTheme,
  onOpenShortcuts,
  marqueeDurationSeconds = 48,
  liveFeedEnabled = true,
}) => {
  // Simulación limpia de WebSocket / Polling de alta frecuencia cada 1.4 segundos
  useEffect(() => {
    if (!liveFeedEnabled || marketStatus === 'Cerrado' || marketStatus === 'Feriado') {
      return;
    }
    const timer = setInterval(() => {
      globalTickerStore.applySimulatedTick();
    }, 1400);

    return () => clearInterval(timer);
  }, [liveFeedEnabled, marketStatus]);

  const isOpen = marketStatus === 'Abierto';
  const isExtended = marketStatus === 'Pre-Market' || marketStatus === 'After-Hours';

  return (
    <header className="sticky top-0 z-40 h-[50px] w-full bg-[#0B0E14] border-b border-[#1E222D] px-3 flex items-center justify-between gap-3 select-none">
      {/* =====================================================================
          A) EXTREMO IZQUIERDO FIJO: Colapsar Sidebar + Badge Estado de Mercado
          ===================================================================== */}
      <div className="flex items-center gap-2 shrink-0">
        {onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            title="Colapsar / Expandir barra lateral ([)"
            className="w-8 h-8 rounded-[8px] inline-flex items-center justify-center text-[#787B86] hover:text-[#D1D4DC] hover:bg-[#131722] border border-transparent hover:border-[#2A2E3D] transition-colors cursor-pointer"
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </button>
        )}

        {/* Badge de Estado de Mercado con LED circular pulsante */}
        <button
          type="button"
          onClick={onCycleMarketStatus}
          title="Click para cambiar sesión (Abierto, Pre-Market, After-Hours, Cerrado)"
          className={`inline-flex items-center gap-2 px-3 h-[30px] rounded-full border text-[11.5px] font-mono-num font-semibold transition-all cursor-pointer ${
            isOpen
              ? 'bg-[#0D221E] text-[#22C55E] border-[#164E3F] hover:border-[#22C55E]/60'
              : isExtended
              ? 'bg-[#281E0E] text-[#F5B544] border-[#59411A]'
              : 'bg-[#1A1318] text-[#F23645] border-[#4A2229]'
          }`}
        >
          <span className="relative flex h-2 w-2">
            {isOpen && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#22C55E] opacity-75" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2 w-2 ${
                isOpen ? 'bg-[#22C55E]' : isExtended ? 'bg-[#F5B544]' : 'bg-[#F23645]'
              }`}
            />
          </span>
          <span className="tracking-tight whitespace-nowrap">
            NYSE / BYMA: {marketStatus}
          </span>
        </button>

        {/* Separador vertical sutil */}
        <div className="h-5 w-[1px] bg-[#1E222D] ml-0.5 hidden sm:block" />
      </div>

      {/* =====================================================================
          B) CONTENEDOR CENTRAL: INFINITE MARQUEE TICKER (Pausa en :hover)
          ===================================================================== */}
      <SeamlessMarqueeTrack
        durationSeconds={marqueeDurationSeconds}
        onSelectTicker={onSelectTicker}
      />

      {/* =====================================================================
          C) EXTREMO DERECHO FIJO: Buscador Ctrl+K + Utilidades + Avatar QM
          ===================================================================== */}
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="h-5 w-[1px] bg-[#1E222D] mr-0.5 hidden sm:block" />

        {/* Botón de búsqueda rápida con indicador de atajo Ctrl K */}
        <button
          type="button"
          onClick={onOpenCommandPalette}
          className="inline-flex items-center gap-2.5 px-2.5 h-[30px] rounded-[8px] bg-[#131722] hover:bg-[#1A1F2C] border border-[#2A2E3D] hover:border-[#3D4358] text-[12px] text-[#787B86] hover:text-[#D1D4DC] transition-colors cursor-pointer"
        >
          <Search className="w-3.5 h-3.5 text-[#8B7CF6]" />
          <span className="hidden md:inline font-medium text-[#9CA3AF]">
            Buscar o ir...
          </span>
          <kbd className="px-1.5 py-0.5 rounded-[5px] text-[10px] font-mono-num font-semibold bg-[#1A1F2C] text-[#D1D4DC] border border-[#2A2E3D]">
            Ctrl K
          </kbd>
        </button>

        {/* Campana de Notificaciones con badge de alerta */}
        <button
          type="button"
          onClick={onOpenAlerts}
          title="Centro de Alertas Cuantitativas"
          className="relative w-8 h-[30px] rounded-[8px] inline-flex items-center justify-center text-[#8A8F9E] hover:text-[#D1D4DC] hover:bg-[#131722] border border-transparent hover:border-[#2A2E3D] transition-colors cursor-pointer"
        >
          <Bell className="w-4 h-4" />
          {hasUnreadAlerts && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#F5B544] ring-2 ring-[#0B0E14]" />
          )}
        </button>

        {/* Selector de Tema (Sol / Luna) */}
        <button
          type="button"
          onClick={onToggleTheme}
          title="Alternar tema Dark / Light"
          className="w-8 h-[30px] rounded-[8px] inline-flex items-center justify-center text-[#8A8F9E] hover:text-[#D1D4DC] hover:bg-[#131722] border border-transparent hover:border-[#2A2E3D] transition-colors cursor-pointer"
        >
          {theme === 'dark' ? (
            <Sun className="w-4 h-4" />
          ) : (
            <Moon className="w-4 h-4" />
          )}
        </button>

        {/* Soporte / Ayuda (?) */}
        <button
          type="button"
          onClick={onOpenShortcuts}
          title="Atajos de teclado y ayuda (?)"
          className="w-8 h-[30px] rounded-[8px] inline-flex items-center justify-center text-[#8A8F9E] hover:text-[#D1D4DC] hover:bg-[#131722] border border-transparent hover:border-[#2A2E3D] transition-colors cursor-pointer"
        >
          <HelpCircle className="w-4 h-4" />
        </button>

        {/* Avatar de usuario (círculo con iniciales QM) */}
        <button
          type="button"
          title="Perfil Institucional: Quant Macro Desk (QM)"
          className="w-[30px] h-[30px] rounded-full bg-[#241F48] border border-[#8B7CF6] inline-flex items-center justify-center text-[11px] font-bold text-[#F3F3F9] hover:brightness-110 transition-all cursor-pointer shrink-0"
        >
          QM
        </button>
      </div>
    </header>
  );
};

export default MarketTickerBar;
