import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  TrendingUp,
  ArrowUpRight,
  Filter,
  Layers,
  Send,
  Bell,
  Plus,
  LayoutGrid,
  CheckCircle2,
  Sliders,
  Eye,
  Sparkles,
  Globe2,
  Landmark,
} from 'lucide-react';
import {
  GLOBAL_INDICATORS,
  AR_STOCKS,
  AR_GENERAL_PANEL_STOCKS,
  AR_PANEL_ANALYTICS,
  BONDS_DATA,
  GGAL_OPTION_EXPIRIES,
  MACRO_CARDS,
  US_MARKET_DATA,
  US_PANEL_ANALYTICS,
  ROFEX_FUTURES,
  CAUCIONES_DATA,
  RATIO_PAIRS,
  RELATION_SUMMARY,
  PortfolioPosition,
  AlertItem,
  fmtNum,
  fmtPct,
  fmtMoneyCompact,
} from '../data/marketData';
import type { EquityPanelAnalyticsDto, EquityPanelRowDto, UsUnifiedQuoteDto } from '../data/liveTypes';
import {
  refreshMacro,
  requestMonitoringPanel,
  requestRelations,
  requestUsSnapshot,
  useLiveMarketState,
} from '../data/liveRuntimeBridge';
import {
  HelpTooltip,
  InsightBanner,
  DeltaPill,
  PriceCell,
  MiniSparkline,
  KPICard,
} from './DesignSystem';
import { CompanyLogo } from './common/CompanyLogo';
import {
  formatExtendedSessionBadge,
  getMarketLiveQuote,
  getMarketLiveClock,
  isMarketLiveStreamFresh,
  tickFlashClass,
  useMarketFocusSymbol,
  useMarketLiveStream,
  useTickFlash,
  type LiveUsSessionPhase,
} from '../api/useMarketLiveStream';

const TickFlash: React.FC<{
  readonly value: number | null;
  readonly className?: string;
  readonly children: React.ReactNode;
}> = ({ value, className = '', children }) => {
  const direction = useTickFlash(value);
  return (
    <span
      className={`inline-flex items-center justify-end rounded-[4px] px-1 py-0.5 transition-colors duration-500 ${tickFlashClass(direction)} ${className}`}
    >
      {children}
    </span>
  );
};

const RealTimeBadge: React.FC<{ readonly clock: string | null }> = ({ clock }) => {
  if (clock === null) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#22C55E]/35 bg-[#22C55E]/10 px-2 py-0.5 font-mono-num text-[10px] font-semibold text-[#22C55E]">
      ● Tiempo real {clock}
    </span>
  );
};

