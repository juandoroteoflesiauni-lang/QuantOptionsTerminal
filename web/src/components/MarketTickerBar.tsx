import React, { useEffect, useState, useSyncExternalStore, memo } from 'react';
import {
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Bell,
  Sun,
  Moon,
  HelpCircle,
} from 'lucide-react';
import { subscribeLiveTickerUpdates, type LiveTickerUpdate } from '../data/liveRuntimeBridge';
import {
  formatExtendedSessionBadge,
  getMarketLiveQuote,
  isMarketLiveStreamFresh,
  tickFlashClass,
  useMarketLiveStream,
  type LiveUsSessionPhase,
} from '../api/useMarketLiveStream';
import type { FeedStatus } from '../data/liveTypes';
import { CompanyLogo } from './common/CompanyLogo';
import {
  FeedsHealthDrawer,
  useFeedsHealthPulse,
  type FeedProviderId,
} from './FeedsHealthDrawer';

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
  sessionPhase?: LiveUsSessionPhase | null;
}

export interface MarketTickerBarProps {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  marketStatus?: MarketSessionState;
  feedStatus?: FeedStatus;
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
   2. CATÁLOGO BASE DEL MARQUEE (VALORES INICIALES EN NaN HASTA CARGAR FEED REAL)
   ============================================================================ */
const INITIAL_TICKER_ITEMS: TickerItem[] = [
  { id: 'SPY', symbol: 'SPY', displayName: 'S&P 500 ETF', category: 'MACRO_ETF', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'QQQ', symbol: 'QQQ', displayName: 'Nasdaq 100', category: 'MACRO_ETF', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'IWM', symbol: 'IWM', displayName: 'Russell 2000', category: 'MACRO_ETF', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'DIA', symbol: 'DIA', displayName: 'Dow Jones ETF', category: 'MACRO_ETF', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'VIX', symbol: 'VIX', displayName: 'Volatilidad 30d', category: 'VOLATILITY_YIELD', price: Number.NaN, changePct: Number.NaN, decimals: 2 },
  { id: 'SUPV', symbol: 'SUPV', displayName: 'Banco Supervielle', category: 'TOP_GAINER', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'GGAL', symbol: 'GGAL', displayName: 'Grupo Galicia', category: 'TOP_GAINER', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'YPFD', symbol: 'YPFD', displayName: 'YPF S.A.', category: 'TOP_GAINER', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'PAMP', symbol: 'PAMP', displayName: 'Pampa Energía', category: 'TOP_GAINER', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'BMA', symbol: 'BMA', displayName: 'Banco Macro', category: 'TOP_GAINER', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'NVDA', symbol: 'NVDA', displayName: 'NVIDIA Corp.', category: 'MACRO_ETF', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'AAPL', symbol: 'AAPL', displayName: 'Apple Inc.', category: 'MACRO_ETF', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'TXAR', symbol: 'TXAR', displayName: 'Ternium Argentina', category: 'TOP_LOSER', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$' },
  { id: 'MEP', symbol: 'Dólar MEP', displayName: 'AL30 Implicito', category: 'RISK_ON_FX', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$ ' },
  { id: 'CCL', symbol: 'Dólar CCL', displayName: 'Mediana ADRs/Bonos', category: 'RISK_ON_FX', price: Number.NaN, changePct: Number.NaN, decimals: 2, prefix: '$ ' },
  { id: 'EMBI', symbol: 'Riesgo País', displayName: 'EMBI+ AR', category: 'RISK_ON_FX', price: Number.NaN, changePct: Number.NaN, decimals: 0, suffix: ' pb' },
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
  private streamAuthorityAtMs = new Map<string, number>();

  constructor(initialItems: TickerItem[]) {
    initialItems.forEach((item) => {
      this.itemsMap.set(item.id, item);
    });
  }

  public getItem = (id: string): TickerItem | undefined => {
    return this.itemsMap.get(id);
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

  public applyRealUpdates = (updates: readonly LiveTickerUpdate[], fromStream = false): void => {
    const now = Date.now();
    for (const u of updates) {
      if (fromStream) this.streamAuthorityAtMs.set(u.id, now);
      const streamAt = this.streamAuthorityAtMs.get(u.id);
      if (!fromStream && streamAt !== undefined && now - streamAt < 5_000) continue;
      const current = this.itemsMap.get(u.id);
      if (!current || !Number.isFinite(u.price)) continue;
      const changed =
        !Number.isFinite(current.price) ||
        Math.abs(u.price - current.price) > 1e-6 ||
        (Number.isFinite(u.changePct) && (!Number.isFinite(current.changePct) || Math.abs(u.changePct - current.changePct) > 1e-6)) ||
        (u.sessionPhase !== undefined && u.sessionPhase !== current.sessionPhase);
      if (!changed) continue;

      const updated: TickerItem = {
        ...current,
        price: u.price,
        changePct: Number.isFinite(u.changePct) ? u.changePct : current.changePct,
        lastTickDir: u.dir ?? (Number.isFinite(current.price) ? (u.price > current.price ? 'up' : u.price < current.price ? 'down' : null) : null),
        lastTickTs:
          (u.dir ?? (Number.isFinite(current.price) ? (u.price > current.price ? 'up' : u.price < current.price ? 'down' : null) : null)) !== null
            ? now
            : current.lastTickTs,
        sessionPhase: u.sessionPhase !== undefined ? u.sessionPhase : current.sessionPhase ?? null,
      };
      this.itemsMap.set(u.id, updated);
      const listeners = this.listenersMap.get(u.id);
      listeners?.forEach((fn) => fn());
    }
  };
}

const globalTickerStore = new TickerFeedStore(INITIAL_TICKER_ITEMS);

/* ============================================================================
   4. FORMATEADORES NUMÉRICOS (TABULAR-NUMS)
   ============================================================================ */
function formatPriceEsAr(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '—';
  const fixed = Math.abs(value).toFixed(decimals);
  const parts = fixed.split('.');
  const intPart = parts[0] ?? '0';
  const decPart = parts[1] ?? '';
  const withDots = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return decimals > 0 ? `${withDots},${decPart}` : withDots;
}

function formatChangePct(val: number): string {
  if (!Number.isFinite(val)) return '—';
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

  const [flash, setFlash] = useState<{ readonly dir: 'up' | 'down'; readonly id: number } | null>(null);

  useEffect(() => {
    if (!item?.lastTickDir || !item?.lastTickTs) {
      setFlash(null);
      return;
    }
    setFlash({ dir: item.lastTickDir, id: item.lastTickTs });
    const timer = setTimeout(() => {
      setFlash(null);
    }, 650);
    return () => clearTimeout(timer);
  }, [item?.lastTickTs, item?.lastTickDir]);

  if (!item) return null;

  const isPositive = Number.isFinite(item.changePct) && item.changePct > 0;
  const isNegative = Number.isFinite(item.changePct) && item.changePct < 0;

  const clickableSymbol = ['GGAL', 'SUPV', 'TXAR', 'YPFD', 'PAMP', 'BMA'].includes(item.symbol)
    ? item.symbol
    : 'GGAL';

  return (
    <button
      type="button"
      onClick={() => onSelectTicker?.(clickableSymbol)}
      title={`${item.symbol} (${item.displayName}) — Click para inspeccionar`}
      className="group inline-flex items-center gap-2 px-2.5 h-[30px] rounded-[8px] bg-[#131722] hover:bg-[#1A1F2C] border border-[#2A2E3D] hover:border-[#3D4358] shrink-0 cursor-pointer select-none"
    >
      <CompanyLogo ticker={item.id} name={item.displayName} size="sm" />

      <span className="text-[11.5px] font-semibold text-[#8A8F9E] group-hover:text-[#D1D4DC] transition-colors whitespace-nowrap">
        {item.symbol}
      </span>
      {formatExtendedSessionBadge(item.sessionPhase) !== null && (
        <span className="rounded px-1 py-0.2 font-mono-num text-[9px] font-bold tracking-wider bg-[#F5B544]/15 text-[#F5B544] border border-[#F5B544]/35">
          {formatExtendedSessionBadge(item.sessionPhase)}
        </span>
      )}

      <span
        className={`font-mono-num text-[12px] font-bold whitespace-nowrap transition-colors duration-500 ${
          flash === null ? 'text-[#ECEDF2]' : tickFlashClass(flash.dir)
        }`}
      >
        {Number.isFinite(item.price)
          ? `${item.prefix ?? ''}${formatPriceEsAr(item.price, item.decimals)}${item.suffix ?? ''}`
          : '—'}
      </span>

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
  feedStatus = 'NO_DATA',
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
  const liveStream = useMarketLiveStream({ manageConnection: liveFeedEnabled });
  const feedsHealth = useFeedsHealthPulse();
  const [feedsDrawerOpen, setFeedsDrawerOpen] = useState(false);

  useEffect(() => {
    if (!liveFeedEnabled) return;
    const updates: LiveTickerUpdate[] = [];
    const streamFresh = isMarketLiveStreamFresh(liveStream);
    const pushQuote = (id: string, market: 'AR' | 'US', symbol: string): void => {
      const quote = getMarketLiveQuote(liveStream, market, symbol);
      if (quote === null) return;
      const extBadge = formatExtendedSessionBadge(quote.sessionPhase);
      const displayPrice =
        extBadge !== null && quote.extendedPrice !== undefined && quote.extendedPrice !== null
          ? quote.extendedPrice
          : quote.price;
      const displayChangePct =
        extBadge !== null && quote.extendedChangePct !== undefined && quote.extendedChangePct !== null
          ? quote.extendedChangePct
          : quote.changePct ?? Number.NaN;
      updates.push({
        id,
        symbol: id,
        price: displayPrice,
        changePct: displayChangePct,
        dir: quote.direction,
        sessionPhase: market === 'US' ? (quote.sessionPhase ?? null) : null,
      });
    };
    for (const symbol of ['SPY', 'QQQ', 'IWM', 'DIA', 'NVDA', 'AAPL']) {
      pushQuote(symbol, 'US', symbol);
    }
    pushQuote('VIX', 'US', 'I:VIX');
    for (const symbol of ['GGAL', 'SUPV', 'TXAR', 'YPFD', 'PAMP', 'BMA']) {
      pushQuote(symbol, 'AR', symbol);
    }
    if (streamFresh && liveStream.cclMedian !== null) {
      updates.push({ id: 'CCL', symbol: 'Dólar CCL', price: liveStream.cclMedian, changePct: Number.NaN, dir: null });
    }
    if (streamFresh && liveStream.mepMedian !== null) {
      updates.push({ id: 'MEP', symbol: 'Dólar MEP', price: liveStream.mepMedian, changePct: Number.NaN, dir: null });
    }
    if (updates.length > 0) globalTickerStore.applyRealUpdates(updates, true);
  }, [liveFeedEnabled, liveStream]);

  // Suscripción a actualizaciones reales emitidas por liveRuntimeBridge (Data912 / BYMA / Massive WS)
  useEffect(() => {
    if (!liveFeedEnabled) return;
    return subscribeLiveTickerUpdates((updates) => {
      globalTickerStore.applyRealUpdates(updates);
    });
  }, [liveFeedEnabled]);

  const streamIsFresh = isMarketLiveStreamFresh(liveStream);
  const liveClock =
    liveStream.lastReceivedAtMs !== null
      ? new Date(liveStream.lastReceivedAtMs).toLocaleTimeString('es-AR', { hour12: false })
      : '--:--:--';
  const feedTag = streamIsFresh
    ? liveStream.arSourceMode === 'LIVE_BMB'
      ? 'EN VIVO · BMB'
      : liveStream.arSourceMode === 'LIVE_IOL'
        ? 'EN VIVO · IOL'
        : `EN VIVO · ${liveStream.transport ?? 'WS'}`
    : feedStatus === 'LIVE'
      ? 'EN VIVO'
      : feedStatus === 'EOD_CIERRE'
      ? 'EOD CIERRE'
      : feedStatus === 'DIFERIDO_20M'
      ? 'DIFERIDO 20M'
      : feedStatus === 'PARTIAL'
      ? 'PARCIAL'
      : liveStream.status === 'CONNECTING' || liveStream.status === 'RECONNECTING'
        ? 'CONECTANDO ...'
        : 'SIN FEED';

  const isOpen = marketStatus === 'Abierto' && feedStatus !== 'NO_DATA';
  const isExtended =
    marketStatus === 'Pre-Market' ||
    marketStatus === 'After-Hours' ||
    feedStatus === 'EOD_CIERRE' ||
    feedStatus === 'DIFERIDO_20M' ||
    feedStatus === 'PARTIAL';

  const feedsPulseFresh =
    feedsHealth.lastPulseAtMs !== null && Date.now() - feedsHealth.lastPulseAtMs <= 15_000;
  const feedsSummary = feedsPulseFresh ? feedsHealth.snapshot?.summary ?? null : null;
  const feedsLabel =
    feedsSummary === null
      ? 'Feeds: —'
      : feedsSummary.activeCount > 0
        ? `Feeds: ${String(feedsSummary.activeCount)}/${String(feedsSummary.totalProviders)} Activos`
        : `Feeds: ${String(feedsSummary.configuredCount)}/${String(feedsSummary.totalProviders)} Armados`;
  const feedsBadgeTone =
    feedsSummary === null
      ? { bg: 'bg-[#131722]', text: 'text-[#787B86]', border: 'border-[#2A2E3D]' }
      : feedsSummary.activeCount > 0
        ? { bg: 'bg-[#0D221E]', text: 'text-[#22C55E]', border: 'border-[#164E3F]' }
        : feedsSummary.configuredCount > 0
          ? { bg: 'bg-[#281E0E]', text: 'text-[#F5B544]', border: 'border-[#59411A]' }
          : { bg: 'bg-[#1A1318]', text: 'text-[#F23645]', border: 'border-[#4A2229]' };

  return (
    <>
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
            NYSE / BYMA: {marketStatus} · {feedTag}
            {streamIsFresh ? ` · ${liveClock} · ${String(liveStream.ticksPerSecond)} ticks/s` : ''}
          </span>
        </button>

        {streamIsFresh && (
          <span className="hidden lg:inline-flex items-center gap-1 rounded-full border border-[#22C55E]/35 bg-[#22C55E]/10 px-2 py-0.5 font-mono-num text-[10px] font-semibold text-[#22C55E]">
            ● Tiempo real {liveClock}
          </span>
        )}

        <button
          type="button"
          onClick={() => setFeedsDrawerOpen(true)}
          aria-expanded={feedsDrawerOpen}
          aria-haspopup="dialog"
          title="Monitor unificado de salud, latencia y ticks de proveedores"
          className={`hidden md:inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 font-mono-num text-[10.5px] font-semibold transition-colors cursor-pointer ${feedsBadgeTone.bg} ${feedsBadgeTone.text} ${feedsBadgeTone.border} hover:brightness-110`}
        >
          <span
            className={`inline-flex h-1.5 w-1.5 rounded-full ${
              feedsHealth.socketStatus === 'LIVE' ? 'bg-current' : 'bg-[#787B86]'
            }`}
          />
          {feedsLabel}
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
    <FeedsHealthDrawer
      open={feedsDrawerOpen}
      onClose={() => setFeedsDrawerOpen(false)}
      health={feedsHealth}
      onReconnect={(provider: FeedProviderId) => {
        void feedsHealth.reconnectProvider(provider);
      }}
    />
    </>
  );
};

export default MarketTickerBar;
