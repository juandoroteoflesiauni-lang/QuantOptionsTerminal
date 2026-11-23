import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeOratsSignedRateToDecimal,
  oratsVolToPct,
} from '../../../../src/core/options/zeroDteFixes';
import {
  Activity,
  AlertTriangle,
  Clock,
  Layers,
  Play,
  RefreshCw,
  Scale,
  ShieldCheck,
  TrendingUp,
  Upload,
  X,
} from 'lucide-react';
import {
  fetchGgalClearingRisk,
  fetchGgalDualChartSeries,
  fetchGgalDualDensity,
  fetchGgalFeedStatus,
  fetchGgalMarginRisk,
  fetchGgalMicrostructure,
  fetchGgalOptionsSurface,
  fetchGgalParityGap,
  fetchGgalRegime2027,
  fetchGgalSpecialistOverview,
  fetchGgalStructurePinning,
  fetchGgalVolTriangle,
  postGgalAnexoBIngest,
  postGgalStrategySelector,
  type ArFeedRouterStatusSnapshotDto,
  type BymaClearingStrategyKindDto,
  type CollateralAssetKindDto,
  type GgalAvwapAnchorMode,
  type GgalBadgeMode,
  type GgalClearingRiskResponseDto,
  type GgalDualChartCoordMode,
  type GgalDualChartPayloadDto,
  type GgalDualChartTimeframe,
  type GgalDualDensityResponseDto,
  type GgalMarginRiskResponseDto,
  type GgalMicrostructureResponseDto,
  type GgalOptionsSurfaceResponseDto,
  type GgalParityGapResponseDto,
  type GgalRankedStrategyDto,
  type GgalRegime2027ResponseDto,
  type GgalSpecialistOverviewResponseDto,
  type GgalStrategyFamily,
  type GgalStrategySelectorResponseDto,
  type GgalStructurePinningResponseDto,
  type GgalTelemetryHeaderDto,
  type GgalVolTriangleResponseDto,
} from '../../api/ggalSpecialistClient';
import { fmtNum, fmtPct } from '../../data/marketData';
import { HelpTooltip, InsightBanner, KPICard } from '../DesignSystem';
import { CompanyLogo } from '../common/CompanyLogo';
import type { OrderTicketPreset } from '../Overlays';
import { GgalDualChartView } from './GgalDualChartView';
import {
  getMarketStreamMetaClock,
  pushLiveOrderBook,
  tickFlashClass,
  useAtomicMarketQuote,
  useLivePriceFlash,
  useMarketStreamMeta,
} from '../../api/useMarketLiveStream';

export type GgalTabId =
  | 'parity-gap'
  | 'vol-triangle'
  | 'dual-density'
  | 'structure-pinning'
  | 'strategy-selector'
  | 'microstructure-orats'
  | 'regime-2027'
  | 'margin-risk';

const TAB_ITEMS: readonly { readonly id: GgalTabId; readonly label: string }[] = [
  { id: 'parity-gap', label: '1. Paridad & Gap' },
  { id: 'vol-triangle', label: '2. Triángulo de Volatilidad' },
  { id: 'dual-density', label: '3. Densidad Dual P vs. Q' },
  { id: 'structure-pinning', label: '4. Estructura, Anexo B & Pinning' },
  { id: 'strategy-selector', label: '5. Selector de Estrategias' },
  { id: 'microstructure-orats', label: '6. Microestructura L2, VPIN & ORATS' },
  { id: 'regime-2027', label: '7. Régimen Electoral 2027' },
  { id: 'margin-risk', label: '8. Riesgo, Márgenes & Ejecución' },
];

const BYMA_CLEARING_STRATEGIES: readonly { readonly value: BymaClearingStrategyKindDto; readonly label: string }[] = [
  { value: 'VERTICAL_CREDIT_SPREAD', label: 'Vertical Spread Acreedor' },
  { value: 'UNCOVERED_SHORT', label: 'Lanzamiento Descubierto' },
  { value: 'VERTICAL_DEBIT_SPREAD', label: 'Vertical Spread Deudor' },
  { value: 'RATIO_SPREAD_1X2', label: 'Ratio Spread 1x2' },
  { value: 'RATIO_SPREAD_1X3', label: 'Ratio Spread 1x3' },
  { value: 'SHORT_STRADDLE_STRANGLE', label: 'Straddle / Strangle Vendido' },
  { value: 'COVERED_CALL', label: 'Lanzamiento Cubierto' },
  { value: 'CROSS_COLLATERAL_STRATEGY', label: 'Estrategia Cruzada / Cross-Collateral' },
];

const COLLATERAL_KINDS: readonly { readonly value: CollateralAssetKindDto; readonly label: string; readonly requiresExplicitAforo: boolean }[] = [
  { value: 'CASH_ARS', label: 'Pesos (CASH ARS · 100 %)', requiresExplicitAforo: false },
  { value: 'CASH_USD', label: 'Dólares (CASH USD · 100 %)', requiresExplicitAforo: false },
  { value: 'US_TREASURY_BILL', label: 'US Treasury Bill (98 %)', requiresExplicitAforo: false },
  { value: 'US_TREASURY_NOTE', label: 'US Treasury Note (96 %)', requiresExplicitAforo: false },
  { value: 'US_TREASURY_BOND', label: 'US Treasury Bond (94 %)', requiresExplicitAforo: false },
  { value: 'LECAP', label: 'LECAP Local (Aforo + WWR 15 %)', requiresExplicitAforo: true },
  { value: 'SOVEREIGN_BOND_AR', label: 'Bono Soberano AR (Aforo + WWR 15 %)', requiresExplicitAforo: true },
  { value: 'EQUITY_LOCAL', label: 'Acciones Locales (Aforo + WWR 15 %)', requiresExplicitAforo: true },
];

const STRATEGY_FAMILIES: readonly { readonly value: GgalStrategyFamily | 'ALL'; readonly label: string }[] = [
  { value: 'ALL', label: 'Todas las familias' },
  { value: 'BULL_CALL_SPREAD', label: 'Bull Call Spread' },
  { value: 'BEAR_PUT_SPREAD', label: 'Bear Put Spread' },
  { value: 'RATIO_1X2', label: 'Ratio 1x2' },
  { value: 'RATIO_1X3', label: 'Ratio 1x3' },
  { value: 'BUY_WRITE_T0', label: 'Buy-Write T+0 / 24hs' },
  { value: 'CALENDAR_ROLL_2M', label: 'Calendar Roll 2M' },
];

function badgeToneClass(badge: GgalBadgeMode): string {
  switch (badge) {
    case 'LIVE':
      return 'bg-[#0D2E1D] text-[#2EDC7E] border-[#1F6B43]';
    case 'EOD_CIERRE':
      return 'bg-[#1D2436] text-[#93C5FD] border-[#334155]';
    case 'DIFERIDO_20M':
      return 'bg-[#35280F] text-[#F5B544] border-[#785315]';
    case 'STALE_DATA_LOCK':
    case 'NO_DATA':
      return 'bg-[#361318] text-[#FF5C63] border-[#6E232B]';
    case 'T-1 ANEXO B':
      return 'bg-[#211B3A] text-[#A78BFA] border-[#43347A]';
  }
}

/* Pieza 32: origen del feed de opciones US/OPRA (Tradier Live + ORATS o
   Massive + ORATS) expuesto por /api/us/providers-status. */
type UsProvidersBadgeDto = {
  readonly status?: string;
  readonly usOptionsFeedBadge?: 'TRADIER LIVE + ORATS' | 'MASSIVE + ORATS';
};

const useUsOptionsFeedBadge = (pollMs = 30_000): 'TRADIER LIVE + ORATS' | 'MASSIVE + ORATS' | null => {
  const [badge, setBadge] = useState<'TRADIER LIVE + ORATS' | 'MASSIVE + ORATS' | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let active = true;
    const load = async () => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetch('/api/us/providers-status', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          if (active) setBadge(null);
          return;
        }
        const json = (await res.json()) as UsProvidersBadgeDto;
        if (active) setBadge(json.usOptionsFeedBadge ?? null);
      } catch {
        // Endpoint ausente: badge explícito '—', sin origen falso.
        if (active) setBadge(null);
      } finally {
        window.clearTimeout(timer);
      }
    };
    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, pollMs);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [pollMs]);
  return badge;
};

function fmtCurrency(val: number | null | undefined, prefix = '$ ', decimals = 2): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  return `${prefix}${fmtNum(val, decimals)}`;
}

function fmtAge(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  return `${Math.round(sec)}s`;
}

function sessionRegimeLabel(regime: string | undefined): string {
  switch (regime) {
    case 'OVERLAP':
      return 'OVERLAP AR + NY';
    case 'BYMA_ONLY':
      return 'BYMA SOLO';
    case 'NASDAQ_SOLO_17_18':
      return 'NASDAQ POST-CIERRE AR';
    case 'PREMARKET_REPRICE':
      return 'PRE-MARKET REPRICE';
    case 'CLOSED':
      return 'RUEDA CERRADA (EOD)';
    default:
      return regime ?? '—';
  }
}

const EmptyPanel: React.FC<{ title: string; detail: string }> = ({ title, detail }) => (
  <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-6 text-center space-y-1.5">
    <div className="text-[13px] font-bold text-[#E5E7EB]">{title}</div>
    <p className="text-[12px] text-[#9CA3AF] max-w-2xl mx-auto">{detail}</p>
  </div>
);