const LogoHeatTileImpl: React.FC<{
  readonly ticker: string;
  readonly name?: string;
  readonly deltaPct: number;
  readonly price?: string;
  readonly priceValue?: number;
  readonly onClick?: () => void;
}> = ({ ticker, name, deltaPct, price, priceValue, onClick }) => {
  const effectiveDelta = deltaPct;
  const effectivePrice = priceValue ?? Number.NaN;
  const flashDirection = useTickFlash(effectivePrice);
  const finiteDelta = Number.isFinite(effectiveDelta);
  const isPos = finiteDelta && effectiveDelta > 0.001;
  const isNeg = finiteDelta && effectiveDelta < -0.001;

  let bgStyle = 'bg-[#1A1E29] border-[#262B3B]';
  if (isPos) {
    bgStyle =
      effectiveDelta >= 2.5
        ? 'bg-[#0E382B]/90 border-[#165B43]/70'
        : 'bg-[#0D281E]/85 border-[#144634]/60';
  } else if (isNeg) {
    bgStyle =
      effectiveDelta <= -2.0
        ? 'bg-[#381419]/90 border-[#63222B]/70'
        : 'bg-[#2D1418]/85 border-[#4D1E26]/60';
  }

  const pctColor = isPos ? 'text-[#22C55E]' : isNeg ? 'text-[#F23645]' : 'text-[#787B86]';
  const sign = isPos ? '+' : isNeg ? '-' : '';
  const formattedPct = finiteDelta ? `${sign}${Math.abs(effectiveDelta).toFixed(2).replace('.', ',')} %` : '—';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative px-3.5 py-2.5 rounded-[8px] text-left cursor-pointer flex flex-col justify-between min-h-[64px] border hover:border-[#3B82F6]/80 hover:brightness-110 ${bgStyle}`}
    >
      <div className="flex items-center justify-between gap-2 w-full">
        <div className="flex items-center gap-2 min-w-0">
          <CompanyLogo ticker={ticker} name={name} size="sm" />
          <span className="font-bold text-[13.5px] text-[#FFFFFF] tracking-tight truncate">
            {ticker}
          </span>
        </div>
        {Number.isFinite(effectivePrice) ? (
          <span className={`font-mono-num text-[11px] transition-colors duration-500 shrink-0 ${tickFlashClass(flashDirection)}`}>
            ${fmtNum(effectivePrice, effectivePrice < 1000 ? 1 : 0)}
          </span>
        ) : price ? (
          <span className="font-mono-num text-[11px] text-[#9CA3AF] group-hover:text-[#D1D4DC] transition-colors shrink-0">
            {price}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-center justify-between w-full">
        <span className={`font-mono-num text-[12.5px] font-semibold ${pctColor}`}>
          {formattedPct}
        </span>
      </div>
    </button>
  );
};

const UsIndexLogoKpiCard: React.FC<{
  readonly logoTicker?: string;
  readonly iconNode?: React.ReactNode;
  readonly title: string;
  readonly heroValue: string;
  readonly flashValue?: number;
  readonly deltaPct?: number;
  readonly subtitle: string;
  readonly sessionPhase?: LiveUsSessionPhase | null;
}> = ({ logoTicker, iconNode, title, heroValue, flashValue, deltaPct, subtitle, sessionPhase }) => {
  const extBadge = formatExtendedSessionBadge(sessionPhase);
  return (
    <div className="px-4 py-3.5 rounded-[10px] bg-[#131722] border border-[#232733] hover:border-[#343B4F] transition-all flex flex-col justify-between gap-2">
      <div className="flex items-center gap-2.5 min-w-0">
        {logoTicker ? (
          <CompanyLogo ticker={logoTicker} name={title} size="md" />
        ) : (
          iconNode
        )}
        <span className="text-[12.5px] font-medium text-[#9CA3AF] truncate">{title}</span>
        {extBadge !== null && (
          <span className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-mono-num text-[9px] font-bold tracking-wider bg-[#F5B544]/15 text-[#F5B544] border border-[#F5B544]/35">
            {extBadge}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2.5 pt-0.5">
        <div className="font-mono-num text-[22px] leading-[26px] font-bold text-[#FFFFFF] tracking-tight">
          <TickFlash value={flashValue ?? null}>{heroValue}</TickFlash>
        </div>
        {deltaPct !== undefined && <DeltaPill value={deltaPct} size="md" />}
      </div>
      <div className="text-[11.5px] text-[#787B86] leading-snug truncate">{subtitle}</div>
    </div>
  );
};

export type MonitorSubPanel = 'acciones' | 'bonos' | 'cedears' | 'cauciones';

interface NormalizedPanelRow {
  readonly symbol: string;
  readonly name: string;
  readonly sector: string;
  readonly panel: 'Líder' | 'General';
  readonly color: string;
  readonly last: number;
  readonly prevClose: number;
  readonly dayLow: number;
  readonly dayHigh: number;
  readonly dayRangePos: number;
  readonly volumeM: number;
  readonly return1dPct: number;
  readonly return30dPct: number;
  readonly returnYtdOr252dPct: number;
  readonly realizedVol30dPct: number;
  readonly beta: number;
  readonly avgVolume40dM: number;
  readonly subtitleRight?: string;
  readonly sessionPhase?: LiveUsSessionPhase | null;
  readonly extendedPrice?: number | null;
  readonly extendedChangePct?: number | null;
}

const DayRangeBar: React.FC<{ readonly row: NormalizedPanelRow }> = ({ row }) => {
  const hasRange =
    Number.isFinite(row.last) &&
    Number.isFinite(row.dayLow) &&
    Number.isFinite(row.dayHigh) &&
    row.dayHigh > row.dayLow;
  if (!hasRange) {
    return <span className="text-[var(--text-tertiary)] font-mono-num">—</span>;
  }
  const posPct = Math.max(0, Math.min(100, ((row.last - row.dayLow) / (row.dayHigh - row.dayLow)) * 100));
  const barColor = posPct >= 50 ? '#22C55E' : '#EF4444';
  return (
    <div
      className="inline-flex items-center gap-2"
      title={`Mín ${fmtNum(row.dayLow, 2)} · Máx ${fmtNum(row.dayHigh, 2)} · Último ${fmtNum(row.last, 2)}`}
    >
      <span className="text-[10.5px] font-mono-num tabular-nums text-[var(--text-secondary)]">
        {fmtNum(row.dayLow, 2)}
      </span>
      <div className="relative h-[6px] w-[54px] rounded-full bg-[#1C1C28]">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${posPct}%`, backgroundColor: barColor }}
        />
        <span
          className="absolute -top-[2px] h-[10px] w-[2px] rounded-full"
          style={{ left: `calc(${posPct}% - 1px)`, backgroundColor: barColor }}
        />
      </div>
      <span className="text-[10.5px] font-mono-num tabular-nums text-[var(--text-secondary)]">
        {fmtNum(row.dayHigh, 2)}
      </span>
      <span
        className="w-[36px] text-right text-[10.5px] font-mono-num tabular-nums"
        style={{ color: barColor }}
      >
        {Math.round(posPct)}%
      </span>
    </div>
  );
};

const formatVolMillionsShared = (value: number | null | undefined, currencyPrefix = '$ '): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000) return `${currencyPrefix}${fmtNum(value / 1_000, 2)}B`;
  return `${currencyPrefix}${fmtNum(value, 1)}M`;
};

const PanelTableRow: React.FC<{
  readonly row: NormalizedPanelRow;
  readonly denseRowClass: string;
  readonly currencyPrefix: string;
  readonly onSelectRow: (symbol: string) => void;
}> = memo(({ row, denseRowClass, currencyPrefix, onSelectRow }) => {
  const extBadge = formatExtendedSessionBadge(row.sessionPhase);
  const displayDeltaPct =
    extBadge !== null && row.extendedChangePct !== undefined && row.extendedChangePct !== null && Number.isFinite(row.extendedChangePct)
      ? row.extendedChangePct
      : row.return1dPct;
  return (
    <tr
      onClick={() => onSelectRow(row.symbol)}
      className={`${denseRowClass} hover:bg-[#171724] transition-colors cursor-pointer`}
    >
      <td className="px-3 text-left">
        <div className="flex items-center gap-2 min-w-0">
          <CompanyLogo ticker={row.symbol} name={row.name} size={denseRowClass.includes('h-8') ? 'xs' : 'sm'} />
          <span className="font-bold text-[#F3F4F6] tracking-tight">{row.symbol}</span>
          {extBadge !== null && (
            <span className="rounded px-1 py-0.2 font-mono-num text-[8.5px] font-bold tracking-wider bg-[#F5B544]/15 text-[#F5B544] border border-[#F5B544]/35">
              {extBadge}
            </span>
          )}
          <span className="text-[11px] font-sans text-[#6D6D84] truncate max-w-[135px]">{row.name}</span>
        </div>
      </td>
      <td className="px-2.5 font-semibold text-[#F3F4F6]">
        <TickFlash value={Number.isFinite(row.last) ? row.last : null}>
          {Number.isFinite(row.last) ? `${'$ '}${fmtNum(row.last, row.last >= 1000 ? 0 : 2)}` : '—'}
        </TickFlash>
      </td>
      <td className="px-2.5">
        <DeltaPill value={displayDeltaPct} size="sm" />
      </td>
      <td className="px-2.5 text-[#A5A6BA]">{formatVolMillionsShared(row.volumeM, currencyPrefix)}</td>
      <td className="px-3 text-right"><DayRangeBar row={row} /></td>
    </tr>
  );
}, (prev, next) => (
  prev.denseRowClass === next.denseRowClass &&
  prev.currencyPrefix === next.currencyPrefix &&
  prev.row.symbol === next.row.symbol &&
  prev.row.name === next.row.name &&
  prev.row.last === next.row.last &&
  prev.row.return1dPct === next.row.return1dPct &&
  prev.row.extendedChangePct === next.row.extendedChangePct &&
  prev.row.sessionPhase === next.row.sessionPhase &&
  prev.row.volumeM === next.row.volumeM &&
  prev.row.dayLow === next.row.dayLow &&
  prev.row.dayHigh === next.row.dayHigh &&
  prev.row.dayRangePos === next.row.dayRangePos
));

const RiskTableRow: React.FC<{
  readonly row: NormalizedPanelRow;
  readonly currencyPrefix: string;
  readonly onSelectRow: (symbol: string) => void;
}> = memo(({ row, currencyPrefix, onSelectRow }) => (
  <tr
    key={row.symbol}
    onClick={() => onSelectRow(row.symbol)}
    className="h-8 hover:bg-[#171724] cursor-pointer transition-colors"
  >
    <td className="px-3 text-left">
      <div className="flex items-center gap-2">
        <CompanyLogo ticker={row.symbol} name={row.name} size="xs" />
        <span className="font-bold text-[#F3F4F6]">{row.symbol}</span>
      </div>
    </td>
    <td className={`px-2.5 ${Number.isFinite(row.realizedVol30dPct) && row.realizedVol30dPct >= 45 ? 'text-[#F5B544] font-semibold' : 'text-[#D1D4DC]'}`}>
      {Number.isFinite(row.realizedVol30dPct) ? `${fmtNum(row.realizedVol30dPct, 1)}%` : '—'}
    </td>
    <td
      className={`px-2.5 font-semibold ${
        !Number.isFinite(row.beta)
          ? 'text-[#6D6D84]'
          : row.beta >= 1.25
            ? 'text-[#8B7CF6]'
            : row.beta < 0.7
              ? 'text-[#38BDF8]'
              : 'text-[#D1D4DC]'
      }`}
    >
      {fmtNum(row.beta, 2)}
    </td>
    <td className="px-2.5"><DeltaPill value={row.return30dPct} size="sm" /></td>
    <td className="px-2.5"><DeltaPill value={row.returnYtdOr252dPct} size="sm" /></td>
    <td className="px-3 text-[#A5A6BA]">{formatVolMillionsShared(row.avgVolume40dM, currencyPrefix)}</td>
  </tr>
), (prev, next) => (
  prev.currencyPrefix === next.currencyPrefix &&
  prev.row.symbol === next.row.symbol &&
  prev.row.name === next.row.name &&
  prev.row.realizedVol30dPct === next.row.realizedVol30dPct &&
  prev.row.beta === next.row.beta &&
  prev.row.return30dPct === next.row.return30dPct &&
  prev.row.returnYtdOr252dPct === next.row.returnYtdOr252dPct &&
  prev.row.avgVolume40dM === next.row.avgVolume40dM
));

const areLogoHeatTilePropsEqual = (
  prev: React.ComponentProps<typeof LogoHeatTileImpl>,
  next: React.ComponentProps<typeof LogoHeatTileImpl>,
): boolean => (
  prev.ticker === next.ticker &&
  prev.name === next.name &&
  prev.deltaPct === next.deltaPct &&
  prev.price === next.price &&
  prev.priceValue === next.priceValue
);

const LogoHeatTile: React.FC<React.ComponentProps<typeof LogoHeatTileImpl>> = memo(
  LogoHeatTileImpl,
  areLogoHeatTilePropsEqual,
);

const EquitySixPanelsGrid: React.FC<{
  readonly mode: 'AR' | 'US';
  readonly rows: readonly NormalizedPanelRow[];
  readonly analytics: EquityPanelAnalyticsDto | null;
  readonly currencyPrefix: string;
  readonly benchmarkLabel: string;
  readonly sectorOptions?: readonly string[];
  readonly onSelectRow: (symbol: string) => void;
  readonly denseRowClass?: string;
}> = ({
  mode,
  rows: inputRows,
  analytics,
  currencyPrefix,
  benchmarkLabel,
  sectorOptions,
  onSelectRow,
  denseRowClass = 'h-8 text-[12px]',
}) => {
  const liveStream = useMarketLiveStream();
  const rows = useMemo(
    () =>
      inputRows.map((row) => {
        const live = getMarketLiveQuote(liveStream, mode, row.symbol);
        if (live === null) return row;
        const dayLow = live.dayLow ?? row.dayLow;
        const dayHigh = live.dayHigh ?? row.dayHigh;
        return {
          ...row,
          last: live.price,
          prevClose: live.previousClose ?? row.prevClose,
          dayLow,
          dayHigh,
          dayRangePos:
            Number.isFinite(dayLow) && Number.isFinite(dayHigh) && dayHigh > dayLow
              ? Math.max(0, Math.min(1, (live.price - dayLow) / (dayHigh - dayLow)))
              : row.dayRangePos,
          volumeM: live.turnover !== null ? live.turnover / 1_000_000 : row.volumeM,
          return1dPct: live.changePct ?? row.return1dPct,
          sessionPhase: mode === 'US' ? (live.sessionPhase ?? row.sessionPhase ?? null) : null,
          extendedPrice: mode === 'US' ? (live.extendedPrice ?? row.extendedPrice ?? null) : null,
          extendedChangePct: mode === 'US' ? (live.extendedChangePct ?? row.extendedChangePct ?? null) : null,
        };
      }),
    [inputRows, liveStream, mode],
  );
  const [selectedSector, setSelectedSector] = useState<string>('Todos');
  const [restSearch, setRestSearch] = useState<string>('');
  const [rankHorizon, setRankHorizon] = useState<'Día' | 'Mes' | 'Año'>('Día');

  const leaderRows = useMemo(() => {
    if (mode === 'US' && selectedSector !== 'Todos') {
      return rows.filter((r) => r.sector === selectedSector);
    }
    return rows.filter((r) => r.panel === 'Líder');
  }, [mode, rows, selectedSector]);

  const leaderSymbols = useMemo(() => new Set(leaderRows.map((r) => r.symbol)), [leaderRows]);

  const restRows = useMemo(() => {
    const q = restSearch.trim().toLowerCase();
    if (q) {
      return rows.filter(
        (r) =>
          r.symbol.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          r.sector.toLowerCase().includes(q),
      );
    }
    return rows.filter((r) => !leaderSymbols.has(r.symbol));
  }, [rows, leaderSymbols, restSearch]);

  const countAdvDec = (list: readonly NormalizedPanelRow[]) => {
    let adv = 0;
    let dec = 0;
    for (const r of list) {
      if (Number.isFinite(r.return1dPct)) {
        if (r.return1dPct > 0) adv += 1;
        else if (r.return1dPct < 0) dec += 1;
      }
    }
    return { adv, dec };
  };

  const leaderStats = countAdvDec(leaderRows);
  const restStats = countAdvDec(restRows);

  const rankedRows = useMemo(() => {
    const pick = (r: NormalizedPanelRow) =>
      rankHorizon === 'Día'
        ? r.return1dPct
        : rankHorizon === 'Mes'
          ? r.return30dPct
          : r.returnYtdOr252dPct;
    return rows
      .map((r) => ({ row: r, val: pick(r) }))
      .filter((x) => Number.isFinite(x.val))
      .sort((a, b) => b.val - a.val);
  }, [rows, rankHorizon]);

  const maxAbsRank = useMemo(() => {
    if (rankedRows.length === 0) return 1;
    return Math.max(0.5, ...rankedRows.map((x) => Math.abs(x.val)));
  }, [rankedRows]);

  const riskRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const va = Number.isFinite(a.avgVolume40dM) ? a.avgVolume40dM : -1;
        const vb = Number.isFinite(b.avgVolume40dM) ? b.avgVolume40dM : -1;
        return vb - va;
      }),
    [rows],
  );

  const topGainers = useMemo(() => {
    return [...rows]
      .filter((r) => Number.isFinite(r.return1dPct) && r.return1dPct > 0)
      .sort((a, b) => b.return1dPct - a.return1dPct)
      .slice(0, 6)
      .map((r) => ({
        symbol: r.symbol,
        name: r.name,
        color: r.color,
        last: Number.isFinite(r.last) ? r.last : null,
        volumeM: Number.isFinite(r.volumeM) ? r.volumeM : null,
        return1dPct: r.return1dPct,
      }));
  }, [rows]);

  const topLosers = useMemo(() => {
    return [...rows]
      .filter((r) => Number.isFinite(r.return1dPct) && r.return1dPct < 0)
      .sort((a, b) => a.return1dPct - b.return1dPct)
      .slice(0, 6)
      .map((r) => ({
        symbol: r.symbol,
        name: r.name,
        color: r.color,
        last: Number.isFinite(r.last) ? r.last : null,
        volumeM: Number.isFinite(r.volumeM) ? r.volumeM : null,
        return1dPct: r.return1dPct,
      }));
  }, [rows]);

  const volDays = analytics?.panelVolume40d ?? [];
  const maxDayVol = Math.max(1, ...volDays.map((d) => d.totalVolumeM));
  const volShares = analytics?.volumeShareBreakdown ?? [];
  const volHist = analytics?.panelVolHistory ?? [];

  const formatVolMillions = (m: number | null | undefined) => {
    if (m === null || m === undefined || !Number.isFinite(m)) return '—';
    if (Math.abs(m) >= 1_000) return `${currencyPrefix}${fmtNum(m / 1_000, 2)}B`;
    return `${currencyPrefix}${fmtNum(m, 1)}M`;
  };

  const renderPanelTable = (list: readonly NormalizedPanelRow[], maxHeightClass?: string) => (
    <div className={`overflow-x-auto ${maxHeightClass ?? ''}`}>
      <table className="w-full border-collapse text-right">
        <thead className="sticky top-0 bg-[#0D0D14] z-10">
          <tr className="border-b border-[#1E1E2B] text-[10px] font-semibold uppercase tracking-[0.06em] text-[#787B86]">
            <th className="py-2 px-3 text-left">papel</th>
            <th className="py-2 px-2.5">precio</th>
            <th className="py-2 px-2.5">var</th>
            <th className="py-2 px-2.5">operado</th>
            <th className="py-2 px-3">rango del día</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#1A1A26] font-mono-num">
          {list.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-6 text-center text-[12px] text-[#787B86] font-sans">
                Sin especies coincidentes en esta selección.
              </td>
            </tr>
          ) : (
            list.map((r) => (
              <PanelTableRow
                key={r.symbol}
                row={r}
                denseRowClass={denseRowClass}
                currencyPrefix={currencyPrefix}
                onSelectRow={onSelectRow}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      {sectorOptions && sectorOptions.length > 0 && (
        <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8E90A6]">
            Filtro Sectorial EE.UU. ({rows.length} acciones)
          </span>
          <div className="flex items-center gap-1 flex-wrap">
            {sectorOptions.map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() => setSelectedSector(sec)}
                className={`px-2.5 py-1 rounded-[6px] text-[11px] font-semibold cursor-pointer transition-colors ${
                  selectedSector === sec
                    ? 'bg-[#8B7CF6] text-white'
                    : 'bg-[#0B0B11] text-[#8E90A6] hover:text-[#F3F4F6] border border-[#1E1E2B]'
                }`}
              >
                {sec}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* BLOQUE 1 (2 Columnas): Panel líder / Sectorial + Resto del panel */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-6 rounded-[10px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-[#1E1E2B] flex items-center justify-between gap-2 bg-[#0D0D14]">
            <div className="flex items-center gap-2">
              <h3 className="text-[13.5px] font-bold text-[#F3F4F6] tracking-tight">
                {mode === 'US'
                  ? selectedSector === 'Todos'
                    ? 'Panel líder / Sectorial'
                    : `Sector · ${selectedSector}`
                  : 'Panel líder'}
              </h3>
              <span className="text-[11px] font-mono-num text-[#787B86]">
                {leaderRows.length}
              </span>
            </div>
            <div className="text-[11px] font-mono-num">
              <span className="text-[#2EDC7E] font-semibold">{leaderStats.adv} suben</span>
              <span className="text-[#6D6D84]"> · </span>
              <span className="text-[#FF5468] font-semibold">{leaderStats.dec} bajan</span>
            </div>
          </div>
          {renderPanelTable(leaderRows, 'max-h-[520px] overflow-y-auto')}
        </div>

        <div className="xl:col-span-6 rounded-[10px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden flex flex-col">
          <div className="px-4 py-2.5 border-b border-[#1E1E2B] flex flex-wrap items-center justify-between gap-2 bg-[#0D0D14]">
            <div className="flex items-center gap-2">
              <h3 className="text-[13.5px] font-bold text-[#F3F4F6] tracking-tight">Resto del panel</h3>
              <span className="text-[11px] font-mono-num text-[#787B86]">
                {restRows.length}
              </span>
              <span className="text-[11px] font-mono-num ml-1">
                <span className="text-[#2EDC7E]">{restStats.adv}↑</span>{' '}
                <span className="text-[#FF5468]">{restStats.dec}↓</span>
              </span>
            </div>
            <input
              type="text"
              value={restSearch}
              onChange={(e) => setRestSearch(e.target.value)}
              placeholder="Buscar una acción..."
              className="px-2.5 py-1 rounded-[7px] bg-[#08080D] border border-[#242436] text-[11.5px] text-[#F3F4F6] placeholder:text-[#6D6D84] outline-none focus:border-[#8B7CF6] w-44"
            />
          </div>
          {renderPanelTable(restRows, 'max-h-[520px] overflow-y-auto')}
        </div>
      </div>

      {/* BLOQUE 2 (2 Columnas): Ranking del panel (Día|Mes|Año) + Volatilidad y beta */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-5 rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-[13.5px] font-bold text-[#F3F4F6] tracking-tight">Ranking del panel</h3>
              <p className="text-[11px] text-[#6D6D84]">Retorno ordenado sobre ruedas reales</p>
            </div>
            <div className="inline-flex items-center rounded-[7px] bg-[#08080D] border border-[#1E1E2B] p-0.5">
              {(['Día', 'Mes', 'Año'] as const).map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setRankHorizon(h)}
                  className={`px-2.5 py-1 rounded-[5px] text-[11px] font-semibold cursor-pointer transition-colors ${
                    rankHorizon === h
                      ? 'bg-[#8B7CF6] text-white'
                      : 'text-[#8E90A6] hover:text-[#F3F4F6]'
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
            {rankedRows.length === 0 ? (
              <div className="py-10 text-center text-[12px] text-[#6D6D84]">
                Sin datos cerrados suficientes para {rankHorizon} — sin fallback.
              </div>
            ) : (
              rankedRows.map(({ row, val }) => {
                const pos = val >= 0;
                const widthPct = Math.max(4, Math.min(100, (Math.abs(val) / maxAbsRank) * 100));
                return (
                  <button
                    key={row.symbol}
                    type="button"
                    onClick={() => onSelectRow(row.symbol)}
                    className="w-full flex items-center gap-2.5 px-2 py-1 rounded-[6px] hover:bg-[#171724] text-left cursor-pointer transition-colors"
                  >
                    <CompanyLogo ticker={row.symbol} name={row.name} size="xs" />
                    <span className="w-14 font-mono-num text-[11.5px] font-bold text-[#F3F4F6] shrink-0">
                      {row.symbol}
                    </span>
                    <div className="flex-1 h-2 rounded-full bg-[#181824] overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${widthPct}%`,
                          backgroundColor: pos ? '#2EDC7E' : '#FF5468',
                        }}
                      />
                    </div>
                    <span
                      className={`w-16 text-right font-mono-num text-[11.5px] font-semibold shrink-0 ${
                        pos ? 'text-[#2EDC7E]' : 'text-[#FF5468]'
                      }`}
                    >
                      {fmtPct(val, 2)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="xl:col-span-7 rounded-[10px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-[#1E1E2B] flex items-center justify-between gap-2 bg-[#0D0D14]">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[13.5px] font-bold text-[#F3F4F6] tracking-tight">Volatilidad y beta</h3>
              <HelpTooltip
                title={`Riesgo histórico vs ${benchmarkLabel}`}
                text={`Volatilidad realizada anualizada de 30 ruedas (desvío estándar muestral de log-retornos × √252) y Beta de 60 ruedas frente a ${benchmarkLabel}. Sin fallbacks ante ausencia histórica.`}
              />
            </div>
            <span className="text-[11px] font-mono-num text-[#6D6D84]">Benchmark: {benchmarkLabel}</span>
          </div>
          <div className="overflow-x-auto max-h-[395px] overflow-y-auto">
            <table className="w-full border-collapse text-right">
              <thead className="sticky top-0 bg-[#0D0D14] z-10">
                <tr className="border-b border-[#1E1E2B] text-[10px] font-semibold uppercase tracking-[0.06em] text-[#787B86]">
                  <th className="py-2 px-3 text-left">papel</th>
                  <th className="py-2 px-2.5">volatilidad</th>
                  <th className="py-2 px-2.5">beta</th>
                  <th className="py-2 px-2.5">mes</th>
                  <th className="py-2 px-2.5">año</th>
                  <th className="py-2 px-3">promedio 40</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1A1A26] font-mono-num text-[12px]">
                {riskRows.map((r) => (
                  <RiskTableRow
                    key={r.symbol}
                    row={r}
                    currencyPrefix={currencyPrefix}
                    onSelectRow={onSelectRow}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* BLOQUE 3: Volumen 40 ruedas + Cómo se repartió + Volatilidad en el tiempo + Lo que más se movió hoy */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-5 rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 flex flex-col justify-between gap-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-[13.5px] font-bold text-[#F3F4F6] tracking-tight">
                Volumen de las últimas 40 ruedas
              </h3>
              <p className="text-[11px] text-[#6D6D84]">Monto diario agregado del panel</p>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-[0.06em] text-[#787B86]">Promedio por rueda</div>
              <div className="font-mono-num text-[14px] font-bold text-[#38BDF8]">
                {formatVolMillions(analytics?.volumeAvg40dM)}
              </div>
            </div>
          </div>

          {volDays.length === 0 ? (
            <div className="h-36 flex items-center justify-center text-[12px] text-[#6D6D84]">
              Sin serie histórica de volumen cargada todavía.
            </div>
          ) : (
            <div className="h-36 flex items-end gap-[3px] pt-3 border-b border-[#1E1E2B] pb-1.5">
              {volDays.map((pt) => {
                const hPct = Math.max(4, (pt.totalVolumeM / maxDayVol) * 100);
                return (
                  <div
                    key={pt.date}
                    className="flex-1 h-full flex items-end group"
                    title={`${pt.date}: ${formatVolMillions(pt.totalVolumeM)}`}
                  >
                    <div
                      className="w-full rounded-t-[2px] bg-[#38BDF8]/70 group-hover:bg-[#8B7CF6] transition-colors"
                      style={{ height: `${hPct}%` }}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {volDays.length > 0 && (
            <div className="flex justify-between text-[10px] font-mono-num text-[#6D6D84] -mt-2">
              <span>{volDays[0]?.date}</span>
              <span>{volDays[volDays.length - 1]?.date}</span>
            </div>
          )}

          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="font-semibold text-[#D1D4DC]">Cómo se repartió</span>
              <span className="text-[10.5px] font-mono-num text-[#6D6D84]">Participación 40R</span>
            </div>
            {volShares.length === 0 ? (
              <div className="text-[11.5px] text-[#6D6D84]">—</div>
            ) : (
              <>
                <div className="h-2.5 w-full rounded-full overflow-hidden flex bg-[#181824]">
                  {volShares.map((s) => (
                    <div
                      key={s.symbol}
                      title={`${s.symbol}: ${fmtNum(s.sharePct, 1)}%`}
                      style={{
                        width: `${Math.max(1.5, s.sharePct)}%`,
                        backgroundColor: s.color,
                      }}
                      className="h-full border-r border-[#08080D]/60 last:border-r-0"
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-mono-num">
                  {volShares.map((s) => (
                    <span key={s.symbol} className="inline-flex items-center gap-1.5 text-[#A5A6BA]">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                      {s.symbol !== 'Resto' && <CompanyLogo ticker={s.symbol} size="xs" />}
                      <span className="font-bold text-[#F3F4F6]">{s.symbol}</span>
                      <span>{fmtNum(s.sharePct, 1)}%</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="xl:col-span-7 flex flex-col gap-4">
          <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-[13.5px] font-bold text-[#F3F4F6] tracking-tight">
                  Volatilidad del panel en el tiempo
                </h3>
                <p className="text-[11px] text-[#6D6D84]">
                  Volatilidad realizada rolling 20 ruedas (anualizada %)
                </p>
              </div>
              {volHist.length > 0 && (
                <div className="flex items-center gap-3 text-[11px] font-mono-num">
                  <span className="text-[#8B7CF6] font-bold">
                    Panel: {fmtNum(volHist[volHist.length - 1]?.panelVolPct, 1)}%
                  </span>
                  {volHist[volHist.length - 1]?.avgStockVolPct !== null && (
                    <span className="text-[#38BDF8]">
                      Prom. papel: {fmtNum(volHist[volHist.length - 1]?.avgStockVolPct, 1)}%
                    </span>
                  )}
                </div>
              )}
            </div>

            {volHist.length < 2 ? (
              <div className="h-36 flex items-center justify-center text-[12px] text-[#6D6D84]">
                Sin suficientes ruedas históricas para calcular volatilidad rolling del panel.
              </div>
            ) : (
              (() => {
                const allV = volHist.flatMap((p) =>
                  p.avgStockVolPct !== null ? [p.panelVolPct, p.avgStockVolPct] : [p.panelVolPct],
                );
                const minV = Math.max(0, Math.floor(Math.min(...allV) - 2));
                const maxV = Math.ceil(Math.max(...allV) + 2);
                const spanV = Math.max(1, maxV - minV);
                const mapX = (i: number) => 40 + (i / Math.max(1, volHist.length - 1)) * 500;
                const mapY = (v: number) => 125 - ((v - minV) / spanV) * 105;
                const panelPts = volHist.map((p, i) => `${mapX(i).toFixed(1)},${mapY(p.panelVolPct).toFixed(1)}`);
                const stockPts = volHist
                  .map((p, i) =>
                    p.avgStockVolPct !== null ? `${mapX(i).toFixed(1)},${mapY(p.avgStockVolPct).toFixed(1)}` : null,
                  )
                  .filter((x): x is string => x !== null);
                const ticks = [0, 0.5, 1].map((f) => minV + f * spanV);
                return (
                  <div className="h-36 w-full">
                    <svg viewBox="0 0 555 145" className="w-full h-full overflow-visible">
                      {ticks.map((t) => {
                        const y = mapY(t);
                        return (
                          <g key={t}>
                            <line x1="40" y1={y} x2="540" y2={y} stroke="#1E1E2B" strokeDasharray="3 3" />
                            <text x="34" y={y + 3} textAnchor="end" fill="#6D6D84" fontSize="9.5" className="font-mono-num">
                              {fmtNum(t, 0)}%
                            </text>
                          </g>
                        );
                      })}
                      {stockPts.length >= 2 && (
                        <polyline
                          points={stockPts.join(' ')}
                          fill="none"
                          stroke="#38BDF8"
                          strokeWidth="1.4"
                          strokeDasharray="4 3"
                          opacity="0.75"
                        />
                      )}
                      <polyline
                        points={`40,125 ${panelPts.join(' ')} 540,125`}
                        fill="rgba(139,124,246,0.12)"
                        stroke="none"
                      />
                      <polyline
                        points={panelPts.join(' ')}
                        fill="none"
                        stroke="#8B7CF6"
                        strokeWidth="2.1"
                      />
                      <text x="40" y="140" fill="#6D6D84" fontSize="9.5" className="font-mono-num">
                        {volHist[0]?.date}
                      </text>
                      <text x="540" y="140" textAnchor="end" fill="#6D6D84" fontSize="9.5" className="font-mono-num">
                        {volHist[volHist.length - 1]?.date}
                      </text>
                    </svg>
                  </div>
                );
              })()
            )}
          </div>

          <div className="rounded-[10px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-3">
            <h3 className="text-[13.5px] font-bold text-[#F3F4F6] tracking-tight">
              Lo que más se movió hoy
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#2EDC7E] border-b border-[#1E1E2B] pb-1">
                  Suben
                </div>
                {topGainers.length === 0 ? (
                  <div className="text-[11.5px] text-[#6D6D84] py-2">Sin alzas en esta rueda.</div>
                ) : (
                  topGainers.map((g) => (
                    <button
                      key={g.symbol}
                      type="button"
                      onClick={() => onSelectRow(g.symbol)}
                      className="w-full flex items-center justify-between px-2 py-1 rounded-[6px] hover:bg-[#171724] cursor-pointer text-[12px] font-mono-num"
                    >
                      <span className="inline-flex items-center gap-1.5 min-w-[76px] text-left">
                        <CompanyLogo ticker={g.symbol} name={g.name} size="xs" />
                        <span className="font-bold text-[#F3F4F6]">{g.symbol}</span>
                      </span>
                      <span className="text-[#8E90A6] text-[11px]">
                        {g.last !== null ? `${currencyPrefix}${fmtNum(g.last, 2)}` : '—'}
                      </span>
                      <span className="text-[#6D6D84] text-[11px]">{formatVolMillions(g.volumeM)}</span>
                      <span className="font-bold text-[#2EDC7E]">{fmtPct(g.return1dPct, 2)}</span>
                    </button>
                  ))
                )}
              </div>

              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#FF5468] border-b border-[#1E1E2B] pb-1">
                  Bajan
                </div>
                {topLosers.length === 0 ? (
                  <div className="text-[11.5px] text-[#6D6D84] py-2">Sin bajas en esta rueda.</div>
                ) : (
                  topLosers.map((l) => (
                    <button
                      key={l.symbol}
                      type="button"
                      onClick={() => onSelectRow(l.symbol)}
                      className="w-full flex items-center justify-between px-2 py-1 rounded-[6px] hover:bg-[#171724] cursor-pointer text-[12px] font-mono-num"
                    >
                      <span className="inline-flex items-center gap-1.5 min-w-[76px] text-left">
                        <CompanyLogo ticker={l.symbol} name={l.name} size="xs" />
                        <span className="font-bold text-[#F3F4F6]">{l.symbol}</span>
                      </span>
                      <span className="text-[#8E90A6] text-[11px]">
                        {l.last !== null ? `${currencyPrefix}${fmtNum(l.last, 2)}` : '—'}
                      </span>
                      <span className="text-[#6D6D84] text-[11px]">{formatVolMillions(l.volumeM)}</span>
                      <span className="font-bold text-[#FF5468]">{fmtPct(l.return1dPct, 2)}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const HomeDashboard: React.FC<{
  tickFlashes: Readonly<Record<string, 'up' | 'down' | null>>;
  onSelectStock: (ticker: string) => void;
  onNavigate: (page: string) => void;
  onOpenOrderTicket: (preset: {
    ticker: string;
    side: 'Compra' | 'Venta';
    price: number;
    qty: number;
    instrumentLabel: string;
  }) => void;
}> = ({ onSelectStock, onNavigate }) => {
  const liveMarket = useLiveMarketState();
  const liveStream = useMarketLiveStream();
  const liveLeaderStocks = useMemo(
    () =>
      AR_STOCKS.map((stock) => {
        const quote = getMarketLiveQuote(liveStream, 'AR', stock.ticker);
        return quote === null
          ? stock
          : {
              ...stock,
              last: quote.price,
              deltaPct: quote.changePct ?? stock.deltaPct,
              low: quote.dayLow ?? stock.low,
              high: quote.dayHigh ?? stock.high,
              volumeM: quote.turnover !== null ? quote.turnover / 1_000_000 : stock.volumeM,
            };
      }),
    [liveStream],
  );
  const liveGeneralStocks = useMemo(
    () =>
      AR_GENERAL_PANEL_STOCKS.map((stock) => {
        const quote = getMarketLiveQuote(liveStream, 'AR', stock.ticker);
        return quote === null
          ? stock
          : {
              ...stock,
              last: quote.price,
              deltaPct: quote.changePct ?? stock.deltaPct,
              low: quote.dayLow ?? stock.low,
              high: quote.dayHigh ?? stock.high,
              volumeM: quote.turnover !== null ? quote.turnover / 1_000_000 : stock.volumeM,
            };
      }),
    [liveStream],
  );
  const liveStreamFresh = isMarketLiveStreamFresh(liveStream);
  const cclMedian =
    (liveStreamFresh ? liveStream.cclMedian : null) ??
    liveMarket.overview?.cclMedian ??
    liveMarket.macro?.variables.ccl ??
    GLOBAL_INDICATORS.find((g) => g.id === 'ccl')?.value ??
    null;
  const mepMedian =
    (liveStreamFresh ? liveStream.mepMedian : null) ??
    liveMarket.overview?.mepMedian ??
    liveMarket.macro?.variables.mep ??
    null;
  const computedCanjePct =
    cclMedian !== null &&
    mepMedian !== null &&
    Number.isFinite(cclMedian) &&
    Number.isFinite(mepMedian) &&
    mepMedian > 0
      ? ((cclMedian / mepMedian) - 1) * 100
      : null;
  const canjeGapPct =
    liveStreamFresh && liveStream.cclMedian !== null
      ? computedCanjePct
      : liveMarket.overview?.mepCclGapPct ??
        liveMarket.macro?.variables.canjePct ??
        computedCanjePct;
  const embiVal = GLOBAL_INDICATORS.find((g) => g.id === 'embi')?.value ?? Number.NaN;
  const validTirs = BONDS_DATA.map((b) => b.tir).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const medianTir =
    validTirs.length > 0 ? validTirs[Math.floor(validTirs.length / 2)] ?? Number.NaN : Number.NaN;
  const totalVolM = liveLeaderStocks.reduce((acc, s) => (Number.isFinite(s.volumeM) ? acc + s.volumeM : acc), 0);
  const advCount = liveLeaderStocks.filter((s) => Number.isFinite(s.deltaPct) && s.deltaPct > 0).length;
  const decCount = liveLeaderStocks.filter((s) => Number.isFinite(s.deltaPct) && s.deltaPct < 0).length;
  const deltaFinite = liveLeaderStocks.filter((s) => Number.isFinite(s.deltaPct)).map((s) => s.deltaPct);
  const avgDelta = deltaFinite.length > 0 ? deltaFinite.reduce((a, b) => a + b, 0) / deltaFinite.length : Number.NaN;
  const overviewExt = liveMarket.overview as
    | (typeof liveMarket.overview & {
        readonly atmIvPct?: number | null;
        readonly atmIvExpiryCode?: string | null;
        readonly atmIvExpiryLabel?: string | null;
        readonly atmIvDaysToExpiry?: number | null;
        readonly atmIvRateTnaPct?: number | null;
      })
    | null;
  const ggalOptsMeta = liveMarket.optionsByUnderlying['GGAL'] as
    | ({
        readonly primaryLiquidExpiryCode?: string | null;
        readonly rateTna?: number | null;
      })
    | undefined;
  const frontOpt =
    (ggalOptsMeta?.primaryLiquidExpiryCode
      ? GGAL_OPTION_EXPIRIES.find((e) => e.id === ggalOptsMeta.primaryLiquidExpiryCode)
      : undefined) ??
    GGAL_OPTION_EXPIRIES.find((e) => Number.isFinite(e.atmIV) && e.atmIV > 0) ??
    GGAL_OPTION_EXPIRIES[0];
  const atmIvHeroVal =
    overviewExt?.atmIvPct != null && Number.isFinite(overviewExt.atmIvPct)
      ? overviewExt.atmIvPct
      : (frontOpt?.atmIV ?? Number.NaN);
  const atmIvBadge = overviewExt?.atmIvExpiryCode ?? frontOpt?.id ?? 'SIN CADENA';
  const atmIvDays = overviewExt?.atmIvDaysToExpiry ?? frontOpt?.daysToExpiry ?? null;
  const atmIvLabel = overviewExt?.atmIvExpiryLabel ?? frontOpt?.label ?? atmIvBadge;
  const atmIvRateTna =
    overviewExt?.atmIvRateTnaPct ?? ggalOptsMeta?.rateTna ?? frontOpt?.syntheticRateTNA ?? Number.NaN;

  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant={Number.isFinite(avgDelta) && avgDelta < 0 ? 'neg' : 'pos'} tag="Resumen de Rueda">
        <RealTimeBadge clock={getMarketLiveClock(liveStream)} />{' '}
        Panel Líder BYMA promedio{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">{fmtPct(avgDelta, 2)}</strong> ({advCount} en alza ·{' '}
        {decCount} en baja) · Dólar CCL implícito:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">
          {cclMedian !== null && Number.isFinite(cclMedian) ? `$ ${fmtNum(cclMedian, 2)}` : '—'}
        </strong>{' '}
        · TIR mediana HD: <strong className="text-[#22C55E] font-mono-num">{fmtPct(medianTir, 2, false)}</strong> (
        {liveMarket.feedStatus}).
      </InsightBanner>

      {/* KPIs Héroe de Inicio */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KPICard
          title="Dólar CCL Mediano"
          heroValue={cclMedian !== null && Number.isFinite(cclMedian) ? `$ ${fmtNum(cclMedian, 2)}` : '—'}
          deltaPct={GLOBAL_INDICATORS.find((g) => g.id === 'ccl')?.deltaPct}
          badge={liveMarket.feedStatus}
          subtitle={`MEP: ${fmtNum(mepMedian, 2)} | Canje: ${fmtPct(canjeGapPct, 2)}`}
          helpText="Mediana ponderada del Contado con Liquidación implícito en ADRs, CEDEARs y bonos C."
          onClick={() => onNavigate('monitoreo')}
        />
        <KPICard
          title="TIR Mediana Soberanos HD"
          heroValue={fmtPct(medianTir, 2, false)}
          badge={`${validTirs.length} BONOS`}
          subtitle={`Riesgo País: ${Number.isFinite(embiVal) ? `${fmtNum(embiVal, 0)} pb` : '—'}`}
          helpText="Tasa Interna de Retorno mediana de los bonos soberanos en dólares calculada por XIRR."
          onClick={() => onNavigate('bonos')}
        />
        <KPICard
          title="Volumen Acumulado Merval"
          heroValue={totalVolM > 0 ? fmtMoneyCompact(totalVolM) : '—'}
          badge={`${advCount}▲ / ${decCount}▼`}
          subtitle={`${AR_STOCKS.length} líderes monitoreadas en tiempo real`}
          helpText="Monto efectivo acumulado reportado por Data912 / Open BYMA en acciones del Panel Líder."
          onClick={() => onNavigate('monitoreo')}
        />
        <KPICard
          title="VI ATM Cadena Activa"
          heroValue={Number.isFinite(atmIvHeroVal) ? `${fmtNum(atmIvHeroVal, 1)} %` : '—'}
          badge={atmIvBadge}
          subtitle={
            atmIvDays !== null && Number.isFinite(atmIvDays)
              ? `Vto ${atmIvDays}d (${atmIvLabel}) · Tasa Ref: ${Number.isFinite(atmIvRateTna) ? `${fmtNum(atmIvRateTna, 1)} % TNA` : '—'}`
              : 'Cargando cadena desde /api/ar/options'
          }
          helpText="Volatilidad implícita ATM calculada con modelo Americano Bjerksund-Stensland 2002."
          onClick={() => onNavigate('opciones')}
        />
      </div>

      {/* Panel de Acciones Expandido a Ancho Completo (Panel Líder + Resto del Panel) */}
      <div className="rounded-[10px] bg-[#131722] border border-[#232733] p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <h3 className="text-[15px] font-bold text-[#FFFFFF] tracking-tight">
              Panel Líder
            </h3>
            <span className="text-[11px] font-mono-num text-[#787B86]">
              {AR_STOCKS.length} especies · Click para inspeccionar ficha y libro
            </span>
            <HelpTooltip
              title="Panel de Acciones"
              text="Tarjetas apaisadas con tinte condicional según rendimiento intradiario y variación directa en tipografía monoespaciada tabular."
            />
          </div>
        </div>

        {/* Grid de tarjetas rectangulares — Panel Líder */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
          {liveLeaderStocks.map((st) => (
            <LogoHeatTile
              key={st.ticker}
              ticker={st.ticker}
              name={st.name}
              deltaPct={st.deltaPct}
              price={Number.isFinite(st.last) ? `$${fmtNum(st.last, st.last < 1000 ? 1 : 0)}` : '—'}
              priceValue={st.last}
              onClick={() => onSelectStock(st.ticker)}
            />
          ))}
        </div>

        {/* Sección Resto del Panel (Panel General) */}
        <div className="pt-4 border-t border-[#232733] space-y-3">
          <div className="flex items-center gap-2.5">
            <h4 className="text-[14px] font-bold text-[#D1D4DC] tracking-tight">
              Resto del Panel
            </h4>
            <span className="text-[11px] font-mono-num text-[#787B86]">
              {AR_GENERAL_PANEL_STOCKS.length} especies
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
            {liveGeneralStocks.map((st) => (
              <LogoHeatTile
                key={st.ticker}
                ticker={st.ticker}
                name={st.name}
                deltaPct={st.deltaPct}
                price={Number.isFinite(st.last) ? `$${fmtNum(st.last, st.last < 1000 ? 1 : 0)}` : '—'}
                priceValue={st.last}
                onClick={() => onSelectStock(st.ticker)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export const MonitoringModule: React.FC<{
  subPanel: MonitorSubPanel;
  onSelectSubPanel: (p: MonitorSubPanel) => void;
  density: 'densa' | 'normal' | 'comoda';
  tickFlashes: Readonly<Record<string, 'up' | 'down' | null>>;
  onSelectStock: (ticker: string) => void;
  onOpenOrderTicket: (preset: {
    ticker: string;
    side: 'Compra' | 'Venta';
    price: number;
    qty: number;
    instrumentLabel: string;
  }) => void;
}> = ({ subPanel, onSelectSubPanel, density, tickFlashes, onSelectStock, onOpenOrderTicket }) => {
  const liveMarket = useLiveMarketState();
  const liveStream = useMarketLiveStream();

  useEffect(() => {
    void requestMonitoringPanel(subPanel);
  }, [subPanel]);

  const rowH =
    density === 'densa' ? 'h-8 text-[12px]' : density === 'comoda' ? 'h-11 text-[13px]' : 'h-9 text-[12px]';

  interface ArCaucionRowExt {
    readonly termDays: number;
    readonly label: string;
    readonly currency: 'ARS' | 'USD';
    readonly tnaWeighted: number | null;
    readonly teaEffective: number | null;
    readonly bidTna: number | null;
    readonly askTna: number | null;
    readonly volumeArs: number | null;
    readonly spreadVsBadlarBps: number | null;
    readonly referenceInstrument: string;
    readonly originLabel: string;
    readonly source: 'PRIMARY_ECO_WS' | 'BMB_HOMEBROKER' | 'IOL_REST' | 'DATA912_CAUCION' | 'BCRA_LECAP_REF';
  }

  interface BmbHealthExt {
    readonly status: string;
    readonly error: string | null;
  }

  const monitoringExt = liveMarket.monitoring as
    | (NonNullable<typeof liveMarket.monitoring> & {
        readonly cauciones?: readonly ArCaucionRowExt[];
        readonly caucionesStatus?: 'LIVE_PRIMARY' | 'LIVE_BMB' | 'REFERENCE_BCRA_LECAP' | 'NO_DATA';
        readonly bmbHealth?: BmbHealthExt;
      })
    | null;

  const liveStreamFresh = isMarketLiveStreamFresh(liveStream);
  const streamedCauciones: readonly ArCaucionRowExt[] = liveStreamFresh ? liveStream.cauciones.map((row) => ({
    termDays: row.termDays,
    label: `${String(row.termDays)} días`,
    currency: row.currency,
    tnaWeighted: row.tnaWeighted,
    teaEffective: row.teaEffective,
    bidTna: row.bidTna,
    askTna: row.askTna,
    volumeArs: row.turnoverArs,
    spreadVsBadlarBps: row.spreadVsBadlarBps,
    referenceInstrument: row.referenceInstrument,
    originLabel: row.source === 'PRIMARY_ECO_WS' ? 'Eco Primary XOMS en vivo' : row.source === 'BMB_HOMEBROKER' ? 'BMB HomeBroker en vivo' : row.source === 'IOL_REST' ? 'IOL REST v2 en vivo' : 'Referencia BCRA / LECAP',
    source: row.source,
  })) : [];
  const liveCauciones: readonly ArCaucionRowExt[] =
    liveStreamFresh && liveStream.arSourceMode === 'NO_DATA'
      ? []
      : streamedCauciones.length > 0
        ? streamedCauciones
        : monitoringExt?.cauciones ?? [];
  const caucionesStatus =
    liveStreamFresh && liveStream.arSourceMode === 'NO_DATA'
      ? 'NO_DATA'
      : liveStreamFresh && (liveStream.arSourceMode === 'LIVE_PRIMARY' || liveStream.arSourceMode === 'LIVE_BMB' || liveStream.arSourceMode === 'LIVE_IOL') && streamedCauciones.length > 0
        ? liveStream.arSourceMode
        : monitoringExt?.caucionesStatus ?? 'NO_DATA';
  const bmbHealth = monitoringExt?.bmbHealth;
  const totalCaucionVol = liveCauciones.reduce(
    (acc, r) => (r.volumeArs !== null && Number.isFinite(r.volumeArs) ? acc + r.volumeArs : acc),
    0,
  );
  const caucionesCount = liveCauciones.length > 0 ? liveCauciones.length : CAUCIONES_DATA.length;
  const cclMedian = (liveStreamFresh ? liveStream.cclMedian : null) ?? liveMarket.monitoring?.cclMedian ?? liveMarket.overview?.cclMedian ?? null;
  const [cedearFilterMode, setCedearFilterMode] = useState<'all' | 'mispriced' | 'byma_opts' | 'adrs'>('all');
  const [cedearSearch, setCedearSearch] = useState<string>('');

  interface CedearAdrDisplayRow {
    readonly key: string;
    readonly kind: 'CEDEAR' | 'ADR';
    readonly ticker: string;
    readonly usTicker: string;
    readonly name: string;
    readonly sector: string;
    readonly color: string;
    readonly usLast: number;
    readonly usDeltaPct: number;
    readonly ratioStr: string;
    readonly ratioNum: number;
    readonly localArs: number;
    readonly fairArsPrice: number;
    readonly cclImplicit: number;
    readonly cclMismatchPct: number;
    readonly cclMismatchArs: number;
    readonly iv30d: number;
    readonly ivSource: 'OPRA_IV' | 'MASSIVE_RV30D' | 'NONE';
    readonly volMultiple: number;
    readonly hasUsOptions: boolean;
    readonly hasBymaOptions: boolean;
    readonly arbitrageSignal: string;
  }

  const combinedCedearsAndAdrs: readonly CedearAdrDisplayRow[] = useMemo(() => {
    const usMetaMap = new Map(US_MARKET_DATA.map((u) => [u.ticker.toUpperCase(), u]));
    const usMetaNoDotMap = new Map(
      US_MARKET_DATA.map((u) => [u.ticker.replace(/\./g, '').toUpperCase(), u]),
    );
    const lookupUsMeta = (sym: string) => {
      const upper = sym.toUpperCase();
      return usMetaMap.get(upper) ?? usMetaNoDotMap.get(upper.replace(/\./g, ''));
    };

    const rawCedears = liveMarket.monitoring?.cedears ?? [];
    const cedearRows: CedearAdrDisplayRow[] =
      rawCedears.length > 0
        ? rawCedears.map((ced) => {
            const usSym = (ced.adrTicker?.replace(/ US$/i, '') ?? ced.ticker).trim().toUpperCase();
            const meta = lookupUsMeta(usSym) ?? lookupUsMeta(ced.ticker);
            const ratioNum =
              ced.adrRatio !== undefined && ced.adrRatio !== null && Number.isFinite(ced.adrRatio)
                ? ced.adrRatio
                : meta?.cedearRatioNum ?? Number.NaN;
            return {
              key: `CEDEAR:${ced.ticker}`,
              kind: 'CEDEAR',
              ticker: ced.ticker,
              usTicker: usSym,
              name: ced.name || meta?.name || ced.ticker,
              sector: ced.sector || meta?.sector || 'CEDEAR',
              color: meta?.color ?? '#38BDF8',
              usLast:
                ced.adrPrice !== undefined && ced.adrPrice !== null && Number.isFinite(ced.adrPrice)
                  ? ced.adrPrice
                  : meta?.price ?? Number.NaN,
              usDeltaPct:
                ced.adrDeltaPct !== undefined &&
                ced.adrDeltaPct !== null &&
                Number.isFinite(ced.adrDeltaPct)
                  ? ced.adrDeltaPct
                  : meta?.deltaPct ?? Number.NaN,
              ratioStr: Number.isFinite(ratioNum) ? `${ratioNum}:1` : meta?.cedearRatio ?? '—',
              ratioNum,
              localArs: ced.last !== null && Number.isFinite(ced.last) ? ced.last : Number.NaN,
              fairArsPrice:
                ced.fairArsPrice !== undefined &&
                ced.fairArsPrice !== null &&
                Number.isFinite(ced.fairArsPrice)
                  ? ced.fairArsPrice
                  : Number.NaN,
              cclImplicit:
                ced.cclImplicit !== undefined &&
                ced.cclImplicit !== null &&
                Number.isFinite(ced.cclImplicit)
                  ? ced.cclImplicit
                  : Number.NaN,
              cclMismatchPct:
                ced.cclMismatchPct !== undefined &&
                ced.cclMismatchPct !== null &&
                Number.isFinite(ced.cclMismatchPct)
                  ? ced.cclMismatchPct
                  : Number.NaN,
              cclMismatchArs:
                ced.cclMismatchArs !== undefined &&
                ced.cclMismatchArs !== null &&
                Number.isFinite(ced.cclMismatchArs)
                  ? ced.cclMismatchArs
                  : Number.NaN,
              iv30d:
                ced.iv30d !== undefined && ced.iv30d !== null && Number.isFinite(ced.iv30d)
                  ? ced.iv30d
                  : meta?.iv30d ?? Number.NaN,
              ivSource: ced.ivSource ?? 'NONE',
              volMultiple:
                ced.volMultiple !== null && Number.isFinite(ced.volMultiple)
                  ? ced.volMultiple
                  : meta?.volMultiple ?? Number.NaN,
              hasUsOptions: Boolean(ced.hasUsOptions ?? meta?.hasUsOptions),
              hasBymaOptions: Boolean(ced.hasBymaOptions),
              arbitrageSignal: ced.arbitrageSignal ?? '—',
            };
          })
        : US_MARKET_DATA.map((u) => ({
            key: `CEDEAR:${u.ticker}`,
            kind: 'CEDEAR',
            ticker: u.ticker,
            usTicker: u.ticker,
            name: u.name,
            sector: u.sector,
            color: u.color,
            usLast: u.price,
            usDeltaPct: u.deltaPct,
            ratioStr: u.cedearRatio,
            ratioNum: u.cedearRatioNum,
            localArs: u.cedearArsPrice,
            fairArsPrice:
              cclMedian !== null &&
              Number.isFinite(cclMedian) &&
              Number.isFinite(u.price) &&
              Number.isFinite(u.cedearRatioNum) &&
              u.cedearRatioNum > 0
                ? (u.price * cclMedian) / u.cedearRatioNum
                : Number.NaN,
            cclImplicit: u.cclImplicit,
            cclMismatchPct:
              cclMedian !== null &&
              Number.isFinite(cclMedian) &&
              cclMedian > 0 &&
              Number.isFinite(u.cclImplicit)
                ? ((u.cclImplicit - cclMedian) / cclMedian) * 100
                : Number.NaN,
            cclMismatchArs:
              cclMedian !== null &&
              Number.isFinite(cclMedian) &&
              Number.isFinite(u.price) &&
              Number.isFinite(u.cedearArsPrice) &&
              Number.isFinite(u.cedearRatioNum) &&
              u.cedearRatioNum > 0
                ? u.cedearArsPrice - (u.price * cclMedian) / u.cedearRatioNum
                : Number.NaN,
            iv30d: u.iv30d,
            ivSource: Number.isFinite(u.iv30d) ? 'OPRA_IV' : 'NONE',
            volMultiple: u.volMultiple,
            hasUsOptions: u.hasUsOptions,
            hasBymaOptions: false,
            arbitrageSignal: u.signal,
          }));

    const arMetaMap = new Map(AR_STOCKS.map((s) => [s.ticker, s]));
    const adrSourceStocks =
      liveMarket.monitoring?.stocks && liveMarket.monitoring.stocks.length > 0
        ? liveMarket.monitoring.stocks.filter((s) => s.adrTicker !== undefined)
        : [];

    const adrRows: CedearAdrDisplayRow[] =
      adrSourceStocks.length > 0
        ? adrSourceStocks.map((s) => {
            const meta = arMetaMap.get(s.ticker);
            const usSym = (s.adrTicker ?? '').replace(/ US$/i, '').trim().toUpperCase();
            const ratioNum =
              s.adrRatio !== undefined && s.adrRatio !== null && Number.isFinite(s.adrRatio)
                ? s.adrRatio
                : Number.NaN;
            return {
              key: `ADR:${s.ticker}`,
              kind: 'ADR',
              ticker: s.ticker,
              usTicker: usSym || s.ticker,
              name: s.name,
              sector: s.sector,
              color: meta?.color ?? '#22C55E',
              usLast:
                s.adrPrice !== undefined && s.adrPrice !== null && Number.isFinite(s.adrPrice)
                  ? s.adrPrice
                  : Number.NaN,
              usDeltaPct:
                s.adrDeltaPct !== undefined &&
                s.adrDeltaPct !== null &&
                Number.isFinite(s.adrDeltaPct)
                  ? s.adrDeltaPct
                  : Number.NaN,
              ratioStr: Number.isFinite(ratioNum) ? `${ratioNum}:1 ADR` : '—',
              ratioNum,
              localArs: s.last !== null && Number.isFinite(s.last) ? s.last : Number.NaN,
              fairArsPrice:
                s.fairArsPrice !== undefined &&
                s.fairArsPrice !== null &&
                Number.isFinite(s.fairArsPrice)
                  ? s.fairArsPrice
                  : Number.NaN,
              cclImplicit:
                s.cclImplicit !== undefined &&
                s.cclImplicit !== null &&
                Number.isFinite(s.cclImplicit)
                  ? s.cclImplicit
                  : Number.NaN,
              cclMismatchPct:
                s.cclMismatchPct !== undefined &&
                s.cclMismatchPct !== null &&
                Number.isFinite(s.cclMismatchPct)
                  ? s.cclMismatchPct
                  : Number.NaN,
              cclMismatchArs:
                s.cclMismatchArs !== undefined &&
                s.cclMismatchArs !== null &&
                Number.isFinite(s.cclMismatchArs)
                  ? s.cclMismatchArs
                  : Number.NaN,
              iv30d:
                s.iv30d !== undefined && s.iv30d !== null && Number.isFinite(s.iv30d)
                  ? s.iv30d
                  : Number.NaN,
              ivSource: s.ivSource ?? 'NONE',
              volMultiple:
                s.volMultiple !== null && Number.isFinite(s.volMultiple) ? s.volMultiple : Number.NaN,
              hasUsOptions: Boolean(s.hasUsOptions),
              hasBymaOptions: Boolean(s.hasBymaOptions),
              arbitrageSignal: s.arbitrageSignal ?? '—',
            };
          })
        : AR_STOCKS.filter((s) => s.adrTicker && s.adrTicker.length > 0).map((s) => ({
            key: `ADR:${s.ticker}`,
            kind: 'ADR',
            ticker: s.ticker,
            usTicker: (s.adrTicker ?? '').replace(/ US$/i, '').trim().toUpperCase(),
            name: s.name,
            sector: s.sector,
            color: s.color,
            usLast: s.adrPrice ?? Number.NaN,
            usDeltaPct: s.adrDeltaPct ?? Number.NaN,
            ratioStr: Number.isFinite(s.adrRatio ?? Number.NaN) ? `${s.adrRatio}:1 ADR` : '—',
            ratioNum: s.adrRatio ?? Number.NaN,
            localArs: s.last,
            fairArsPrice: s.fairArsPrice ?? Number.NaN,
            cclImplicit: s.cclImplicit ?? Number.NaN,
            cclMismatchPct: s.cclMismatchPct ?? Number.NaN,
            cclMismatchArs: s.cclMismatchArs ?? Number.NaN,
            iv30d: s.iv30d ?? Number.NaN,
            ivSource: s.ivSource ?? 'NONE',
            volMultiple: s.volMultiple ?? Number.NaN,
            hasUsOptions: Boolean(s.hasUsOptions),
            hasBymaOptions: Boolean(s.hasBymaOptions),
            arbitrageSignal: s.arbitrageSignal ?? '—',
          }));

    return [...adrRows, ...cedearRows].map((row) => {
      const usQuote = getMarketLiveQuote(liveStream, 'US', row.usTicker);
      const arQuote = getMarketLiveQuote(liveStream, 'AR', row.ticker);
      const usLast = usQuote?.price ?? row.usLast;
      const localArs = arQuote?.price ?? row.localArs;
      const fairArsPrice =
        Number.isFinite(usLast) && usLast > 0 && cclMedian !== null && cclMedian > 0 && Number.isFinite(row.ratioNum) && row.ratioNum > 0
          ? (usLast * cclMedian) / row.ratioNum
          : Number.NaN;
      const cclImplicit =
        Number.isFinite(localArs) && localArs > 0 && Number.isFinite(usLast) && usLast > 0 && Number.isFinite(row.ratioNum) && row.ratioNum > 0
          ? (localArs * row.ratioNum) / usLast
          : Number.NaN;
      return {
        ...row,
        usLast,
        usDeltaPct: usQuote?.changePct ?? row.usDeltaPct,
        localArs,
        fairArsPrice,
        cclImplicit,
        cclMismatchPct:
          cclMedian !== null && cclMedian > 0 && Number.isFinite(cclImplicit)
            ? ((cclImplicit - cclMedian) / cclMedian) * 100
            : Number.NaN,
        cclMismatchArs:
          Number.isFinite(localArs) && Number.isFinite(fairArsPrice) ? localArs - fairArsPrice : Number.NaN,
      };
    });
  }, [liveMarket.monitoring?.cedears, liveMarket.monitoring?.stocks, cclMedian, liveMarket.version, liveStream]);

  const cedearRadarSummary = useMemo(() => {
    const discounts = [...combinedCedearsAndAdrs]
      .filter((r) => Number.isFinite(r.cclMismatchPct) && r.cclMismatchPct <= -0.5)
      .sort((a, b) => a.cclMismatchPct - b.cclMismatchPct)
      .slice(0, 3);
    const premiums = [...combinedCedearsAndAdrs]
      .filter((r) => Number.isFinite(r.cclMismatchPct) && r.cclMismatchPct >= 0.5)
      .sort((a, b) => b.cclMismatchPct - a.cclMismatchPct)
      .slice(0, 3);
    const highVolRows = [...combinedCedearsAndAdrs]
      .filter((r) => Number.isFinite(r.volMultiple) && r.volMultiple > 0)
      .sort((a, b) => b.volMultiple - a.volMultiple)
      .slice(0, 3);
    const opraCount = combinedCedearsAndAdrs.filter((r) => r.hasUsOptions).length;
    const bymaCount = combinedCedearsAndAdrs.filter((r) => r.hasBymaOptions).length;
    const mispricedCount = combinedCedearsAndAdrs.filter(
      (r) => Number.isFinite(r.cclMismatchPct) && Math.abs(r.cclMismatchPct) >= 1.2,
    ).length;
    const validIvs = combinedCedearsAndAdrs
      .map((r) => r.iv30d)
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    const medianIv = validIvs.length > 0 ? validIvs[Math.floor(validIvs.length / 2)] : Number.NaN;
    return {
      discounts,
      premiums,
      highVolRows,
      opraCount,
      bymaCount,
      mispricedCount,
      medianIv,
      adrCount: combinedCedearsAndAdrs.filter((r) => r.kind === 'ADR').length,
    };
  }, [combinedCedearsAndAdrs]);

  const filteredCedearsAndAdrs = useMemo(() => {
    const q = cedearSearch.trim().toLowerCase();
    return combinedCedearsAndAdrs.filter((r) => {
      if (
        cedearFilterMode === 'mispriced' &&
        (!Number.isFinite(r.cclMismatchPct) || Math.abs(r.cclMismatchPct) < 1.2)
      ) {
        return false;
      }
      if (cedearFilterMode === 'byma_opts' && !r.hasBymaOptions) return false;
      if (cedearFilterMode === 'adrs' && r.kind !== 'ADR') return false;
      if (!q) return true;
      return (
        r.ticker.toLowerCase().includes(q) ||
        r.usTicker.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.sector.toLowerCase().includes(q)
      );
    });
  }, [combinedCedearsAndAdrs, cedearFilterMode, cedearSearch]);

  const panels: { id: MonitorSubPanel; label: string; count: number }[] = [
    { id: 'acciones', label: 'Acciones Líderes', count: AR_STOCKS.length },
    { id: 'bonos', label: 'Bonos y Letras', count: BONDS_DATA.length },
    { id: 'cedears', label: 'CEDEARs y ADRs', count: combinedCedearsAndAdrs.length },
    { id: 'cauciones', label: 'Cauciones por Plazo', count: caucionesCount },
  ];

  const monitorBonds = BONDS_DATA.map((bond) => {
    const quote = getMarketLiveQuote(liveStream, 'AR', bond.ticker);
    return quote === null
      ? bond
      : {
          ...bond,
          price: quote.price,
          deltaPct: quote.changePct ?? bond.deltaPct,
          volumeM: quote.turnover !== null ? quote.turnover / 1_000_000 : bond.volumeM,
        };
  });

  const stockDeltas = AR_STOCKS.map((s) => {
    const live = getMarketLiveQuote(liveStream, 'AR', s.ticker);
    return live?.changePct ?? s.deltaPct;
  }).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const medianStockDelta = stockDeltas.length > 0 ? stockDeltas[Math.floor(stockDeltas.length / 2)] : Number.NaN;
  const stockAdv = stockDeltas.filter((d) => d > 0).length;

  const arCombinedPanelRows: NormalizedPanelRow[] = useMemo(() => {
    const arAnalytics = liveMarket.monitoring?.arPanelAnalytics ?? AR_PANEL_ANALYTICS;
    const analyticsMap = new Map<string, EquityPanelRowDto>(
      (arAnalytics?.rows ?? []).map((r) => [r.symbol, r]),
    );
    return [...AR_STOCKS, ...AR_GENERAL_PANEL_STOCKS].map((s) => {
      const extra = analyticsMap.get(s.ticker);
      return {
        symbol: s.ticker,
        name: s.name,
        sector: s.sector,
        panel: s.panel === 'General' ? 'General' : 'Líder',
        color: s.color,
        last: Number.isFinite(s.last) ? s.last : extra?.last ?? Number.NaN,
        prevClose: Number.isFinite(s.prevClose) ? s.prevClose : extra?.prevClose ?? Number.NaN,
        dayLow: Number.isFinite(s.low) ? s.low : extra?.dayLow ?? Number.NaN,
        dayHigh: Number.isFinite(s.high) ? s.high : extra?.dayHigh ?? Number.NaN,
        dayRangePos:
          extra?.dayRangePos !== undefined && extra.dayRangePos !== null
            ? extra.dayRangePos
            : s.dayRangePos ?? Number.NaN,
        volumeM:
          Number.isFinite(s.volumeM)
            ? s.volumeM
            : extra?.volumeM !== undefined && extra.volumeM !== null
              ? extra.volumeM
              : Number.NaN,
        return1dPct: Number.isFinite(s.deltaPct) ? s.deltaPct : extra?.return1dPct ?? Number.NaN,
        return30dPct:
          extra?.return30dPct !== undefined && extra.return30dPct !== null
            ? extra.return30dPct
            : s.return30dPct ?? Number.NaN,
        returnYtdOr252dPct:
          extra?.returnYtdOr252dPct !== undefined && extra.returnYtdOr252dPct !== null
            ? extra.returnYtdOr252dPct
            : s.returnYtdOr252dPct ?? Number.NaN,
        realizedVol30dPct:
          extra?.realizedVol30dPct !== undefined && extra.realizedVol30dPct !== null
            ? extra.realizedVol30dPct
            : s.realizedVol30dPct ?? Number.NaN,
        beta:
          extra?.beta !== undefined && extra.beta !== null ? extra.beta : s.beta ?? Number.NaN,
        avgVolume40dM:
          extra?.avgVolume40dM !== undefined && extra.avgVolume40dM !== null
            ? extra.avgVolume40dM
            : s.avgVolume40dM ?? Number.NaN,
      };
    });
  }, [liveMarket.monitoring?.arPanelAnalytics, AR_STOCKS.length, AR_GENERAL_PANEL_STOCKS.length, liveMarket.version]);

  return (
    <div className="space-y-4 animate-module">
      <RealTimeBadge clock={getMarketLiveClock(liveStream)} />
      {/* Sub-navegación de Monitoreo */}
      <div className="qc-card p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 p-1 rounded-[10px] bg-[var(--bg-sidebar)] border border-[var(--border-subtle)]">
            {panels.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelectSubPanel(p.id)}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-[12px] font-semibold cursor-pointer transition-all ${
                  subPanel === p.id
                    ? 'bg-[var(--accent-primary)] text-white'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <span>{p.label}</span>
                <span className="text-[10px] font-mono-num px-1.5 py-0.2 rounded bg-black/25">
                  {p.count}
                </span>
              </button>
            ))}
          </div>

        </div>

        {subPanel === 'acciones' && (
          <InsightBanner variant="pos" tag="Panel Acciones">
            Mediana de variación intradiaria:{' '}
            <strong className="text-[#2EDC7E] font-mono-num">{fmtPct(medianStockDelta, 2)}</strong> ·{' '}
            <strong className="text-[var(--text-primary)]">
              {stockAdv} de {stockDeltas.length}
            </strong>{' '}
            especies operando positivo ({liveMarket.feedStatus}).
          </InsightBanner>
        )}
        {subPanel === 'bonos' && (
          <InsightBanner variant="pos" tag="Renta Fija">
            Curva soberana y letras del Tesoro sincronizada en tiempo real ({BONDS_DATA.length} especies ·{' '}
            {liveMarket.feedStatus}).
          </InsightBanner>
        )}
        {subPanel === 'cedears' && (
          <InsightBanner variant="default" tag="CEDEARs / Wall Street">
            Dólar CCL de referencia:{' '}
            <strong className="text-[var(--text-primary)] font-mono-num">
              {cclMedian !== null && Number.isFinite(cclMedian) ? `$ ${fmtNum(cclMedian, 2)}` : '—'}
            </strong>{' '}
            con cotizaciones locales y NYSE combinadas.
          </InsightBanner>
        )}
        {subPanel === 'cauciones' && (
          <InsightBanner variant={caucionesStatus === 'LIVE_PRIMARY' || caucionesStatus === 'LIVE_BMB' || caucionesStatus === 'LIVE_IOL' ? 'pos' : 'warn'} tag="Liquidez / Cauciones">
            {caucionesStatus === 'LIVE_BMB' ? (
              <>
                Puntas vivas Tomadora/Colocadora vía <strong className="text-[#2EDC7E]">Bull Market HomeBroker</strong> ({liveCauciones.length} plazos activos).
              </>
            ) : caucionesStatus === 'LIVE_IOL' ? (
              <>
                Cotizaciones L1 vía <strong className="text-[#38BDF8]">IOL REST v2</strong> ({liveCauciones.length} plazos activos; BMB conserva prioridad cuando está fresco).
              </>
            ) : liveCauciones.length > 0 ? (
              <>
                Conector BMB en estado <strong className="text-[#F5B544]">{bmbHealth?.status ?? 'OFFLINE'}</strong> — Mostrando{' '}
                <strong>Curva de Referencia Implícita BCRA / Lecap</strong> ({liveCauciones.length} plazos · BADLAR:{' '}
                <strong className="font-mono-num text-[var(--text-primary)]">
                  {fmtNum(liveMarket.monitoring?.badlarTna ?? liveMarket.macro?.variables.badlarTna, 2)}% TNA
                </strong>
                ). Sin puntas simuladas.
              </>
            ) : (
              `Sin libro vivo BMB (${bmbHealth?.status ?? 'NO_DATA'}) ni curva BCRA cargada todavía.`
            )}
          </InsightBanner>
        )}
      </div>

      {/* ACCIONES AR: LOS 6 PANELES ANALÍTICOS */}
      {subPanel === 'acciones' && (
        <EquitySixPanelsGrid
          mode="AR"
          rows={arCombinedPanelRows}
          analytics={liveMarket.monitoring?.arPanelAnalytics ?? AR_PANEL_ANALYTICS}
          currencyPrefix="$ "
          benchmarkLabel="Panel Líder"
          onSelectRow={(ticker) => onSelectStock(ticker)}
          denseRowClass={rowH}
        />
      )}

      {/* TABLA 2: BONOS Y LETRAS CON GRUPOS Y BARRAS EN LÍNEA */}
      {subPanel === 'bonos' && (
        <div className="qc-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-right">
              <thead>
                <tr className="bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                  <th className="py-2.5 px-3 text-left">Especie</th>
                  <th className="py-2.5 px-2 text-left">Ley / Moneda</th>
                  <th className="py-2.5 px-2.5">Precio</th>
                  <th className="py-2.5 px-2.5">Var. Día</th>
                  <th className="py-2.5 px-3 text-left">TIR Anual (Barra en Línea)</th>
                  <th className="py-2.5 px-2.5">Δ TIR (pb)</th>
                  <th className="py-2.5 px-2.5">Paridad %</th>
                  <th className="py-2.5 px-2.5">Mod. Duration</th>
                  <th className="py-2.5 px-2.5">Volumen / Múlt.</th>
                  <th className="py-2.5 px-3 text-left">Lectura / Señal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {(
                  [
                    'Tramo corto (2026–2030)',
                    'Tramo largo (2035–2046)',
                    'LECAC / Letras Tasa Fija',
                    'CER / Ajustables por inflación',
                  ] as const
                ).map((group) => {
                  const rows = monitorBonds.filter((b) => b.tranche === group);
                  return (
                    <React.Fragment key={group}>
                      <tr className="bg-[var(--surface-2)]">
                        <td
                          colSpan={10}
                          className="py-1.5 px-3 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--accent-primary)]"
                        >
                          ▸ {group} ({rows.length} especies)
                        </td>
                      </tr>
                      {rows.map((b) => {
                        const tirBarW = Number.isFinite(b.tir) ? Math.min(100, Math.max(0, (b.tir / 32) * 100)) : 0;
                        return (
                          <tr key={b.ticker} className={`${rowH} hover:bg-[var(--surface-2)]/70 font-mono-num`}>
                            <td className="px-3 text-left">
                              <div className="font-bold text-[var(--text-primary)]">{b.ticker}</div>
                              <div className="text-[10px] font-sans text-[var(--text-tertiary)]">{b.name}</div>
                            </td>
                            <td className="px-2 text-left font-sans">
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-secondary)]">
                                {b.law} · {b.currency}
                              </span>
                            </td>
                            <td className="px-2.5 font-bold text-[var(--text-primary)]">
                              <TickFlash value={Number.isFinite(b.price) ? b.price : null}>
                                {Number.isFinite(b.price)
                                  ? `${b.currency === 'ARS' ? '$ ' : 'US$ '}${fmtNum(b.price, 2)}`
                                  : '—'}
                              </TickFlash>
                            </td>
                            <td className="px-2.5">
                              <DeltaPill value={b.deltaPct} size="sm" />
                            </td>
                            {/* Barra en línea de TIR */}
                            <td className="px-3 text-left">
                              <div className="flex items-center gap-2">
                                <div className="w-24 h-2 rounded-full bg-[var(--surface-3)] overflow-hidden">
                                  <div
                                    style={{ width: `${tirBarW}%` }}
                                    className="h-full bg-[#8B7CF6]"
                                  />
                                </div>
                                <span className="font-bold text-[var(--text-primary)]">
                                  {Number.isFinite(b.tir) ? `${fmtNum(b.tir, 2)} %` : '—'}
                                </span>
                              </div>
                            </td>
                            <td
                              className={`px-2.5 font-semibold ${
                                !Number.isFinite(b.tirDeltaPb)
                                  ? 'text-[#787B86]'
                                  : b.tirDeltaPb < 0
                                  ? 'text-[#2EDC7E]'
                                  : 'text-[#FF5C63]'
                              }`}
                            >
                              {Number.isFinite(b.tirDeltaPb)
                                ? `${b.tirDeltaPb > 0 ? `+${b.tirDeltaPb}` : `−${Math.abs(b.tirDeltaPb)}`} pb`
                                : '—'}
                            </td>
                            <td className="px-2.5 text-[var(--text-secondary)]">
                              {Number.isFinite(b.parity) ? `${fmtNum(b.parity, 1)} %` : '—'}
                            </td>
                            <td className="px-2.5 text-[var(--text-secondary)]">
                              {Number.isFinite(b.modDuration) ? `${fmtNum(b.modDuration, 2)} a` : '—'}
                            </td>
                            <td className="px-2.5">
                              <span className="text-[var(--text-primary)]">{fmtMoneyCompact(b.volumeM)}</span>{' '}
                              {Number.isFinite(b.volMultiple) && (
                                <span className="text-[10px] text-[#8B7CF6] font-semibold">
                                  {fmtNum(b.volMultiple, 1)}×
                                </span>
                              )}
                            </td>
                            <td className="px-3 text-left font-sans text-[12px] text-[var(--text-secondary)]">
                              {b.signal}
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TABLA 3: CEDEARS, ADRs Y RADAR DE ARBITRAJE CCL / OPCIONES */}
      {subPanel === 'cedears' && (
        <div className="space-y-4">
          {/* Radar de Arbitraje de Opciones & Ratios */}
          <div className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[13.5px] font-bold text-[#F3F4F6] tracking-tight">
                  Radar de Arbitraje de Opciones & Ratios (BYMA vs. NYSE)
                </div>
                <div className="text-[11px] text-[#787B86]">
                  Desfase ARS vs. CCL Implícito · Volatilidad 30D (OPRA / Realizada Massive) · Vol. Relativo vs. 20D
                </div>
              </div>
              <div className="text-[11px] font-mono-num text-[#9CA3AF]">
                CCL Ref:{' '}
                <strong className="text-[#F3F4F6]">
                  {cclMedian !== null && Number.isFinite(cclMedian) ? `$ ${fmtNum(cclMedian, 2)}` : '—'}
                </strong>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {/* Card 1: Descuentos (BYMA barato vs CCL) */}
              <div className="rounded-[10px] bg-[#0B0B11] border border-[#1E1E2B] p-3 space-y-2">
                <div className="flex items-center justify-between text-[10.5px] uppercase tracking-[0.05em] text-[#2EDC7E] font-semibold">
                  <span>Descuentos vs. CCL</span>
                  <span className="font-mono-num">{cedearRadarSummary.discounts.length}</span>
                </div>
                {cedearRadarSummary.discounts.length > 0 ? (
                  <div className="space-y-1.5">
                    {cedearRadarSummary.discounts.map((d) => (
                      <div
                        key={`disc-${d.key}`}
                        className="flex items-center justify-between text-[11.5px] font-mono-num"
                      >
                        <span className="inline-flex items-center gap-1.5 font-bold text-[#F3F4F6]">
                          <CompanyLogo ticker={d.usTicker || d.ticker} name={d.name} size="xs" />
                          <span>{d.ticker}</span>
                          <span className="text-[10px] font-sans text-[#787B86]">{d.kind}</span>
                        </span>
                        <span className="text-[#2EDC7E] font-semibold">
                          {fmtPct(d.cclMismatchPct, 2)} (
                          {Number.isFinite(d.cclMismatchArs) ? `$ ${fmtNum(d.cclMismatchArs, 0)}` : '—'})
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-[#787B86]">Sin descuentos &ge; 0,5%</div>
                )}
              </div>

              {/* Card 2: Primas (BYMA caro vs CCL) */}
              <div className="rounded-[10px] bg-[#0B0B11] border border-[#1E1E2B] p-3 space-y-2">
                <div className="flex items-center justify-between text-[10.5px] uppercase tracking-[0.05em] text-[#F5B544] font-semibold">
                  <span>Primas / Sobreprecio vs. CCL</span>
                  <span className="font-mono-num">{cedearRadarSummary.premiums.length}</span>
                </div>
                {cedearRadarSummary.premiums.length > 0 ? (
                  <div className="space-y-1.5">
                    {cedearRadarSummary.premiums.map((p) => (
                      <div
                        key={`prem-${p.key}`}
                        className="flex items-center justify-between text-[11.5px] font-mono-num"
                      >
                        <span className="inline-flex items-center gap-1.5 font-bold text-[#F3F4F6]">
                          <CompanyLogo ticker={p.usTicker || p.ticker} name={p.name} size="xs" />
                          <span>{p.ticker}</span>
                          <span className="text-[10px] font-sans text-[#787B86]">{p.kind}</span>
                        </span>
                        <span className="text-[#F5B544] font-semibold">
                          +{fmtNum(p.cclMismatchPct, 2)}% (+$ {fmtNum(p.cclMismatchArs, 0)})
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-[#787B86]">Sin primas &ge; 0,5%</div>
                )}
              </div>

              {/* Card 3: Cobertura Opciones (OPRA & BYMA) */}
              <div className="rounded-[10px] bg-[#0B0B11] border border-[#1E1E2B] p-3 space-y-2">
                <div className="flex items-center justify-between text-[10.5px] uppercase tracking-[0.05em] text-[#60A5FA] font-semibold">
                  <span>Cobertura Opciones</span>
                  <span className="font-mono-num">OPRA / BYMA</span>
                </div>
                <div className="space-y-1 text-[11.5px] font-mono-num">
                  <div className="flex justify-between">
                    <span className="text-[#9CA3AF] font-sans">Cadenas EE.UU. (OPRA):</span>
                    <span className="text-[#F3F4F6] font-bold">{cedearRadarSummary.opraCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#9CA3AF] font-sans">Lotes BYMA (ADRs):</span>
                    <span className="text-[#F3F4F6] font-bold">{cedearRadarSummary.bymaCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#9CA3AF] font-sans">VI 30D Mediana panel:</span>
                    <span className="text-[#F3F4F6] font-bold">
                      {Number.isFinite(cedearRadarSummary.medianIv)
                        ? `${fmtNum(cedearRadarSummary.medianIv, 1)} %`
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Card 4: Mayor Vol. Relativo */}
              <div className="rounded-[10px] bg-[#0B0B11] border border-[#1E1E2B] p-3 space-y-2">
                <div className="flex items-center justify-between text-[10.5px] uppercase tracking-[0.05em] text-[#A78BFA] font-semibold">
                  <span>Flujo &amp; Vol. Relativo 20D</span>
                  <span className="font-mono-num">Top 3</span>
                </div>
                {cedearRadarSummary.highVolRows.length > 0 ? (
                  <div className="space-y-1.5">
                    {cedearRadarSummary.highVolRows.map((v) => (
                      <div
                        key={`vol-${v.key}`}
                        className="flex items-center justify-between text-[11.5px] font-mono-num"
                      >
                        <span className="inline-flex items-center gap-1.5 font-bold text-[#F3F4F6]">
                          <CompanyLogo ticker={v.usTicker || v.ticker} name={v.name} size="xs" />
                          <span>{v.ticker}</span>
                          <span className="text-[10px] font-sans text-[#787B86]">{v.kind}</span>
                        </span>
                        <span
                          className={`font-semibold ${
                            v.volMultiple >= 1.5 ? 'text-[#A78BFA]' : 'text-[#D1D4DC]'
                          }`}
                        >
                          {fmtNum(v.volMultiple, 1)}×
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-[#787B86]">Sin histórico de volumen relativo</div>
                )}
              </div>
            </div>
          </div>

          {/* Barra de Filtros y Buscador */}
          <div className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] overflow-hidden">
            <div className="px-4 py-3 border-b border-[#1E1E2B] flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5 bg-[#0B0B11] p-1 rounded-[8px] border border-[#1E1E2B]">
                {(
                  [
                    { id: 'all', label: `Todos (${combinedCedearsAndAdrs.length})` },
                    {
                      id: 'mispriced',
                      label: `Desfasajes ≥ 1,2% (${cedearRadarSummary.mispricedCount})`,
                    },
                    { id: 'adrs', label: `ADRs Locales (${cedearRadarSummary.adrCount})` },
                    { id: 'byma_opts', label: `Con Opciones BYMA (${cedearRadarSummary.bymaCount})` },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setCedearFilterMode(tab.id)}
                    className={`px-2.5 py-1 rounded-[6px] text-[11px] font-semibold cursor-pointer transition-colors ${
                      cedearFilterMode === tab.id
                        ? 'bg-[#1F2637] text-[#F3F4F6]'
                        : 'text-[#787B86] hover:text-[#D1D4DC]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={cedearSearch}
                onChange={(e) => setCedearSearch(e.target.value)}
                placeholder="Buscar ticker, subyacente o ADR..."
                className="w-60 px-3 py-1.5 rounded-[8px] bg-[#0B0B11] border border-[#1E1E2B] text-[12px] text-[#F3F4F6] placeholder:text-[#787B86] outline-none focus:border-[#3B82F6]"
              />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-right">
                <thead>
                  <tr className="bg-[#0B0E14] border-b border-[#1E1E2B] text-[10px] font-semibold uppercase tracking-[0.06em] text-[#787B86]">
                    <th className="py-2.5 px-3.5 text-left">Ticker / Subyacente</th>
                    <th className="py-2.5 px-2 text-left">Tipo / Sector</th>
                    <th className="py-2.5 px-2.5">NYSE (USD)</th>
                    <th className="py-2.5 px-2.5">Var. USD</th>
                    <th className="py-2.5 px-2.5">Ratio</th>
                    <th className="py-2.5 px-2.5">Local BYMA (ARS)</th>
                    <th className="py-2.5 px-2.5">CCL Implícito &amp; Desfase ARS</th>
                    <th className="py-2.5 px-2.5">VI 30d</th>
                    <th className="py-2.5 px-2.5">Vol. Relativo</th>
                    <th className="py-2.5 px-3.5 text-left">Señal Arbitraje / Opciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#181824] font-mono-num">
                  {filteredCedearsAndAdrs.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="py-8 text-center font-sans text-[12px] text-[#787B86]">
                        Sin instrumentos para el filtro seleccionado.
                      </td>
                    </tr>
                  ) : (
                    filteredCedearsAndAdrs.map((r) => {
                      const hasMismatch = Number.isFinite(r.cclMismatchPct);
                      const isDiscount = hasMismatch && r.cclMismatchPct <= -1.2;
                      const isPremium = hasMismatch && r.cclMismatchPct >= 1.2;
                      const mismatchBadgeCls = isDiscount
                        ? 'text-[#2EDC7E] bg-[#2EDC7E]/12 border-[#2EDC7E]/30'
                        : isPremium
                        ? 'text-[#F5B544] bg-[#F5B544]/12 border-[#F5B544]/30'
                        : 'text-[#9CA3AF] bg-[#1A1A26] border-[#262636]';

                      return (
                        <tr
                          key={r.key}
                          onClick={() =>
                            onOpenOrderTicket({
                              ticker: r.ticker,
                              side: 'Compra',
                              price: Number.isFinite(r.localArs) ? r.localArs : 0,
                              qty: 10,
                              instrumentLabel:
                                r.kind === 'ADR'
                                  ? `${r.ticker} BYMA (ADR ${r.usTicker} · ${r.ratioStr})`
                                  : `CEDEAR ${r.name} (Ratio ${r.ratioStr})`,
                            })
                          }
                          className={`${rowH} hover:bg-[#181C27] transition-colors cursor-pointer`}
                        >
                          <td className="px-3.5 text-left">
                            <div className="flex items-center gap-2.5">
                              <CompanyLogo
                                ticker={r.usTicker || r.ticker}
                                name={r.name}
                                size={rowH.startsWith('h-8') ? 'xs' : 'sm'}
                              />
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-bold text-[#F3F4F6] leading-tight">
                                    {r.ticker}
                                  </span>
                                  {r.usTicker && r.usTicker !== r.ticker && (
                                    <span className="text-[10px] text-[#787B86] font-mono-num">
                                      ({r.usTicker})
                                    </span>
                                  )}
                                  {r.kind === 'ADR' && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onSelectStock(r.ticker);
                                      }}
                                      className="text-[9.5px] px-1.5 py-0.2 rounded bg-[#1F2637] text-[#60A5FA] hover:bg-[#2A334A] font-sans font-semibold cursor-pointer"
                                    >
                                      Ficha
                                    </button>
                                  )}
                                </div>
                                <div className="text-[11px] font-sans text-[#787B86] truncate max-w-[165px]">
                                  {r.name}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-2 text-left font-sans">
                            <div className="flex flex-col gap-0.5">
                              <span
                                className={`inline-flex w-fit px-1.5 py-0.2 rounded text-[9.5px] font-semibold ${
                                  r.kind === 'ADR'
                                    ? 'bg-[#2EDC7E]/15 text-[#2EDC7E]'
                                    : 'bg-[#38BDF8]/12 text-[#38BDF8]'
                                }`}
                              >
                                {r.kind === 'ADR' ? 'ADR BYMA' : 'CEDEAR'}
                              </span>
                              <span className="text-[10.5px] text-[#787B86] truncate max-w-[120px]">
                                {r.sector}
                              </span>
                            </div>
                          </td>
                          <td className="px-2.5 font-bold text-[#F3F4F6]">
                            <TickFlash value={Number.isFinite(r.usLast) ? r.usLast : null}>
                              {Number.isFinite(r.usLast) ? `US$ ${fmtNum(r.usLast, 2)}` : '—'}
                            </TickFlash>
                          </td>
                          <td className="px-2.5">
                            <DeltaPill value={r.usDeltaPct} size="sm" />
                          </td>
                          <td className="px-2.5 text-[#9CA3AF] text-[11px]">{r.ratioStr}</td>
                          <td className="px-2.5">
                            <TickFlash value={Number.isFinite(r.localArs) ? r.localArs : null}>
                              <span className="block font-bold text-[#38BDF8]">
                                {Number.isFinite(r.localArs) ? `$ ${fmtNum(r.localArs, 0)}` : '—'}
                              </span>
                            </TickFlash>
                            {Number.isFinite(r.fairArsPrice) && (
                              <div className="text-[10px] text-[#787B86]">
                                Par: $ {fmtNum(r.fairArsPrice, 0)}
                              </div>
                            )}
                          </td>
                          <td className="px-2.5">
                            <div className="font-semibold text-[#D1D4DC]">
                              {Number.isFinite(r.cclImplicit)
                                ? `$ ${fmtNum(r.cclImplicit, 2)}`
                                : '—'}
                            </div>
                            {hasMismatch ? (
                              <div className="mt-0.5 inline-flex items-center gap-1">
                                <span
                                  className={`px-1.5 py-0.2 rounded border text-[9.5px] font-semibold ${mismatchBadgeCls}`}
                                >
                                  {isDiscount ? 'DESC ' : isPremium ? 'PRIMA ' : ''}
                                  {r.cclMismatchPct >= 0 ? '+' : ''}
                                  {fmtNum(r.cclMismatchPct, 2)}%
                                  {Number.isFinite(r.cclMismatchArs)
                                    ? ` (${r.cclMismatchArs >= 0 ? '+' : '-'}$ ${fmtNum(
                                        Math.abs(r.cclMismatchArs),
                                        0,
                                      )})`
                                    : ''}
                                </span>
                              </div>
                            ) : (
                              <div className="text-[10px] text-[#787B86]">—</div>
                            )}
                          </td>
                          <td className="px-2.5">
                            {Number.isFinite(r.iv30d) ? (
                              <div className="inline-flex items-center gap-1">
                                <span className="text-[#E5E7EB] font-semibold">
                                  {fmtNum(r.iv30d, 1)} %
                                </span>
                                {r.ivSource !== 'NONE' && (
                                  <span className="text-[9px] px-1 py-0.2 rounded bg-[#181C27] text-[#9CA3AF] border border-[#232733]">
                                    {r.ivSource === 'OPRA_IV' ? 'IV' : 'RV30'}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-[#787B86]">—</span>
                            )}
                          </td>
                          <td className="px-2.5">
                            {Number.isFinite(r.volMultiple) ? (
                              <span
                                className={`text-[11.5px] font-semibold ${
                                  r.volMultiple >= 1.5
                                    ? 'text-[#A78BFA]'
                                    : r.volMultiple >= 1.2
                                    ? 'text-[#2EDC7E]'
                                    : 'text-[#9CA3AF]'
                                }`}
                              >
                                {fmtNum(r.volMultiple, 1)}×
                              </span>
                            ) : (
                              <span className="text-[#787B86]">—</span>
                            )}
                          </td>
                          <td className="px-3.5 text-left font-sans text-[11.5px]">
                            <div className="flex flex-wrap items-center gap-1">
                              {r.hasUsOptions && (
                                <span className="px-1.5 py-0.2 rounded bg-[#3B82F6]/15 text-[#60A5FA] text-[9.5px] font-semibold font-mono-num">
                                  OPRA
                                </span>
                              )}
                              {r.hasBymaOptions && (
                                <span className="px-1.5 py-0.2 rounded bg-[#2EDC7E]/15 text-[#2EDC7E] text-[9.5px] font-semibold font-mono-num">
                                  BYMA OPC
                                </span>
                              )}
                              <span
                                className={
                                  isDiscount
                                    ? 'text-[#2EDC7E] font-semibold'
                                    : isPremium
                                    ? 'text-[#F5B544] font-semibold'
                                    : 'text-[#9CA3AF]'
                                }
                              >
                                {r.arbitrageSignal || '—'}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TABLA 4: CAUCIONES POR PLAZO */}
      {subPanel === 'cauciones' && (
        <div className="qc-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-right font-mono-num">
              <thead>
                <tr className="bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                  <th className="py-2.5 px-3 text-left">Plazo (Días)</th>
                  <th className="py-2.5 px-2.5">Moneda</th>
                  <th className="py-2.5 px-2.5">TNA Promedio</th>
                  <th className="py-2.5 px-2.5">TEA Efectiva</th>
                  <th className="py-2.5 px-2.5 text-[#2EDC7E]">Tomadora (Bid)</th>
                  <th className="py-2.5 px-2.5 text-[#FF5C63]">Colocadora (Ask)</th>
                  <th className="py-2.5 px-2.5">vs BADLAR</th>
                  <th className="py-2.5 px-3">Volumen ARS</th>
                  <th className="py-2.5 px-3 text-left">Origen / Instrumento Ref.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {liveCauciones.length > 0 ? (
                  liveCauciones.map((c, idx) => {
                    const volSharePct =
                      totalCaucionVol > 0 && c.volumeArs !== null && Number.isFinite(c.volumeArs)
                        ? (c.volumeArs / totalCaucionVol) * 100
                        : null;
                    return (
                      <tr key={`${c.currency}-${String(c.termDays)}-${String(idx)}`} className={`${rowH} hover:bg-[var(--surface-2)]`}>
                        <td className="px-3 text-left font-bold text-[var(--text-primary)]">{c.label}</td>
                        <td className="px-2.5 text-[var(--text-secondary)]">{c.currency}</td>
                        <td className="px-2.5 font-bold text-[#8B7CF6]">
                          <TickFlash value={c.tnaWeighted}>
                            {c.tnaWeighted !== null ? `${fmtNum(c.tnaWeighted, 2)} %` : '—'}
                          </TickFlash>
                        </td>
                        <td className="px-2.5 text-[var(--text-primary)]">
                          {c.teaEffective !== null ? `${fmtNum(c.teaEffective, 2)} %` : '—'}
                        </td>
                        <td className="px-2.5 text-[#2EDC7E]">
                          {c.bidTna !== null ? `${fmtNum(c.bidTna, 2)} %` : '—'}
                        </td>
                        <td className="px-2.5 text-[#FF5C63]">
                          {c.askTna !== null ? `${fmtNum(c.askTna, 2)} %` : '—'}
                        </td>
                        <td className="px-2.5 text-[var(--text-secondary)]">
                          {c.spreadVsBadlarBps !== null ? `${fmtNum(c.spreadVsBadlarBps, 0)} pb` : '—'}
                        </td>
                        <td className="px-3 font-semibold text-[var(--text-primary)]">
                          {c.volumeArs !== null ? (
                            <span>
                              {fmtMoneyCompact(c.volumeArs / 1e6)}
                              {volSharePct !== null ? ` (${fmtNum(volSharePct, 1)}%)` : ''}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-3 text-left font-sans text-[11px]">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[9.5px] font-bold tracking-wider ${
                                c.source === 'BMB_HOMEBROKER'
                                  ? 'bg-[#0D221E] text-[#2EDC7E] border border-[#164E3F]'
                                  : c.source === 'IOL_REST'
                                    ? 'bg-[#0B1F33] text-[#38BDF8] border border-[#38BDF8]/35'
                                    : 'bg-[#35280F] text-[#F5B544] border border-[#F5B544]/40'
                              }`}
                            >
                              {c.source === 'BMB_HOMEBROKER' ? 'BMB VIVO' : c.source === 'IOL_REST' ? 'IOL VIVO' : 'REF. BCRA/LECAP'}
                            </span>
                            <span className="text-[var(--text-secondary)] truncate max-w-[200px]" title={c.originLabel}>
                              {c.referenceInstrument}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={9} className="py-8 text-center font-sans text-[12px] text-[var(--text-tertiary)]">
                      Sin datos de cauciones ni tasas BCRA disponibles en este momento.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

/* MÓDULO MACRO ARGENTINA Y MUNDO */
export const MacroModule: React.FC = () => {
  const liveMarket = useLiveMarketState();
  const [selectedTheme, setSelectedTheme] = useState<string>('Todos');
  const themes = [
    'Todos',
    'Dólar y Brecha',
    'Actividad e Inflación',
    'Cuentas Públicas y Monetarias',
    'Sector Externo y Afuera',
  ];

  const cards =
    selectedTheme === 'Todos'
      ? MACRO_CARDS
      : MACRO_CARDS.filter((c) => c.theme === selectedTheme);

  const vars = liveMarket.macro?.variables;
  const brechaPct =
    vars?.ccl !== null && vars?.ccl !== undefined && vars?.a3500 !== null && vars?.a3500 !== undefined && vars.a3500 > 0
      ? (vars.ccl / vars.a3500 - 1) * 100
      : Number.NaN;

  return (
    <div className="space-y-4 animate-module">
      <div className="qc-card p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Landmark className="w-4 h-4 text-[var(--accent-primary)]" />
            <h2 className="text-[16px] font-bold text-[var(--text-primary)]">
              Monitor Macroeconómico Argentina y Condiciones Internacionales
            </h2>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {themes.map((th) => (
              <button
                key={th}
                type="button"
                onClick={() => setSelectedTheme(th)}
                className={`px-2.5 py-1 rounded-[8px] text-[12px] font-semibold cursor-pointer ${
                  selectedTheme === th
                    ? 'bg-[var(--accent-primary)] text-white'
                    : 'bg-[var(--surface-2)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {th}
              </button>
            ))}
          </div>
        </div>

        <InsightBanner variant="pos" tag="Lectura Macro">
          Brecha CCL/A3500:{' '}
          <strong className="text-[#2EDC7E] font-mono-num">{fmtPct(brechaPct, 2, false)}</strong> · Inflación mensual:{' '}
          <strong className="text-[var(--text-primary)] font-mono-num">
            {fmtPct(vars?.inflacionMensualPct, 2, false)}
          </strong>{' '}
          · BADLAR:{' '}
          <strong className="text-[var(--text-primary)] font-mono-num">{fmtPct(vars?.badlarTna, 2, false)}</strong> ·
          Plazo Fijo:{' '}
          <strong className="text-[var(--text-primary)] font-mono-num">{fmtPct(vars?.plazoFijoTna, 2, false)}</strong> ·
          Reservas BCRA:{' '}
          <strong className="text-[#2EDC7E] font-mono-num">
            {vars?.reservasUsdM != null ? `US$ ${fmtNum(vars.reservasUsdM, 0)} M` : '—'}
          </strong>{' '}
          ({liveMarket.feedStatus}).
        </InsightBanner>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {cards.map((c) => (
          <div key={c.id} className="qc-card qc-card-interactive p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-primary)]">
                  {c.theme}
                </span>
                <HelpTooltip title={c.title} text={c.context} formula={c.formulaHelp} />
              </div>
              <h3 className="text-[13px] font-bold text-[var(--text-primary)] leading-snug">{c.title}</h3>
            </div>

            <div className="flex items-end justify-between gap-2">
              <div>
                <div className="font-mono-num text-[24px] font-bold text-[var(--text-primary)] leading-none">
                  {c.value}
                </div>
                <div
                  className={`mt-1.5 font-mono-num text-[12px] font-semibold ${
                    c.deltaPositive ? 'text-[#22C55E]' : 'text-[#787B86]'
                  }`}
                >
                  {c.deltaPositive ? '↗ ' : ''}
                  {c.deltaLabel}
                </div>
              </div>
              <MiniSparkline data={c.sparkline} positive={true} width={84} height={32} />
            </div>

            <div className="pt-2 border-t border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
              {c.context}
            </div>
          </div>
        ))}
      </div>

      {/* Cotizaciones de Referencia USD (DolarApi / ArgentinaDatos) */}
      <div className="qc-card p-4 space-y-3">
        <h3 className="text-[14px] font-bold text-[var(--text-primary)]">
          Referencias de Dólar y Liquidez Cambiaria ({liveMarket.macro?.dolares.length ?? 0} plazas)
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
          {(liveMarket.macro?.dolares ?? []).slice(0, 6).map((d) => (
            <div
              key={d.casa}
              className="p-3 rounded-[10px] bg-[var(--surface-2)] border border-[var(--border-subtle)] space-y-1"
            >
              <div className="flex items-center justify-between text-[11px] font-mono-num">
                <span className="text-[#5B8CFF] font-semibold">{d.nombre}</span>
                <span className="px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-secondary)]">
                  {d.casa.toUpperCase()}
                </span>
              </div>
              <div className="font-bold font-mono-num text-[var(--text-primary)]">
                Compra: $ {fmtNum(d.compra, 2)} · Venta: $ {fmtNum(d.venta, 2)}
              </div>
              <div className="text-[11px] text-[var(--text-secondary)]">
                {d.fechaActualizacion ? `Actualizado: ${d.fechaActualizacion.slice(0, 16).replace('T', ' ')}` : 'Fuente oficial / pública'}
              </div>
            </div>
          ))}
          {(liveMarket.macro?.dolares.length ?? 0) === 0 && (
            <div className="col-span-3 text-[12px] text-[var(--text-tertiary)]">
              Sin cotizaciones cambiarias cargadas todavía ({liveMarket.feedStatus}).
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* MÓDULO MERCADO EE.UU. */

/* Pieza 32: estado de proveedores US expuesto por /api/us/providers-status
   (sin material secreto: configured/connected/keySlot/activeRole). */
type UsProviderNodeDto = {
  readonly configured?: boolean;
  readonly connected?: boolean | null;
  readonly state?: string;
  readonly keySlot?: {
    readonly envName?: string;
    readonly slotIndex?: number;
    readonly poolSize?: number;
  } | null;
  readonly activeRole?: string;
  readonly lastError?: string | null;
  readonly poolSize?: number;
  readonly lastSlotIndex?: number | null;
  readonly roundRobinRequests?: number;
  readonly slots?: readonly { readonly envName?: string; readonly slotIndex?: number }[];
};
type UsProvidersStatusDto = {
  readonly status?: string;
  readonly asOfUtcSec?: number;
  readonly usOptionsFeedBadge?: 'TRADIER LIVE + ORATS' | 'MASSIVE + ORATS';
  readonly providers?: {
    readonly MASSIVE_WS?: UsProviderNodeDto;
    readonly MASSIVE_REST_POOL?: UsProviderNodeDto;
    readonly TRADIER_LIVE?: UsProviderNodeDto;
    readonly ORATS?: UsProviderNodeDto;
  };
};

const useUsProvidersStatus = (pollMs = 30_000): UsProvidersStatusDto | null => {
  const [status, setStatus] = useState<UsProvidersStatusDto | null>(null);
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
          if (active) setStatus(null);
          return;
        }
        const json = (await res.json()) as UsProvidersStatusDto;
        if (active) setStatus(json);
      } catch {
        // Endpoint ausente o caído: la UI muestra '—' explícito, nunca un proveedor falso.
        if (active) setStatus(null);
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
  return status;
};

const usProviderDotClass = (connected: boolean | null | undefined, configured: boolean | null | undefined): string =>
  connected === true ? 'bg-[#22C55E]' : configured === true ? 'bg-[#F5B544]' : 'bg-[#4A4E5A]';

export const USMarketModule: React.FC<{
  onOpenOrderTicket: (preset: {
    ticker: string;
    side: 'Compra' | 'Venta';
    price: number;
    qty: number;
    instrumentLabel: string;
  }) => void;
}> = ({ onOpenOrderTicket }) => {
  const liveMarket = useLiveMarketState();
  const liveStream = useMarketLiveStream();
  const [directUsPanelAnalytics, setDirectUsPanelAnalytics] = useState<EquityPanelAnalyticsDto | null>(null);
  const [focusedUsSymbol, setFocusedUsSymbol] = useState<string | null>(null);
  useMarketFocusSymbol(focusedUsSymbol);
  // Pieza 32: estado real de proveedores US (Massive WS/REST pool, Tradier Live, ORATS).
  const usProviders = useUsProvidersStatus();
  const prov = usProviders?.providers;
  const massiveWs = prov?.MASSIVE_WS;
  const restPool = prov?.MASSIVE_REST_POOL;
  const tradierLive = prov?.TRADIER_LIVE;
  const oratsProv = prov?.ORATS;
  const usFeedBadge = usProviders?.usOptionsFeedBadge ?? null;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const fetchPanelAnalytics = async () => {
      try {
        const res = await fetch('/api/us/panel-analytics', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!res.ok) return;
        const json = (await res.json()) as EquityPanelAnalyticsDto;
        if (active && json && Array.isArray(json.rows)) {
          setDirectUsPanelAnalytics(json);
        }
      } catch {
        // Keep previously loaded panel analytics; missing values stay NaN / '—'.
      }
    };
    void fetchPanelAnalytics();
    void Promise.all([
      requestUsSnapshot('SPY'),
      requestUsSnapshot('QQQ'),
      requestUsSnapshot('IWM'),
      requestMonitoringPanel('cedears'),
    ]);
    const timerId = window.setInterval(() => {
      void fetchPanelAnalytics();
    }, 60_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timerId);
    };
  }, []);

  const usSectors: readonly string[] = [
    'Todos',
    'Mega Caps / Tech',
    'Semiconductores',
    'Finanzas',
    'Consumo',
    'Energía',
    'Salud',
    'Industrial',
    'Índices / ETF',
  ];

  const usPanelAnalytics =
    directUsPanelAnalytics ??
    liveMarket.usSnapshotsBySymbol['SPY']?.usEquityPanel ??
    liveMarket.monitoring?.usEquityPanel ??
    US_PANEL_ANALYTICS;

  const spyUnifiedQuotes = liveMarket.usSnapshotsBySymbol['SPY']?.marketContext?.unifiedQuotes;
  const staticMetaMap = new Map(US_MARKET_DATA.map((u) => [u.ticker, u]));

  const usPanelRows: NormalizedPanelRow[] = useMemo(() => {
    const analyticsRows = usPanelAnalytics?.rows ?? [];
    const unifiedQuoteMap = new Map<string, UsUnifiedQuoteDto>(
      (spyUnifiedQuotes ?? []).map((q) => [q.ticker, q]),
    );
    const finiteOrNull = (v: number | null | undefined): number | null =>
      v !== undefined && v !== null && Number.isFinite(v) ? v : null;

    const baseRows = analyticsRows.length > 0
      ? analyticsRows.map((r) => ({
          symbol: r.symbol,
          name: r.name,
          sector: r.sector,
          panel: r.panel,
          color: r.color,
          last: r.last ?? Number.NaN,
          prevClose: r.prevClose ?? Number.NaN,
          low: r.dayLow ?? Number.NaN,
          high: r.dayHigh ?? Number.NaN,
          volumeM: r.volumeM ?? Number.NaN,
          deltaPct: r.return1dPct ?? Number.NaN,
          return30dPct: r.return30dPct ?? Number.NaN,
          returnYtdOr252dPct: r.returnYtdOr252dPct ?? Number.NaN,
          realizedVol30dPct: r.realizedVol30dPct ?? Number.NaN,
          beta: r.beta ?? Number.NaN,
          avgVolume40dM: r.avgVolume40dM ?? Number.NaN,
        }))
      : US_MARKET_DATA.map((u) => ({
          symbol: u.ticker,
          name: u.name,
          sector: u.sector,
          panel: u.panel,
          color: u.color,
          last: u.price,
          prevClose: u.prevClose,
          low: u.low,
          high: u.high,
          volumeM: u.volumeM,
          deltaPct: u.deltaPct,
          return30dPct: u.return30dPct,
          returnYtdOr252dPct: u.returnYtdOr252dPct,
          realizedVol30dPct: u.realizedVol30dPct,
          beta: u.beta,
          avgVolume40dM: u.avgVolume40dM,
        }));

    return baseRows.map((base) => {
      const extra = analyticsRows.find((r) => r.symbol === base.symbol) ?? null;
      const uq = unifiedQuoteMap.get(base.symbol);
      const live = getMarketLiveQuote(liveStream, 'US', base.symbol);
      const uqVolM =
        finiteOrNull(uq?.tradedVolumeUsd) !== null
          ? (uq!.tradedVolumeUsd as number) / 1_000_000
          : finiteOrNull(uq?.volumeM);
      const extraVolM =
        finiteOrNull(extra?.tradedVolumeUsd) !== null
          ? (extra!.tradedVolumeUsd as number) / 1_000_000
          : finiteOrNull(extra?.volumeM);
      const dayLow = live?.dayLow ?? finiteOrNull(uq?.dayLow) ?? finiteOrNull(extra?.dayLow) ?? base.low;
      const dayHigh = live?.dayHigh ?? finiteOrNull(uq?.dayHigh) ?? finiteOrNull(extra?.dayHigh) ?? base.high;
      const currentLast = live?.price ?? finiteOrNull(uq?.price) ?? finiteOrNull(extra?.last) ?? base.last;

      return {
        symbol: base.symbol,
        name: base.name,
        sector: base.sector,
        panel: base.panel,
        color: base.color,
        last: currentLast,
        prevClose: live?.previousClose ?? finiteOrNull(uq?.previousClose) ?? finiteOrNull(extra?.prevClose) ?? base.prevClose,
        dayLow,
        dayHigh,
        dayRangePos:
          live !== null && Number.isFinite(dayLow) && Number.isFinite(dayHigh) && dayHigh > dayLow
            ? Math.max(0, Math.min(1, (live.price - dayLow) / (dayHigh - dayLow)))
            : finiteOrNull(uq?.dayRangePos) ?? finiteOrNull(extra?.dayRangePos) ?? Number.NaN,
        volumeM: live?.turnover !== null && live?.turnover !== undefined ? live.turnover / 1_000_000 : uqVolM ?? extraVolM ?? base.volumeM,
        return1dPct: live?.changePct ?? finiteOrNull(uq?.changePct) ?? finiteOrNull(extra?.return1dPct) ?? base.deltaPct,
        return30dPct:
          extra?.return30dPct !== undefined && extra.return30dPct !== null
            ? extra.return30dPct
            : base.return30dPct,
        returnYtdOr252dPct:
          extra?.returnYtdOr252dPct !== undefined && extra.returnYtdOr252dPct !== null
            ? extra.returnYtdOr252dPct
            : base.returnYtdOr252dPct,
        realizedVol30dPct:
          extra?.realizedVol30dPct !== undefined && extra.realizedVol30dPct !== null
            ? extra.realizedVol30dPct
            : base.realizedVol30dPct,
        beta: extra?.beta !== undefined && extra.beta !== null ? extra.beta : base.beta,
        avgVolume40dM:
          extra?.avgVolume40dM !== undefined && extra.avgVolume40dM !== null
            ? extra.avgVolume40dM
            : base.avgVolume40dM,
        sessionPhase: live?.sessionPhase ?? extra?.sessionPhase ?? null,
        extendedPrice: live?.extendedPrice ?? extra?.extendedPrice ?? null,
        extendedChangePct: live?.extendedChangePct ?? extra?.extendedChangePct ?? null,
      };
    });
  }, [usPanelAnalytics, spyUnifiedQuotes, liveMarket.version, liveStream]);

  const handleSelectUsRow = (symbol: string) => {
    const row = usPanelRows.find((r) => r.symbol === symbol);
    if (!row) return;
    setFocusedUsSymbol(symbol);
    const staticItem = staticMetaMap.get(symbol);
    const live = getMarketLiveQuote(liveStream, 'US', symbol);
    const staticArsPrice = staticItem?.cedearArsPrice ?? Number.NaN;
    const price = Number.isFinite(staticArsPrice) ? staticArsPrice : live?.price ?? row.last;
    onOpenOrderTicket({
      ticker: row.symbol,
      side: 'Compra',
      price: Number.isFinite(price) ? price : 0,
      qty: 10,
      instrumentLabel:
        staticItem !== undefined && Number.isFinite(staticItem.cedearRatioNum)
          ? `CEDEAR ${staticItem.name} (Ratio ${staticItem.cedearRatio})`
          : `${row.name} (NYSE / NASDAQ)`,
    });
  };

  const withLiveUsQuote = (item: (typeof US_MARKET_DATA)[number] | undefined) => {
    if (item === undefined) return undefined;
    const live = getMarketLiveQuote(liveStream, 'US', item.ticker);
    if (live === null) {
      return {
        ...item,
        sessionPhase: null as LiveUsSessionPhase | null,
        extendedPrice: null as number | null,
        extendedChangePct: null as number | null,
      };
    }
    const extBadge = formatExtendedSessionBadge(live.sessionPhase);
    return {
      ...item,
      price:
        extBadge !== null && live.extendedPrice !== undefined && live.extendedPrice !== null
          ? live.extendedPrice
          : live.price,
      prevClose: live.previousClose ?? item.prevClose,
      deltaPct:
        extBadge !== null && live.extendedChangePct !== undefined && live.extendedChangePct !== null
          ? live.extendedChangePct
          : live.changePct ?? item.deltaPct,
      low: live.dayLow ?? item.low,
      high: live.dayHigh ?? item.high,
      volumeM: live.turnover !== null ? live.turnover / 1_000_000 : item.volumeM,
      sessionPhase: live.sessionPhase ?? null,
      extendedPrice: live.extendedPrice ?? null,
      extendedChangePct: live.extendedChangePct ?? null,
    };
  };
  const spy = withLiveUsQuote(US_MARKET_DATA.find((u) => u.ticker === 'SPY'));
  const qqq = withLiveUsQuote(US_MARKET_DATA.find((u) => u.ticker === 'QQQ'));
  const iwm = withLiveUsQuote(US_MARKET_DATA.find((u) => u.ticker === 'IWM'));
  const spyExtBadge = formatExtendedSessionBadge(spy?.sessionPhase);
  const spyCtx = liveMarket.usSnapshotsBySymbol['SPY']?.marketContext;
  const ust10y = spyCtx?.treasury?.yield10Y ?? null;
  const ust2y = spyCtx?.treasury?.yield2Y ?? null;
  const slope2s10s =
    ust10y !== null && ust2y !== null && Number.isFinite(ust10y) && Number.isFinite(ust2y)
      ? Math.round((ust10y - ust2y) * 100)
      : null;
  const liveVix = getMarketLiveQuote(liveStream, 'US', 'I:VIX');
  const vixVal = liveVix?.price ?? spyCtx?.vixLevel ?? GLOBAL_INDICATORS.find((g) => g.id === 'vix')?.value ?? Number.NaN;
  const vixDelta = liveVix?.changePct ?? GLOBAL_INDICATORS.find((g) => g.id === 'vix')?.deltaPct;

  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant="default" tag="Wall Street en Vivo">
        <RealTimeBadge clock={getMarketLiveClock(liveStream)} />{' '}
        {spyExtBadge !== null && (
          <span className="inline-flex items-center rounded-full border border-[#F5B544]/35 bg-[#F5B544]/10 px-1.5 py-0.5 font-mono-num text-[9.5px] font-bold text-[#F5B544] mr-1">
            {spyExtBadge}
          </span>
        )}
        SPY:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">
          {spy && Number.isFinite(spy.price) ? `US$ ${fmtNum(spy.price, 2)}` : '—'}
        </strong>{' '}
        ({fmtPct(spy?.deltaPct, 2)}) · QQQ:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">{fmtPct(qqq?.deltaPct, 2)}</strong> · VIX:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">{fmtNum(vixVal, 2)}</strong> · UST 10Y:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">{fmtPct(ust10y, 2, false)}</strong>.
      </InsightBanner>

      {/* Pieza 32: estado de proveedores US en vivo + badge de origen de opciones US */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[10px] bg-[#131722] border border-[#232733] px-3 py-2 text-[10.5px] font-mono-num text-[#9CA3AF]">
        <span className="font-semibold text-[#D1D4DC] tracking-wider">PROVEEDORES US</span>
        <span className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${usProviderDotClass(massiveWs?.connected, massiveWs?.configured)}`} />
          MASSIVE_WS{' '}
          <strong className="text-[#D1D4DC]">
            {massiveWs?.connected === true
              ? 'ON'
              : massiveWs?.configured === true
                ? (massiveWs.state ?? '—')
                : '—'}
          </strong>
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${usProviderDotClass(restPool?.configured, restPool?.configured)}`} />
          MASSIVE_REST_POOL{' '}
          <strong className="text-[#D1D4DC]">
            {restPool?.configured === true
              ? `x${String(restPool.poolSize ?? 0)} · slot ${String(restPool.lastSlotIndex ?? '—')}`
              : '—'}
          </strong>
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${usProviderDotClass(tradierLive?.connected, tradierLive?.configured)}`} />
          TRADIER_LIVE{' '}
          <strong className="text-[#D1D4DC]">
            {tradierLive?.connected === true
              ? 'ON'
              : tradierLive?.configured === true
                ? (tradierLive.state ?? '—')
                : 'OFF'}
          </strong>
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${usProviderDotClass(oratsProv?.connected, oratsProv?.configured)}`} />
          ORATS{' '}
          <strong className="text-[#D1D4DC]">
            {oratsProv?.connected === true ? 'ON' : oratsProv?.configured === true ? 'CFG' : '—'}
          </strong>
        </span>
        <span
          className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
            usFeedBadge === 'TRADIER LIVE + ORATS'
              ? 'border-[#22C55E]/40 bg-[#22C55E]/10 text-[#22C55E]'
              : usFeedBadge === 'MASSIVE + ORATS'
                ? 'border-[#38BDF8]/40 bg-[#38BDF8]/10 text-[#38BDF8]'
                : 'border-[#232733] bg-[#0B0E14] text-[#787B86]'
          }`}
          title="Origen del feed de opciones US: puntas/griegas (Tradier Live o Massive) + superficie ORATS (smvVol, IV Rank, impliedMove)"
        >
          {usFeedBadge ?? 'ORIGEN OPCIONES US —'}
        </span>
      </div>

      {/* Estructura superior de 5 índices macro alargados */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <UsIndexLogoKpiCard
          logoTicker="SPY"
          title="S&P 500 (SPY)"
          heroValue={spy && Number.isFinite(spy.price) ? `US$ ${fmtNum(spy.price, 2)}` : '—'}
          flashValue={spy?.price}
          deltaPct={spy?.deltaPct}
          sessionPhase={spy?.sessionPhase ?? null}
          subtitle={`CEDEAR SPY: $ ${fmtNum(spy?.cedearArsPrice, 0)} · Ratio 20:1`}
        />
        <UsIndexLogoKpiCard
          logoTicker="QQQ"
          title="Nasdaq 100 (QQQ)"
          heroValue={qqq && Number.isFinite(qqq.price) ? `US$ ${fmtNum(qqq.price, 2)}` : '—'}
          flashValue={qqq?.price}
          deltaPct={qqq?.deltaPct}
          sessionPhase={qqq?.sessionPhase ?? null}
          subtitle={`CEDEAR QQQ: $ ${fmtNum(qqq?.cedearArsPrice, 0)} · Ratio 20:1`}
        />
        <UsIndexLogoKpiCard
          logoTicker="IWM"
          title="Russell 2000 (IWM)"
          heroValue={iwm && Number.isFinite(iwm.price) ? `US$ ${fmtNum(iwm.price, 2)}` : '—'}
          flashValue={iwm?.price}
          deltaPct={iwm?.deltaPct}
          sessionPhase={iwm?.sessionPhase ?? null}
          subtitle={`CEDEAR IWM: $ ${fmtNum(iwm?.cedearArsPrice, 0)} · Ratio 10:1`}
        />
        <UsIndexLogoKpiCard
          iconNode={
            <div className="w-[26px] h-[26px] rounded-full bg-[#151520] border border-[#262636] shrink-0 flex items-center justify-center">
              <Landmark className="w-3.5 h-3.5 text-[#38BDF8]" />
            </div>
          }
          title="US Treasury 10Y Yield"
          heroValue={ust10y !== null && Number.isFinite(ust10y) ? `${fmtNum(ust10y, 2)} %` : '—'}
          subtitle={`Spread 2Y/10Y: ${slope2s10s !== null ? `${slope2s10s >= 0 ? '+' : ''}${slope2s10s} pb` : '—'}`}
        />
        <UsIndexLogoKpiCard
          logoTicker="VIX"
          title="CBOE VIX (Volatilidad S&P)"
          heroValue={fmtNum(vixVal, 2)}
          flashValue={vixVal}
          deltaPct={vixDelta}
          subtitle={
            Number.isFinite(vixVal)
              ? vixVal < 15
                ? 'Régimen de baja volatilidad (<15)'
                : vixVal < 22
                ? 'Volatilidad normal (15–22)'
                : 'Estrés de volatilidad (>22)'
              : 'Esperando índice VIX desde Massive'
          }
        />
      </div>

      {/* Curva Treasury EE.UU. + Motores Cuantitativos SPY (Piezas 15–18) */}
      {(() => {
        const spySnap = liveMarket.usSnapshotsBySymbol['SPY'];
        const te = spySnap?.terminalEngines ?? null;
        const tr = spyCtx?.treasury;
        const cone0 = te?.volCone?.cones?.[0];
        const teExt = te as
          | (NonNullable<typeof te> & {
              readonly nearestInstitutionalLevel?: {
                readonly name: string;
                readonly category: string;
                readonly price: number;
                readonly distanceAbs: number;
                readonly distancePct: number;
                readonly distanceAtr: number | null;
                readonly side: 'ABOVE' | 'BELOW' | 'AT_SPOT';
                readonly clusterRadiusAtrUsed: number | null;
              } | null;
            })
          | null;
        const strongCent = te?.confluenceClusters?.strongestClusterCentroid ?? null;
        const strongScore = te?.confluenceClusters?.strongestClusterStrength ?? null;
        const confRadiusAtr =
          (te?.confluenceClusters as ({ readonly clusterRadiusAtr?: number | null } | null | undefined))
            ?.clusterRadiusAtr ?? 0.15;
        const spySpotPx = spy?.price ?? spySnap?.envelope?.snapshot?.metrics?.spot ?? Number.NaN;
        const atrSpy = te?.atr14d ?? Number.NaN;
        const nearestLevel = (() => {
          if (teExt?.nearestInstitutionalLevel) return teExt.nearestInstitutionalLevel;
          if (!Number.isFinite(spySpotPx) || spySpotPx <= 0) return null;
          const candidates: { name: string; category: string; price: number }[] = [];
          if (te?.volumeProfile?.status === 'OK') {
            if (te.volumeProfile.poc != null && Number.isFinite(te.volumeProfile.poc))
              candidates.push({ name: 'POC', category: 'AMT', price: te.volumeProfile.poc });
            if (te.volumeProfile.vah != null && Number.isFinite(te.volumeProfile.vah))
              candidates.push({ name: 'VAH', category: 'AMT', price: te.volumeProfile.vah });
            if (te.volumeProfile.val != null && Number.isFinite(te.volumeProfile.val))
              candidates.push({ name: 'VAL', category: 'AMT', price: te.volumeProfile.val });
          }
          const expS = spySnap?.exposureSummary;
          if (expS?.callWallStrike != null && Number.isFinite(expS.callWallStrike))
            candidates.push({ name: 'Call Wall', category: 'OPTIONS', price: expS.callWallStrike });
          if (expS?.putWallStrike != null && Number.isFinite(expS.putWallStrike))
            candidates.push({ name: 'Put Wall', category: 'OPTIONS', price: expS.putWallStrike });
          if (expS?.gammaFlipSpot != null && Number.isFinite(expS.gammaFlipSpot))
            candidates.push({ name: 'Zero Gamma', category: 'OPTIONS', price: expS.gammaFlipSpot });
          if (te?.gexCharmPin?.gexCharmPinStrike != null && Number.isFinite(te.gexCharmPin.gexCharmPinStrike))
            candidates.push({ name: 'GEX Pin', category: 'OPTIONS', price: te.gexCharmPin.gexCharmPinStrike });
          let best: (typeof candidates)[number] | null = null;
          let bestDist = Number.POSITIVE_INFINITY;
          for (const c of candidates) {
            const d = Math.abs(c.price - spySpotPx);
            if (d < bestDist) {
              bestDist = d;
              best = c;
            }
          }
          if (!best || !Number.isFinite(bestDist)) return null;
          return {
            name: best.name,
            category: best.category,
            price: best.price,
            distanceAbs: bestDist,
            distancePct: ((best.price - spySpotPx) / spySpotPx) * 100,
            distanceAtr: Number.isFinite(atrSpy) && atrSpy > 0 ? bestDist / atrSpy : null,
            side: best.price > spySpotPx ? ('ABOVE' as const) : best.price < spySpotPx ? ('BELOW' as const) : ('AT_SPOT' as const),
            clusterRadiusAtrUsed: null,
          };
        })();
        const pinStrike = te?.gexCharmPin?.gexCharmPinStrike ?? null;
        const netPremUsd = te?.orderFlow?.netDirectionalPremiumUsd ?? null;
        const netDeltaSh = te?.orderFlow?.netDeltaShares ?? null;
        const ivRank = te?.volCone?.ivRank ?? null;
        const rsSpread = te?.relativeStrength?.rsSpread ?? null;
        const rsClass = te?.relativeStrength?.rsClassification ?? 'NO_DATA';
        const anomCount = te?.volOiAnomalies?.anomalies?.length ?? null;
        const ust2Y = tr?.yield2Y ?? null;
        const ust10Y = tr?.yield10Y ?? null;
        const sofr = tr?.sofr ?? null;
        const skew = spyCtx?.skewLevel ?? null;
        return (
          <div className="rounded-[10px] bg-[#131722] border border-[#232733] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[13px] font-bold text-[#FFFFFF]">
                <CompanyLogo ticker="SPY" name="SPDR S&P 500 ETF Trust" size="sm" />
                <span>Curva Tasas EE.UU. &amp; Lectura Cuantitativa SPY (Piezas 15–18)</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono-num text-[#9CA3AF]">
                <span>
                  UST 2Y: <strong className="text-[#FFFFFF]">{ust2Y != null && Number.isFinite(ust2Y) ? `${fmtNum(ust2Y, 2)}%` : '—'}</strong>
                </span>
                <span>
                  UST 10Y: <strong className="text-[#FFFFFF]">{ust10Y != null && Number.isFinite(ust10Y) ? `${fmtNum(ust10Y, 2)}%` : '—'}</strong>
                </span>
                <span>
                  SOFR: <strong className="text-[#38BDF8]">{sofr != null && Number.isFinite(sofr) ? `${fmtNum(sofr, 2)}%` : '—'}</strong>
                </span>
                <span>
                  SKEW: <strong className={spyCtx?.tailRiskAlert ? 'text-[#F5B544]' : 'text-[#FFFFFF]'}>{skew != null && Number.isFinite(skew) ? fmtNum(skew, 1) : '—'}</strong>
                </span>
                <span
                  className="px-2 py-0.5 rounded bg-[#0B0E14] border border-[#232733] text-[#D1D4DC]"
                  title={spySnap?.quoteMode === 'EOD_CLOSE_REF' ? 'Cotizaciones referenciales EOD OPRA (fuera de rueda)' : undefined}
                >
                  {spySnap?.feedMode === 'EOD_CIERRE' || spySnap?.quoteMode === 'EOD_CLOSE_REF'
                    ? 'EOD_CIERRE'
                    : spySnap?.feedMode ?? 'SIN FEED'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-[12px]">
              <div className="p-3 rounded-[8px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
                <div className="text-[10.5px] uppercase tracking-wider text-[#787B86] font-mono-num">
                  CONO 1σ &amp; IV RANK (SPY)
                </div>
                <div className="font-mono-num text-[15px] font-bold text-[#FFFFFF]">
                  {cone0?.sigmaMovePct != null && Number.isFinite(cone0.sigmaMovePct)
                    ? `±${fmtNum(cone0.sigmaMovePct * 100, 2)} %`
                    : '—'}
                </div>
                <div className="text-[11px] font-mono-num text-[#9CA3AF]">
                  IV Rank: {ivRank != null && Number.isFinite(ivRank) ? `${fmtNum(ivRank, 1)}%` : '—'} ·{' '}
                  {cone0?.lower1Sigma != null && cone0?.upper1Sigma != null
                    ? `$${fmtNum(cone0.lower1Sigma, 1)}–$${fmtNum(cone0.upper1Sigma, 1)}`
                    : '—'}
                </div>
              </div>

              <div className="p-3 rounded-[8px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
                <div className="text-[10.5px] uppercase tracking-wider text-[#787B86] font-mono-num">
                  OPRA ORDER FLOW &amp; MAD
                </div>
                <div
                  className={`font-mono-num text-[15px] font-bold ${
                    netPremUsd != null && Number.isFinite(netPremUsd)
                      ? netPremUsd >= 0
                        ? 'text-[#22C55E]'
                        : 'text-[#F23645]'
                      : 'text-[#FFFFFF]'
                  }`}
                >
                  {netPremUsd != null && Number.isFinite(netPremUsd)
                    ? `${netPremUsd >= 0 ? '+' : ''}US$ ${fmtNum(netPremUsd / 1_000_000, 2)} M`
                    : '—'}
                </div>
                <div className="text-[11px] font-mono-num text-[#9CA3AF]">
                  Δ Neto: {netDeltaSh != null && Number.isFinite(netDeltaSh) ? `${fmtNum(netDeltaSh, 0)} acc` : '—'} · Anom: {anomCount ?? '—'}
                </div>
              </div>

              <div className="p-3 rounded-[8px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
                <div className="text-[10.5px] uppercase tracking-wider text-[#787B86] font-mono-num">
                  GEX/CHARM PIN &amp; WHEEL
                </div>
                <div className="font-mono-num text-[15px] font-bold text-[#C084FC]">
                  {pinStrike != null && Number.isFinite(pinStrike) ? `$ ${fmtNum(pinStrike, 2)}` : '—'}
                </div>
                <div className="text-[11px] font-mono-num text-[#9CA3AF] truncate">
                  {te?.wheelTracker?.regime ?? 'SIN WHEEL'} · Dist:{' '}
                  {te?.wheelTracker?.distanceToPinPct != null && Number.isFinite(te.wheelTracker.distanceToPinPct)
                    ? `${fmtNum(te.wheelTracker.distanceToPinPct * 100, 2)}%`
                    : '—'}
                </div>
              </div>

              <div className="p-3 rounded-[8px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
                <div className="text-[10.5px] uppercase tracking-wider text-[#787B86] font-mono-num">
                  {strongCent != null && Number.isFinite(strongCent)
                    ? `CONFLUENCIA < ${fmtNum(confRadiusAtr, 2)} ATR`
                    : nearestLevel !== null
                      ? 'NIVEL INST. CERCANO'
                      : 'CONFLUENCIA < 0.15 ATR'}
                </div>
                <div className="font-mono-num text-[15px] font-bold text-[#38BDF8] truncate">
                  {strongCent != null && Number.isFinite(strongCent)
                    ? `$ ${fmtNum(strongCent, 2)} (${strongScore != null ? fmtNum(strongScore, 0) : '—'})`
                    : nearestLevel !== null
                      ? `${nearestLevel.name} $ ${fmtNum(nearestLevel.price, 2)}`
                      : '—'}
                </div>
                <div className="text-[11px] font-mono-num text-[#9CA3AF] truncate">
                  {strongCent == null && nearestLevel !== null
                    ? `${nearestLevel.distanceAtr != null && Number.isFinite(nearestLevel.distanceAtr) ? `${fmtNum(nearestLevel.distanceAtr, 2)} ATR` : fmtPct(nearestLevel.distancePct, 2)} · RS: ${rsSpread != null && Number.isFinite(rsSpread) ? fmtPct(rsSpread * 100, 2) : '—'}`
                    : `RS (${rsClass}): ${rsSpread != null && Number.isFinite(rsSpread) ? fmtPct(rsSpread * 100, 2) : '—'}`}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Universo ampliado EE.UU. (~73 acciones & ETFs en 6 paneles analíticos) */}
      <EquitySixPanelsGrid
        mode="US"
        rows={usPanelRows}
        analytics={usPanelAnalytics}
        currencyPrefix="US$ "
        benchmarkLabel="SPY"
        sectorOptions={usSectors}
        onSelectRow={handleSelectUsRow}
      />
    </div>
  );
};

/* MÓDULO CURVA DE BONOS SOBERANOS Y LETRAS */
export const BondsCurveModule: React.FC = () => {
  const liveMarket = useLiveMarketState();
  const curveBonds = BONDS_DATA.filter(
    (b) => Number.isFinite(b.tir) && b.tir > 0 && Number.isFinite(b.modDuration) && b.modDuration > 0
  );
  const al30 = curveBonds.find((b) => b.ticker === 'AL30');
  const gd30 = curveBonds.find((b) => b.ticker === 'GD30');
  const gd35 = curveBonds.find((b) => b.ticker === 'GD35');
  const spreadNyArPb =
    al30 && gd30 ? Math.round((al30.tir - gd30.tir) * 100) : Number.NaN;

  const minDur = curveBonds.length > 0 ? Math.min(...curveBonds.map((b) => b.modDuration)) : 1;
  const maxDur = curveBonds.length > 0 ? Math.max(...curveBonds.map((b) => b.modDuration), minDur + 1) : 6;
  const minTir = curveBonds.length > 0 ? Math.floor(Math.min(...curveBonds.map((b) => b.tir)) - 1) : 8;
  const maxTir = curveBonds.length > 0 ? Math.ceil(Math.max(...curveBonds.map((b) => b.tir)) + 1) : 15;
  const mapX = (dur: number) => 55 + ((dur - minDur) / Math.max(0.2, maxDur - minDur)) * 465;
  const mapY = (tir: number) => 185 - ((tir - minTir) / Math.max(1, maxTir - minTir)) * 155;

  const arPts = curveBonds
    .filter((b) => b.law === 'Ley AR')
    .sort((a, b) => a.modDuration - b.modDuration)
    .map((b) => ({ t: b.ticker, x: mapX(b.modDuration), y: mapY(b.tir), c: '#8B7CF6', tir: fmtNum(b.tir, 2) }));
  const nyPts = curveBonds
    .filter((b) => b.law === 'Ley NY')
    .sort((a, b) => a.modDuration - b.modDuration)
    .map((b) => ({ t: b.ticker, x: mapX(b.modDuration), y: mapY(b.tir), c: '#4BA3FF', tir: fmtNum(b.tir, 2) }));
  const arLine = arPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const nyLine = nyPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const gridTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => minTir + f * (maxTir - minTir));

  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant="pos" tag="Curva Soberana HD">
        AL30:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">
          {al30 ? `${fmtNum(al30.tir, 2)} %` : '—'}
        </strong>{' '}
        · GD35:{' '}
        <strong className="text-[#2EDC7E] font-mono-num">
          {gd35 ? `${fmtNum(gd35.tir, 2)} %` : '—'}
        </strong>{' '}
        · Spread legislación AL30/GD30:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">
          {Number.isFinite(spreadNyArPb) ? `${fmtNum(spreadNyArPb, 0)} pb` : '—'}
        </strong>{' '}
        ({liveMarket.feedStatus}).
      </InsightBanner>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Gráfico de Dispersión + Curva TIR vs Duration */}
        <div className="lg:col-span-7 qc-card p-4 flex flex-col justify-between gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[14px] font-bold text-[var(--text-primary)]">
                Curva de Rendimiento Soberana: TIR (%) vs. Modified Duration
              </h3>
              <HelpTooltip
                title="Curva TIR vs Duration"
                text="Compara el rendimiento anual en USD (XIRR sobre flujos reales) de los bonos Ley Local (violeta) frente a los Globales Ley Nueva York (azul)."
              />
            </div>
            <div className="flex items-center gap-3 text-[11px] font-mono-num">
              <span className="text-[#8B7CF6]">● Ley Argentina (AL)</span>
              <span className="text-[#4BA3FF]">● Ley NY (GD)</span>
            </div>
          </div>

          <div className="h-64 w-full pt-2">
            {curveBonds.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[12px] text-[var(--text-tertiary)] font-mono-num">
                Sin bonos con TIR / Duration computable ({liveMarket.feedStatus}).
              </div>
            ) : (
              <svg viewBox="0 0 560 220" className="w-full h-full overflow-visible">
                {gridTicks.map((t) => {
                  const y = mapY(t);
                  return (
                    <g key={t}>
                      <line x1="45" y1={y} x2="530" y2={y} stroke="#1E1E2B" />
                      <text x="38" y={y + 3} textAnchor="end" fill="#6D6D84" fontSize="10" className="font-mono-num">
                        {fmtNum(t, 1)}%
                      </text>
                    </g>
                  );
                })}

                {arPts.length >= 2 && (
                  <polyline
                    points={arLine}
                    fill="none"
                    stroke="#8B7CF6"
                    strokeWidth="2.2"
                    className="chart-line-draw"
                  />
                )}
                {nyPts.length >= 2 && (
                  <polyline
                    points={nyLine}
                    fill="none"
                    stroke="#4BA3FF"
                    strokeWidth="2.2"
                    strokeDasharray="5 3"
                  />
                )}

                {[...arPts, ...nyPts].map((pt) => (
                  <g key={pt.t}>
                    <circle cx={pt.x} cy={pt.y} r="5" fill={pt.c} stroke="#08080D" strokeWidth="1.5" />
                    <text
                      x={pt.x}
                      y={pt.y - 9}
                      textAnchor="middle"
                      fill="#F3F3F9"
                      fontSize="10"
                      fontWeight="bold"
                      className="font-mono-num"
                    >
                      {pt.t} ({pt.tir}%)
                    </text>
                  </g>
                ))}
                <text x="290" y="208" textAnchor="middle" fill="#6D6D84" fontSize="10" className="font-mono-num">
                  Modified Duration (Años) →
                </text>
              </svg>
            )}
          </div>
        </div>

        {/* Sensibilidad de Precio ante Compresión de Riesgo País */}
        <div className="lg:col-span-5 qc-card p-4 flex flex-col justify-between gap-3">
          <div>
            <h3 className="text-[14px] font-bold text-[var(--text-primary)] mb-1">
              Simulador de Upside por Compresión de TIR (Target 8,0 % / 9,0 %)
            </h3>
            <p className="text-[12px] text-[var(--text-secondary)]">
              Ganancia estimada (Duration Modificada × ΔTIR) calculada sobre los bonos soberanos en vivo.
            </p>
          </div>

          <table className="w-full font-mono-num text-[12px] text-right border-collapse">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] text-[10px] uppercase text-[var(--text-tertiary)]">
                <th className="py-2 text-left">Bono</th>
                <th className="py-2">TIR Hoy</th>
                <th className="py-2">Duration</th>
                <th className="py-2 text-[#2EDC7E]">Target 9%</th>
                <th className="py-2 text-[#2EDC7E]">Target 8%</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {BONDS_DATA.slice(0, 8).map((b) => {
                const finite = Number.isFinite(b.tir) && Number.isFinite(b.modDuration);
                const up9 = finite ? Math.max(0, (b.tir - 9.0) * b.modDuration) : Number.NaN;
                const up8 = finite ? Math.max(0, (b.tir - 8.0) * b.modDuration) : Number.NaN;
                return (
                  <tr key={b.ticker} className="h-9">
                    <td className="text-left font-bold text-[var(--text-primary)]">{b.ticker}</td>
                    <td>{Number.isFinite(b.tir) ? `${fmtNum(b.tir, 2)}%` : '—'}</td>
                    <td className="text-[var(--text-secondary)]">{fmtNum(b.modDuration, 2)}</td>
                    <td className="text-[#2EDC7E] font-semibold">
                      {Number.isFinite(up9) ? `+${fmtNum(up9, 1)} %` : '—'}
                    </td>
                    <td className="text-[#2EDC7E] font-bold">
                      {Number.isFinite(up8) ? `+${fmtNum(up8, 1)} %` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

/* MÓDULO FUTUROS ROFEX Y TASA SINTÉTICA USD */
interface SyntheticUsdFutureRow {
  readonly contract: string;
  readonly maturity: string;
  readonly expiryUtcSec: number;
  readonly days: number;
  readonly spotA3500: number;
  readonly forwardPrice: number;
  readonly impliedDevalPct: number;
  readonly temPct: number;
  readonly tnaPct: number;
  readonly teaPct: number;
  readonly arsRateTnaPct: number;
  readonly arsRateSource: string;
  readonly usdRatePct: number;
  readonly usdRateSource: string;
  readonly spreadVsCclPct: number | null;
  readonly badge: 'SINTÉTICO IMPLÍCITO';
}

const SYNTHETIC_MONTH_ABBR = [
  'ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC',
] as const;

function buildFallbackSyntheticUsdFutures(params: {
  readonly nowSec: number;
  readonly a3500: number | null | undefined;
  readonly arsRateTnaPct: number | null | undefined;
  readonly arsRateSource: string;
  readonly usdRatePct: number | null | undefined;
  readonly usdRateSource: string;
  readonly ccl: number | null | undefined;
}): readonly SyntheticUsdFutureRow[] {
  const { a3500, arsRateTnaPct, usdRatePct } = params;
  if (
    a3500 == null ||
    !Number.isFinite(a3500) ||
    a3500 <= 0 ||
    arsRateTnaPct == null ||
    !Number.isFinite(arsRateTnaPct) ||
    arsRateTnaPct <= 0 ||
    usdRatePct == null ||
    !Number.isFinite(usdRatePct) ||
    usdRatePct < 0
  ) {
    return [];
  }
  const rArsCont = (365 / 30) * Math.log(1 + (arsRateTnaPct / 100) * (30 / 365));
  const rUsdCont = Math.log(1 + usdRatePct / 100);
  const nowDate = new Date(params.nowSec * 1_000);
  let startYear = nowDate.getUTCFullYear();
  let startMonth = nowDate.getUTCMonth();
  const firstEomSec = Math.floor(Date.UTC(startYear, startMonth + 1, 0, 18, 0, 0) / 1_000);
  if (firstEomSec - params.nowSec < 86_400) {
    startMonth += 1;
    if (startMonth >= 12) {
      startMonth -= 12;
      startYear += 1;
    }
  }
  const rows: SyntheticUsdFutureRow[] = [];
  for (let i = 0; i < 6; i += 1) {
    const totalMonths = startMonth + i;
    const y = startYear + Math.floor(totalMonths / 12);
    const m = totalMonths % 12;
    const eom = new Date(Date.UTC(y, m + 1, 0, 18, 0, 0));
    const expiryUtcSec = Math.floor(eom.getTime() / 1_000);
    const days = Math.max(1, Math.round((expiryUtcSec - params.nowSec) / 86_400));
    const tYears = days / 365;
    const forwardPrice = a3500 * Math.exp((rArsCont - rUsdCont) * tYears);
    const ratio = forwardPrice / a3500;
    const impliedDevalPct = (ratio - 1) * 100;
    const temPct = (Math.pow(ratio, 30 / days) - 1) * 100;
    const tnaPct = (ratio - 1) * (365 / days) * 100;
    const teaPct = (Math.pow(ratio, 365 / days) - 1) * 100;
    const monthAbbr = SYNTHETIC_MONTH_ABBR[m] ?? 'MES';
    rows.push({
      contract: `DLR-${monthAbbr}${String(y).slice(-2)}-SINT`,
      maturity: eom.toISOString().slice(0, 10),
      expiryUtcSec,
      days,
      spotA3500: a3500,
      forwardPrice,
      impliedDevalPct,
      temPct,
      tnaPct,
      teaPct,
      arsRateTnaPct,
      arsRateSource: params.arsRateSource,
      usdRatePct,
      usdRateSource: params.usdRateSource,
      spreadVsCclPct:
        params.ccl != null && Number.isFinite(params.ccl) && params.ccl > 0
          ? (forwardPrice / params.ccl - 1) * 100
          : null,
      badge: 'SINTÉTICO IMPLÍCITO',
    });
  }
  return rows;
}

interface PrimaryDlrContractExt {
  readonly contract: string;
  readonly category: 'OUTRIGHT' | 'MINI' | 'SPREAD' | 'OPTION' | 'SPOT' | 'OTHER';
  readonly marketId: string;
  readonly maturity: string | null;
  readonly days: number | null;
  readonly price: number | null;
  readonly priceBasis: 'LAST' | 'MID' | 'SETTLEMENT_EOD' | 'NONE';
  readonly last: number | null;
  readonly settlement: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly openInterest: number | null;
  readonly nominalVolume: number | null;
  readonly spotUsed: number | null;
  readonly spotSource: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE';
  readonly devalDirectaPct: number | null;
  readonly tnaImplicitaPct: number | null;
  readonly teaImplicitaPct: number | null;
  readonly forwardToForwardPct?: number | null;
  readonly updatedAtUtcSec?: number | null;
  readonly source: 'PRIMARY_ROFEX';
}

type FuturesTab = 'OUTRIGHT' | 'MINI' | 'DDF' | 'SINTETICO';

export const FuturesModule: React.FC = () => {
  const liveMarket = useLiveMarketState();
  const liveStream = useMarketLiveStream();
  const [futuresTab, setFuturesTab] = useState<FuturesTab>('OUTRIGHT');

  useEffect(() => {
    void requestUsSnapshot('SPY');
    void refreshMacro(false);
  }, []);

  const macroExt = liveMarket.macro as
    | (NonNullable<typeof liveMarket.macro> & {
        readonly variables: NonNullable<typeof liveMarket.macro>['variables'] & {
          readonly sofrUsdTna?: number | null;
        };
        readonly syntheticFutures?: readonly SyntheticUsdFutureRow[];
        readonly rofxFutures?: readonly PrimaryDlrContractExt[];
        readonly rofxSpotA3500?: number | null;
        readonly rofxSpotSource?: 'A3500_BCRA' | 'DLR_SPOT' | 'NONE';
      })
    | null;

  const rofxContracts: readonly PrimaryDlrContractExt[] = (() => {
    const macroContracts = macroExt?.rofxFutures ?? [];
    const liveByContract = new Map(liveStream.futures.map((contract) => [contract.contract, contract]));
    const merged = macroContracts.map((contract) => {
      const live = liveByContract.get(contract.contract);
      return live === undefined ? contract : { ...contract, ...live };
    });
    const known = new Set(merged.map((contract) => contract.contract));
    for (const live of liveStream.futures) {
      if (known.has(live.contract) || live.category === 'SPOT') continue;
      merged.push({ ...live, marketId: 'ROFX' });
    }
    return merged;
  })();
  const outrightRofx = rofxContracts.filter((c) => c.category === 'OUTRIGHT');
  const miniRofx = rofxContracts.filter((c) => c.category === 'MINI');
  const ddfDerivatives = rofxContracts.filter(
    (c) => c.category === 'SPREAD' || c.category === 'OPTION' || c.category === 'SPOT' || c.category === 'OTHER',
  );
  const hasPrimaryRofx = rofxContracts.length > 0;

  const syntheticRows: readonly SyntheticUsdFutureRow[] = (() => {
    if (ROFEX_FUTURES.length > 0) return [];
    const serverCurve = macroExt?.syntheticFutures;
    if (serverCurve && serverCurve.length > 0) return serverCurve;
    const vars = macroExt?.variables;
    const spyTreasury = liveMarket.usSnapshotsBySymbol['SPY']?.marketContext?.treasury;
    const usdRatePct =
      vars?.sofrUsdTna ??
      spyTreasury?.sofr ??
      spyTreasury?.yield3M ??
      spyTreasury?.yield1M ??
      null;
    const usdRateSource =
      vars?.sofrUsdTna != null
        ? 'NY Fed SOFR'
        : spyTreasury?.sofr != null
          ? 'US SOFR'
          : 'US Treasury';
    const arsRateSource =
      vars?.tamarTna != null
        ? 'BCRA TAMAR'
        : vars?.badlarTna != null
          ? 'BCRA BADLAR'
          : vars?.tpmTna != null
            ? 'BCRA TPM'
            : 'ArgentinaDatos PF';
    const arsRateTnaPct =
      vars?.tamarTna ?? vars?.badlarTna ?? vars?.tpmTna ?? vars?.plazoFijoTna ?? null;
    return buildFallbackSyntheticUsdFutures({
      nowSec: macroExt?.asOfUtcSec ?? Math.floor(Date.now() / 1_000),
      a3500: vars?.a3500,
      arsRateTnaPct,
      arsRateSource,
      usdRatePct,
      usdRateSource,
      ccl: vars?.ccl ?? liveMarket.overview?.cclMedian,
    });
  })();

  const firstSynth = syntheticRows[0] ?? null;
  const visibleRofxRows =
    futuresTab === 'OUTRIGHT'
      ? outrightRofx
      : futuresTab === 'MINI'
        ? miniRofx
        : futuresTab === 'DDF'
          ? ddfDerivatives
          : [];
  const showPrimaryTable = hasPrimaryRofx && futuresTab !== 'SINTETICO';

  return (
    <div className="space-y-4 animate-module">
      <InsightBanner
        variant={hasPrimaryRofx || ROFEX_FUTURES.length > 0 ? 'pos' : 'warn'}
        tag="Curva MATBA ROFEX / Sintético USD"
      >
        {hasPrimaryRofx ? (
          <>
            Conectado a <strong className="text-[#2EDC7E]">Primary API (MATBA-ROFEX)</strong>:{' '}
            <strong>{outrightRofx.length}</strong> futuros DLR estándar ·{' '}
            <strong>{miniRofx.length}</strong> minis · <strong>{ddfDerivatives.length}</strong> derivados DDF · Spot Ref. ({macroExt?.rofxSpotSource ?? 'NONE'}):{' '}
            <strong className="font-mono-num text-[var(--text-primary)]">
              {macroExt?.rofxSpotA3500 != null ? `$ ${fmtNum(macroExt.rofxSpotA3500, 2)}` : '—'}
            </strong>
            .{' '}
            {liveStream.futuresSource === 'PRIMARY_WS' && (
              <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-sans font-bold bg-[#22C55E]/10 text-[#22C55E] border border-[#22C55E]/35">
                ● DLR WS LIVE ({liveStream.futures.length})
              </span>
            )}
          </>
        ) : ROFEX_FUTURES.length > 0 ? (
          `Contratos activos de dólar futuro (${ROFEX_FUTURES.length} vencimientos).`
        ) : firstSynth ? (
          <>
            Sin feed directo de MATBA-ROFEX — Curva forward implícita{' '}
            <strong className="text-[#EAB308]">SINTÉTICO IMPLÍCITO</strong> ({syntheticRows.length} contratos CIP) · A3500 BCRA:{' '}
            <strong className="font-mono-num text-[var(--text-primary)]">$ {fmtNum(firstSynth.spotA3500, 2)}</strong> ·{' '}
            {firstSynth.arsRateSource}:{' '}
            <strong className="font-mono-num text-[var(--text-primary)]">{fmtNum(firstSynth.arsRateTnaPct, 2)}%</strong> ·{' '}
            {firstSynth.usdRateSource}:{' '}
            <strong className="font-mono-num text-[#2EDC7E]">{fmtNum(firstSynth.usdRatePct, 2)}%</strong>. Cero ticks simulados de Rofex.
          </>
        ) : (
          `Sin feed directo de MATBA-ROFEX ni curva completa de tasas USD/ARS (${liveMarket.feedStatus}). Referencia TC Mayorista A3500 BCRA: ${
            liveMarket.macro?.variables.a3500 != null ? `$ ${fmtNum(liveMarket.macro.variables.a3500, 2)}` : '—'
          }.`
        )}
      </InsightBanner>

      {hasPrimaryRofx && (
        <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-[10px] bg-[var(--bg-sidebar)] border border-[var(--border-subtle)] w-fit">
          {(
            [
              { id: 'OUTRIGHT', label: 'Futuros DLR (DLR/MMMYY)', count: outrightRofx.length },
              { id: 'MINI', label: 'Mini (DLR/*M)', count: miniRofx.length },
              { id: 'DDF', label: 'Pases / Opciones DDF', count: ddfDerivatives.length },
              { id: 'SINTETICO', label: 'Curva Sintética CIP', count: syntheticRows.length },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setFuturesTab(t.id)}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-[12px] font-semibold cursor-pointer transition-all ${
                futuresTab === t.id
                  ? 'bg-[var(--accent-primary)] text-white'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <span>{t.label}</span>
              <span className="text-[10px] font-mono-num px-1.5 py-0.2 rounded bg-black/25">
                {t.count}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="qc-card overflow-hidden">
        <div className="overflow-x-auto">
          {showPrimaryTable ? (
            <table className="w-full border-collapse text-right font-mono-num text-[12px]">
              <thead>
                <tr className="bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                  <th className="py-2.5 px-3 text-left">Contrato ROFEX</th>
                  <th className="py-2.5 px-2.5">Vencimiento</th>
                  <th className="py-2.5 px-2.5">Días</th>
                  <th className="py-2.5 px-2.5">Último / Ajuste ($)</th>
                  <th className="py-2.5 px-2.5">Puntas (BI / OF)</th>
                  <th className="py-2.5 px-2.5">OI</th>
                  <th className="py-2.5 px-2.5">Vol. Nom</th>
                  <th className="py-2.5 px-2.5">Deval. Directa</th>
                  <th className="py-2.5 px-2.5">TNA Implícita</th>
                  <th className="py-2.5 px-2.5">TEA Implícita</th>
                  <th className="py-2.5 px-3">Fwd i→i+1</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {visibleRofxRows.length > 0 ? (
                  visibleRofxRows.map((c) => (
                    <tr key={c.contract} className="h-9 hover:bg-[var(--surface-2)]">
                      <td className="px-3 text-left font-bold text-[var(--text-primary)]">
                        <span className="inline-flex items-center gap-2">
                          <span>{c.contract}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[9.5px] font-sans font-bold tracking-wider ${
                              c.priceBasis === 'SETTLEMENT_EOD'
                                ? 'bg-[#35280F] text-[#F5B544] border border-[#F5B544]/40'
                                : c.priceBasis === 'LAST' || c.priceBasis === 'MID'
                                  ? 'bg-[#0D221E] text-[#2EDC7E] border border-[#164E3F]'
                                  : 'bg-[#1E222D] text-[#9CA3AF] border border-[#2A3347]'
                            }`}
                          >
                            {c.priceBasis}
                          </span>
                        </span>
                      </td>
                      <td className="px-2.5 text-[var(--text-secondary)]">{c.maturity ?? '—'}</td>
                      <td className="px-2.5 text-[var(--text-secondary)]">
                        {c.days !== null ? `${String(c.days)}d` : '—'}
                      </td>
                      <td className="px-2.5 font-bold text-[var(--text-primary)]">
                        <TickFlash value={c.price}>
                          {c.price !== null ? `$ ${fmtNum(c.price, 2)}` : '—'}
                        </TickFlash>
                      </td>
                      <td className="px-2.5 text-[var(--text-secondary)]">
                        {(() => {
                          const cExt = c as typeof c & {
                            readonly bidPrice?: number | null;
                            readonly askPrice?: number | null;
                            readonly bidSize?: number | null;
                            readonly askSize?: number | null;
                          };
                          const bPx = cExt.bidPrice ?? c.bid;
                          const aPx = cExt.askPrice ?? c.ask;
                          const bSz = cExt.bidSize ?? null;
                          const aSz = cExt.askSize ?? null;
                          if (bPx !== null || aPx !== null) {
                            const bTxt =
                              bPx !== null
                                ? `${fmtNum(bPx, 2)}${bSz !== null && bSz > 0 ? ` (${bSz.toLocaleString('es-AR')})` : ''}`
                                : '—';
                            const aTxt =
                              aPx !== null
                                ? `${fmtNum(aPx, 2)}${aSz !== null && aSz > 0 ? ` (${aSz.toLocaleString('es-AR')})` : ''}`
                                : '—';
                            return `${bTxt} / ${aTxt}`;
                          }
                          if (liveMarket.marketState === 'CERRADO' || c.priceBasis === 'SETTLEMENT_EOD') {
                            return (
                              <span className="text-[11px] font-sans text-[#787B86]">
                                Sin puntas (Cierre)
                              </span>
                            );
                          }
                          return '—';
                        })()}
                      </td>
                      <td className="px-2.5 text-[var(--text-secondary)]">
                        {c.openInterest !== null ? c.openInterest.toLocaleString('es-AR') : '—'}
                      </td>
                      <td className="px-2.5 text-[var(--text-secondary)]">
                        {c.nominalVolume !== null ? c.nominalVolume.toLocaleString('es-AR') : '—'}
                      </td>
                      <td className="px-2.5 text-[var(--text-secondary)]">
                        {c.devalDirectaPct !== null ? fmtPct(c.devalDirectaPct, 2) : '—'}
                      </td>
                      <td className="px-2.5 font-semibold text-[#8B7CF6]">
                        {c.tnaImplicitaPct !== null ? `${fmtNum(c.tnaImplicitaPct, 2)} %` : '—'}
                      </td>
                      <td className="px-3 text-[#2EDC7E] font-semibold">
                        {c.teaImplicitaPct !== null ? `${fmtNum(c.teaImplicitaPct, 2)} %` : '—'}
                      </td>
                      <td className="px-3 text-[#E5C76B] font-semibold">
                        {c.forwardToForwardPct != null ? `${fmtNum(c.forwardToForwardPct, 2)} %` : '—'}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={11} className="py-8 text-center font-sans text-[12px] text-[var(--text-tertiary)]">
                      No hay contratos cargados en la categoría seleccionada.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full border-collapse text-right font-mono-num text-[12px]">
              <thead>
                <tr className="bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                  <th className="py-2.5 px-3 text-left">Contrato Rofex / Sintético</th>
                  <th className="py-2.5 px-2.5">Vencimiento</th>
                  <th className="py-2.5 px-2.5">Días</th>
                  <th className="py-2.5 px-2.5">Forward Teórico ($)</th>
                  <th className="py-2.5 px-2.5">Var. Día</th>
                  <th className="py-2.5 px-2.5">Deval. Directa</th>
                  <th className="py-2.5 px-2.5">TNA Implícita</th>
                  <th className="py-2.5 px-2.5">TEA Implícita</th>
                  <th className="py-2.5 px-2.5">Tasa ARS Ref.</th>
                  <th className="py-2.5 px-3 text-[#2EDC7E]">Tasa USD Ref.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {syntheticRows.length > 0 ? (
                  syntheticRows.map((s) => (
                    <tr key={s.contract} className="h-9 hover:bg-[var(--surface-2)]">
                      <td className="px-3 text-left font-bold text-[var(--text-primary)]">
                        <span className="inline-flex items-center gap-2">
                          <span>{s.contract}</span>
                          <span className="px-1.5 py-0.5 rounded bg-[#35280F] text-[#F5B544] border border-[#F5B544]/40 text-[9.5px] font-sans font-bold tracking-wider">
                            {s.badge}
                          </span>
                        </span>
                      </td>
                      <td className="px-2.5 text-[var(--text-secondary)]">{s.maturity}</td>
                      <td className="px-2.5 text-[var(--text-secondary)]">{s.days}d</td>
                      <td className="px-2.5 font-bold text-[var(--text-primary)]">$ {fmtNum(s.forwardPrice, 2)}</td>
                      <td className="px-2.5 text-[var(--text-tertiary)]">—</td>
                      <td className="px-2.5 text-[var(--text-secondary)]">{fmtPct(s.impliedDevalPct, 2)}</td>
                      <td className="px-2.5 font-semibold text-[#8B7CF6]">{fmtNum(s.tnaPct, 2)} %</td>
                      <td className="px-2.5 text-[var(--text-secondary)]">{fmtNum(s.teaPct, 2)} %</td>
                      <td className="px-2.5 text-[var(--text-secondary)]">
                        {s.arsRateSource} ({fmtNum(s.arsRateTnaPct, 1)}%)
                      </td>
                      <td className="px-3 font-bold text-[#2EDC7E]">
                        {fmtNum(s.usdRatePct, 2)}% ({s.usdRateSource})
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={10} className="py-8 text-center font-sans text-[12px] text-[var(--text-tertiary)]">
                      No hay contratos Rofex ni curvas suficientes para calcular sintéticos. Todos los campos muestran — sin valores simulados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

/* MÓDULO RELACIONES, LIQUIDEZ Y ROTACIÓN DE CAPITAL */
type RelationsFilterTab =
  | 'Todos'
  | 'Rotación Sectorial'
  | 'Liquidez y Crédito'
  | 'Oportunidad (Z-Score)';

const RELATIONS_FILTER_TABS: readonly RelationsFilterTab[] = [
  'Todos',
  'Rotación Sectorial',
  'Liquidez y Crédito',
  'Oportunidad (Z-Score)',
];

function formatRelationScalar(value: number, unit: string): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const decimals = unit === 'x' && Math.abs(value) < 5 ? 3 : Math.abs(value) < 100 ? 2 : 0;
  return `${fmtNum(value, decimals)} ${unit}`;
}

export const RelationsModule: React.FC = () => {
  const liveMarket = useLiveMarketState();
  const [activeFilter, setActiveFilter] = useState<RelationsFilterTab>('Todos');

  useEffect(() => {
    void requestRelations();
  }, []);

  const sectorCount = RATIO_PAIRS.filter((p) => p.categoryGroup === 'ROTACION_SECTORIAL').length;
  const liquidityCount = RATIO_PAIRS.filter((p) => p.categoryGroup === 'LIQUIDEZ_CREDITO').length;
  const opportunityPairs = RATIO_PAIRS.filter(
    (p) => Number.isFinite(p.zScore) && Math.abs(p.zScore) >= 1.5,
  ).sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  const extremeTwoSigmaCount =
    RATIO_PAIRS.length > 0 ? RELATION_SUMMARY.extremeTwoSigmaCount : Number.NaN;

  const visiblePairs =
    activeFilter === 'Todos'
      ? RATIO_PAIRS
      : activeFilter === 'Rotación Sectorial'
      ? RATIO_PAIRS.filter((p) => p.categoryGroup === 'ROTACION_SECTORIAL')
      : activeFilter === 'Liquidez y Crédito'
      ? RATIO_PAIRS.filter((p) => p.categoryGroup === 'LIQUIDEZ_CREDITO')
      : opportunityPairs;

  const topFlowDelta = RELATION_SUMMARY.topCapitalFlowDeltaPct;
  const topFlowSector = RELATION_SUMMARY.topCapitalFlowSector;

  return (
    <div className="space-y-4 animate-module">
      {/* Resumen superior de alertas activas */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KPICard
          title="Pares en Extremo ±2σ"
          heroValue={Number.isFinite(extremeTwoSigmaCount) ? `${String(extremeTwoSigmaCount)} pares` : '—'}
          subtitle={
            RATIO_PAIRS.length > 0
              ? `${String(RELATION_SUMMARY.moderateDeviationCount)} con desvío moderado (1,5σ – 2,0σ)`
              : 'Esperando series diarias 60d'
          }
          badge={
            Number.isFinite(extremeTwoSigmaCount) && extremeTwoSigmaCount > 0 ? 'ALERTA ±2σ' : 'SIN EXTREMOS'
          }
          helpText="Cantidad de pares cuya lectura actual supera ±2,0 desviaciones estándar respecto a su media móvil de 60 ruedas."
          helpFormula="z = (x_t − μ_60) / σ_60"
        />

        <KPICard
          title="Sector con Mayor Giro de Capital"
          heroValue={topFlowSector ?? '—'}
          deltaPct={Number.isFinite(topFlowDelta) ? topFlowDelta : undefined}
          subtitle={
            Number.isFinite(topFlowDelta)
              ? `Participación de volumen efectivo 5d vs. media 20d`
              : 'Flujo sectorial no disponible'
          }
          badge="FLUJO 5D/20D"
          helpText="Variación porcentual de la participación de volumen efectivo de los últimos 5 días frente a su promedio de 20 ruedas."
          helpFormula="ΔFlujo% = (mean_5(s_t) / mean_20(s_t) − 1) × 100"
        />

        <KPICard
          title="Universo Multi-Mercado"
          heroValue={RATIO_PAIRS.length > 0 ? `${String(RATIO_PAIRS.length)} relaciones` : '—'}
          subtitle={`${String(sectorCount)} rotación sectorial · ${String(liquidityCount)} liquidez/crédito · ${liveMarket.feedStatus}`}
          badge="MASSIVE 1D + BYMA"
          helpText="Combina barras diarias ajustadas Massive 1D (90 ruedas USD) con acciones, bonos soberanos y CCL/MEP locales."
        />
      </div>

      {/* Barra de filtros por categoría */}
      <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-[10px] bg-[var(--bg-sidebar)] border border-[var(--border-subtle)]">
        <div className="flex flex-wrap items-center gap-1.5">
          {RELATIONS_FILTER_TABS.map((tab) => {
            const count =
              tab === 'Todos'
                ? RATIO_PAIRS.length
                : tab === 'Rotación Sectorial'
                ? sectorCount
                : tab === 'Liquidez y Crédito'
                ? liquidityCount
                : opportunityPairs.length;
            const active = activeFilter === tab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveFilter(tab)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-semibold transition-colors cursor-pointer ${
                  active
                    ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]/60'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] border border-transparent'
                }`}
              >
                <span>{tab}</span>
                <span className="px-1.5 py-0.2 rounded bg-[var(--surface-2)] font-mono-num text-[10px] text-[var(--text-tertiary)]">
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <span className="px-2 text-[11px] font-mono-num text-[var(--text-tertiary)]">
          Mín. 20 ruedas · Objetivo 60d · Reversión OU AR(1)
        </span>
      </div>

      {RATIO_PAIRS.length === 0 ? (
        <div className="qc-card p-8 text-center text-[12px] text-[var(--text-tertiary)]">
          Cargando relaciones de rotación sectorial, liquidez y crédito desde /api/ar/relations ({liveMarket.feedStatus})...
        </div>
      ) : visiblePairs.length === 0 ? (
        <div className="qc-card p-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]">
          <span>
            No hay relaciones con desvío significativo (|Z-Score| ≥ 1,5σ) en el cierre actual.
          </span>
          <button
            type="button"
            onClick={() => setActiveFilter('Todos')}
            className="px-3 py-1.5 rounded-[8px] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-semibold cursor-pointer"
          >
            Ver todas las relaciones ({RATIO_PAIRS.length})
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {visiblePairs.map((pair) => {
            const badge = pair.opportunityBadge;
            const badgeStyle =
              badge === 'EXTREMO COMPRA'
                ? 'bg-[#0E2F20] text-[#2EDC7E] border-[#1C5C3C]'
                : badge === 'EXTREMO VENTA'
                ? 'bg-[#2A1216] text-[#F23645] border-[#5C2229]'
                : badge === 'DESVÍO MODERADO'
                ? 'bg-[#35280F] text-[#F5B544] border-[#F5B544]/40'
                : 'bg-[var(--surface-2)] text-[var(--text-secondary)] border-[var(--border-subtle)]';

            const sparkData = pair.sparkline.length >= 2 ? pair.sparkline : pair.history;
            const flowFinite = Number.isFinite(pair.capitalFlowDeltaPct);
            const hlFinite = Number.isFinite(pair.halfLifeDays);

            return (
              <div key={pair.id} className="qc-card qc-card-interactive p-4 flex flex-col justify-between gap-3">
                {/* Encabezado de tarjeta */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex items-center -space-x-2 shrink-0">
                      <CompanyLogo ticker={pair.legA} size="md" className="ring-2 ring-[#11111A] relative z-10" />
                      <CompanyLogo ticker={pair.legB} size="md" className="ring-2 ring-[#11111A]" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-primary)]">
                          {pair.categoryLabel}
                        </span>
                        <span className="px-1.5 py-0.2 rounded bg-[var(--surface-2)] border border-[var(--border-subtle)] text-[9.5px] font-mono-num text-[var(--text-tertiary)]">
                          {pair.source === 'MASSIVE_1D'
                            ? 'NYSE · 1D USD'
                            : pair.source === 'MIXED_USD_CCL'
                            ? 'AR · USD CCL'
                            : 'BYMA · DATA912'}
                        </span>
                      </div>
                      <h3 className="text-[15px] font-bold text-[var(--text-primary)] truncate">{pair.pairTitle}</h3>
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span
                      className={`px-2 py-0.5 rounded-full border text-[10px] font-mono-num font-bold tracking-wide ${badgeStyle}`}
                    >
                      {badge ?? '—'}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full font-mono-num text-[11px] font-semibold ${
                        Number.isFinite(pair.zScore) && Math.abs(pair.zScore) >= 1.5
                          ? 'bg-[#35280F] text-[#F5B544] border border-[#F5B544]/40'
                          : 'bg-[#0E2F20] text-[#2EDC7E] border border-[#1C5C3C]'
                      }`}
                    >
                      Z-Score:{' '}
                      {Number.isFinite(pair.zScore)
                        ? `${pair.zScore > 0 ? '+' : '−'}${fmtNum(Math.abs(pair.zScore), 2)}σ`
                        : '—'}
                    </span>
                  </div>
                </div>

                {/* Banda principal 3 columnas */}
                <div className="grid grid-cols-3 gap-2 p-2.5 rounded-[10px] bg-[var(--surface-2)] font-mono-num text-[12px]">
                  <div>
                    <div className="text-[10px] text-[var(--text-tertiary)]">Valor Actual</div>
                    <div className="text-[15px] font-bold text-[var(--text-primary)]">
                      {formatRelationScalar(pair.currentRatio, pair.unit)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[var(--text-tertiary)]">Media 60d</div>
                    <div className="text-[14px] text-[var(--text-secondary)]">
                      {formatRelationScalar(pair.mean90d, pair.unit)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[var(--text-tertiary)]">Percentil 60d</div>
                    <div className="text-[14px] font-semibold text-[#8B7CF6]">
                      {Number.isFinite(pair.percentile90d) ? `P${fmtNum(pair.percentile90d, 0)}` : '—'}
                    </div>
                  </div>
                </div>

                {/* Sub-indicadores cuantitativos (Flujo 5d/20d + Vida Media OU) + Sparkline */}
                <div className="flex items-center justify-between gap-3 pt-0.5">
                  <div className="grid grid-cols-2 gap-3 flex-1 font-mono-num text-[11px]">
                    <div className="px-2.5 py-1.5 rounded-[8px] bg-[var(--bg-sidebar)] border border-[var(--border-subtle)]">
                      <div className="text-[9.5px] uppercase tracking-wider text-[var(--text-tertiary)]">
                        Flujo 5d/20d
                      </div>
                      <div
                        className={`text-[12.5px] font-bold ${
                          !flowFinite
                            ? 'text-[var(--text-tertiary)]'
                            : pair.capitalFlowDeltaPct >= 0
                            ? 'text-[#2EDC7E]'
                            : 'text-[#F23645]'
                        }`}
                      >
                        {flowFinite
                          ? `${pair.capitalFlowDeltaPct >= 0 ? '+' : '−'}${fmtNum(
                              Math.abs(pair.capitalFlowDeltaPct),
                              1,
                            )}%`
                          : '—'}
                      </div>
                    </div>

                    <div
                      className="px-2.5 py-1.5 rounded-[8px] bg-[var(--bg-sidebar)] border border-[var(--border-subtle)]"
                      title="Vida media de reversión OU t½ = -ln(2)/ln(φ) estimada vía AR(1); '—' si la serie es no estacionaria (φ ≥ 1 o φ ≤ 0)."
                    >
                      <div className="text-[9.5px] uppercase tracking-wider text-[var(--text-tertiary)]">
                        Vida Media OU (t½)
                      </div>
                      <div className="text-[12.5px] font-bold text-[var(--text-primary)]">
                        {hlFinite ? `${fmtNum(pair.halfLifeDays, 1)} d` : '—'}
                      </div>
                    </div>
                  </div>

                  {sparkData.length >= 2 ? (
                    <MiniSparkline
                      data={sparkData}
                      positive={!Number.isFinite(pair.zScore) || pair.zScore < 0}
                      width={104}
                      height={34}
                    />
                  ) : (
                    <span className="w-[104px] text-center font-mono-num text-[11px] text-[var(--text-tertiary)]">
                      —
                    </span>
                  )}
                </div>

                <p className="text-[11.5px] text-[var(--text-secondary)] leading-snug">{pair.recommendation}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const RatiosModule = RelationsModule;

/* MÓDULO POSICIONES (CARTERA Y RIESGO AGREGADO + CUENTA BROKER READ-ONLY) */
interface BrokerCurrencyBalanceExt {
  readonly currency: string;
  readonly consumed: number | null;
  readonly available: number | null;
}

interface BrokerAccountSummaryExt {
  readonly broker: 'PRIMARY_REMARKETS' | 'BMB_HOMEBROKER';
  readonly accountLabel: string | null;
  readonly status: 'OK' | 'DISABLED' | 'UNAVAILABLE' | 'ERROR';
  readonly collateral: number | null;
  readonly margin: number | null;
  readonly availableToCollateral: number | null;
  readonly cashTotalArs: number | null;
  readonly pendingMovementsArs: number | null;
  readonly marketMember: string | null;
  readonly currencyBalances: readonly BrokerCurrencyBalanceExt[];
  readonly error: string | null;
}

interface BrokerPositionExt {
  readonly symbol: string;
  readonly marketId: string | null;
  readonly buySize: number;
  readonly sellSize: number;
  readonly netSize: number;
  readonly buyPrice: number | null;
  readonly sellPrice: number | null;
  readonly totalDailyDiffArs: number | null;
  readonly totalDiffArs: number | null;
  readonly source: 'PRIMARY_ROFEX' | 'BMB_HOMEBROKER';
}

interface BrokerPositionsResponseExt {
  readonly asOfUtcSec: number;
  readonly primaryStatus: 'OK' | 'DISABLED' | 'UNAVAILABLE' | 'ERROR';
  readonly bmbStatus: string;
  readonly primaryAccount: BrokerAccountSummaryExt;
  readonly bmbAccountLabel: string | null;
  readonly positions: readonly BrokerPositionExt[];
  readonly providerErrors: readonly string[];
}

export const PositionsModule: React.FC<{
  positions: PortfolioPosition[];
  onOpenOrderTicket: (preset: {
    ticker: string;
    side: 'Compra' | 'Venta';
    price: number;
    qty: number;
    instrumentLabel: string;
  }) => void;
}> = ({ positions, onOpenOrderTicket }) => {
  const [activeTab, setActiveTab] = useState<'TERMINAL' | 'BROKER'>('TERMINAL');
  const [brokerData, setBrokerData] = useState<BrokerPositionsResponseExt | null>(null);
  const [brokerLoading, setBrokerLoading] = useState(false);
  const [brokerError, setBrokerError] = useState<string | null>(null);

  const loadBrokerAccount = async (forceRefresh = false): Promise<void> => {
    setBrokerLoading(true);
    setBrokerError(null);
    try {
      const qs = forceRefresh ? '?refresh=1' : '';
      const res = await fetch(`/api/ar/positions${qs}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${String(res.status)}`);
      }
      const parsed = (await res.json()) as BrokerPositionsResponseExt;
      setBrokerData(parsed);
    } catch (err: unknown) {
      setBrokerError(err instanceof Error ? err.message : 'Error consultando /api/ar/positions');
    } finally {
      setBrokerLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'BROKER' && brokerData === null && !brokerLoading) {
      void loadBrokerAccount(false);
    }
  }, [activeTab]);

  const totalVal = positions.reduce((acc, p) => acc + p.marketValueArs, 0);
  const totalPnlDay = positions.reduce((acc, p) => acc + p.pnlDayArs, 0);
  const totalTheta = positions.reduce((acc, p) => acc + p.thetaDayArs, 0);
  const dayPct = totalVal > 0 ? (totalPnlDay / totalVal) * 100 : Number.NaN;

  const primaryLabel = brokerData?.primaryAccount.accountLabel ?? 'REM22710';
  const bmbLabel = brokerData?.bmbAccountLabel ?? 'BMB 266758';

  return (
    <div className="space-y-4 animate-module">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 p-1 rounded-[10px] bg-[var(--bg-sidebar)] border border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={() => setActiveTab('TERMINAL')}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-[12px] font-semibold cursor-pointer transition-all ${
              activeTab === 'TERMINAL'
                ? 'bg-[var(--accent-primary)] text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span>Cartera Terminal</span>
            <span className="text-[10px] font-mono-num px-1.5 rounded bg-black/25">
              {positions.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('BROKER')}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-[8px] text-[12px] font-semibold cursor-pointer transition-all ${
              activeTab === 'BROKER'
                ? 'bg-[var(--accent-primary)] text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span>{`Cuenta Broker (${primaryLabel} / ${bmbLabel})`}</span>
            {brokerData && (
              <span className="text-[10px] font-mono-num px-1.5 rounded bg-black/25">
                {brokerData.positions.length}
              </span>
            )}
          </button>
        </div>

        {activeTab === 'BROKER' && (
          <button
            type="button"
            onClick={() => void loadBrokerAccount(true)}
            disabled={brokerLoading}
            className="px-3 py-1.5 rounded-[8px] text-[11.5px] font-semibold bg-[var(--surface-2)] hover:bg-[var(--accent-primary)] hover:text-white border border-[var(--border-subtle)] cursor-pointer disabled:opacity-50"
          >
            {brokerLoading ? 'Sincronizando...' : 'Actualizar Cuenta'}
          </button>
        )}
      </div>

      {activeTab === 'TERMINAL' ? (
        <>
          <InsightBanner variant="pos" tag="Cartera Consolidada">
            {positions.length === 0 ? (
              <>Tu portafolio está vacío. Enviá órdenes reales desde el Ticket de Orden para trackear tenencia y riesgo.</>
            ) : (
              <>
                Tu portafolio suma <strong className="text-[var(--text-primary)] font-mono-num">$ {fmtNum(totalVal / 1e6, 2)} M</strong>{' '}
                con variación diaria de{' '}
                <strong className="text-[#2EDC7E] font-mono-num">
                  $ {fmtNum(totalPnlDay / 1e6, 2)} M ({fmtPct(dayPct, 2)})
                </strong>{' '}
                y Theta de <strong className="text-[#2EDC7E] font-mono-num">$ {fmtNum(totalTheta, 0)} / día</strong>.
              </>
            )}
          </InsightBanner>

          <div className="qc-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-right font-mono-num text-[12px]">
                <thead>
                  <tr className="bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                    <th className="py-2.5 px-3 text-left">Instrumento</th>
                    <th className="py-2.5 px-2 text-left">Tipo</th>
                    <th className="py-2.5 px-2.5">Cantidad</th>
                    <th className="py-2.5 px-2.5">PPC ($)</th>
                    <th className="py-2.5 px-2.5">Último ($)</th>
                    <th className="py-2.5 px-2.5">Valuación ARS</th>
                    <th className="py-2.5 px-2.5">P&L Rueda</th>
                    <th className="py-2.5 px-2.5">P&L Total</th>
                    <th className="py-2.5 px-2.5">Theta / Día</th>
                    <th className="py-2.5 px-3">Cerrar / Ajustar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {positions.map((p) => (
                    <tr key={p.id} className="h-10 hover:bg-[var(--surface-2)]">
                      <td className="px-3 text-left font-bold text-[var(--text-primary)]">
                        <div className="flex items-center gap-2">
                          <CompanyLogo ticker={p.ticker} size="sm" />
                          <span>{p.ticker}</span>
                        </div>
                      </td>
                      <td className="px-2 text-left font-sans text-[11px] text-[var(--text-secondary)]">
                        {p.instrumentType}
                      </td>
                      <td className={p.qty < 0 ? 'px-2.5 text-[#FF5C63] font-semibold' : 'px-2.5 text-[#2EDC7E] font-semibold'}>
                        {p.qty.toLocaleString('es-AR')}
                      </td>
                      <td className="px-2.5 text-[var(--text-secondary)]">$ {fmtNum(p.avgPrice, 2)}</td>
                      <td className="px-2.5 font-bold text-[var(--text-primary)]">$ {fmtNum(p.lastPrice, 2)}</td>
                      <td className="px-2.5 font-semibold text-[var(--text-primary)]">
                        $ {fmtNum(p.marketValueArs, 0)}
                      </td>
                      <td className="px-2.5">
                        <DeltaPill value={p.pnlDayPct} size="sm" />
                      </td>
                      <td className={p.pnlTotalArs >= 0 ? 'px-2.5 text-[#2EDC7E] font-semibold' : 'px-2.5 text-[#FF5C63]'}>
                        +$ {fmtNum(p.pnlTotalArs, 0)} ({fmtPct(p.pnlTotalPct)})
                      </td>
                      <td className="px-2.5 text-[#2EDC7E]">+$ {fmtNum(p.thetaDayArs, 0)}</td>
                      <td className="px-3">
                        <button
                          type="button"
                          onClick={() =>
                            onOpenOrderTicket({
                              ticker: p.ticker,
                              side: p.qty > 0 ? 'Venta' : 'Compra',
                              price: p.lastPrice,
                              qty: Math.abs(p.qty),
                              instrumentLabel: `Cerrar/Ajustar ${p.ticker}`,
                            })
                          }
                          className="px-2.5 py-1 rounded text-[11px] font-sans font-semibold bg-[var(--surface-2)] hover:bg-[var(--accent-primary)] hover:text-white border border-[var(--border-subtle)] cursor-pointer"
                        >
                          {p.qty > 0 ? 'Vender' : 'Recomprar'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="space-y-4">
          <InsightBanner
            variant={brokerData?.primaryStatus === 'OK' ? 'pos' : 'warn'}
            tag="Consulta Read-Only Broker"
          >
            {brokerError ? (
              `Error consultando cuenta broker: ${brokerError}`
            ) : brokerData ? (
              <>
                Primary reMarkets ({primaryLabel}): <strong>{brokerData.primaryStatus}</strong> · Bull Market ({bmbLabel}):{' '}
                <strong>{brokerData.bmbStatus}</strong> · Posiciones abiertas:{' '}
                <strong className="font-mono-num">{brokerData.positions.length}</strong>.
              </>
            ) : (
              'Sincronizando cuenta Primary reMarkets (getPositions / accountReport) y estado Bull Market...'
            )}
          </InsightBanner>

          {brokerData && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
              <div className="qc-card p-4 space-y-1">
                <div className="text-[11px] text-[var(--text-tertiary)]">Efectivo ARS ({primaryLabel})</div>
                <div className="font-mono-num text-[18px] font-bold text-[#2EDC7E]">
                  {brokerData.primaryAccount.cashTotalArs !== null
                    ? `$ ${fmtNum(brokerData.primaryAccount.cashTotalArs, 2)}`
                    : '—'}
                </div>
                <div className="text-[11px] text-[var(--text-secondary)]">
                  Miembro: {brokerData.primaryAccount.marketMember ?? '—'}
                </div>
              </div>
              <div className="qc-card p-4 space-y-1">
                <div className="text-[11px] text-[var(--text-tertiary)]">Disponible Garantías</div>
                <div className="font-mono-num text-[18px] font-bold text-[var(--text-primary)]">
                  {brokerData.primaryAccount.availableToCollateral !== null
                    ? `$ ${fmtNum(brokerData.primaryAccount.availableToCollateral, 2)}`
                    : '—'}
                </div>
                <div className="text-[11px] text-[var(--text-secondary)]">
                  Colateral: {brokerData.primaryAccount.collateral !== null ? `$ ${fmtNum(brokerData.primaryAccount.collateral, 2)}` : '—'}
                </div>
              </div>
              <div className="qc-card p-4 space-y-1">
                <div className="text-[11px] text-[var(--text-tertiary)]">Margen Consumido</div>
                <div className="font-mono-num text-[18px] font-bold text-[#F5B544]">
                  {brokerData.primaryAccount.margin !== null
                    ? `$ ${fmtNum(brokerData.primaryAccount.margin, 2)}`
                    : '—'}
                </div>
                <div className="text-[11px] text-[var(--text-secondary)]">
                  Mov. Pendientes:{' '}
                  {brokerData.primaryAccount.pendingMovementsArs !== null
                    ? `$ ${fmtNum(brokerData.primaryAccount.pendingMovementsArs, 2)}`
                    : '—'}
                </div>
              </div>
              <div className="qc-card p-4 space-y-1">
                <div className="text-[11px] text-[var(--text-tertiary)]">Conector BMB ({bmbLabel})</div>
                <div className="font-mono-num text-[16px] font-bold text-[#38BDF8]">
                  {brokerData.bmbStatus}
                </div>
                <div className="text-[11px] text-[var(--text-secondary)] truncate">
                  {brokerData.bmbStatus === 'READY'
                    ? 'HomeBroker SignalR activo (127.0.0.1:8788)'
                    : 'Degradado explícito (solo lectura)'}
                </div>
              </div>
            </div>
          )}

          <div className="qc-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-right font-mono-num text-[12px]">
                <thead>
                  <tr className="bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                    <th className="py-2.5 px-3 text-left">Instrumento</th>
                    <th className="py-2.5 px-2.5 text-left">Mercado</th>
                    <th className="py-2.5 px-2.5">Compra</th>
                    <th className="py-2.5 px-2.5">Venta</th>
                    <th className="py-2.5 px-2.5">Neto</th>
                    <th className="py-2.5 px-2.5">Precio Compra</th>
                    <th className="py-2.5 px-2.5">Precio Venta</th>
                    <th className="py-2.5 px-2.5">Diff. Diaria</th>
                    <th className="py-2.5 px-2.5">Diff. Total</th>
                    <th className="py-2.5 px-3 text-left">Fuente</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {brokerData && brokerData.positions.length > 0 ? (
                    brokerData.positions.map((pos, idx) => (
                      <tr key={`${pos.symbol}-${String(idx)}`} className="h-10 hover:bg-[var(--surface-2)]">
                        <td className="px-3 text-left font-bold text-[var(--text-primary)]">
                          <div className="flex items-center gap-2">
                            <CompanyLogo ticker={pos.symbol} size="sm" />
                            <span>{pos.symbol}</span>
                          </div>
                        </td>
                        <td className="px-2.5 text-left text-[var(--text-secondary)]">{pos.marketId ?? 'ROFX'}</td>
                        <td className="px-2.5 text-[#2EDC7E]">{pos.buySize.toLocaleString('es-AR')}</td>
                        <td className="px-2.5 text-[#FF5C63]">{pos.sellSize.toLocaleString('es-AR')}</td>
                        <td className={`px-2.5 font-bold ${pos.netSize >= 0 ? 'text-[#2EDC7E]' : 'text-[#FF5C63]'}`}>
                          {pos.netSize.toLocaleString('es-AR')}
                        </td>
                        <td className="px-2.5 text-[var(--text-secondary)]">
                          {pos.buyPrice !== null ? `$ ${fmtNum(pos.buyPrice, 2)}` : '—'}
                        </td>
                        <td className="px-2.5 text-[var(--text-secondary)]">
                          {pos.sellPrice !== null ? `$ ${fmtNum(pos.sellPrice, 2)}` : '—'}
                        </td>
                        <td className="px-2.5 text-[var(--text-primary)]">
                          {pos.totalDailyDiffArs !== null ? `$ ${fmtNum(pos.totalDailyDiffArs, 2)}` : '—'}
                        </td>
                        <td className="px-2.5 text-[var(--text-primary)]">
                          {pos.totalDiffArs !== null ? `$ ${fmtNum(pos.totalDiffArs, 2)}` : '—'}
                        </td>
                        <td className="px-3 text-left text-[11px] text-[#38BDF8]">{pos.source}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={10} className="py-8 text-center font-sans text-[12px] text-[var(--text-tertiary)]">
                        {brokerLoading
                          ? 'Consultando getPositions / accountReport en Primary...'
                          : `Sin posiciones abiertas en cuenta ${primaryLabel} (o conector deshabilitado).`}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* MÓDULO ESPACIOS MULTIMONITOR, ALERTAS Y CONFIGURACIÓN / DESIGN SYSTEM */
export const WorkspacesModule: React.FC<{ onNavigate: (p: string) => void }> = ({ onNavigate }) => {
  const layouts = [
    {
      name: 'Mesa de Opciones y Volatilidad (2560px Dual)',
      desc: 'Cadena GGAL + Sonrisa de Volatilidad + Caja de 5 puntas + Matriz de Spreads en vivo.',
      target: 'opciones',
      modules: 4,
    },
    {
      name: 'Arbitraje Renta Fija & Sintéticos USD',
      desc: 'Curva Soberana HD + LECAPs + Futuros Rofex + Ratio GD30/AL30 con Z-Score.',
      target: 'bonos',
      modules: 4,
    },
    {
      name: 'Macro Argentina + Wall Street ADR Monitor',
      desc: 'Tarjetas Macro (Brecha, Reservas, IPC) + Mapa de Calor S&P 500 y CEDEARs.',
      target: 'macro',
      modules: 5,
    },
  ];
  return (
    <div className="space-y-4 animate-module">
      <InsightBanner tag="Espacios de Trabajo">
        Configuraciones de pantalla guardadas para pantallas de 1440p, 1920p y setups multimonitor de 2560px.
      </InsightBanner>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {layouts.map((l) => (
          <div key={l.name} className="qc-card qc-card-interactive p-4 flex flex-col justify-between gap-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <LayoutGrid className="w-5 h-5 text-[var(--accent-primary)]" />
                <span className="text-[11px] font-mono-num text-[var(--text-tertiary)]">
                  {l.modules} paneles sincronizados
                </span>
              </div>
              <h3 className="text-[15px] font-bold text-[var(--text-primary)]">{l.name}</h3>
              <p className="text-[12px] text-[var(--text-secondary)]">{l.desc}</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate(l.target)}
              className="qc-cta-primary py-2 rounded-[8px] text-[12px] font-semibold cursor-pointer"
            >
              Activar Espacio
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export const AlertsModule: React.FC<{
  alerts: AlertItem[];
  onAddAlert: (a: AlertItem) => void;
}> = ({ alerts, onAddAlert }) => {
  const [ticker, setTicker] = useState('GGAL');
  const [cond, setCond] = useState('Precio supera umbral de');
  const [target, setTarget] = useState('$ 6.600,00');

  return (
    <div className="space-y-4 animate-module">
      <div className="qc-card p-4 flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-[14px] font-bold text-[var(--text-primary)]">
            Crear Nueva Regla de Alerta Cuantitativa
          </h3>
          <p className="text-[12px] text-[var(--text-secondary)]">
            Monitoreo en tiempo real sobre precios, volatilidad implícita, Z-score de ratios y tasas de caución.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            className="w-24 px-2.5 py-1.5 rounded-[8px] bg-[var(--surface-2)] border border-[var(--border-strong)] font-mono-num text-[var(--text-primary)]"
            placeholder="Ticker"
          />
          <select
            value={cond}
            onChange={(e) => setCond(e.target.value)}
            className="px-2.5 py-1.5 rounded-[8px] bg-[var(--surface-2)] border border-[var(--border-strong)] text-[var(--text-primary)]"
          >
            <option>Precio supera umbral de</option>
            <option>Volatilidad Implícita ATM &lt;</option>
            <option>Volumen relativo intradiario &gt;</option>
            <option>Z-Score de arbitraje supera</option>
          </select>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-36 px-2.5 py-1.5 rounded-[8px] bg-[var(--surface-2)] border border-[var(--border-strong)] font-mono-num text-[var(--text-primary)]"
          />
          <button
            type="button"
            onClick={() =>
              onAddAlert({
                id: `al-${Date.now()}`,
                ticker,
                condition: cond,
                target,
                currentValue: 'En monitoreo',
                status: 'Activa',
                priority: 'Alta',
              })
            }
            className="qc-cta-primary px-3 py-1.5 rounded-[8px] font-semibold inline-flex items-center gap-1 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> Crear Alerta
          </button>
        </div>
      </div>

      <div className="qc-card overflow-hidden">
        <table className="w-full border-collapse text-left text-[12px]">
          <thead>
            <tr className="bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
              <th className="py-2.5 px-3">Estado</th>
              <th className="py-2.5 px-3">Especie / Par</th>
              <th className="py-2.5 px-3">Condición</th>
              <th className="py-2.5 px-3">Umbral Objetivo</th>
              <th className="py-2.5 px-3">Valor Actual</th>
              <th className="py-2.5 px-3">Hora de Disparo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-subtle)]">
            {alerts.map((a) => (
              <tr key={a.id} className="h-10 hover:bg-[var(--surface-2)]">
                <td className="px-3">
                  <span
                    className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                      a.status === 'Disparada'
                        ? 'bg-[#35280F] text-[#F5B544] border border-[#F5B544]/40'
                        : 'bg-[#0E2F20] text-[#2EDC7E] border border-[#1C5C3C]'
                    }`}
                  >
                    {a.status}
                  </span>
                </td>
                <td className="px-3 font-mono-num font-bold text-[var(--text-primary)]">{a.ticker}</td>
                <td className="px-3 text-[var(--text-secondary)]">{a.condition}</td>
                <td className="px-3 font-mono-num font-semibold text-[var(--text-primary)]">{a.target}</td>
                <td className="px-3 font-mono-num text-[#4BA3FF]">{a.currentValue}</td>
                <td className="px-3 font-mono-num text-[var(--text-tertiary)]">{a.triggeredAt ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export const SettingsAndDesignSystemModule: React.FC<{
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  density: 'densa' | 'normal' | 'comoda';
  onChangeDensity: (d: 'densa' | 'normal' | 'comoda') => void;
  liveTicksEnabled: boolean;
  onToggleLiveTicks: () => void;
}> = ({
  theme,
  onToggleTheme,
  density,
  onChangeDensity,
  liveTicksEnabled,
  onToggleLiveTicks,
}) => {
  const colorTokens = [
    { name: 'bg/app', hex: '#08080D', desc: 'Fondo general' },
    { name: 'bg/sidebar', hex: '#0C0C13', desc: 'Sidebar y TopBar' },
    { name: 'surface/1', hex: '#11111A', desc: 'Tarjeta base' },
    { name: 'surface/2', hex: '#171722', desc: 'Tarjeta elevada / hover' },
    { name: 'accent/primary', hex: '#8B7CF6', desc: 'Selección y foco' },
    { name: 'pos/fg', hex: '#2EDC7E', desc: 'Suba y ganancia' },
    { name: 'neg/fg', hex: '#FF5C63', desc: 'Baja y pérdida' },
    { name: 'warn/fg', hex: '#F5B544', desc: 'Alertas y VWAP' },
    { name: 'call/fg', hex: '#4BA3FF', desc: 'Opciones Call' },
    { name: 'put/fg', hex: '#E5558F', desc: 'Opciones Put' },
    { name: 'gauge/cheap', hex: '#3F9B5F', desc: 'Valuación Barata' },
    { name: 'gauge/rich', hex: '#A88A2A', desc: 'Valuación Cara' },
  ];

  return (
    <div className="space-y-4 animate-module">
      <div className="qc-card p-4 space-y-4">
        <h3 className="text-[15px] font-bold text-[var(--text-primary)]">
          Preferencias Globales de Terminal y Accesibilidad
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-[13px]">
          <div className="p-3.5 rounded-[10px] bg-[var(--surface-2)] border border-[var(--border-subtle)] flex items-center justify-between">
            <div>
              <div className="font-semibold text-[var(--text-primary)]">Modo de Color (`Terminal / Color`)</div>
              <div className="text-[11px] text-[var(--text-tertiary)]">Dark (#08080D) o Light (#F4F5FA)</div>
            </div>
            <button
              type="button"
              onClick={onToggleTheme}
              className="px-3 py-1.5 rounded-[8px] font-semibold bg-[var(--accent-primary)] text-white cursor-pointer"
            >
              {theme === 'dark' ? 'Modo Dark Activo' : 'Modo Light Activo'}
            </button>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[var(--surface-2)] border border-[var(--border-subtle)] flex items-center justify-between">
            <div>
              <div className="font-semibold text-[var(--text-primary)]">Densidad de Tablas</div>
              <div className="text-[11px] text-[var(--text-tertiary)]">Altura de fila: 32px · 36px · 44px</div>
            </div>
            <div className="flex gap-1">
              {(['densa', 'normal', 'comoda'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => onChangeDensity(d)}
                  className={`px-2 py-1 rounded text-[11px] font-semibold capitalize cursor-pointer ${
                    density === d
                      ? 'bg-[var(--accent-primary)] text-white'
                      : 'bg-[var(--surface-3)] text-[var(--text-secondary)]'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[var(--surface-2)] border border-[var(--border-subtle)] flex items-center justify-between">
            <div>
              <div className="font-semibold text-[var(--text-primary)]">Simulación de Ticks en Vivo</div>
              <div className="text-[11px] text-[var(--text-tertiary)]">Destello 600ms + roll vertical 140ms</div>
            </div>
            <button
              type="button"
              onClick={onToggleLiveTicks}
              className={`px-3 py-1.5 rounded-[8px] font-semibold cursor-pointer ${
                liveTicksEnabled
                  ? 'bg-[#0E2F20] text-[#2EDC7E] border border-[#1C5C3C]'
                  : 'bg-[var(--surface-3)] text-[var(--text-secondary)]'
              }`}
            >
              {liveTicksEnabled ? 'En Vivo (Activo)' : 'Pausado'}
            </button>
          </div>
        </div>
      </div>

      {/* Catálogo de Tokens de Figma (Sección 4 del Informe) */}
      <div className="qc-card p-4 space-y-3">
        <h3 className="text-[14px] font-bold text-[var(--text-primary)]">
          Tokens del Sistema de Diseño (`Terminal / Color`, Tipografía Manrope + Mono Tabular y Elevación)
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2.5">
          {colorTokens.map((t) => (
            <div
              key={t.name}
              className="p-2.5 rounded-[10px] bg-[var(--surface-2)] border border-[var(--border-subtle)] flex flex-col gap-1.5"
            >
              <div
                className="w-full h-8 rounded-[6px] border border-white/10"
                style={{ backgroundColor: t.hex }}
              />
              <div className="font-mono-num text-[11px] font-bold text-[var(--text-primary)]">{t.name}</div>
              <div className="font-mono-num text-[10px] text-[var(--text-tertiary)]">
                {t.hex} · {t.desc}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
