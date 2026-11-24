import React, { memo, useEffect, useMemo } from 'react';
import {
  AR_GENERAL_PANEL_STOCKS,
  AR_STOCKS,
  BONDS_DATA,
  GLOBAL_INDICATORS,
  fmtMoneyCompact,
  fmtNum,
  fmtPct,
} from '../data/marketData';
import {
  useLiveMacro,
  useLiveMarketStatus,
  useLiveOptionsSlice,
  useLiveOverview,
} from '../data/liveRuntimeBridge';
import {
  HelpTooltip,
  InsightBanner,
  KPICard,
} from './DesignSystem';
import { CompanyLogo } from './common/CompanyLogo';
import { LiveClockBadge } from './common/LiveClockBadge';
import {
  getAtomicMarketQuote,
  setVisibleMarketSymbols,
  tickFlashClass,
  useMarketLiveFx,
  useMarketScopedQuotesTick,
  useTickFlash,
} from '../api/useMarketLiveStream';

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
        <span className={`inline-block w-[62px] shrink-0 text-right font-mono-num tabular-nums text-[11px] ${tickFlashClass(flashDirection)}`}>
          {Number.isFinite(effectivePrice) ? '$' + fmtNum(effectivePrice, effectivePrice < 1000 ? 1 : 0) : price ?? '—'}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between w-full">
        <span className={`font-mono-num text-[12.5px] font-semibold ${pctColor}`}>
          {formattedPct}
        </span>
      </div>
    </button>
  );
};

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
  const overview = useLiveOverview();
  const macro = useLiveMacro();
  const { feedStatus } = useLiveMarketStatus();
  const ggal = useLiveOptionsSlice('AR:GGAL');
  const streamMeta = useMarketLiveFx();
  const quoteTick = useMarketScopedQuotesTick('AR');
  useEffect(() => {
    setVisibleMarketSymbols(
      [...AR_STOCKS, ...AR_GENERAL_PANEL_STOCKS].map(({ ticker }) => 'AR:' + ticker),
      'home',
    );
    return () => setVisibleMarketSymbols([], 'home');
  }, []);
  const liveLeaderStocks = useMemo(
    () =>
      AR_STOCKS.map((stock) => {
        const quote = getAtomicMarketQuote('AR', stock.ticker);
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
    [overview, quoteTick],
  );
  const liveGeneralStocks = useMemo(
    () =>
      AR_GENERAL_PANEL_STOCKS.map((stock) => {
        const quote = getAtomicMarketQuote('AR', stock.ticker);
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
    [overview, quoteTick],
  );
  const liveStreamFresh = streamMeta.isFresh;
  const cclMedian =
    (liveStreamFresh ? streamMeta.cclMedian : null) ??
    overview?.cclMedian ??
    macro?.variables.ccl ??
    GLOBAL_INDICATORS.find((g) => g.id === 'ccl')?.value ??
    null;
  const mepMedian =
    (liveStreamFresh ? streamMeta.mepMedian : null) ??
    overview?.mepMedian ??
    macro?.variables.mep ??
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
    liveStreamFresh && streamMeta.cclMedian !== null
      ? computedCanjePct
      : overview?.mepCclGapPct ??
        macro?.variables.canjePct ??
        computedCanjePct;
  const embiVal = GLOBAL_INDICATORS.find((g) => g.id === 'embi')?.value ?? Number.NaN;
  const validTirs = useMemo(() => BONDS_DATA.map((b) => b.tir).filter((v) => Number.isFinite(v)).sort((a, b) => a - b), [overview]);
  const medianTir =
    validTirs.length > 0 ? validTirs[Math.floor(validTirs.length / 2)] ?? Number.NaN : Number.NaN;
  const totalVolM = liveLeaderStocks.reduce((acc, s) => (Number.isFinite(s.volumeM) ? acc + s.volumeM : acc), 0);
  const advCount = liveLeaderStocks.filter((s) => Number.isFinite(s.deltaPct) && s.deltaPct > 0).length;
  const decCount = liveLeaderStocks.filter((s) => Number.isFinite(s.deltaPct) && s.deltaPct < 0).length;
  const deltaFinite = liveLeaderStocks.filter((s) => Number.isFinite(s.deltaPct)).map((s) => s.deltaPct);
  const avgDelta = deltaFinite.length > 0 ? deltaFinite.reduce((a, b) => a + b, 0) / deltaFinite.length : Number.NaN;
  const overviewExt = overview as
    | (typeof overview & {
        readonly atmIvPct?: number | null;
        readonly atmIvExpiryCode?: string | null;
        readonly atmIvExpiryLabel?: string | null;
        readonly atmIvDaysToExpiry?: number | null;
        readonly atmIvRateTnaPct?: number | null;
      })
    | null;
  // Pieza 50.3: la tarjeta héroe de Inicio lee SIEMPRE el subyacente AR:GGAL aislado.
  const ggalOptionExpiries = ggal.expiries;
  const ggalOptsMeta = ggal.options as
    | ({
        readonly primaryLiquidExpiryCode?: string | null;
        readonly rateTna?: number | null;
      })
    | undefined;
  const frontOpt =
    (ggalOptsMeta?.primaryLiquidExpiryCode
      ? ggalOptionExpiries.find((e) => e.id === ggalOptsMeta.primaryLiquidExpiryCode)
      : undefined) ??
    ggalOptionExpiries.find((e) => Number.isFinite(e.atmIV) && e.atmIV > 0) ??
    ggalOptionExpiries[0];
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
    <div data-qot-module-ready="inicio" className="space-y-4 animate-module">
      <InsightBanner variant={Number.isFinite(avgDelta) && avgDelta < 0 ? 'neg' : 'pos'} tag="Resumen de Rueda">
        <LiveClockBadge />{' '}
        Panel Líder BYMA promedio{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">{fmtPct(avgDelta, 2)}</strong> ({advCount} en alza ·{' '}
        {decCount} en baja) · Dólar CCL implícito:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">
          {cclMedian !== null && Number.isFinite(cclMedian) ? `$ ${fmtNum(cclMedian, 2)}` : '—'}
        </strong>{' '}
        · TIR mediana HD: <strong className="text-[#22C55E] font-mono-num">{fmtPct(medianTir, 2, false)}</strong> (
        {feedStatus}).
      </InsightBanner>

      {/* KPIs Héroe de Inicio */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KPICard
          title="Dólar CCL Mediano"
          heroValue={cclMedian !== null && Number.isFinite(cclMedian) ? `$ ${fmtNum(cclMedian, 2)}` : '—'}
          deltaPct={GLOBAL_INDICATORS.find((g) => g.id === 'ccl')?.deltaPct}
          badge={feedStatus}
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