export const GgalSpecialistModule: React.FC<{
  onOpenOrderTicket: (preset: OrderTicketPreset) => void;
}> = ({ onOpenOrderTicket }) => {
  const [activeTab, setActiveTab] = useState<GgalTabId>('parity-gap');
  const liveArGgal = useAtomicMarketQuote('AR', 'GGAL', 250);
  const liveUsGgal = useAtomicMarketQuote('US', 'GGAL', 250);
  const liveStreamMeta = useMarketStreamMeta(500);
  const liveFx = liveStreamMeta.isFresh ? liveStreamMeta.liveFx : null;
  const liveClock = liveStreamMeta.isFresh ? getMarketStreamMetaClock(liveStreamMeta) : null;
  const arFlash = useLivePriceFlash(liveArGgal?.price ?? null);
  const usFlash = useLivePriceFlash(liveUsGgal?.price ?? null);
  // Pieza 32: origen del feed de opciones US/OPRA (Tradier Live o Massive) + ORATS.
  const usOptionsFeedBadge = useUsOptionsFeedBadge();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [overview, setOverview] = useState<GgalSpecialistOverviewResponseDto | null>(null);
  const [parityData, setParityData] = useState<GgalParityGapResponseDto | null>(null);
  const [volData, setVolData] = useState<GgalVolTriangleResponseDto | null>(null);
  const [dualData, setDualData] = useState<GgalDualDensityResponseDto | null>(null);
  const [structureData, setStructureData] = useState<GgalStructurePinningResponseDto | null>(null);
  const [strategyData, setStrategyData] = useState<GgalStrategySelectorResponseDto | null>(null);
  const [routerStatus, setRouterStatus] = useState<ArFeedRouterStatusSnapshotDto | null>(null);
  const [microData, setMicroData] = useState<GgalMicrostructureResponseDto | null>(null);
  const [surfaceData, setSurfaceData] = useState<GgalOptionsSurfaceResponseDto | null>(null);
  const [clearingRiskData, setClearingRiskData] = useState<GgalClearingRiskResponseDto | null>(null);
  const [regimeData, setRegimeData] = useState<GgalRegime2027ResponseDto | null>(null);
  const [marginRiskData, setMarginRiskData] = useState<GgalMarginRiskResponseDto | null>(null);

  // Dual Synced Charts state
  const [coordMode, setCoordMode] = useState<GgalDualChartCoordMode>('ARS_BYMA');
  const [chartTimeframe, setChartTimeframe] = useState<GgalDualChartTimeframe>('1D');
  const [avwapAnchor, setAvwapAnchor] = useState<GgalAvwapAnchorMode>('MONTH_START');
  const [dualChartPayload, setDualChartPayload] = useState<GgalDualChartPayloadDto | null>(null);
  const [dualChartLoading, setDualChartLoading] = useState(false);
  const [dualChartError, setDualChartError] = useState<string | null>(null);
  // Pieza 39: caché por vista (`mode:timeframe:anchor`) — pintado instantáneo
  // al cambiar de modo/timeframe sin desmontar el chart.
  const dualChartCacheRef = useRef(new Map<string, GgalDualChartPayloadDto>());
  const [dualMicroError, setDualMicroError] = useState<string | null>(null);

  // Filtros interactivos Motor 5 (0 lotes/nom por defecto cuando no hay Anexo B ingestado o en EOD)
  const [familyFilter, setFamilyFilter] = useState<GgalStrategyFamily | 'ALL'>('ALL');
  const [minBymaOiNom, setMinBymaOiNom] = useState<string>('0');
  const [minEvMultiple, setMinEvMultiple] = useState<string>('1.5');
  const [enforceThresholds, setEnforceThresholds] = useState<boolean>(false);

  // Parámetros interactivos Motor 6
  const [m6StrategyKind, setM6StrategyKind] = useState<BymaClearingStrategyKindDto>('VERTICAL_CREDIT_SPREAD');
  const [m6CapitalArs, setM6CapitalArs] = useState<string>('25000000');
  const [m6CollateralKind, setM6CollateralKind] = useState<CollateralAssetKindDto>('CASH_ARS');
  const [m6CollateralValueArs, setM6CollateralValueArs] = useState<string>('5000000');
  const [m6CollateralAforo, setM6CollateralAforo] = useState<string>('');
  const [m6DesiredLots, setM6DesiredLots] = useState<string>('20');
  const [m6Side, setM6Side] = useState<'BUY' | 'SELL'>('BUY');

  // Modal Anexo B IAMC
  const [anexoModalOpen, setAnexoModalOpen] = useState(false);
  const [anexoDateInput, setAnexoDateInput] = useState(() => new Date().toISOString().slice(0, 10));
  const [anexoRawText, setAnexoRawText] = useState('');
  const [anexoExpiryCode, setAnexoExpiryCode] = useState('');
  const [allowProxyOi, setAllowProxyOi] = useState(false);
  const [anexoSubmitting, setAnexoSubmitting] = useState(false);
  const [anexoError, setAnexoError] = useState<string | null>(null);
  const [anexoSuccess, setAnexoSuccess] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const dualChartAbortRef = useRef<AbortController | null>(null);
  const dualMicroAbortRef = useRef<AbortController | null>(null);
  const dualWarmRetryRef = useRef<{ readonly key: string; readonly attempts: number }>({
    key: '',
    attempts: 0,
  });
  const dualWarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dualChartRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dualChartRetryAttemptsRef = useRef(0);
  const lastValidDualChartRef = useRef<GgalDualChartPayloadDto | null>(null);
  const loadDualChartRef = useRef<((forceRefresh?: boolean) => Promise<void>) | null>(null);

  const clearDualChartRetryTimer = (): void => {
    if (dualChartRetryTimerRef.current !== null) {
      clearTimeout(dualChartRetryTimerRef.current);
      dualChartRetryTimerRef.current = null;
    }
  };

  const scheduleDualChartRetry = (): void => {
    if (dualChartRetryTimerRef.current !== null) return;
    if (dualChartRetryAttemptsRef.current >= 2) {
      if (lastValidDualChartRef.current === null || lastValidDualChartRef.current.coordMode !== coordMode) {
        setDualChartError('No se pudo cargar el gráfico dual tras dos reintentos.');
      }
      return;
    }
    const delayMs = dualChartRetryAttemptsRef.current === 0 ? 400 : 800;
    dualChartRetryAttemptsRef.current += 1;
    dualChartRetryTimerRef.current = setTimeout(() => {
      dualChartRetryTimerRef.current = null;
      void loadDualChartRef.current?.(false);
    }, delayMs);
  };

  const loadDualChart = useCallback(
    async (forceRefresh = false) => {
      clearDualChartRetryTimer();
      dualChartAbortRef.current?.abort();
      const ctrl = new AbortController();
      dualChartAbortRef.current = ctrl;
      const cacheKey = `${coordMode}:${chartTimeframe}:${avwapAnchor}`;
      const cached = dualChartCacheRef.current.get(cacheKey);
      const sameCurrencyFallback =
        lastValidDualChartRef.current !== null &&
        lastValidDualChartRef.current.coordMode === coordMode
          ? lastValidDualChartRef.current
          : null;
      if (cached !== undefined) {
        setDualChartPayload(cached);
        setDualChartError(null);
        setDualChartLoading(false);
      } else if (sameCurrencyFallback !== null) {
        setDualChartPayload(sameCurrencyFallback);
        setDualChartError(null);
        setDualChartLoading(true);
      } else {
        setDualChartPayload(null);
        setDualChartError(null);
        setDualChartLoading(true);
      }
      try {
        const res = await fetchGgalDualChartSeries({
          coord: coordMode,
          timeframe: chartTimeframe,
          avwapAnchor,
          forceRefresh,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        setRouterStatus(res.routerStatus);
        if (res.dualChart.status === 'UNAVAILABLE' && res.dualChart.reason === 'DUAL_CHART_WARMING_UP') {
          scheduleDualChartRetry();
          return;
        }
        if (res.dualChart.status === 'OPERATIONAL') {
          dualChartRetryAttemptsRef.current = 0;
          lastValidDualChartRef.current = res.dualChart;
          dualChartCacheRef.current.delete(cacheKey);
          dualChartCacheRef.current.set(cacheKey, res.dualChart);
          while (dualChartCacheRef.current.size > 24) {
            const oldestKey = dualChartCacheRef.current.keys().next().value;
            if (oldestKey === undefined) break;
            dualChartCacheRef.current.delete(oldestKey);
          }
          setDualChartPayload(res.dualChart);
          setDualChartError(null);
        } else if (cached === undefined && lastValidDualChartRef.current === null) {
          setDualChartPayload(res.dualChart);
        }
      } catch {
        if (!ctrl.signal.aborted) {
          scheduleDualChartRetry();
        }
      } finally {
        if (!ctrl.signal.aborted) {
          setDualChartLoading(false);
        }
      }
    },
    [avwapAnchor, chartTimeframe, coordMode],
  );
  loadDualChartRef.current = loadDualChart;

  const loadDualMicro = useCallback(async (forceRefresh = false) => {
    dualMicroAbortRef.current?.abort();
    const ctrl = new AbortController();
    dualMicroAbortRef.current = ctrl;
    setDualMicroError(null);
    try {
      const res = await fetchGgalMicrostructure({ forceRefresh, signal: ctrl.signal });
      if (!ctrl.signal.aborted) {
        setMicroData(res);
        if (res.l2Ladder.available) {
          pushLiveOrderBook({
            symbol: res.l2Ladder.symbol,
            bids: res.l2Ladder.bids.map((level) => ({
              price: level.price,
              size: level.size,
              orderCount: level.orderCount,
            })),
            asks: res.l2Ladder.asks.map((level) => ({
              price: level.price,
              size: level.size,
              orderCount: level.orderCount,
            })),
            microprice:
              res.microstructure.status === 'OPERATIONAL' ? res.microstructure.micropriceMultiLevel : null,
            micropriceL1:
              res.microstructure.status === 'OPERATIONAL' ? res.microstructure.micropriceL1 : null,
            vpin: res.microstructure.status === 'OPERATIONAL' ? res.microstructure.vpin.vpin : null,
            asOfUtcSec: res.l2Ladder.asOfUtcSec,
            source: res.l2Ladder.activeProvider ?? 'UNKNOWN',
          });
        }
      }
    } catch (err: unknown) {
      if (!ctrl.signal.aborted) {
        setDualMicroError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  const loadTab = useCallback(
    async (tab: GgalTabId, forceRefresh = false) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setErrorMsg(null);
      try {
        const overviewPromise = fetchGgalSpecialistOverview({
          forceRefresh,
          signal: ctrl.signal,
        });
        const feedStatusPromise = fetchGgalFeedStatus({
          forceRefresh,
          signal: ctrl.signal,
        }).then((rs) => {
          if (!ctrl.signal.aborted) {
            setRouterStatus(rs);
          }
        });

        let tabPromise: Promise<void>;
        if (tab === 'parity-gap') {
          tabPromise = fetchGgalParityGap({ forceRefresh, signal: ctrl.signal }).then(setParityData);
        } else if (tab === 'vol-triangle') {
          tabPromise = fetchGgalVolTriangle({ forceRefresh, signal: ctrl.signal }).then(setVolData);
        } else if (tab === 'dual-density') {
          tabPromise = fetchGgalDualDensity({ forceRefresh, signal: ctrl.signal }).then(setDualData);
        } else if (tab === 'structure-pinning') {
          tabPromise = fetchGgalStructurePinning({ forceRefresh, signal: ctrl.signal, allowProxyOi }).then(
            setStructureData,
          );
        } else if (tab === 'microstructure-orats') {
          tabPromise = Promise.all([
            fetchGgalMicrostructure({ forceRefresh, signal: ctrl.signal }),
            fetchGgalOptionsSurface({ forceRefresh, signal: ctrl.signal }),
            fetchGgalClearingRisk({ forceRefresh, signal: ctrl.signal }),
          ]).then(([mRes, sRes, cRes]) => {
            if (!ctrl.signal.aborted) {
              setRouterStatus(mRes.routerStatus);
              setMicroData(mRes);
              setSurfaceData(sRes);
              setClearingRiskData(cRes);
            }
          });
        } else if (tab === 'regime-2027') {
          tabPromise = fetchGgalRegime2027({ forceRefresh, signal: ctrl.signal }).then((rRes) => {
            if (!ctrl.signal.aborted) {
              setRouterStatus(rRes.routerStatus);
              setRegimeData(rRes);
            }
          });
        } else if (tab === 'margin-risk') {
          const parsedCap = Number(m6CapitalArs);
          const parsedCollVal = Number(m6CollateralValueArs);
          const parsedAforo = m6CollateralAforo.trim() !== '' ? Number(m6CollateralAforo) : undefined;
          const parsedLots = Number(m6DesiredLots);
          tabPromise = fetchGgalMarginRisk(
            {
              strategyKind: m6StrategyKind,
              collateralKind: m6CollateralKind,
              side: m6Side,
              ...(Number.isFinite(parsedCap) && parsedCap > 0 ? { capitalArs: parsedCap } : {}),
              ...(Number.isFinite(parsedCollVal) && parsedCollVal >= 0
                ? { collateralValueArs: parsedCollVal }
                : {}),
              ...(parsedAforo !== undefined && Number.isFinite(parsedAforo) && parsedAforo > 0 && parsedAforo <= 1
                ? { collateralAforo: parsedAforo }
                : {}),
              ...(Number.isFinite(parsedLots) && parsedLots > 0 ? { desiredLots: parsedLots } : {}),
            },
            { forceRefresh, signal: ctrl.signal },
          ).then(setMarginRiskData);
        } else {
          const parsedOi = Number(minBymaOiNom);
          const parsedMult = Number(minEvMultiple);
          tabPromise = postGgalStrategySelector(
            {
              familyFilter,
              enforceThresholds,
              ...(Number.isFinite(parsedOi) && parsedOi >= 0 ? { minBymaOiNominals: parsedOi } : {}),
              ...(Number.isFinite(parsedMult) && parsedMult >= 0
                ? { minEvToCostMultiple: parsedMult }
                : {}),
              maxCandidates: 25,
            },
            { forceRefresh, signal: ctrl.signal },
          ).then(setStrategyData);
        }

        const [ov] = await Promise.all([overviewPromise, feedStatusPromise, tabPromise]);
        if (!ctrl.signal.aborted) {
          setOverview(ov);
        }
      } catch (err: unknown) {
        if (ctrl.signal.aborted) {
          return;
        }
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        if (!ctrl.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [
      allowProxyOi,
      enforceThresholds,
      familyFilter,
      m6CapitalArs,
      m6CollateralAforo,
      m6CollateralKind,
      m6CollateralValueArs,
      m6DesiredLots,
      m6Side,
      m6StrategyKind,
      minBymaOiNom,
      minEvMultiple,
    ],
  );

  useEffect(() => {
    dualChartRetryAttemptsRef.current = 0;
    void loadDualChart(false);
    return () => {
      dualChartAbortRef.current?.abort();
      clearDualChartRetryTimer();
    };
  }, [loadDualChart]);

  // Cold start: el bundle del especialista puede tardar >1 s. Si el primer payload
  // llega sin cono (sin IV/vencimiento reales), reintentamos con espera acotada
  // para completarlo cuando el bundle ya está caliente. Nunca se dibuja un cono sintético.
  useEffect(() => {
    if (dualChartPayload === null || dualChartPayload.status !== 'OPERATIONAL') {
      return;
    }
    if ((dualChartPayload.expectedCone?.length ?? 0) >= 2) {
      return;
    }
    const key = `${coordMode}|${chartTimeframe}|${avwapAnchor}`;
    const previous = dualWarmRetryRef.current;
    const attempts = previous.key === key ? previous.attempts : 0;
    if (attempts >= 3) {
      return;
    }
    const nextAttempt = attempts + 1;
    dualWarmRetryRef.current = { key, attempts: nextAttempt };
    const delaysMs = [8_000, 16_000, 24_000] as const;
    const delay = delaysMs[nextAttempt - 1] ?? 24_000;
    dualWarmTimerRef.current = setTimeout(() => {
      dualWarmTimerRef.current = null;
      void loadDualChart(false);
    }, delay);
    return () => {
      if (dualWarmTimerRef.current !== null) {
        clearTimeout(dualWarmTimerRef.current);
        dualWarmTimerRef.current = null;
      }
    };
  }, [dualChartPayload, coordMode, chartTimeframe, avwapAnchor, loadDualChart]);

  useEffect(() => {
    void loadDualMicro(false);
    return () => {
      dualMicroAbortRef.current?.abort();
    };
  }, [loadDualMicro]);

  useEffect(() => {
    void loadTab(activeTab, false);
    return () => {
      abortRef.current?.abort();
    };
  }, [activeTab, loadTab]);

  const activeTelemetry: GgalTelemetryHeaderDto | null = useMemo(() => {
    if (activeTab === 'parity-gap' && parityData !== null) return parityData.telemetry;
    if (activeTab === 'vol-triangle' && volData !== null) return volData.telemetry;
    if (activeTab === 'dual-density' && dualData !== null) return dualData.telemetry;
    if (activeTab === 'structure-pinning' && structureData !== null) return structureData.telemetry;
    if (activeTab === 'strategy-selector' && strategyData !== null) return strategyData.telemetry;
    if (activeTab === 'margin-risk' && marginRiskData !== null) return marginRiskData.telemetry;
    return overview?.telemetry ?? null;
  }, [activeTab, dualData, marginRiskData, overview, parityData, strategyData, structureData, volData]);

  const handleIngestAnexoB = async (e: React.FormEvent) => {
    e.preventDefault();
    setAnexoSubmitting(true);
    setAnexoError(null);
    setAnexoSuccess(null);
    try {
      const res = await postGgalAnexoBIngest({
        asOfDate: anexoDateInput.trim() || undefined,
        rawText: anexoRawText,
        ...(anexoExpiryCode.trim() ? { expiryCode: anexoExpiryCode.trim() } : {}),
        sourceLabel: 'IAMC_ANEXO_B_MANUAL',
      });
      const expiries = Object.values(res.record.byExpiry ?? {});
      const loaded = expiries.length > 0
        ? expiries.map((item) => `${item.contractualExpiry} · ${item.totals.strikesCount} strikes`).join(', ')
        : `${res.record.totals.strikesCount} strikes`;
      setAnexoSuccess(`Informe ${res.record.asOfDate} · ${loaded}`);
      setAnexoModalOpen(false);
      await loadTab('structure-pinning', false);
      setActiveTab('structure-pinning');
    } catch (err: unknown) {
      setAnexoError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnexoSubmitting(false);
    }
  };

  const renderSpreadChart = () => {
    const pts = (parityData?.historicalSpreads ?? []).filter(
      (p) => p.spreadLogBps !== null && Number.isFinite(p.spreadLogBps),
    );
    if (pts.length < 2) {
      return (
        <EmptyPanel
          title="Serie histórica de spread CCL GGAL vs. Soberanos insuficiente"
          detail="Requiere histórico alineado GGAL BYMA, GGAL ADR (Massive) y AL30/AL30C para calibrar las bandas ±2σ de equilibrio Ornstein-Uhlenbeck."
        />
      );
    }

    const vals = pts.map((p) => p.spreadLogBps as number);
    const mu = parityData?.result.ccl.ouMeanBps;
    const eqSig = parityData?.result.ccl.ouEqSigmaBps;
    const bandHigh =
      mu !== null && mu !== undefined && eqSig !== null && eqSig !== undefined
        ? mu + 2 * eqSig
        : null;
    const bandLow =
      mu !== null && mu !== undefined && eqSig !== null && eqSig !== undefined
        ? mu - 2 * eqSig
        : null;

    const allY = [...vals];
    if (mu !== null && mu !== undefined) allY.push(mu);
    if (bandHigh !== null) allY.push(bandHigh);
    if (bandLow !== null) allY.push(bandLow);
    const minY = Math.min(...allY);
    const maxY = Math.max(...allY);
    const spanY = Math.max(10, maxY - minY);

    const w = 780;
    const h = 210;
    const padL = 48;
    const padR = 16;
    const padT = 14;
    const padB = 24;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const toX = (idx: number) => padL + (idx / (pts.length - 1)) * innerW;
    const toY = (v: number) => padT + innerH - ((v - minY) / spanY) * innerH;

    const linePath = pts
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${toX(idx).toFixed(1)} ${toY(p.spreadLogBps as number).toFixed(1)}`)
      .join(' ');

    return (
      <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[12.5px] font-bold text-[#F3F4F6]">
            Spread Log CCL GGAL vs. Benchmark Soberano (pbs) + Bandas OU ±2σ
          </div>
          <div className="flex items-center gap-3 text-[11px] font-mono-num text-[#9CA3AF]">
            <span>Obs causal: {pts.length}</span>
            <span>μ: {mu !== null && mu !== undefined ? `${fmtNum(mu, 1)} pb` : '—'}</span>
            <span>σ_eq: {eqSig !== null && eqSig !== undefined ? `${fmtNum(eqSig, 1)} pb` : '—'}</span>
          </div>
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[210px] overflow-visible">
          {bandHigh !== null && bandLow !== null && (
            <rect
              x={padL}
              y={toY(bandHigh)}
              width={innerW}
              height={Math.max(1, toY(bandLow) - toY(bandHigh))}
              fill="#8B7CF6"
              fillOpacity={0.08}
            />
          )}
          {mu !== null && mu !== undefined && (
            <line
              x1={padL}
              x2={w - padR}
              y1={toY(mu)}
              y2={toY(mu)}
              stroke="#9CA3AF"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          )}
          <path d={linePath} fill="none" stroke="#8B7CF6" strokeWidth={2} />
          <text x={padL - 6} y={padT + 10} textAnchor="end" className="fill-[#787B86] text-[10px] font-mono-num">
            {fmtNum(maxY, 0)}
          </text>
          <text x={padL - 6} y={h - padB} textAnchor="end" className="fill-[#787B86] text-[10px] font-mono-num">
            {fmtNum(minY, 0)}
          </text>
          <text x={padL} y={h - 6} className="fill-[#787B86] text-[10px] font-mono-num">
            {pts[0]?.date}
          </text>
          <text x={w - padR} y={h - 6} textAnchor="end" className="fill-[#787B86] text-[10px] font-mono-num">
            {pts[pts.length - 1]?.date}
          </text>
        </svg>
      </div>
    );
  };

  const renderSmileChart = () => {
    const pts = (volData?.smileComparison ?? []).filter(
      (p) =>
        p.bymaCallMidIvPct !== null ||
        p.bymaPutMidIvPct !== null ||
        p.theoreticalBymaIvPct !== null,
    );
    if (pts.length < 2) {
      return (
        <EmptyPanel
          title="Sonrisa BYMA vs. Teórica Triangular no disponible"
          detail="Se requieren al menos 2 strikes con IV BS02 válida en BYMA y slice coincidente en OPRA USD."
        />
      );
    }

    const ivVals: number[] = [];
    for (const p of pts) {
      if (p.bymaCallMidIvPct !== null) ivVals.push(p.bymaCallMidIvPct);
      if (p.bymaPutMidIvPct !== null) ivVals.push(p.bymaPutMidIvPct);
      if (p.theoreticalBymaIvPct !== null) ivVals.push(p.theoreticalBymaIvPct);
    }
    const minY = Math.max(0, Math.min(...ivVals) - 3);
    const maxY = Math.max(...ivVals) + 3;
    const spanY = Math.max(5, maxY - minY);
    const strikes = pts.map((p) => p.strikeArs);
    const minX = Math.min(...strikes);
    const maxX = Math.max(...strikes);
    const spanX = Math.max(1, maxX - minX);

    const w = 780;
    const h = 210;
    const padL = 46;
    const padR = 16;
    const padT = 14;
    const padB = 24;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const toX = (k: number) => padL + ((k - minX) / spanX) * innerW;
    const toY = (v: number) => padT + innerH - ((v - minY) / spanY) * innerH;

    const buildPath = (getter: (p: (typeof pts)[number]) => number | null) => {
      let d = '';
      for (const p of pts) {
        const v = getter(p);
        if (v === null) continue;
        d += `${d === '' ? 'M' : ' L'} ${toX(p.strikeArs).toFixed(1)} ${toY(v).toFixed(1)}`;
      }
      return d;
    };

    const callPath = buildPath((p) => p.bymaCallMidIvPct);
    const theoPath = buildPath((p) => p.theoreticalBymaIvPct);

    return (
      <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[12.5px] font-bold text-[#F3F4F6]">
            Smile IV BYMA BS02 (%) vs. Curva Teórica Triangular OPRA + CCL
          </div>
          <div className="flex items-center gap-4 text-[11px] font-mono-num">
            <span className="text-[#2EDC7E]">● IV Call BYMA</span>
            <span className="text-[#8B7CF6]">● IV Teórica Triangular</span>
          </div>
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[210px] overflow-visible">
          {theoPath !== '' && (
            <path d={theoPath} fill="none" stroke="#8B7CF6" strokeWidth={2} strokeDasharray="5 3" />
          )}
          {callPath !== '' && <path d={callPath} fill="none" stroke="#2EDC7E" strokeWidth={2} />}
          {pts.map((p) =>
            p.bymaCallMidIvPct !== null ? (
              <circle
                key={`c-${p.strikeArs}`}
                cx={toX(p.strikeArs)}
                cy={toY(p.bymaCallMidIvPct)}
                r={3}
                fill="#2EDC7E"
              />
            ) : null,
          )}
          <text x={padL - 6} y={padT + 10} textAnchor="end" className="fill-[#787B86] text-[10px] font-mono-num">
            {fmtNum(maxY, 1)}%
          </text>
          <text x={padL - 6} y={h - padB} textAnchor="end" className="fill-[#787B86] text-[10px] font-mono-num">
            {fmtNum(minY, 1)}%
          </text>
          <text x={padL} y={h - 6} className="fill-[#787B86] text-[10px] font-mono-num">
            ${fmtNum(minX, 0)}
          </text>
          <text x={w - padR} y={h - 6} textAnchor="end" className="fill-[#787B86] text-[10px] font-mono-num">
            ${fmtNum(maxX, 0)}
          </text>
        </svg>
      </div>
    );
  };

  const renderDualDensityHistogram = () => {
    const nodes = (dualData?.result?.simulatedNodes ?? []).filter(
      (n) => n.spotArs !== null && Number.isFinite(n.spotArs) && n.probability !== null,
    );
    if (nodes.length < 10) {
      return (
        <EmptyPanel
          title="Densidad Física P_{USD/CER} sin nodos simulados"
          detail="Requiere serie causal alineada ADR USD + CCL GGAL + índice CER BCRA v4.0 (>= 25 ruedas) y superficie SVI BYMA/OPRA."
        />
      );
    }

    const prices = nodes.map((n) => n.spotArs as number);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const span = Math.max(1, maxP - minP);
    const binCount = 24;
    const bins = Array.from({ length: binCount }, () => 0);
    for (const n of nodes) {
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((((n.spotArs as number) - minP) / span) * binCount)));
      bins[idx] = (bins[idx] ?? 0) + (n.probability ?? 0);
    }
    const maxProb = Math.max(1e-6, ...bins);

    const w = 780;
    const h = 195;
    const padL = 42;
    const padR = 16;
    const padT = 14;
    const padB = 24;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const barW = innerW / binCount;
    const qMeanArs = dualData?.result?.riskNeutralBymaArs.impliedMeanArs;

    return (
      <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[12.5px] font-bold text-[#F3F4F6]">
            Histograma Terminal Físico P_(USD/CER) en ARS vs. Media Riesgo-Neutral Q_BYMA
          </div>
          <div className="flex items-center gap-4 text-[11px] font-mono-num text-[#9CA3AF]">
            <span>Nodos Halton: {nodes.length}</span>
            <span>E_Q[S_T]: {fmtCurrency(qMeanArs, '$ ', 0)}</span>
          </div>
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[195px]">
          {bins.map((prob, idx) => {
            const barH = (prob / maxProb) * innerH;
            return (
              <rect
                key={idx}
                x={padL + idx * barW + 1}
                y={padT + innerH - barH}
                width={Math.max(2, barW - 2)}
                height={barH}
                rx={2}
                fill="#8B7CF6"
                fillOpacity={0.72}
              />
            );
          })}
          {qMeanArs !== null && qMeanArs !== undefined && qMeanArs >= minP && qMeanArs <= maxP && (
            <line
              x1={padL + ((qMeanArs - minP) / span) * innerW}
              x2={padL + ((qMeanArs - minP) / span) * innerW}
              y1={padT}
              y2={padT + innerH}
              stroke="#F5B544"
              strokeWidth={2}
              strokeDasharray="4 3"
            />
          )}
          <text x={padL} y={h - 6} className="fill-[#787B86] text-[10px] font-mono-num">
            ${fmtNum(minP, 0)}
          </text>
          <text x={w - padR} y={h - 6} textAnchor="end" className="fill-[#787B86] text-[10px] font-mono-num">
            ${fmtNum(maxP, 0)}
          </text>
        </svg>
      </div>
    );
  };

  const renderGexProfileChart = () => {
    const isProxy = allowProxyOi && structureData?.gexStatus === 'ESTIMATED_PROXY_OPT_IN';
    const profile = (isProxy ? structureData?.proxyResult : structureData?.result)?.strikeProfile ?? [];
    if (profile.length === 0) {
      return null;
    }

    const gexVals = profile.map((r) => r.effectiveSignedGex ?? 0);
    const maxAbs = Math.max(1, ...gexVals.map((v) => Math.abs(v)));
    const w = 780;
    const h = 210;
    const padL = 48;
    const padR = 16;
    const padT = 18;
    const padB = 28;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const midY = padT + innerH / 2;
    const barW = innerW / profile.length;

    return (
      <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[12.5px] font-bold text-[#F3F4F6] flex items-center gap-2">
            <span>
              {isProxy
                ? 'Perfil Signed GEX Ponderado (Proxy Data912 — Sin Anexo B)'
                : 'Perfil Signed GEX Ponderado (Anexo B IAMC en Acciones Nominales)'}
            </span>
            {isProxy && (
              <span className="px-2 py-0.5 rounded text-[10px] font-mono-num bg-[#F5B544]/15 text-[#F5B544] border border-[#F5B544]/40">
                PROXY DATA912 (SIN ANEXO B)
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-[11px] font-mono-num">
            <span className="text-[#2EDC7E]">■ GEX (+) Mean-Reverting</span>
            <span className="text-[#FF5C63]">■ GEX (−) Trending</span>
          </div>
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[210px]">
          <line x1={padL} x2={w - padR} y1={midY} y2={midY} stroke="#2E3244" strokeWidth={1} />
          {profile.map((row, idx) => {
            const val = row.effectiveSignedGex ?? 0;
            const barH = (Math.abs(val) / maxAbs) * (innerH / 2 - 4);
            const y = val >= 0 ? midY - barH : midY;
            const fill = val >= 0 ? '#2EDC7E' : '#FF5C63';
            return (
              <g key={row.strikeArs ?? idx}>
                <rect
                  x={padL + idx * barW + 2}
                  y={y}
                  width={Math.max(4, barW - 4)}
                  height={Math.max(1.5, barH)}
                  rx={2}
                  fill={fill}
                  fillOpacity={0.82}
                />
                {idx % Math.max(1, Math.floor(profile.length / 8)) === 0 && (
                  <text
                    x={padL + idx * barW + barW / 2}
                    y={h - 8}
                    textAnchor="middle"
                    className="fill-[#787B86] text-[9.5px] font-mono-num"
                  >
                    ${fmtNum(row.strikeArs, 0)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    );
  };

  const renderTelemetryBar = () => {
    const t = activeTelemetry;
    const badges: readonly GgalBadgeMode[] = t?.feedBadges ?? ['NO_DATA'];
    return (
      <div className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2.5 pr-3 border-r border-[#1E1E2B]">
            <CompanyLogo ticker="GGAL" name="Grupo Financiero Galicia" size="lg" />
            <div className="flex items-center gap-2">
              <Scale className="w-4 h-4 text-[#8B7CF6]" />
              <span className="text-[13.5px] font-bold text-[#F3F4F6] tracking-tight">
                GGAL Specialist
              </span>
              <span className="text-[11px] font-mono-num text-[#9CA3AF]">
                BYMA 100 · ADR 10:1
              </span>
            </div>
          </div>

          {badges.map((b) => (
            <span
              key={b}
              className={`px-2 py-0.5 rounded-[6px] border text-[10.5px] font-mono-num font-semibold uppercase tracking-wider ${badgeToneClass(b)}`}
            >
              {b}
            </span>
          ))}

          {(liveArGgal !== null || liveUsGgal !== null) && liveClock !== null && (
            <span className="rounded-full border border-[#22C55E]/35 bg-[#22C55E]/10 px-2 py-0.5 font-mono-num text-[10px] font-semibold text-[#22C55E]">
              ● Tiempo real {liveClock}
            </span>
          )}

          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[6px] bg-[#171722] border border-[#1E1E2B] text-[10.5px] font-mono-num text-[#D1D5DB]">
            <Clock className="w-3 h-3 text-[#8B7CF6]" />
            {t?.dstMode ?? '—'} · {sessionRegimeLabel(t?.sessionRegime)}
          </span>

          <span className="px-2 py-0.5 rounded-[6px] bg-[#171722] border border-[#1E1E2B] text-[10.5px] font-mono-num text-[#9CA3AF]">
            D912: {fmtAge(t?.data912AgeSec)} · Massive: {fmtAge(t?.massiveAgeSec)}
          </span>

          <span className="px-2 py-0.5 rounded-[6px] bg-[#171722] border border-[#1E1E2B] text-[10.5px] font-mono-num text-[#9CA3AF]">
            Base: {t?.executionPriceBasis ?? '—'} · Grabador 20s: {t?.recorder.snapshotsCount ?? 0}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAnexoModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-[#211B3A] border border-[#43347A] hover:border-[#8B7CF6] text-[12px] font-semibold text-[#C4B5FD] transition-colors cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            Ingestar Anexo B IAMC
          </button>
          <button
            type="button"
            onClick={() => void loadTab(activeTab, true)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-[#171722] border border-[#2A2A3B] hover:border-[#8B7CF6] text-[12px] font-semibold text-[#E5E7EB] disabled:opacity-50 transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {renderTelemetryBar()}

      {errorMsg !== null && (
        <InsightBanner tag="Error Runtime" variant="neg">
          {errorMsg}
        </InsightBanner>
      )}

      {(() => {
        if (activeTelemetry === null) return null;
        const closedSession =
          activeTelemetry.marketMode === 'EOD_CIERRE' || activeTelemetry.sessionRegime === 'CLOSED';
        const hasOperationalContingency = activeTelemetry.feedStatus !== 'NO_DATA';
        const visibleWarnings = activeTelemetry.providerErrors.filter((err) => {
          if (closedSession && /open\.bymadata\.com\.ar/i.test(err)) {
            return false;
          }
          if ((closedSession || hasOperationalContingency) && /aborted due to timeout/i.test(err)) {
            return false;
          }
          return true;
        });
        if (visibleWarnings.length === 0) return null;
        return (
          <InsightBanner tag="Avisos de Fuente" variant="warn">
            {visibleWarnings.join(' | ')}
          </InsightBanner>
        );
      })()}

      {/* Telemetría compacta del Router AR (Zero Silent Fallbacks) */}
      {routerStatus !== null && (() => {
        const hasBrokerConfigured = routerStatus.providers.some(
          (p) =>
            p.provider !== 'DATA912_EOD_CONTINGENCY' &&
            p.provider !== 'IAMC_ANEXO_B_PDF' &&
            p.configured,
        );
        const operatingContingency =
          !hasBrokerConfigured &&
          routerStatus.activePrimaryEquityProvider === 'DATA912_EOD_CONTINGENCY';
        return (
          <div className="rounded-[10px] bg-[#111116] border border-[#1C1C24] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="font-semibold text-[#9CA3AF]">Enrutador Feeds AR:</span>
              <span className="rounded px-2 py-0.5 font-mono bg-[#0A0A0D] text-[#E5C76B] border border-[#E5C76B]/35">
                {operatingContingency
                  ? 'Massive (ADR/OPRA) + Data912 (BYMA)'
                  : `Activo: ${routerStatus.activePrimaryEquityProvider ?? 'NINGUNO'}`}
              </span>
              <span
                className={`rounded px-2 py-0.5 font-mono border ${
                  routerStatus.l2Available
                    ? 'bg-[#22C55E]/10 text-[#22C55E] border-[#22C55E]/35'
                    : hasBrokerConfigured
                      ? 'bg-[#EF4444]/10 text-[#EF4444] border-[#EF4444]/35'
                      : 'bg-[#0A0A0D] text-[#9CA3AF] border-[#1C1C24]'
                }`}
              >
                {routerStatus.l2Available
                  ? 'L2 5-Puntas OK'
                  : hasBrokerConfigured
                    ? 'L2 Desconectado'
                    : 'L1 / EOD (Sin credenciales L2)'}
              </span>
              {routerStatus.activeQualityTier !== 'REALTIME_L2_TICK' && (
                <span className="rounded px-2 py-0.5 font-mono bg-[#0A0A0D] text-[#9CA3AF] border border-[#1C1C24]">
                  {routerStatus.activeQualityTier}
                </span>
              )}
              {routerStatus.futuresDlrLive === 'CONNECTED' && (
                <span className="rounded px-2 py-0.5 font-mono bg-[#22C55E]/10 text-[#22C55E] border border-[#22C55E]/35">
                  {routerStatus.futuresDlrProvider === 'PRIMARY_REMARKETS_SANDBOX'
                    ? 'DLR WS SANDBOX'
                    : 'DLR WS LIVE'}{' '}
                  ({routerStatus.futuresDlrCount ?? 0})
                </span>
              )}
              {hasBrokerConfigured && routerStatus.degradationReason !== null && (
                <span className="rounded px-2 py-0.5 font-mono bg-[#EF4444]/10 text-[#EF4444] border border-[#EF4444]/35">
                  {routerStatus.degradationReason}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {routerStatus.providers.map((p) => {
                const label = p.provider
                  .replace('PRIMARY_MATRIZ_WS', 'MATRIZ')
                  .replace('_REST', '')
                  .replace('_MARKETDATA_V1', '')
                  .replace('BYMA_CLEARING', 'CLEARING')
                  .replace('IAMC_ANEXO_B_PDF', 'ANEXO B')
                  .replace('DATA912_EOD_CONTINGENCY', 'DATA912');
                return (
                  <span
                    key={p.provider}
                    title={`${p.roleDescription} | ${p.connected ? p.qualityTier : (p.errorReason ?? 'UNAVAILABLE')}${p.latencyMs !== null ? ` (${String(p.latencyMs)}ms)` : ''}`}
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] border ${
                      p.connected
                        ? 'bg-[#22C55E]/10 border-[#22C55E]/35 text-[#22C55E]'
                        : p.configured
                          ? 'bg-[#E5C76B]/10 border-[#E5C76B]/35 text-[#E5C76B]'
                          : 'bg-[#0A0A0D] border-[#1C1C24] text-[#6B7280]'
                    }`}
                  >
                    {label}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Gráficos full-width: precio + CVD, con bloque inferior fijo GEX/L2/niveles */}
      <GgalDualChartView
        payload={dualChartPayload}
        microstructure={microData}
        microstructureError={dualMicroError}
        loading={dualChartLoading}
        error={dualChartError}
        coordMode={coordMode}
        timeframe={chartTimeframe}
        avwapAnchor={avwapAnchor}
        onChangeCoordMode={setCoordMode}
        onChangeTimeframe={setChartTimeframe}
        onChangeAvwapAnchor={setAvwapAnchor}
        onRefresh={() => {
          void loadDualChart(true);
          void loadDualMicro(true);
        }}
      />

      {/* Sub-navegación de 7 motores */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#1E1E2B] pb-2.5">
        {TAB_ITEMS.map((t) => {
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`px-3 py-1.5 rounded-[8px] text-[12.5px] font-semibold transition-all cursor-pointer ${
                active
                  ? 'bg-[#8B7CF6]/15 text-[#FFFFFF] border border-[#8B7CF6]'
                  : 'bg-[#11111A] text-[#9CA3AF] border border-[#1E1E2B] hover:text-[#E5E7EB] hover:border-[#2E2E42]'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1 — PARIDAD & GAP */}
      {activeTab === 'parity-gap' && parityData !== null && (
        <div className="space-y-4">
          <InsightBanner
            tag="Paridad & OU AR(1)"
            variant={
              parityData.result.signal === 'STALE_DATA_LOCK'
                ? 'neg'
                : parityData.result.signal === 'NEUTRAL'
                  ? 'default'
                  : 'pos'
            }
          >
            Señal activa: <strong className="font-mono-num">{parityData.result.signal}</strong> · Liquidación ΔAR={parityData.result.deltaAr1Days ?? '—'}d / ΔUS={parityData.result.deltaUs1Days ?? '—'}d · Edge neto={fmtNum(parityData.result.ccl.netEdgeAfterCostsBps, 1)} pb · Prob. cierre 5d={fmtPct(parityData.result.ccl.closeProbability5d !== null ? parityData.result.ccl.closeProbability5d * 100 : null, 1, false)}
          </InsightBanner>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="px-5 py-4 rounded-[10px] bg-[#131722] border border-[#232733] hover:border-[#343B4F] transition-all flex flex-col justify-between gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <CompanyLogo ticker="GGAL" name="GGAL BYMA 24hs / CI" size="md" />
                  <span className="text-[12.5px] font-medium text-[#9CA3AF] truncate">
                    GGAL BYMA 24hs / CI
                  </span>
                  <HelpTooltip
                    title="GGAL BYMA 24hs / CI"
                    text="Cotización mid de GGAL en BYMA 24hs y cierre teórico ajustado por paridad SOFR/Caución y apertura ADR."
                  />
                </div>
                <span className="text-[10px] font-mono-num font-semibold uppercase tracking-wider text-[#787B86] shrink-0">
                  {parityData.telemetry.marketMode}
                </span>
              </div>
              <div className="flex items-baseline gap-2.5 pt-0.5">
                <div
                  className={`rounded px-1 font-mono-num tabular-nums text-[23px] leading-[28px] font-bold ${tickFlashClass(arFlash)}`}
                >
                  {fmtCurrency(liveArGgal?.price ?? parityData.result.spot.byma24hArs, '$ ', 2)}
                </div>
              </div>
              <div className="text-[11.5px] text-[#787B86] leading-snug truncate">
                {`Contado Inmediato: ${fmtCurrency(parityData.result.spot.bymaCiArs, '$ ', 2)} · Fair Open: ${fmtCurrency(parityData.result.spot.fairBymaOpenArs, '$ ', 2)}`}
              </div>
            </div>
            <div className="px-5 py-4 rounded-[10px] bg-[#131722] border border-[#232733] hover:border-[#343B4F] transition-all flex flex-col justify-between gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <CompanyLogo ticker="GGAL" name="GGAL ADR (NASDAQ 10:1)" size="md" />
                  <span className="text-[12.5px] font-medium text-[#9CA3AF] truncate">
                    GGAL ADR (NASDAQ 10:1)
                  </span>
                  <HelpTooltip
                    title="GGAL ADR (NASDAQ 10:1)"
                    text="Precio del ADR en dólares en NASDAQ y paridad justa implícita frente al benchmark de bonos soberanos."
                  />
                </div>
                <span className="text-[10px] font-mono-num font-semibold uppercase tracking-wider text-[#787B86] shrink-0">
                  {parityData.rateInputs.sofrSource ?? 'SOFR'}
                </span>
              </div>
              <div className="flex items-baseline gap-2.5 pt-0.5">
                <div
                  className={`rounded px-1 font-mono-num tabular-nums text-[23px] leading-[28px] font-bold ${tickFlashClass(usFlash)}`}
                >
                  {fmtCurrency(liveUsGgal?.price ?? parityData.result.spot.adrMidUsd, 'US$ ', 2)}
                </div>
              </div>
              <div className="text-[11.5px] text-[#787B86] leading-snug truncate">
                {`ADR Justo s/ AL30: ${fmtCurrency(parityData.result.spot.fairAdrUsd, 'US$ ', 2)} · SOFR: ${fmtPct(parityData.rateInputs.sofrPct, 2, false)}`}
              </div>
            </div>
            <KPICard
              title="CCL GGAL vs. Soberanos"
              heroValue={fmtCurrency(liveFx?.cclImplicitGgal ?? parityData.result.ccl.cclGgal24h, '$ ', 2)}
              badge="BMA/BYMA"
              subtitle={`Benchmark AL30/GD30: ${fmtCurrency(liveFx?.cclMedian ?? parityData.result.ccl.cclSovereignBenchmark, '$ ', 2)} · Spread: ${fmtNum(parityData.result.ccl.spreadLogBps, 1)} pb`}
              helpText="Contado con Liquidación implícito en GGAL ajustado por diferencial T+1 ARS vs T+1 US frente al promedio ponderado AL30/GD30."
            />
            <KPICard
              title="Z-Score OU & Vida Media"
              heroValue={fmtNum(parityData.result.ccl.zScore, 2)}
              badge={parityData.result.ouCalibration.status}
              subtitle={`Half-life: ${fmtNum(parityData.result.ccl.ouHalfLifeDays, 2)} d · Gap apertura: ${fmtPct(parityData.result.spot.gapPctVsPrevClose, 2, true)}`}
              helpText="Calibración estrictamente causal Ornstein-Uhlenbeck AR(1) del spread logarítmico."
            />
          </div>

          {renderSpreadChart()}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[#1E1E2B] text-[12.5px] font-bold text-[#F3F4F6]">
                Patas de Benchmark Soberano (ARS 24hs / USD-C)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] font-mono-num">
                  <thead className="bg-[#0B0B12] text-[#787B86] text-[10.5px] uppercase">
                    <tr>
                      <th className="text-left px-3 py-2">Bono</th>
                      <th className="text-right px-3 py-2">ARS Bid/Ask</th>
                      <th className="text-right px-3 py-2">USD-C Bid/Ask</th>
                      <th className="text-right px-3 py-2">CCL Impl.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E1E2B]">
                    {parityData.sovereignBonds.map((b) => (
                      <tr key={b.ticker} className="hover:bg-[#171722]">
                        <td className="px-3 py-2 font-bold text-[#E5E7EB]">{b.ticker}</td>
                        <td className="px-3 py-2 text-right text-[#D1D5DB]">
                          {fmtNum(b.arsBid, 1)} / {fmtNum(b.arsAsk, 1)}
                        </td>
                        <td className="px-3 py-2 text-right text-[#D1D5DB]">
                          {fmtNum(b.usdCBid, 2)} / {fmtNum(b.usdCAsk, 2)}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-[#8B7CF6]">
                          {fmtCurrency(b.cclImplied, '$ ', 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[#1E1E2B] text-[12.5px] font-bold text-[#F3F4F6]">
                Repricing Pre-Apertura de Opciones BYMA (Taylor Orden 2)
              </div>
              {parityData.result.preOpenOptionRepricing.length === 0 ? (
                <div className="p-4 text-[12px] text-[#9CA3AF]">
                  Sin contratos con griegas completas para repricing de apertura.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-[240px]">
                  <table className="w-full text-[12px] font-mono-num">
                    <thead className="bg-[#0B0B12] text-[#787B86] text-[10.5px] uppercase">
                      <tr>
                        <th className="text-left px-3 py-2">Serie</th>
                        <th className="text-right px-3 py-2">Cierre Prev.</th>
                        <th className="text-right px-3 py-2">Fair Open</th>
                        <th className="text-right px-3 py-2">Δ %</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1E1E2B]">
                      {parityData.result.preOpenOptionRepricing.map((opt) => (
                        <tr key={opt.tickerByma} className="hover:bg-[#171722]">
                          <td className="px-3 py-2 font-semibold text-[#E5E7EB]">{opt.tickerByma}</td>
                          <td className="px-3 py-2 text-right text-[#D1D5DB]">{fmtCurrency(opt.prevCloseArs, '$ ', 2)}</td>
                          <td className="px-3 py-2 text-right text-[#FFFFFF]">{fmtCurrency(opt.fairOpenArs, '$ ', 2)}</td>
                          <td
                            className={`px-3 py-2 text-right font-semibold ${
                              (opt.deltaRepricePct ?? 0) >= 0 ? 'text-[#2EDC7E]' : 'text-[#FF5C63]'
                            }`}
                          >
                            {fmtPct(opt.deltaRepricePct, 2, true)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2 — TRIÁNGULO DE VOLATILIDAD */}
      {activeTab === 'vol-triangle' && volData !== null && (() => {
        const volExt = volData as typeof volData & {
          readonly impliedCclVolWingsPct?: number | null;
          readonly impliedCclMinFloorPct?: number | null;
          readonly atmCompressionPts?: number | null;
        };
        const isCompressed = volData.result?.boundaryRegime === 'VIOLATION_BYMA_COMPRESSED';
        const cclHeroValue =
          volData.result?.impliedCclVolPct !== null && volData.result?.impliedCclVolPct !== undefined
            ? fmtPct(volData.result.impliedCclVolPct, 2, false)
            : isCompressed
              ? volExt.impliedCclVolWingsPct !== null && volExt.impliedCclVolWingsPct !== undefined
                ? `σ_CCL (Alas/Puts): ${fmtPct(volExt.impliedCclVolWingsPct, 2, false)}`
                : volExt.atmCompressionPts !== null && volExt.atmCompressionPts !== undefined
                  ? `Compresión ATM: ${fmtNum(volExt.atmCompressionPts, 1)} pts vs OPRA`
                  : volExt.impliedCclMinFloorPct !== null && volExt.impliedCclMinFloorPct !== undefined
                    ? `Piso σ_min: ${fmtPct(volExt.impliedCclMinFloorPct, 2, false)}`
                    : '—'
              : '—';
        const cclBadge =
          isCompressed && volExt.atmCompressionPts !== null && volExt.atmCompressionPts !== undefined
            ? `Compresión ATM: ${fmtNum(volExt.atmCompressionPts, 1)} pts vs OPRA`
            : (volData.result?.boundaryRegime ?? '—');
        return (
        <div className="space-y-4">
          <InsightBanner
            tag="Triángulo σ_BYMA² = σ_ADR² + σ_CCL² + 2ρσ_ADRσ_CCL"
            variant={
              volData.result?.boundaryRegime === 'VIOLATION_BYMA_COMPRESSED' ? 'warn' : 'default'
            }
          >
            Vto BYMA: <strong className="font-mono-num">{volData.frontExpiryCode ?? '—'}</strong> ({volData.frontDteCalendar ?? '—'}d) · OPRA Match: <strong className="font-mono-num">{volData.opraMatchedExpiryDate ?? '—'}</strong> · Régimen: <strong className="font-mono-num">{volData.result?.boundaryRegime ?? 'NO_DATA'}</strong> · Violaciones No-Arb: <strong className="font-mono-num">{volData.result?.arbViolationsCount ?? 0}</strong>
          </InsightBanner>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <KPICard
              title="IV ATM BYMA (BS02 T+0)"
              heroValue={fmtPct(volData.result?.bymaAtmIvPct, 2, false)}
              badge={volData.frontExpiryCode ?? 'BYMA'}
              subtitle={`25D Skew BYMA (P−C): ${fmtPct(volData.result?.skewMetrics.byma25dPutMinusCallPct, 2, true)}`}
              helpText="Volatilidad implícita americana Bjerksund-Stensland 2002 ajustada por liquidación T+0 vs acciones 24hs."
            />
            <KPICard
              title="IV ATM ADR OPRA (USD)"
              heroValue={fmtPct(volData.result?.opraAdrAtmIvPct, 2, false)}
              badge={usOptionsFeedBadge ?? 'OPRA'}
              subtitle={`25D Skew OPRA (P−C): ${fmtPct(volData.result?.skewMetrics.opra25dPutMinusCallPct, 2, true)}`}
              helpText="Volatilidad implícita del ADR GGAL en OPRA interpolada por varianza total al plazo BYMA. Origen del feed US: Tradier Live + ORATS o Massive + ORATS."
            />
            <KPICard
              title="IV Implícita del CCL (Modo A)"
              heroValue={cclHeroValue}
              badge={cclBadge}
              subtitle={`HAR-RV CCL: ${fmtPct(volData.result?.harRvCclPct, 2, false)} · ρ_impl (Modo B): ${fmtNum(volData.result?.impliedCorrelation, 3)} · Regime: ${volData.result?.boundaryRegime ?? '—'}`}
              helpText={`Inversión triangular de volatilidad implícita del tipo de cambio CCL fijando ρ_EWMA; en VIOLATION_BYMA_COMPRESSED muestra σ_CCL sobre alas OTM/Puts o compresión ATM vs OPRA (piso σ_CCL,min: ${fmtPct(volExt.impliedCclMinFloorPct, 2, false)}).`}
            />
            <KPICard
              title="Compresión Call Overwriting"
              heroValue={fmtPct(volData.result?.skewMetrics.overwritingCompressionScore, 2, true)}
              badge={`ρ EWMA: ${fmtNum(volData.result?.realizedCorrEwma, 3)}`}
              subtitle={`Observaciones alineadas: ${volData.returnObservationsUsed} · Anomalías: ${volData.result?.anomalies.length ?? 0}`}
              helpText="Detecta si el lanzamiento cubierto en BYMA deprime el ala derecha frente al skew teórico importado de OPRA."
            />
          </div>

          {renderSmileChart()}

          <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#1E1E2B] flex items-center justify-between">
              <span className="text-[12.5px] font-bold text-[#F3F4F6]">
                Anomalías RelVal por Moneyness Estandarizado z y Cotas de Arbitraje
              </span>
              <span className="text-[11px] font-mono-num text-[#9CA3AF]">
                {volData.smileComparison.length} strikes analizados
              </span>
            </div>
            <div className="overflow-x-auto max-h-[300px]">
              <table className="w-full text-[12px] font-mono-num">
                <thead className="bg-[#0B0B12] text-[#787B86] text-[10.5px] uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Strike ARS</th>
                    <th className="text-right px-3 py-2">z</th>
                    <th className="text-right px-3 py-2">IV Call BYMA</th>
                    <th className="text-right px-3 py-2">IV Teórica</th>
                    <th className="text-right px-3 py-2">Spread (pts)</th>
                    <th className="text-center px-3 py-2">Sesgo</th>
                    <th className="text-right px-3 py-2">OI Nom</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E1E2B]">
                  {volData.smileComparison.map((row) => (
                    <tr key={row.strikeArs} className="hover:bg-[#171722]">
                      <td className="px-3 py-2 font-bold text-[#FFFFFF]">${fmtNum(row.strikeArs, 0)}</td>
                      <td className="px-3 py-2 text-right text-[#D1D5DB]">{fmtNum(row.standardizedMoneynessZ, 2)}</td>
                      <td className="px-3 py-2 text-right text-[#2EDC7E]">{fmtPct(row.bymaCallMidIvPct, 2, false)}</td>
                      <td className="px-3 py-2 text-right text-[#8B7CF6]">{fmtPct(row.theoreticalBymaIvPct, 2, false)}</td>
                      <td
                        className={`px-3 py-2 text-right font-semibold ${
                          (row.relValVolSpreadPct ?? 0) < -2
                            ? 'text-[#2EDC7E]'
                            : (row.relValVolSpreadPct ?? 0) > 2
                              ? 'text-[#FF5C63]'
                              : 'text-[#D1D5DB]'
                        }`}
                      >
                        {fmtPct(row.relValVolSpreadPct, 2, true)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className="px-2 py-0.5 rounded bg-[#171722] border border-[#2A2A3B] text-[10.5px]">
                          {row.sideBias ?? row.arbFlag ?? '—'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-[#9CA3AF]">{fmtNum(row.openInterestNom, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        );
      })()}

      {/* TAB 3 — DENSIDAD DUAL P vs. Q */}
      {activeTab === 'dual-density' && dualData !== null && (
        <div className="space-y-4">
          <InsightBanner
            tag="Cópula P_{USD/CER} vs. Breeden-Litzenberger Q"
            variant={
              dualData.result?.tailDislocationSignal === 'ALIGNED' || dualData.result === null
                ? 'default'
                : 'pos'
            }
          >
            Señal Dislocación 10%: <strong className="font-mono-num">{dualData.result?.tailDislocationSignal ?? 'NO_DATA'}</strong> · Fuente CER: <strong className="font-mono-num">{dualData.cerSource ?? '—'}</strong> ({dualData.cerSeriesCount} obs BCRA · {dualData.historicalObsUsed} ruedas alineadas)
          </InsightBanner>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <KPICard
              title="Cópula t-Student (P)"
              heroValue={
                dualData.result?.physicalMetricsUsd.studentTCopulaDof !== null &&
                dualData.result?.physicalMetricsUsd.studentTCopulaDof !== undefined
                  ? `ν=${fmtNum(dualData.result.physicalMetricsUsd.studentTCopulaDof, 1)}`
                  : '—'
              }
              badge={dualData.result?.physicalMetricsUsd.status ?? 'NO_DATA'}
              subtitle={`ρ_copula: ${fmtNum(dualData.result?.physicalMetricsUsd.studentTCopulaRho, 3)} · CVaR 95%: ${fmtPct(dualData.result?.physicalMetricsUsd.cvar95UsdPct, 2, true)}`}
              helpText="Grados de libertad estimados por pseudo-verosimilitud sobre retornos ADR USD y CCL deflactado por CER."
            />
            <KPICard
              title="Retorno / Vol Física P (USD)"
              heroValue={fmtPct(dualData.result?.physicalMetricsUsd.expectedReturnPct, 2, true)}
              badge={`${dualData.dteCalendar ?? '—'}d`}
              subtitle={`Vol P: ${fmtPct(dualData.result?.physicalMetricsUsd.volatilityPct, 2, false)} · CER horizonte: ${fmtPct(dualData.expectedCerGrowthOverHorizonPct, 2, true)}`}
            />
            <KPICard
              title="Densidad Q_BYMA (SVI)"
              heroValue={fmtCurrency(dualData.result?.riskNeutralBymaArs.impliedMeanArs, '$ ', 0)}
              badge={`KL: ${fmtNum(dualData.result?.riskNeutralBymaArs.klDivergencePvsQ, 4)}`}
              subtitle={`IV Q: ${fmtPct(dualData.result?.riskNeutralBymaArs.impliedVolPct, 2, false)} · ΔCola Izq: ${fmtPct(dualData.result?.riskNeutralBymaArs.leftTail10PctProbDiff !== null && dualData.result?.riskNeutralBymaArs.leftTail10PctProbDiff !== undefined ? dualData.result.riskNeutralBymaArs.leftTail10PctProbDiff * 100 : null, 2, true)}`}
            />
            <KPICard
              title="Densidad Q_OPRA (SVI USD)"
              heroValue={fmtCurrency(dualData.result?.riskNeutralOpraUsd.impliedMeanUsd, 'US$ ', 2)}
              badge={`KL: ${fmtNum(dualData.result?.riskNeutralOpraUsd.klDivergencePvsQ, 4)}`}
              subtitle={`IV Q: ${fmtPct(dualData.result?.riskNeutralOpraUsd.impliedVolPct, 2, false)} · ΔCola Der: ${fmtPct(dualData.result?.riskNeutralBymaArs.rightTail10PctProbDiff !== null && dualData.result?.riskNeutralBymaArs.rightTail10PctProbDiff !== undefined ? dualData.result.riskNeutralBymaArs.rightTail10PctProbDiff * 100 : null, 2, true)}`}
            />
          </div>

          {renderDualDensityHistogram()}
        </div>
      )}

      {/* TAB 4 — ESTRUCTURA, ANEXO B & PINNING */}
      {activeTab === 'structure-pinning' && structureData !== null && (() => {
        const usingProxy = allowProxyOi && structureData.gexStatus === 'ESTIMATED_PROXY_OPT_IN';
        const effStruct = usingProxy ? structureData.proxyResult ?? null : structureData.result;
        const flowBadge =
          structureData.flowBasis === 'EOD_PREV_SESSION'
            ? 'EOD RUEDA PREVIA'
            : (effStruct?.intradayFlow.leeReadyConfidence ?? 'SNAPSHOT_20S_APPROX');
        return (
        <div className="space-y-4">
          <div className="flex min-h-9 flex-wrap items-center gap-x-3 text-[12px] text-[#D1D5DB]">
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={allowProxyOi} onChange={(event) => setAllowProxyOi(event.target.checked)} />
              Estimar GEX con volumen
            </label>
            <span className="inline-flex w-28 tabular-nums text-[#F5B544]">
              {usingProxy ? 'PROXY OPT-IN' : structureData.gexStatus === 'PARTIAL_COVERAGE'
                ? `${fmtPct((structureData.oiCoverageRatio ?? 0) * 100, 0, false)} parcial` : ''}
            </span>
            <span>Signo dealer teórico</span>
          </div>
            <div className="min-h-20 rounded-[10px] bg-[#211B3A]/60 border border-[#43347A] p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-[#A78BFA] shrink-0 mt-0.5" />
                <div className="text-[12.5px] text-[#E5E7EB]">{structureData.notice ?? 'Anexo B disponible para el vencimiento consultado.'}</div>
              </div>
              <button
                type="button"
                onClick={() => setAnexoModalOpen(true)}
                className="px-3 py-1.5 rounded-[8px] bg-[#8B7CF6] hover:bg-[#7C6CE6] text-[12px] font-semibold text-white cursor-pointer"
              >
                Ingestar Anexo B ahora
              </button>
            </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 tabular-nums">
            <KPICard
              title="Régimen Gamma & Zero-Gamma"
              heroValue={fmtCurrency(effStruct?.zeroGammaLevelArs, '$ ', 0)}
              badge={effStruct?.regime ?? 'NO_DATA'}
              subtitle={`GEX${structureData.gexStatus === 'PARTIAL_COVERAGE' ? ' parcial' : ''}: ${fmtCurrency(effStruct?.netEffectiveGexArsPer1Pct, '$ ', 0)} /1%${usingProxy ? ' · Proxy opt-in' : ''}`}
              helpText="Nivel donde la exposición Gamma ponderada (Anexo B IAMC o Proxy Data912) cruza por cero vía método de Brent."
            />
            <KPICard
              title="Call Wall / Put Wall"
              heroValue={`${fmtCurrency(effStruct?.putWallArs, '$ ', 0)} / ${fmtCurrency(effStruct?.callWallArs, '$ ', 0)}`}
              badge={usingProxy ? (structureData.proxySource ?? 'PROXY DATA912 (SIN ANEXO B)') : structureData.telemetry.anexoBStatus}
              subtitle={`Lag Anexo B: ${structureData.telemetry.anexoBLagTradingDays !== null ? `${structureData.telemetry.anexoBLagTradingDays}d` : usingProxy ? 'Proxy activo' : '—'}`}
            />
            <KPICard
              title="Monitor Pinning 15:30 ART"
              heroValue={fmtCurrency(effStruct?.peakPinStrikeArs, '$ ', 0)}
              badge={effStruct?.isExpiryDay ? 'OPEX HOY' : 'NO OPEX'}
              subtitle={`Pin Score: ${fmtNum(effStruct?.maxPinScore, 3)} · Min a 15:30 ART: ${fmtNum(effStruct?.minutesTo1530Cutoff, 0)}`}
            />
            <KPICard
              title="Flujo Intradiario Firmado"
              heroValue={fmtCurrency(effStruct?.intradayFlow.bymaNetSignedArs, '$ ', 0)}
              badge={flowBadge}
              subtitle={`ADR Flow: ${fmtCurrency(effStruct?.intradayFlow.adrNetSignedUsd, 'US$ ', 0)} · Snapshots 20s: ${structureData.telemetry.recorder.flowPointsCount}`}
            />
          </div>

          <div className="h-[255px] overflow-hidden">{renderGexProfileChart()}</div>

          {effStruct !== null ? (
            <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[#1E1E2B] flex flex-wrap items-center justify-between gap-2 text-[12.5px] font-bold text-[#F3F4F6]">
                <span>
                  {usingProxy
                    ? `Desglose Signed GEX / Vanna / Pinning (${structureData.frontExpiryCode ?? '—'}) — Volumen/OI Proxy Data912`
                    : 'Desglose Anexo B IAMC por Strike (Acciones Nominales sin multiplicar x100)'}
                </span>

              </div>
              <div className="h-[260px] overflow-auto">
                <table className="w-full text-[11.5px] font-mono-num tabular-nums">
                  <thead className="bg-[#0B0B12] text-[#787B86] text-[10.5px] uppercase">
                    <tr>
                      <th className="text-left px-3 py-2">Strike</th>
                      <th className="text-right px-3 py-2">Cubierta</th>
                      <th className="text-right px-3 py-2">{usingProxy ? 'DESCUB. (PROXY)' : 'Descubierta'}</th>
                      <th className="text-right px-3 py-2">Opuesta</th>
                      <th className="text-right px-3 py-2">Cruzada</th>
                      <th className="text-right px-3 py-2">Signed GEX</th>
                      <th className="text-right px-3 py-2">Vanna</th>
                      <th className="text-right px-3 py-2">Pin Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E1E2B]">
                    {effStruct.strikeProfile.map((r, idx) => (
                      <tr key={r.strikeArs ?? idx} className="hover:bg-[#171722]">
                        <td className="px-3 py-2 font-bold text-[#FFFFFF]">${fmtNum(r.strikeArs, 0)}</td>
                        <td className="px-3 py-2 text-right text-[#9CA3AF]">{fmtNum(r.oiCoveredNom, 0)}</td>
                        <td className="px-3 py-2 text-right text-[#F5B544]">{fmtNum(r.oiUncoveredNom, 0)}</td>
                        <td className="px-3 py-2 text-right text-[#9CA3AF]">{fmtNum(r.oiOppositeNom, 0)}</td>
                        <td className="px-3 py-2 text-right text-[#9CA3AF]">{fmtNum(r.oiCrossedNom, 0)}</td>
                        <td
                          className={`px-3 py-2 text-right font-semibold ${
                            (r.effectiveSignedGex ?? 0) >= 0 ? 'text-[#2EDC7E]' : 'text-[#FF5C63]'
                          }`}
                        >
                          {fmtNum(r.effectiveSignedGex, 0)}
                        </td>
                        <td className="px-3 py-2 text-right text-[#D1D5DB]">{fmtNum(r.vannaExpArs, 0)}</td>
                        <td className="px-3 py-2 text-right font-semibold text-[#A78BFA]">{fmtNum(r.pinScore, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[#1E1E2B] flex items-center justify-between">
                <span className="text-[12.5px] font-bold text-[#F3F4F6]">
                  Cadena BYMA ({structureData.frontExpiryCode ?? '—'})
                </span>
                <HelpTooltip
                  title="Data912 vs. Anexo B IAMC"
                  text="Data912 publica volumen en vivo. El OI se muestra cuando el feed lo informa explícitamente. El Anexo B IAMC aporta el desglose de nominales por categoría."
                />
              </div>
              <div className="h-[260px] overflow-auto">
                <table className="w-full text-[12px] font-mono-num tabular-nums">
                  <thead className="bg-[#0B0B12] text-[#787B86] text-[10.5px] uppercase">
                    <tr>
                      <th className="text-left px-3 py-2">Strike ARS</th>
                      <th className="text-right px-3 py-2">OI Total Call (nom.)</th>
                      <th className="text-right px-3 py-2">IV Call</th>
                      <th className="text-right px-3 py-2">OI Total Put (nom.)</th>
                      <th className="text-right px-3 py-2">IV Put</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E1E2B]">
                    {structureData.data912TotalOiFallback.map((row) => (
                      <tr key={row.strikeArs} className="hover:bg-[#171722]">
                        <td className="px-3 py-2 font-bold text-[#FFFFFF]">${fmtNum(row.strikeArs, 0)}</td>
                        <td className="px-3 py-2 text-right text-[#2EDC7E]">{fmtNum(row.callTotalOiNom, 0)}</td>
                        <td className="px-3 py-2 text-right text-[#D1D5DB]">{fmtPct(row.callIvPct, 1, false)}</td>
                        <td className="px-3 py-2 text-right text-[#FF5C63]">{fmtNum(row.putTotalOiNom, 0)}</td>
                        <td className="px-3 py-2 text-right text-[#D1D5DB]">{fmtPct(row.putIvPct, 1, false)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        );
      })()}

      {/* TAB 5 — SELECTOR DE ESTRATEGIAS */}
      {activeTab === 'strategy-selector' && (
        <div className="space-y-4">
          <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="block text-[10.5px] uppercase tracking-wider text-[#787B86] font-mono-num">
                Familia de Estrategia
              </label>
              <select
                value={familyFilter}
                onChange={(e) => setFamilyFilter(e.target.value as GgalStrategyFamily | 'ALL')}
                className="px-3 py-1.5 rounded-[8px] bg-[#0B0B12] border border-[#2A2A3B] text-[12px] text-[#E5E7EB]"
              >
                {STRATEGY_FAMILIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <label className="block text-[10.5px] uppercase tracking-wider text-[#787B86] font-mono-num">
                  OI Mínimo BYMA (nom.)
                </label>
                <button
                  type="button"
                  onClick={() => setMinBymaOiNom(minBymaOiNom === '0' ? '100000' : '0')}
                  className="text-[10px] font-mono-num text-[#8B7CF6] hover:underline cursor-pointer"
                >
                  {minBymaOiNom === '0' ? 'Usar 1.000 lotes' : 'Fijar 0 (sin Anexo B)'}
                </button>
              </div>
              <input
                type="number"
                min={0}
                value={minBymaOiNom}
                onChange={(e) => setMinBymaOiNom(e.target.value)}
                className="w-36 px-3 py-1.5 rounded-[8px] bg-[#0B0B12] border border-[#2A2A3B] text-[12px] font-mono-num text-[#E5E7EB]"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-[10.5px] uppercase tracking-wider text-[#787B86] font-mono-num">
                Múltiplo EV / Costo
              </label>
              <input
                type="number"
                min={0}
                step={0.1}
                value={minEvMultiple}
                onChange={(e) => setMinEvMultiple(e.target.value)}
                className="w-28 px-3 py-1.5 rounded-[8px] bg-[#0B0B12] border border-[#2A2A3B] text-[12px] font-mono-num text-[#E5E7EB]"
              />
            </div>

            <label className="inline-flex items-center gap-2 text-[12px] text-[#D1D5DB] pb-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={enforceThresholds}
                onChange={(e) => setEnforceThresholds(e.target.checked)}
                className="accent-[#8B7CF6]"
              />
              Exigir EV &gt; 0 y 1.5x round-trip
            </label>

            <button
              type="button"
              onClick={() => void loadTab('strategy-selector', false)}
              disabled={loading}
              className="ml-auto inline-flex items-center gap-1.5 px-4 py-1.5 rounded-[8px] bg-[#8B7CF6] hover:bg-[#7C6CE6] text-[12px] font-semibold text-white cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              Evaluar Motor 5
            </button>
          </div>

          {strategyData !== null && (
            <>
              <InsightBanner tag="Benchmarks & Fricciones BYMA + IVA 21%" variant="default">
                Caución 1d: <strong className="font-mono-num">{fmtPct(strategyData.result?.marketBenchmarks.caucion1dTnaPct, 2, false)}</strong> · Lecap emp.: <strong className="font-mono-num">{fmtPct(strategyData.result?.marketBenchmarks.lecapMatchedTnaPct, 2, false)}</strong> · SOFR: <strong className="font-mono-num">{fmtPct(strategyData.result?.marketBenchmarks.sofrPct, 2, false)}</strong> · Nodos P simulados: <strong className="font-mono-num">{strategyData.physicalNodesCount}</strong>
              </InsightBanner>

              {(strategyData.result?.rankedStrategies ?? []).length === 0 ? (
                <EmptyPanel
                  title="Sin estrategias aprobadas bajo los umbrales actuales"
                  detail="Prueba desactivar el filtro estricto (1.5x round-trip) o verifica que existan puntas Bid/Ask reales, OI nominal y distribución física P_{USD/CER} activa."
                />
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
                  {(strategyData.result?.rankedStrategies ?? []).map((cand: GgalRankedStrategyDto) => {
                    const primaryLeg = cand.legs[0];
                    return (
                      <div
                        key={cand.id}
                        className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] hover:border-[#343B4F] p-4 space-y-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-bold text-[#FFFFFF]">{cand.family}</span>
                              <span className="px-2 py-0.5 rounded bg-[#171722] border border-[#2A2A3B] text-[10px] font-mono-num text-[#8B7CF6]">
                                {cand.venue}
                              </span>
                            </div>
                            <div className="text-[11px] font-mono-num text-[#787B86] mt-0.5">{cand.id}</div>
                          </div>
                          {primaryLeg !== undefined && primaryLeg.currency === 'ARS' && (
                            <button
                              type="button"
                              onClick={() =>
                                onOpenOrderTicket({
                                  ticker: primaryLeg.ticker,
                                  side: primaryLeg.side === 'BUY' ? 'Compra' : 'Venta',
                                  price: primaryLeg.execPrice ?? 0,
                                  qty: primaryLeg.qtyContracts,
                                  instrumentLabel: `${cand.family} · ${primaryLeg.ticker}`,
                                })
                              }
                              className="px-2.5 py-1 rounded-[7px] bg-[#1E1B3A] border border-[#43347A] hover:border-[#8B7CF6] text-[11px] font-semibold text-[#C4B5FD] cursor-pointer"
                            >
                              Armar orden
                            </button>
                          )}
                        </div>

                        <div className="space-y-1 text-[11.5px] font-mono-num bg-[#0B0B12] rounded-[8px] p-2.5 border border-[#1A1A26]">
                          {cand.legs.map((leg, i) => (
                            <div key={`${cand.id}-leg-${i}`} className="flex items-center justify-between">
                              <span>
                                <strong className={leg.side === 'BUY' ? 'text-[#2EDC7E]' : 'text-[#FF5C63]'}>
                                  {leg.side}
                                </strong>{' '}
                                {leg.qtyContracts}x <span className="text-[#E5E7EB]">{leg.ticker}</span> ({leg.settlement})
                              </span>
                              <span className="text-[#D1D5DB]">
                                {leg.currency === 'ARS' ? '$ ' : 'US$ '}
                                {fmtNum(leg.execPrice, 2)}
                              </span>
                            </div>
                          ))}
                        </div>

                        <div className="grid grid-cols-3 gap-2 text-[11.5px] font-mono-num">
                          <div>
                            <div className="text-[10px] text-[#787B86] uppercase">EV bajo P</div>
                            <div
                              className={`font-bold ${
                                (cand.economics.expectedValueUnderP ?? 0) >= 0 ? 'text-[#2EDC7E]' : 'text-[#FF5C63]'
                              }`}
                            >
                              {fmtNum(cand.economics.expectedValueUnderP, 0)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-[#787B86] uppercase">PoP % / Sharpe</div>
                            <div className="text-[#FFFFFF] font-semibold">
                              {fmtPct(
                                cand.economics.probProfitUnderP !== null
                                  ? cand.economics.probProfitUnderP * 100
                                  : null,
                                1,
                                false,
                              )}{' '}
                              / {fmtNum(cand.economics.netSharpeProxy, 2)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-[#787B86] uppercase">Fricción + IVA</div>
                            <div className="text-[#F5B544]">{fmtNum(cand.economics.allInFeesAndIva, 0)}</div>
                          </div>
                          <div>
                            <div className="text-[10px] text-[#787B86] uppercase">TNA / vs Lecap</div>
                            <div className="text-[#D1D5DB]">
                              {fmtPct(cand.economics.tnaYieldPct, 1, false)} ({fmtNum(cand.economics.spreadOverLecapBps, 0)} pb)
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-[#787B86] uppercase">OPRA Sharpe Eq.</div>
                            <div className="text-[#D1D5DB]">
                              {fmtNum(cand.usdAlternativeComparison.opraEquivalentSharpe, 2)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-[#787B86] uppercase">Ventaja BYMA</div>
                            <div className="text-[#8B7CF6]">
                              {fmtNum(cand.usdAlternativeComparison.bymaAdvantageBps, 0)} pb
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* TAB 6 — MICROESTRUCTURA L2 / VPIN (MOTOR 8), SUPERFICIE ORATS HÍBRIDA & CLEARING */}
      {activeTab === 'microstructure-orats' && (
        <div className="space-y-4">
          {microData !== null && microData.microstructure.status === 'UNAVAILABLE' && (
            <InsightBanner tag="Degradación Explícita Motor 8 (Zero Silent Fallbacks)" variant="neg">
              Microestructura L2 INDISPONIBLE ({microData.microstructure.reason}):{' '}
              {microData.microstructure.detail} · Proveedor activo:{' '}
              {microData.microstructure.activeProvider ?? 'NINGUNO'} (
              {microData.microstructure.qualityTier})
            </InsightBanner>
          )}

          {microData !== null && microData.microstructure.status === 'OPERATIONAL' && (
            <div className="space-y-3">
              {microData.microstructure.vpin.toxicAlert && (
                <InsightBanner tag="VPIN Toxicidad > Percentil 90" variant="neg">
                  Flujo informado elevado en reloj de volumen (V_bucket={' '}
                  {fmtNum(microData.microstructure.vpin.bucketSizeShares, 0)} acciones · VPIN={' '}
                  {fmtNum(microData.microstructure.vpin.vpin, 3)} · Percentil{' '}
                  {fmtNum(microData.microstructure.vpin.percentileRank, 1)}%).
                </InsightBanner>
              )}
              {microData.microstructure.iceberg.detected && (
                <InsightBanner tag="Detección Iceberg L1 Activa" variant="warn">
                  Recarga oculta detectada en punta{' '}
                  <strong>{microData.microstructure.iceberg.side}</strong> @{' '}
                  {fmtCurrency(microData.microstructure.iceberg.priceLevel, '$ ', 2)} · Vol.
                  ejecutado {fmtNum(microData.microstructure.iceberg.executedVolumeAtBest, 0)} &gt;
                  caída visible {fmtNum(microData.microstructure.iceberg.visibleDropAtBest, 0)} (est.
                  recarga {fmtNum(microData.microstructure.iceberg.reloadedVolumeEstimate, 0)}).
                </InsightBanner>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                <KPICard
                  title="Microprice L1 / Multi-Nivel"
                  heroValue={fmtCurrency(microData.microstructure.micropriceMultiLevel, '$ ', 2)}
                  subtitle={`Microprice L1: ${fmtCurrency(microData.microstructure.micropriceL1, '$ ', 2)} · Mid: ${fmtCurrency(microData.microstructure.midPrice, '$ ', 2)}`}
                />
                <KPICard
                  title="OBI L1 / L1–L5 Decay"
                  heroValue={fmtNum(microData.microstructure.obiMultiLevel, 3)}
                  subtitle={`OBI L1: ${fmtNum(microData.microstructure.obiL1, 3)} · α=${fmtNum(microData.microstructure.decayAlpha, 2)} · Spread: ${fmtNum(microData.microstructure.spreadBps, 1)} bps`}
                />
                <KPICard
                  title="Profundidad L1–L5 Bid / Ask"
                  heroValue={`${fmtNum(microData.microstructure.totalBidDepth5, 0)} / ${fmtNum(microData.microstructure.totalAskDepth5, 0)}`}
                  subtitle={`L1: ${fmtCurrency(microData.microstructure.bestBid, '$ ', 2)} × ${fmtCurrency(microData.microstructure.bestAsk, '$ ', 2)}`}
                />
                <KPICard
                  title="VPIN (N=50 Buckets)"
                  heroValue={fmtNum(microData.microstructure.vpin.vpin, 3)}
                  subtitle={`Percentil ${fmtNum(microData.microstructure.vpin.percentileRank, 1)}% · Buckets=${microData.microstructure.vpin.populatedBuckets}`}
                />
              </div>
            </div>
          )}

          {/* Superficie Híbrida ORATS + Massive Spot + Yang-Zhang */}
          {surfaceData !== null && (
            <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-[13px] font-bold text-[#F3F4F6]">
                  Desacople Híbrido: Spot Massive ({surfaceData.surface.massiveSpotSourceMode}) +
                  Superficie ORATS + Vol. Realizada Yang-Zhang
                </h4>
                <span className="font-mono text-[11px] text-[#9CA3AF]">
                  ORATS: {surfaceData.surface.status}
                  {surfaceData.surface.status === 'UNAVAILABLE'
                    ? ` (${surfaceData.surface.reason})`
                    : ` (${surfaceData.surface.tradeDate})`}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                <KPICard
                  title="Massive ADR Spot / Yang-Zhang 20d"
                  heroValue={fmtCurrency(surfaceData.surface.massiveSpotPrice, 'US$ ', 2)}
                  subtitle={`YZ ADR Vol: ${fmtPct(surfaceData.surface.yangZhangAdrVol !== null ? surfaceData.surface.yangZhangAdrVol * 100 : null, 2, false)}`}
                />
                <KPICard
                  title="VI CCL Alas OTM (Motor 2)"
                  heroValue={fmtPct(
                    surfaceData.otmWingCclVol.extractedCclImplVol !== null
                      ? surfaceData.otmWingCclVol.extractedCclImplVol * 100
                      : null,
                    2,
                    false,
                  )}
                  subtitle={
                    surfaceData.otmWingCclVol.status === 'OPERATIONAL'
                      ? `Compresión ATM Call Overwriting: ${fmtNum(surfaceData.otmWingCclVol.callOverwritingCompressionPct, 1)}% (${surfaceData.otmWingCclVol.selectedWingsCount} alas)`
                      : `Indisponible: ${surfaceData.otmWingCclVol.reason ?? '—'}`
                  }
                />
                {surfaceData.surface.status === 'OPERATIONAL' ? (
                  <>
                    <KPICard
                      title="ORATS smvVol / Ex-Ern IV30"
                      heroValue={fmtPct(
                        Number.isFinite(oratsVolToPct(surfaceData.surface.smvVol))
                          ? oratsVolToPct(surfaceData.surface.smvVol)
                          : null,
                        2,
                        false,
                      )}
                      subtitle={`IV30: ${fmtPct(Number.isFinite(oratsVolToPct(surfaceData.surface.iv30d)) ? oratsVolToPct(surfaceData.surface.iv30d) : null, 2, false)} · ExErn30: ${fmtPct(Number.isFinite(oratsVolToPct(surfaceData.surface.exErnIv30d)) ? oratsVolToPct(surfaceData.surface.exErnIv30d) : null, 2, false)}`}
                    />
                    <KPICard
                      title="ORATS Div / Borrow / Implied Move"
                      heroValue={fmtPct(
                        surfaceData.surface.impliedMove !== null &&
                          Number.isFinite(oratsVolToPct(surfaceData.surface.impliedMove))
                          ? oratsVolToPct(surfaceData.surface.impliedMove)
                          : null,
                        2,
                        false,
                      )}
                      subtitle={`annIdiv: ${fmtNum(surfaceData.surface.annIdiv, 2)} · borrow30: ${fmtPct(
                        surfaceData.surface.borrow30 !== null &&
                          Number.isFinite(normalizeOratsSignedRateToDecimal(surfaceData.surface.borrow30))
                          ? normalizeOratsSignedRateToDecimal(surfaceData.surface.borrow30) * 100
                          : null,
                        2,
                        false,
                      )}`}
                    />
                  </>
                ) : (
                  <div className="xl:col-span-2 flex items-center rounded-[8px] border border-[#334155] bg-[#161B2B] px-3 py-2 text-xs text-[#CBD5E1]">
                    ORATS desacoplado explícitamente en modo UNAVAILABLE ({surfaceData.surface.reason}). Spot NBBO/Barras Massive y Yang-Zhang activos sin fallback silencioso.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Clearing Risk BYMA & PinScore 15:30 ART ponderado por L2 */}
          {clearingRiskData !== null && (
            <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-2">
              <h4 className="text-[13px] font-bold text-[#F3F4F6]">
                Riesgo de Clearing BYMA, Anexo B &amp; PinScore L2 (15:30 ART)
              </h4>
              {clearingRiskData.clearingRisk.status === 'UNAVAILABLE' ? (
                <div className="text-xs text-[#FCA5A5]">
                  Clearing Risk INDISPONIBLE: {clearingRiskData.clearingRisk.reason}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className="rounded border border-[#1E1E2B] bg-[#0B0D14] p-3">
                    <div className="text-[#9CA3AF]">Estado Anexo B IAMC</div>
                    <div className="font-mono font-bold text-[#F3F4F6] mt-0.5">
                      {clearingRiskData.clearingRisk.anexoBStatus} (
                      {clearingRiskData.clearingRisk.anexoBTradeDate ?? 'Sin ingesta'})
                    </div>
                    <div className="text-[#787B86] mt-1 tabular-nums">
                      Descubiertas: {clearingRiskData.clearingRisk.totalUncoveredContracts === null
                        ? `${fmtNum(clearingRiskData.clearingRisk.totalUncoveredNom, 0)} acc.`
                        : `${fmtNum(clearingRiskData.clearingRisk.totalUncoveredContracts, 2)} lotes`} · Cubiertas:{' '}
                      {clearingRiskData.clearingRisk.totalCoveredContracts === null
                        ? `${fmtNum(clearingRiskData.clearingRisk.totalCoveredNom, 0)} acc.`
                        : `${fmtNum(clearingRiskData.clearingRisk.totalCoveredContracts, 2)} lotes`}
                    </div>
                  </div>
                  <div className="rounded border border-[#1E1E2B] bg-[#0B0D14] p-3">
                    <div className="text-[#9CA3AF]">Asimetría Dividendo JUL-26 (sin ajuste strike)</div>
                    <div className="font-mono font-bold text-[#F5B544] mt-0.5">
                      {clearingRiskData.clearingRisk.jul26DividendNoStrikeAdjFlag
                        ? 'ACTIVO — Ajuste Forward BYMA aplicado'
                        : 'NO APLICA EN VTO ACTIVO'}
                    </div>
                    <div className="text-[#787B86] mt-1">
                      Margen Inicial Ref: {fmtPct(clearingRiskData.clearingRisk.bymaInitialMarginPct, 1, false)} · Aforo:{' '}
                      {fmtPct(clearingRiskData.clearingRisk.clearingHaircutPct, 1, false)}
                    </div>
                  </div>
                  <div className="rounded border border-[#1E1E2B] bg-[#0B0D14] p-3">
                    <div className="text-[#9CA3AF]">PinScore 15:30 ART Ponderado OBI/Depth</div>
                    <div className="font-mono font-bold text-[#E5E7EB] mt-0.5">
                      {clearingRiskData.clearingRisk.l2PinScore.status === 'OPERATIONAL'
                        ? fmtNum(clearingRiskData.clearingRisk.l2PinScore.weightedPinScore, 3)
                        : `UNAVAILABLE (${clearingRiskData.clearingRisk.l2PinScore.reason ?? 'NON_L2'})`}
                    </div>
                    <div className="text-[#787B86] mt-1">
                      Hora ART: {clearingRiskData.clearingRisk.l2PinScore.asOfBuenosAiresTime}{' '}
                      {clearingRiskData.clearingRisk.l2PinScore.isClosingWindow1530Art
                        ? '(Ventana Cierre 15:30 ART)'
                        : '(Fuera de ventana cierre)'}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 7 — RÉGIMEN ELECTORAL 2027 (MOTOR 9 HAMILTON MARKOV-SWITCHING) */}
      {activeTab === 'regime-2027' && (
        <div className="space-y-4">
          {regimeData === null ? (
            <EmptyPanel title="Cargando Motor 9..." detail="Evaluando filtro de Hamilton 3 estados..." />
          ) : regimeData.regime.status === 'UNAVAILABLE' ? (
            <InsightBanner tag="Motor 9 — Régimen Electoral 2027 UNAVAILABLE" variant="neg">
              Filtro Hamilton detenido explícitamente sin fallback ({regimeData.regime.reason}).
              Verifica disponibilidad de la curva de futuros DLR/* (mínimo 4 vencimientos) y barras
              sincrónicas/asincrónicas de GGAL, BMA, BBAR y SUPV.
            </InsightBanner>
          ) : (
            (() => {
              const reg = regimeData.regime;
              const probs = reg.posteriorProbabilities;
              const labels = [
                'CALM_COMPRESSION (Compresión)',
                'FX_BRECHA_TENSION (Tensión Brecha/FX)',
                'ELECTORAL_TAIL_JUMP (Salto de Cola Electoral)',
              ] as const;
              return (
                <div className="space-y-4">
                  <InsightBanner
                    tag="Motor 9 — Filtro Recursivo Hamilton (3 Estados)"
                    variant={
                      reg.currentRegime === 'CALM_COMPRESSION'
                        ? 'pos'
                        : reg.currentRegime === 'FX_BRECHA_TENSION'
                          ? 'warn'
                          : 'neg'
                    }
                  >
                    Régimen activo: <strong>{reg.currentRegime}</strong> · Intensidad de Salto Efectiva λ=
                    <strong className="font-mono-num">{fmtNum(reg.effectiveJumpIntensity, 2)}</strong>/año · Multiplicador Kelly=
                    <strong className="font-mono-num">{fmtNum(reg.kellyFractionMultiplier, 2)}x</strong> · CVaR 99% Overnight=
                    <strong className="font-mono-num">{fmtPct(reg.overnightCvar99Pct, 2, false)}</strong>
                  </InsightBanner>

                  {/* Probabilidades Posteriores */}
                  <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-3">
                    <h4 className="text-[13px] font-bold text-[#F3F4F6]">
                      Probabilidades Posteriores de Estado Markov-Switching
                    </h4>
                    <div className="space-y-2.5">
                      {labels.map((lbl, idx) => {
                        const probPct = (probs[idx] ?? 0) * 100;
                        const barColor =
                          idx === 0
                            ? 'bg-emerald-500'
                            : idx === 1
                              ? 'bg-amber-400'
                              : 'bg-rose-500';
                        return (
                          <div key={lbl} className="space-y-1">
                            <div className="flex justify-between text-xs font-mono">
                              <span className="text-[#D1D5DB]">{lbl}</span>
                              <span className="text-[#FFFFFF] font-semibold">
                                {fmtPct(probPct, 2, false)}
                              </span>
                            </div>
                            <div className="h-2 w-full rounded bg-[#1E1E2B] overflow-hidden">
                              <div
                                className={`h-full ${barColor}`}
                                style={{ width: `${Math.min(100, Math.max(0, probPct)).toFixed(1)}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* 5 Observables + Pesos de Cobertura Recomendados */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-2 text-xs">
                      <h4 className="text-[13px] font-bold text-[#F3F4F6]">
                        Vector de 5 Observables &amp; Lead-Lag Hayashi-Yoshida
                      </h4>
                      <div className="grid grid-cols-2 gap-2 font-mono">
                        <div className="rounded bg-[#0B0D14] p-2 border border-[#1E1E2B]">
                          <div className="text-[#9CA3AF]">Basket Bancos IV30 Ex-Ern</div>
                          <div className="text-sm font-bold text-white">
                            {fmtPct(reg.observables.bankBasketIv30ExErn * 100, 2, false)}
                          </div>
                        </div>
                        <div className="rounded bg-[#0B0D14] p-2 border border-[#1E1E2B]">
                          <div className="text-[#9CA3AF]">GGAL Skew 25Δ (Put-Call)</div>
                          <div className="text-sm font-bold text-white">
                            {fmtPct(reg.observables.ggal25DeltaSkew * 100, 2, false)}
                          </div>
                        </div>
                        <div className="rounded bg-[#0B0D14] p-2 border border-[#1E1E2B]">
                          <div className="text-[#9CA3AF]">Spread Legislación NY/ARG</div>
                          <div className="text-sm font-bold text-white">
                            {fmtPct(reg.observables.sovereignLegislationSpreadPct, 2, false)}
                          </div>
                        </div>
                        <div className="rounded bg-[#0B0D14] p-2 border border-[#1E1E2B]">
                          <div className="text-[#9CA3AF]">Kink Forward DLR/* Electoral</div>
                          <div className="text-sm font-bold text-amber-300">
                            {fmtPct(reg.observables.dlrElectoralForwardKink, 2, false)} (
                            {reg.dlrKinkDetail.peakMaturityLabel ?? '—'})
                          </div>
                        </div>
                      </div>
                      {reg.leadLagDetail.byBankScore !== null && (
                        <div className="mt-2 pt-2 border-t border-[#1E1E2B]">
                          <div className="text-[#9CA3AF] mb-1">
                            Líder Hayashi-Yoshida: <strong className="text-cyan-300">{reg.observables.crossBankLeadLagLeader}</strong>
                          </div>
                          <div className="grid grid-cols-4 gap-1.5 font-mono text-[11px]">
                            {(['GGAL', 'BMA', 'BBAR', 'SUPV'] as const).map((tk) => (
                              <div key={tk} className="rounded bg-[#0B0D14] px-2 py-1 border border-[#1E1E2B] text-center">
                                <div className="text-[#9CA3AF]">{tk}</div>
                                <div className="text-white font-semibold">
                                  {fmtNum(reg.leadLagDetail.byBankScore?.[tk], 3)}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-2 text-xs">
                      <h4 className="text-[13px] font-bold text-[#F3F4F6]">
                        Pesos de Cobertura Óptimos Recomendados (Convexo Hamilton)
                      </h4>
                      <div className="grid grid-cols-2 gap-2 font-mono">
                        <div className="rounded bg-[#0B0D14] p-2.5 border border-[#1E1E2B]">
                          <div className="text-[#9CA3AF]">Futuros DLR/* A3/ROFEX</div>
                          <div className="text-base font-bold text-cyan-300">
                            {fmtPct(reg.recommendedHedgeWeights.dlrFuturesWeight * 100, 1, false)}
                          </div>
                        </div>
                        <div className="rounded bg-[#0B0D14] p-2.5 border border-[#1E1E2B]">
                          <div className="text-[#9CA3AF]">OTM Put Wings</div>
                          <div className="text-base font-bold text-rose-300">
                            {fmtPct(reg.recommendedHedgeWeights.otmPutWingWeight * 100, 1, false)}
                          </div>
                        </div>
                        <div className="rounded bg-[#0B0D14] p-2.5 border border-[#1E1E2B]">
                          <div className="text-[#9CA3AF]">Collar Cash ARS / Lecap</div>
                          <div className="text-base font-bold text-emerald-300">
                            {fmtPct(reg.recommendedHedgeWeights.cashArsCollarWeight * 100, 1, false)}
                          </div>
                        </div>
                        <div className="rounded bg-[#0B0D14] p-2.5 border border-[#1E1E2B]">
                          <div className="text-[#9CA3AF]">ADR Delta Hedge (US)</div>
                          <div className="text-base font-bold text-amber-300">
                            {fmtPct(reg.recommendedHedgeWeights.adrDeltaHedgeWeight * 100, 1, false)}
                          </div>
                        </div>
                      </div>
                      <div className="pt-2 text-[11px] font-mono text-[#9CA3AF]">
                        Vol. Realizada Yang-Zhang 20d (ADR):{' '}
                        <span className="text-white">
                          {fmtPct(reg.yangZhangVol20d !== null ? reg.yangZhangVol20d * 100 : null, 2, false)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()
          )}
        </div>
      )}

      {/* TAB 8: RIESGO, MÁRGENES BYMA CLEARING 2026 & MICROESTRUCTURA L1-L2 */}
      {activeTab === 'margin-risk' && (
        <div className="space-y-4">
          {/* Panel interactivo de parámetros de margen, colateral y ejecución */}
          <div className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] p-4 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
            <label className="text-[11px] text-[#9A9CA6] space-y-1">
              <span className="block uppercase font-semibold">Estrategia BYMA Clearing</span>
              <select
                value={m6StrategyKind}
                onChange={(e) => setM6StrategyKind(e.target.value as BymaClearingStrategyKindDto)}
                className="w-full rounded-[6px] bg-[#161622] border border-[#2A2A3B] px-2.5 py-1.5 text-[12px] text-[#FFFFFF]"
              >
                {BYMA_CLEARING_STRATEGIES.map((st) => (
                  <option key={st.value} value={st.value}>
                    {st.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-[#9A9CA6] space-y-1">
              <span className="block uppercase font-semibold">Colateral / Garantía</span>
              <select
                value={m6CollateralKind}
                onChange={(e) => setM6CollateralKind(e.target.value as CollateralAssetKindDto)}
                className="w-full rounded-[6px] bg-[#161622] border border-[#2A2A3B] px-2.5 py-1.5 text-[12px] text-[#FFFFFF]"
              >
                {COLLATERAL_KINDS.map((ck) => (
                  <option key={ck.value} value={ck.value}>
                    {ck.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-[#9A9CA6] space-y-1">
              <span className="block uppercase font-semibold">Val. Colateral (ARS)</span>
              <input
                type="number"
                min={0}
                value={m6CollateralValueArs}
                onChange={(e) => setM6CollateralValueArs(e.target.value)}
                className="w-full rounded-[6px] bg-[#161622] border border-[#2A2A3B] px-2.5 py-1.5 text-[12px] text-[#FFFFFF] font-mono-num"
              />
            </label>
            <label className="text-[11px] text-[#9A9CA6] space-y-1">
              <span className="block uppercase font-semibold">
                Aforo Explícito (0-1)
                {COLLATERAL_KINDS.find((c) => c.value === m6CollateralKind)?.requiresExplicitAforo
                  ? ' · Req.'
                  : ''}
              </span>
              <input
                type="number"
                step="0.01"
                min={0.01}
                max={1}
                placeholder="Ej. 0.88"
                value={m6CollateralAforo}
                onChange={(e) => setM6CollateralAforo(e.target.value)}
                className="w-full rounded-[6px] bg-[#161622] border border-[#2A2A3B] px-2.5 py-1.5 text-[12px] text-[#FFFFFF] font-mono-num"
              />
            </label>
            <label className="text-[11px] text-[#9A9CA6] space-y-1">
              <span className="block uppercase font-semibold">Capital Cartera (ARS)</span>
              <input
                type="number"
                min={100000}
                value={m6CapitalArs}
                onChange={(e) => setM6CapitalArs(e.target.value)}
                className="w-full rounded-[6px] bg-[#161622] border border-[#2A2A3B] px-2.5 py-1.5 text-[12px] text-[#FFFFFF] font-mono-num"
              />
            </label>
            <div className="flex items-end gap-2">
              <label className="flex-1 text-[11px] text-[#9A9CA6] space-y-1">
                <span className="block uppercase font-semibold">Lotes / Lado</span>
                <div className="flex gap-1.5">
                  <input
                    type="number"
                    min={1}
                    value={m6DesiredLots}
                    onChange={(e) => setM6DesiredLots(e.target.value)}
                    className="w-16 rounded-[6px] bg-[#161622] border border-[#2A2A3B] px-2 py-1.5 text-[12px] text-[#FFFFFF] font-mono-num"
                  />
                  <select
                    value={m6Side}
                    onChange={(e) => setM6Side(e.target.value as 'BUY' | 'SELL')}
                    className="flex-1 rounded-[6px] bg-[#161622] border border-[#2A2A3B] px-2 py-1.5 text-[12px] text-[#FFFFFF]"
                  >
                    <option value="BUY">BUY</option>
                    <option value="SELL">SELL</option>
                  </select>
                </div>
              </label>
            </div>
          </div>

          {marginRiskData === null ? (
            <div className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] p-6 text-[13px] text-[#787B86]">
              Cargando evaluación BYMA Clearing 2026, Microestructura L1–L2 y Riesgo de Cola...
            </div>
          ) : (
            <>
              {marginRiskData.notice && (
                <InsightBanner tag="Diagnóstico Motor 6" variant="warn">
                  {marginRiskData.notice}
                </InsightBanner>
              )}

              {/* Alerta Circular N° 3588 Sec. 1.3 */}
              {marginRiskData.marginRisk && (
                <div
                  className={`rounded-[10px] px-4 py-2.5 border flex flex-wrap items-center justify-between gap-2 text-[12px] ${
                    marginRiskData.marginRisk.circular3588Alert.active
                      ? 'bg-[#361318] border-[#FF5C63]/60 text-[#FFB4B8]'
                      : 'bg-[#11111A] border-[#1E1E2B] text-[#9A9CA6]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle
                      className={`w-4 h-4 ${
                        marginRiskData.marginRisk.circular3588Alert.active
                          ? 'text-[#FF5C63]'
                          : 'text-[#8B7CF6]'
                      }`}
                    />
                    <span className="font-semibold text-[#FFFFFF]">
                      Circular N° 3588 Sec. 1.3:
                    </span>
                    <span>{marginRiskData.marginRisk.circular3588Alert.reason}</span>
                  </div>
                  <div className="font-mono-num text-[11px] text-[#D1D5DB]">
                    Vto {marginRiskData.frontExpiryCode ?? '—'} ({marginRiskData.frontExpiryDate ?? '—'}) · Δ ATM mín:{' '}
                    {fmtPct(
                      marginRiskData.marginRisk.circular3588Alert.atmDistancePctMin !== null
                        ? marginRiskData.marginRisk.circular3588Alert.atmDistancePctMin * 100
                        : null,
                      2,
                      false,
                    )}
                  </div>
                </div>
              )}

              <div className="flex h-8 items-center gap-3 overflow-hidden text-[11px] text-[#A78BFA]">
                <span className="truncate">Modelo Interno CCP BS02 · Reglas BYMA Ago-2026</span>
                <span className="shrink-0" role="status">
                  {marginRiskData.marginRiskStatus === 'INDETERMINATE_MARGIN' ? 'Margen indeterminado'
                    : marginRiskData.marginRiskStatus === 'PARTIAL_COVERAGE_CONSERVATIVE' ? 'Cobertura parcial'
                    : marginRiskData.marginRisk?.strategyValidation?.matchesLegs === false ? 'Estructura no coincide' : ''}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 tabular-nums">
                <KPICard
                  title="Margen estimado con buffers"
                  heroValue={fmtCurrency(marginRiskData.marginRisk?.totalRequiredWithBuffersArs, '$ ', 0)}
                  badge={marginRiskData.frontExpiryCode ?? 'BYMA'}
                  subtitle={`Base CCP/Piso: ${fmtCurrency(marginRiskData.marginRisk?.baseRequiredMarginArs, '$ ', 0)}`}
                />
                <KPICard
                  title="Excedente / Déficit Neto"
                  heroValue={fmtCurrency(marginRiskData.marginRisk?.excessOrDeficitArs, '$ ', 0)}
                  badge={marginRiskData.marginRisk?.collateralStatus ?? '—'}
                  subtitle={`Colateral Efec.: ${fmtCurrency(marginRiskData.marginRisk?.totalEffectiveCollateralArs, '$ ', 0)}`}
                />
                <KPICard
                  title="Recargo WWR (15 %) + Buffer (10 %)"
                  heroValue={fmtCurrency(
                    marginRiskData.marginRisk &&
                      marginRiskData.marginRisk.liquidBufferArs !== null &&
                      marginRiskData.marginRisk.wrongWayRiskSurchargeArs !== null
                      ? marginRiskData.marginRisk.liquidBufferArs +
                          marginRiskData.marginRisk.wrongWayRiskSurchargeArs
                      : null,
                    '$ ',
                    0,
                  )}
                  badge="WWR + LIQ"
                  subtitle={`Buffer: ${fmtCurrency(marginRiskData.marginRisk?.liquidBufferArs, '$ ', 0)} · WWR: ${fmtCurrency(marginRiskData.marginRisk?.wrongWayRiskSurchargeArs, '$ ', 0)}`}
                />
                <KPICard
                  title="T+0 Cashflow Neto & Carry/Día"
                  heroValue={fmtCurrency(marginRiskData.marginRisk?.t0NetCashflowArs, '$ ', 0)}
                  badge="AGO-2026"
                  subtitle={`DM+IVA T+0: ${fmtCurrency(marginRiskData.marginRisk?.t0OptionFeesDmIvaArs, '$ ', 0)} · Carry/d: ${fmtCurrency(marginRiskData.marginRisk?.dailyMarginCarryCostArs, '$ ', 0)}`}
                />
              </div>

              {/* Bloque A: Matriz 8 Estrategias Clearing + Desglose Colateral & Patas */}
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
                <div className="xl:col-span-7 rounded-[12px] bg-[#11111A] border border-[#1E1E2B] p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-[#8B7CF6]" />
                      <h3 className="text-[13px] font-bold text-[#FFFFFF]">
                        Matriz BYMA Clearing 2026 — Las 8 Estrategias (Grilla CCP BS02 vs. Piso Escalonado)
                      </h3>
                    </div>
                    <span className="text-[11px] font-mono-num text-[#787B86]">
                      Peor nodo CCP: {fmtPct(
                        marginRiskData.marginRisk?.worstCcpNode.spotShockPct !== null &&
                          marginRiskData.marginRisk?.worstCcpNode.spotShockPct !== undefined
                          ? marginRiskData.marginRisk.worstCcpNode.spotShockPct * 100
                          : null,
                        0,
                        true,
                      )}{' '}
                      spot /{' '}
                      {fmtPct(
                        marginRiskData.marginRisk?.worstCcpNode.volShockDecimal !== null &&
                          marginRiskData.marginRisk?.worstCcpNode.volShockDecimal !== undefined
                          ? marginRiskData.marginRisk.worstCcpNode.volShockDecimal * 100
                          : null,
                        0,
                        true,
                      )}{' '}
                      vol
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[600px] table-fixed text-left text-[12px] tabular-nums">
                      <thead>
                        <tr className="border-b border-[#1E1E2B] text-[10.5px] uppercase text-[#787B86]">
                          <th className="w-[42%] py-1.5 pr-3">Estrategia</th>
                          <th className="py-1.5 px-2 text-right">Riesgo CCP BS02</th>
                          <th className="py-1.5 px-2 text-right">Piso OTM (1/2.5/5%)</th>
                          <th className="py-1.5 pl-2 text-right">Margen Base Req.</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1E1E2B]/70 font-mono-num tabular-nums">
                        {(marginRiskData.marginRisk?.strategyReferenceMatrix ?? []).map((row) => {
                          const isSelected = row.strategyKind === m6StrategyKind;
                          return (
                            <tr
                              key={row.strategyKind}
                              onClick={() => setM6StrategyKind(row.strategyKind)}
                              className={`cursor-pointer ${
                                isSelected
                                  ? 'bg-[#211B3A]/60 text-[#FFFFFF]'
                                  : 'hover:bg-[#161622] text-[#D1D5DB]'
                              }`}
                            >
                              <td className="truncate py-1.5 pr-3 font-sans" title={row.applicabilityReason ?? row.label}>
                                <span className="font-medium">{row.label}</span>
                                <span className="ml-2 inline-block w-16 whitespace-nowrap text-[9px] text-[#9CA3AF]">
                                  {row.applicableToCurrentLegs === false ? 'NO APLICA' : ''}
                                </span>
                                {isSelected && (
                                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-[#8B7CF6]/20 text-[#A78BFA] border border-[#8B7CF6]/40">
                                    ACTIVA
                                  </span>
                                )}
                              </td>
                              <td className="py-1.5 px-2 text-right">
                                {row.applicableToCurrentLegs === false ? '—' : fmtCurrency(row.ccpRiskArrayLossArs, '$ ', 0)}
                              </td>
                              <td className="py-1.5 px-2 text-right">
                                {row.applicableToCurrentLegs === false ? '—' : fmtCurrency(row.steppedFloorArs, '$ ', 0)}
                              </td>
                              <td className="py-1.5 pl-2 text-right font-bold text-[#FFFFFF]">
                                {row.applicableToCurrentLegs === false ? '—' : fmtCurrency(row.requiredMarginArs, '$ ', 0)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="xl:col-span-5 rounded-[12px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[13px] font-bold text-[#FFFFFF]">
                      Patas BYMA Seleccionadas & Costos Clearing Ago-2026
                    </h3>
                    <span className="text-[11px] font-mono-num text-[#9A9CA6]">
                      Contrato foco: {marginRiskData.targetOptionSymbol ?? '—'}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-[11.5px] font-mono-num">
                    {marginRiskData.selectedLegs.map((leg, i) => (
                      <div
                        key={`${leg.ticker}-${String(i)}`}
                        className="flex items-center justify-between rounded-[6px] bg-[#161622] px-2.5 py-1.5 border border-[#1E1E2B]"
                      >
                        <span
                          className={`font-semibold ${
                            leg.side === 'BUY' ? 'text-[#2EDC7E]' : 'text-[#FF5C63]'
                          }`}
                        >
                          {leg.side} {leg.lots}L {leg.ticker}
                        </span>
                        <span className="text-[#D1D5DB]">
                          K {fmtNum(leg.strikeArs, 0)} · Prima {fmtCurrency(leg.optionPriceArs, '$ ', 2)} · VI{' '}
                          {fmtPct(leg.ivPct, 1, false)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#1E1E2B] text-[11.5px]">
                    <div className="rounded-[8px] bg-[#161622] p-2.5">
                      <div className="text-[10px] text-[#787B86] uppercase">Prima T+0 Bruta / Neta</div>
                      <div className="font-mono-num font-bold text-[#FFFFFF]">
                        {fmtCurrency(marginRiskData.marginRisk?.t0GrossPremiumCashflowArs, '$ ', 0)} /{' '}
                        {fmtCurrency(marginRiskData.marginRisk?.t0NetCashflowArs, '$ ', 0)}
                      </div>
                    </div>
                    <div className="rounded-[8px] bg-[#161622] p-2.5">
                      <div className="text-[10px] text-[#787B86] uppercase">Ejercicio T+1 / Acciones PPT</div>
                      <div className="font-mono-num font-bold text-[#F5B544]">
                        {fmtCurrency(marginRiskData.marginRisk?.projectedT1ExerciseFeeDmIvaArs, '$ ', 0)} /{' '}
                        {fmtCurrency(marginRiskData.marginRisk?.projectedSpotEquityFeeDmIvaArs, '$ ', 0)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Bloque B: Microestructura Asíncrona Hayashi-Yoshida + Filtro 4 Compuertas + Poisson L1-L2 */}
              {marginRiskData.executionMicrostructure && (
                <div className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Activity className="w-4 h-4 text-[#8B7CF6]" />
                      <h3 className="text-[13px] font-bold text-[#FFFFFF]">
                        Microestructura L1–L2, Correlación Asíncrona Hayashi-Yoshida & Enrutamiento
                      </h3>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2.5 py-0.5 rounded-[5px] text-[11px] font-bold border ${
                          marginRiskData.executionMicrostructure.decision === 'ABORT_STALE'
                            ? 'bg-[#361318] text-[#FF5C63] border-[#6E232B]'
                            : marginRiskData.executionMicrostructure.decision === 'POST_PASSIVE_L1'
                              ? 'bg-[#0D2E1D] text-[#2EDC7E] border-[#1F6B43]'
                              : marginRiskData.executionMicrostructure.decision === 'PRICE_IMPROVE_1_TICK'
                                ? 'bg-[#35280F] text-[#F5B544] border-[#785315]'
                                : 'bg-[#211B3A] text-[#A78BFA] border-[#43347A]'
                        }`}
                      >
                        {marginRiskData.executionMicrostructure.decision}
                      </span>
                      <span className="text-[11px] font-mono-num text-[#787B86]">
                        Book: {marginRiskData.executionBookDiagnostics.bookSource} · Subyacente L2:{' '}
                        {marginRiskData.executionBookDiagnostics.underlyingBook5LevelsSource ?? '—'}
                      </span>
                    </div>
                  </div>
                  <p className="text-[12px] text-[#D1D5DB]">
                    {marginRiskData.executionMicrostructure.decisionReason}
                  </p>

                  {/* 4 Compuertas Anti-Flujo Tóxico */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-[11.5px]">
                    {[
                      {
                        title: 'Gate 1 · Frescura',
                        ok: marginRiskData.executionMicrostructure.gates.gate1FreshnessPassed,
                        detail: `${marginRiskData.executionMicrostructure.gates.gate1Status} (${fmtAge(marginRiskData.executionMicrostructure.gates.quoteAgeSec)})`,
                      },
                      {
                        title: 'Gate 2 · Spread <= 4 %',
                        ok: marginRiskData.executionMicrostructure.gates.gate2SpreadPassed,
                        detail: `Spread: ${fmtPct(
                          marginRiskData.executionMicrostructure.gates.spreadPct !== null
                            ? marginRiskData.executionMicrostructure.gates.spreadPct * 100
                            : null,
                          2,
                          false,
                        )} (${fmtNum(marginRiskData.executionMicrostructure.spreadTicks, 0)} ticks)`,
                      },
                      {
                        title: 'Gate 3 · Depth L1 >= 5L',
                        ok: marginRiskData.executionMicrostructure.gates.gate3DepthPassed,
                        detail: `Join ${fmtNum(marginRiskData.executionMicrostructure.gates.l1JoinLots, 0)}L / Cross ${fmtNum(marginRiskData.executionMicrostructure.gates.l1CrossLots, 0)}L`,
                      },
                      {
                        title: 'Gate 4 · Confirmación Tick',
                        ok: marginRiskData.executionMicrostructure.gates.gate4TickConfirmPassed,
                        detail: marginRiskData.executionMicrostructure.gates.gate4TickConfirmPassed
                          ? 'BBO + Last consistente'
                          : 'Anomalía tick / book vacío',
                      },
                    ].map((g) => (
                      <div
                        key={g.title}
                        className={`rounded-[8px] px-3 py-2 border ${
                          g.ok
                            ? 'bg-[#0D2E1D]/40 border-[#1F6B43]'
                            : 'bg-[#361318]/50 border-[#6E232B]'
                        }`}
                      >
                        <div className="flex items-center justify-between font-semibold text-[#FFFFFF]">
                          <span>{g.title}</span>
                          <span className={g.ok ? 'text-[#2EDC7E]' : 'text-[#FF5C63]'}>
                            {g.ok ? 'PASS' : 'FAIL'}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[#9A9CA6] font-mono-num">{g.detail}</div>
                      </div>
                    ))}
                  </div>

                  {/* Hayashi-Yoshida + Poisson + Orden Máxima */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3 pt-2 border-t border-[#1E1E2B] text-[11.5px]">
                    <div>
                      <div className="text-[10px] text-[#787B86] uppercase">Hayashi-Yoshida Lead-Lag</div>
                      <div className="font-mono-num font-bold text-[#FFFFFF]">
                        {marginRiskData.executionMicrostructure.hayashiYoshida.leadLagSignal}
                      </div>
                      <div className="text-[11px] font-mono-num text-[#9A9CA6]">
                        Lag {fmtNum(marginRiskData.executionMicrostructure.hayashiYoshida.optimalLagSec, 0)}s · ρ={fmtNum(marginRiskData.executionMicrostructure.hayashiYoshida.optimalCorrelation, 3)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-[#787B86] uppercase">P(Fill L1) / +1 Tick</div>
                      <div className="font-mono-num font-bold text-[#2EDC7E]">
                        {fmtPct(
                          marginRiskData.executionMicrostructure.fillProbPassiveL1 !== null
                            ? marginRiskData.executionMicrostructure.fillProbPassiveL1 * 100
                            : null,
                          1,
                          false,
                        )}{' '}
                        /{' '}
                        {fmtPct(
                          marginRiskData.executionMicrostructure.fillProbImprove1Tick !== null
                            ? marginRiskData.executionMicrostructure.fillProbImprove1Tick * 100
                            : null,
                          1,
                          false,
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-[#787B86] uppercase">ES Pasivo / +1 Tick</div>
                      <div className="font-mono-num font-semibold text-[#FFFFFF]">
                        {fmtCurrency(marginRiskData.executionMicrostructure.esPassiveL1Ars, '$ ', 2)} /{' '}
                        {fmtCurrency(marginRiskData.executionMicrostructure.esImprove1TickArs, '$ ', 2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-[#787B86] uppercase">ES Cruce Book (VWAP)</div>
                      <div className="font-mono-num font-semibold text-[#F5B544]">
                        {fmtCurrency(marginRiskData.executionMicrostructure.esCrossBookArs, '$ ', 2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-[#787B86] uppercase">Máx. Orden Individual</div>
                      <div className="font-mono-num font-bold text-[#8B7CF6]">
                        {fmtNum(marginRiskData.executionMicrostructure.maxSingleOrderLots, 0)} lotes
                      </div>
                      <div className="text-[10.5px] text-[#787B86]">
                        {marginRiskData.executionMicrostructure.liquidityCapBindingReason}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Bloque C: Estrés Macro (5 Escenarios) & Sizing Kelly-CVaR 99 % Overnight 18h */}
              {marginRiskData.tailStress ? (
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
                  <div className="xl:col-span-7 rounded-[12px] bg-[#11111A] border border-[#1E1E2B] p-4">
                    <h3 className="text-[13px] font-bold text-[#FFFFFF] mb-3">
                      Matriz de Estrés Conjunto ADR + CCL + IV + LECAP (5 Escenarios Macro)
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-[12px]">
                        <thead>
                          <tr className="border-b border-[#1E1E2B] text-[10.5px] uppercase text-[#787B86]">
                            <th className="py-1.5 pr-3">Escenario</th>
                            <th className="py-1.5 px-2 text-right">ADR USD</th>
                            <th className="py-1.5 px-2 text-right">CCL ARS</th>
                            <th className="py-1.5 px-2 text-right">Spot ARS (%)</th>
                            <th className="py-1.5 px-2 text-right">PnL / Lote-Unid.</th>
                            <th className="py-1.5 pl-2 text-right">Colat. Estresado</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1E1E2B]/70 font-mono-num">
                          {marginRiskData.tailStress.scenarioResults.map((sc) => {
                            const isWorst = sc.id === marginRiskData.tailStress?.worstScenarioId;
                            return (
                              <tr
                                key={sc.id}
                                className={isWorst ? 'bg-[#361318]/45 text-[#FFFFFF]' : 'text-[#D1D5DB]'}
                              >
                                <td className="py-1.5 pr-3 font-sans">
                                  <span className="font-medium">{sc.label}</span>
                                  {isWorst && (
                                    <span className="ml-1.5 text-[10px] text-[#FF5C63] font-bold">
                                      PEOR
                                    </span>
                                  )}
                                </td>
                                <td className="py-1.5 px-2 text-right">{fmtNum(sc.shockedAdrUsd, 2)}</td>
                                <td className="py-1.5 px-2 text-right">{fmtNum(sc.shockedCclArs, 1)}</td>
                                <td className="py-1.5 px-2 text-right">
                                  {fmtNum(sc.shockedSpotArs, 0)} (
                                  {fmtPct(
                                    sc.spotArsChangePct !== null ? sc.spotArsChangePct * 100 : null,
                                    1,
                                    true,
                                  )}
                                  )
                                </td>
                                <td
                                  className={`py-1.5 px-2 text-right font-bold ${
                                    (sc.portfolioPnlPerUnitArs ?? 0) >= 0
                                      ? 'text-[#2EDC7E]'
                                      : 'text-[#FF5C63]'
                                  }`}
                                >
                                  {fmtCurrency(sc.portfolioPnlPerUnitArs, '$ ', 0)}
                                </td>
                                <td className="py-1.5 pl-2 text-right">
                                  {fmtCurrency(sc.stressedEffectiveCollateralArs, '$ ', 0)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="xl:col-span-5 rounded-[12px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[13px] font-bold text-[#FFFFFF]">
                        Sizing Óptimo Overnight 18h (Quarter-Kelly + CVaR 99 %)
                      </h3>
                      <span className="text-[11px] font-mono-num text-[#8B7CF6]">
                        {marginRiskData.tailStress.overnightNodesCount} nodos Merton
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="rounded-[8px] bg-[#161622] border border-[#2A2A3B] p-3">
                        <div className="text-[10.5px] uppercase text-[#787B86]">
                          Lotes BYMA Óptimos
                        </div>
                        <div className="text-[20px] font-bold font-mono-num text-[#2EDC7E]">
                          {marginRiskData.tailStress.recommendedBymaLots} L
                        </div>
                        <div className="text-[10.5px] text-[#9A9CA6]">
                          Cota activa: {marginRiskData.tailStress.sizingBreakdown.bindingConstraint}
                        </div>
                      </div>
                      <div className="rounded-[8px] bg-[#161622] border border-[#2A2A3B] p-3">
                        <div className="text-[10.5px] uppercase text-[#787B86]">
                          Equiv. OPRA (1:10 lotes)
                        </div>
                        <div className="text-[20px] font-bold font-mono-num text-[#8B7CF6]">
                          {fmtNum(marginRiskData.tailStress.recommendedOpraContractsExact, 1)} cts
                        </div>
                        <div className="text-[10.5px] text-[#9A9CA6]">
                          Enteros redondeados: {marginRiskData.tailStress.recommendedOpraContractsFloored} cts
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11.5px] font-mono-num pt-1 border-t border-[#1E1E2B]">
                      <div className="flex justify-between">
                        <span className="text-[#787B86] font-sans">E[PnL 18h / Unid.]</span>
                        <span className="text-[#FFFFFF]">
                          {fmtCurrency(marginRiskData.tailStress.overnightExpectedPnlPerUnitArs, '$ ', 0)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#787B86] font-sans">CVaR 99 % / Unid.</span>
                        <span className="text-[#FF5C63]">
                          {fmtCurrency(marginRiskData.tailStress.overnightCvar99PerUnitArs, '$ ', 0)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#787B86] font-sans">Quarter-Kelly 0.25x</span>
                        <span className="text-[#D1D5DB]">
                          {fmtNum(marginRiskData.tailStress.sizingBreakdown.quarterKellyLots, 1)} L
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#787B86] font-sans">No-Ruin 95 %</span>
                        <span className="text-[#D1D5DB]">
                          {fmtNum(marginRiskData.tailStress.sizingBreakdown.noRuinCapLots, 1)} L
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#787B86] font-sans">CVaR 99 % Budget</span>
                        <span className="text-[#D1D5DB]">
                          {fmtNum(marginRiskData.tailStress.sizingBreakdown.cvar99CapLots, 1)} L
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#787B86] font-sans">Cap. Colateral</span>
                        <span className="text-[#D1D5DB]">
                          {fmtNum(marginRiskData.tailStress.sizingBreakdown.collateralMarginCapLots, 1)} L
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <InsightBanner tag="Sizing Kelly-CVaR no calculable" variant="default">
                  Se requieren al menos 15 ruedas históricas alineadas ADR/CCL y colateral con aforo
                  explícito válido para calibrar la distribución Jump-Diffusion 18h y el sizing.
                </InsightBanner>
              )}
            </>
          )}
        </div>
      )}

      {/* MODAL INGESTA ANEXO B IAMC */}
      {anexoModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(13,17,23,0.92)] p-4">
          <form
            onSubmit={(e) => void handleIngestAnexoB(e)}
            className="w-full max-w-2xl rounded-[12px] bg-[#11111A] border border-[#2A2A3B] p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-[#1E1E2B] pb-3">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-[#8B7CF6]" />
                <h3 className="text-[14px] font-bold text-[#FFFFFF]">
                  Ingestar Matriz T-1 Anexo B IAMC (Acciones Nominales)
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setAnexoModalOpen(false)}
                className="text-[#787B86] hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-mono-num uppercase text-[#9CA3AF] mb-1">
                  Fecha Anexo B (YYYY-MM-DD)
                </label>
                <input
                  type="text"
                  value={anexoDateInput}
                  onChange={(e) => setAnexoDateInput(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-[8px] bg-[#0B0B12] border border-[#2A2A3B] text-[12.5px] font-mono-num text-[#FFFFFF]"
                />
              </div>
              <label className="block text-[11px] font-mono-num uppercase text-[#9CA3AF]">
                Código de vencimiento (opcional)
                <input
                  type="text"
                  maxLength={2}
                  value={anexoExpiryCode}
                  onChange={(event) => setAnexoExpiryCode(event.target.value.toUpperCase())}
                  className="mt-1 w-full px-3 py-1.5 rounded-[8px] bg-[#0B0B12] border border-[#2A2A3B] text-[12.5px] tabular-nums text-[#FFFFFF]"
                />
              </label>
            </div>

            <textarea
              rows={8}
              value={anexoRawText}
              onChange={(e) => setAnexoRawText(e.target.value)}
              placeholder={`Formato 1 (por serie IAMC):\nGFGC6500DI 120000 45000 18000 5000\nGFGV6500DI 25000 60000 12000 2000\n\nFormato 2 (strike + 4 call + 4 put):\n6500 120000 45000 18000 5000 25000 60000 12000 2000`}
              className="w-full px-3 py-2 rounded-[8px] bg-[#0B0B12] border border-[#2A2A3B] text-[12px] font-mono-num text-[#E5E7EB]"
            />

            {anexoError !== null && (
              <div className="text-[12px] text-[#FF5C63] bg-[#361318]/60 border border-[#6E232B] px-3 py-2 rounded-[8px]">
                {anexoError}
              </div>
            )}
            {anexoSuccess !== null && (
              <div className="text-[12px] text-[#2EDC7E] bg-[#0D2E1D]/60 border border-[#1F6B43] px-3 py-2 rounded-[8px] flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                {anexoSuccess}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setAnexoModalOpen(false)}
                className="px-3.5 py-1.5 rounded-[8px] bg-[#171722] border border-[#2A2A3B] text-[12px] font-semibold text-[#D1D5DB] cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={anexoSubmitting || anexoRawText.trim() === ''}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-[8px] bg-[#8B7CF6] hover:bg-[#7C6CE6] disabled:opacity-50 text-[12px] font-semibold text-white cursor-pointer"
              >
                <Activity className="w-3.5 h-3.5" />
                {anexoSubmitting ? 'Procesando...' : 'Procesar e Ingestar'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Resumen ejecutivo inferior (cuando hay overview) */}
      {overview !== null && (
        <div className="rounded-[10px] bg-[#0D0D15] border border-[#1E1E2B] px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-num text-[#787B86]">
          <span className="inline-flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-[#8B7CF6]" />
            Estrategias rankeadas resumen: {overview.topStrategies.length} · Anomalías Smile: {overview.volatility.anomaliesCount}
          </span>
          <span>UTC evaluación: {overview.telemetry.timestampUtc}</span>
        </div>
      )}
    </div>
  );
};
