import React, { useEffect, useState } from 'react';
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
  BONDS_DATA,
  GGAL_OPTION_EXPIRIES,
  MACRO_CARDS,
  US_MARKET_DATA,
  ROFEX_FUTURES,
  CAUCIONES_DATA,
  RATIO_PAIRS,
  PortfolioPosition,
  AlertItem,
  fmtNum,
  fmtPct,
  fmtMoneyCompact,
} from '../data/marketData';
import {
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
  RangeBar,
  MiniSparkline,
  KPICard,
  HeatTile,
} from './DesignSystem';

export type MonitorSubPanel = 'acciones' | 'bonos' | 'cedears' | 'cauciones';

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
  const cclMedian = liveMarket.overview?.cclMedian ?? GLOBAL_INDICATORS.find((g) => g.id === 'ccl')?.value ?? null;
  const embiVal = GLOBAL_INDICATORS.find((g) => g.id === 'embi')?.value ?? Number.NaN;
  const validTirs = BONDS_DATA.map((b) => b.tir).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const medianTir =
    validTirs.length > 0 ? validTirs[Math.floor(validTirs.length / 2)] ?? Number.NaN : Number.NaN;
  const totalVolM = AR_STOCKS.reduce((acc, s) => (Number.isFinite(s.volumeM) ? acc + s.volumeM : acc), 0);
  const advCount = AR_STOCKS.filter((s) => Number.isFinite(s.deltaPct) && s.deltaPct > 0).length;
  const decCount = AR_STOCKS.filter((s) => Number.isFinite(s.deltaPct) && s.deltaPct < 0).length;
  const deltaFinite = AR_STOCKS.filter((s) => Number.isFinite(s.deltaPct)).map((s) => s.deltaPct);
  const avgDelta = deltaFinite.length > 0 ? deltaFinite.reduce((a, b) => a + b, 0) / deltaFinite.length : Number.NaN;
  const frontOpt = GGAL_OPTION_EXPIRIES[0];

  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant={Number.isFinite(avgDelta) && avgDelta < 0 ? 'neg' : 'pos'} tag="Resumen de Rueda">
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
          subtitle={`MEP: ${fmtNum(liveMarket.overview?.mepMedian, 2)} | Canje: ${fmtPct(liveMarket.overview?.mepCclGapPct, 2)}`}
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
          heroValue={frontOpt && Number.isFinite(frontOpt.atmIV) ? `${fmtNum(frontOpt.atmIV, 1)} %` : '—'}
          badge={frontOpt?.id ?? 'SIN CADENA'}
          subtitle={
            frontOpt
              ? `Vto ${frontOpt.daysToExpiry}d · Tasa Ref: ${fmtNum(frontOpt.syntheticRateTNA, 1)} % TNA`
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
          {AR_STOCKS.map((st) => (
            <HeatTile
              key={st.ticker}
              ticker={st.ticker}
              color={st.color}
              deltaPct={st.deltaPct}
              price={Number.isFinite(st.last) ? `$${fmtNum(st.last, st.last < 1000 ? 1 : 0)}` : '—'}
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
            {AR_GENERAL_PANEL_STOCKS.map((st) => (
              <HeatTile
                key={st.ticker}
                ticker={st.ticker}
                color={st.color}
                deltaPct={st.deltaPct}
                price={Number.isFinite(st.last) ? `$${fmtNum(st.last, st.last < 1000 ? 1 : 0)}` : '—'}
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

  useEffect(() => {
    void requestMonitoringPanel(subPanel);
  }, [subPanel]);

  const rowH =
    density === 'densa' ? 'h-8 text-[12px]' : density === 'comoda' ? 'h-11 text-[13px]' : 'h-9 text-[12px]';

  const panels: { id: MonitorSubPanel; label: string; count: number }[] = [
    { id: 'acciones', label: 'Acciones Líderes', count: AR_STOCKS.length },
    { id: 'bonos', label: 'Bonos y Letras', count: BONDS_DATA.length },
    { id: 'cedears', label: 'CEDEARs y ADRs', count: US_MARKET_DATA.length },
    { id: 'cauciones', label: 'Cauciones por Plazo', count: CAUCIONES_DATA.length },
  ];

  const stockDeltas = AR_STOCKS.map((s) => s.deltaPct).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const medianStockDelta = stockDeltas.length > 0 ? stockDeltas[Math.floor(stockDeltas.length / 2)] : Number.NaN;
  const stockAdv = stockDeltas.filter((d) => d > 0).length;
  const cclMedian = liveMarket.monitoring?.cclMedian ?? liveMarket.overview?.cclMedian ?? null;

  return (
    <div className="space-y-4 animate-module">
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
          <InsightBanner variant="warn" tag="Liquidez / Cauciones">
            {CAUCIONES_DATA.length > 0
              ? `Tasas de caución BYMA (${CAUCIONES_DATA.length} plazos activos).`
              : `Sin feed gratuito directo de libro de cauciones BYMA · Tasa BADLAR BCRA: ${fmtNum(
                  liveMarket.monitoring?.badlarTna ?? liveMarket.macro?.variables.badlarTna,
                  2
                )} % TNA.`}
          </InsightBanner>
        )}
      </div>

      {/* TABLA 1: ACCIONES CON LOGOS, RANGO DEL DÍA, SEÑAL Y MÚLTIPLO DE VOLUMEN */}
      {subPanel === 'acciones' && (
        <div className="qc-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-right">
              <thead>
                <tr className="bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                  <th className="py-2.5 px-4 text-left">Especie / Papel</th>
                  <th className="py-2.5 px-4">Último ARS</th>
                  <th className="py-2.5 px-4">Variación</th>
                  <th className="py-2.5 px-4">Tendencia</th>
                  <th className="py-2.5 px-4">Volumen / Múltiplo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {AR_STOCKS.map((s) => (
                  <tr
                    key={s.ticker}
                    onClick={() => onSelectStock(s.ticker)}
                    className={`${rowH} hover:bg-[var(--surface-2)] transition-colors cursor-pointer`}
                  >
                    <td className="px-4 text-left">
                      <div className="flex items-center gap-2.5">
                        <span
                          className="w-6 h-6 rounded-full inline-flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                          style={{ backgroundColor: s.color }}
                        >
                          {s.ticker.slice(0, 2)}
                        </span>
                        <div>
                          <div className="font-mono-num font-bold text-[var(--text-primary)] leading-tight">
                            {s.ticker}
                          </div>
                          <div className="text-[11px] text-[var(--text-tertiary)] truncate max-w-[220px]">
                            {s.name}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4">
                      <PriceCell
                        value={s.last}
                        decimals={2}
                        flashDirection={tickFlashes[s.ticker] ?? null}
                        className="font-bold text-[var(--text-primary)]"
                      />
                    </td>
                    <td className="px-4">
                      <DeltaPill value={s.deltaPct} size="sm" />
                    </td>
                    <td className="px-4">
                      <div className="flex justify-end">
                        <MiniSparkline data={s.sparkline} positive={s.deltaPct >= 0} width={68} height={22} />
                      </div>
                    </td>
                    <td className="px-4 font-mono-num">
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="text-[var(--text-primary)]">{fmtMoneyCompact(s.volumeM)}</span>
                        <span
                          className={`text-[11px] font-semibold ${
                            s.volMultiple >= 1.8
                              ? 'text-[#8B7CF6]'
                              : 'text-[var(--text-tertiary)]'
                          }`}
                        >
                          {fmtNum(s.volMultiple, 1)}×
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
                  const rows = BONDS_DATA.filter((b) => b.tranche === group);
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
                              {Number.isFinite(b.price)
                                ? `${b.currency === 'ARS' ? '$ ' : 'US$ '}${fmtNum(b.price, 2)}`
                                : '—'}
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

      {/* TABLA 3: CEDEARS Y CONVERSIÓN CCL */}
      {subPanel === 'cedears' && (
        <div className="rounded-[10px] bg-[#131722] border border-[#232733] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-right">
              <thead>
                <tr className="bg-[#0B0E14] border-b border-[#232733] text-[10px] font-semibold uppercase tracking-[0.06em] text-[#787B86]">
                  <th className="py-2.5 px-3.5 text-left">Ticker / Compañía</th>
                  <th className="py-2.5 px-2 text-left">Sector</th>
                  <th className="py-2.5 px-2.5">Precio NYSE (USD)</th>
                  <th className="py-2.5 px-2.5">Var. USD</th>
                  <th className="py-2.5 px-2.5">Ratio Conv.</th>
                  <th className="py-2.5 px-2.5">CEDEAR BYMA (ARS)</th>
                  <th className="py-2.5 px-2.5">CCL Implícito</th>
                  <th className="py-2.5 px-2.5">VI 30d</th>
                  <th className="py-2.5 px-2.5">Vol. Relativo</th>
                  <th className="py-2.5 px-3.5 text-left">Señal / Radar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E222D] font-mono-num">
                {US_MARKET_DATA.map((u) => (
                  <tr
                    key={u.ticker}
                    onClick={() =>
                      onOpenOrderTicket({
                        ticker: u.ticker,
                        side: 'Compra',
                        price: u.cedearArsPrice,
                        qty: 10,
                        instrumentLabel: `CEDEAR ${u.name} (Ratio ${u.cedearRatio})`,
                      })
                    }
                    className={`${rowH} hover:bg-[#181C27] transition-colors cursor-pointer`}
                  >
                    <td className="px-3.5 text-left">
                      <div className="flex items-center gap-2.5">
                        <span
                          className="w-6 h-6 rounded-full inline-flex items-center justify-center text-[9.5px] font-extrabold text-white shrink-0"
                          style={{ backgroundColor: u.color }}
                        >
                          {u.ticker.slice(0, 2)}
                        </span>
                        <div>
                          <div className="font-bold text-[#FFFFFF] leading-tight">{u.ticker}</div>
                          <div className="text-[11px] font-sans text-[#787B86] truncate max-w-[165px]">
                            {u.name}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 text-left font-sans text-[11.5px] text-[#787B86]">
                      {u.sector}
                    </td>
                    <td className="px-2.5 font-bold text-[#FFFFFF]">
                      {Number.isFinite(u.price) ? `US$ ${fmtNum(u.price, 2)}` : '—'}
                    </td>
                    <td className="px-2.5">
                      <DeltaPill value={u.deltaPct} size="sm" />
                    </td>
                    <td className="px-2.5 text-[#9CA3AF]">{u.cedearRatio}</td>
                    <td className="px-2.5 font-bold text-[#38BDF8]">
                      {Number.isFinite(u.cedearArsPrice) ? `$ ${fmtNum(u.cedearArsPrice, 0)}` : '—'}
                    </td>
                    <td className="px-2.5 text-[#D1D4DC]">
                      {Number.isFinite(u.cedearArsPrice) && Number.isFinite(u.price) && u.price > 0
                        ? `$ ${fmtNum((u.cedearArsPrice * u.cedearRatioNum) / u.price, 2)}`
                        : '—'}
                    </td>
                    <td className="px-2.5 text-[#9CA3AF]">
                      {Number.isFinite(u.iv30d) ? `${fmtNum(u.iv30d, 1)} %` : '—'}
                    </td>
                    <td className="px-2.5">
                      <span
                        className={`text-[11.5px] font-semibold ${
                          u.volMultiple >= 1.5 ? 'text-[#8B7CF6]' : 'text-[#787B86]'
                        }`}
                      >
                        {fmtNum(u.volMultiple, 1)}×
                      </span>
                    </td>
                    <td className="px-3.5 text-left font-sans text-[12px] text-[#9CA3AF]">
                      {u.signal}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                  <th className="py-2.5 px-3 text-left">Participación de Volumen</th>
                  <th className="py-2.5 px-3">Monto Operado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {CAUCIONES_DATA.map((c) => (
                  <tr key={c.termDays} className={`${rowH} hover:bg-[var(--surface-2)]`}>
                    <td className="px-3 text-left font-bold text-[var(--text-primary)]">
                      {c.termDays} {c.termDays === 1 ? 'día hábil' : 'días'}
                    </td>
                    <td className="px-2.5 text-[var(--text-secondary)]">{c.currency}</td>
                    <td className="px-2.5 font-bold text-[#8B7CF6]">{fmtNum(c.tnaWeighted, 2)} %</td>
                    <td className="px-2.5 text-[var(--text-primary)]">{fmtNum(c.teaEffective, 2)} %</td>
                    <td className="px-2.5 text-[#2EDC7E]">{fmtNum(c.bidTna, 2)} %</td>
                    <td className="px-2.5 text-[#FF5C63]">{fmtNum(c.askTna, 2)} %</td>
                    <td className="px-3 text-left">
                      <div className="flex items-center gap-2">
                        <div className="w-28 h-2 rounded-full bg-[var(--surface-3)] overflow-hidden">
                          <div
                            style={{ width: `${c.shareOfTotalPct}%` }}
                            className="h-full bg-[#2EDC7E]"
                          />
                        </div>
                        <span className="text-[11px] text-[var(--text-secondary)]">
                          {fmtNum(c.shareOfTotalPct, 1)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-3 font-semibold text-[var(--text-primary)]">
                      {fmtMoneyCompact(c.volumeM)}
                    </td>
                  </tr>
                ))}
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
  const [selectedSector, setSelectedSector] = useState<string>('Todos');
  const [searchQ, setSearchQ] = useState<string>('');

  useEffect(() => {
    void Promise.all([
      requestUsSnapshot('SPY'),
      requestUsSnapshot('QQQ'),
      requestUsSnapshot('IWM'),
      requestUsSnapshot('MSFT'),
      requestUsSnapshot('AMZN'),
      requestUsSnapshot('TSLA'),
    ]);
  }, []);

  const sectors = [
    'Todos',
    'Mega Caps / Tech',
    'Finanzas',
    'Consumo',
    'Energía',
    'Salud',
    'Industrial',
    'Índices / ETF',
  ];

  const filteredUS = US_MARKET_DATA.filter((item) => {
    const matchSec = selectedSector === 'Todos' || item.sector === selectedSector;
    const q = searchQ.trim().toLowerCase();
    const matchQ =
      !q || item.ticker.toLowerCase().includes(q) || item.name.toLowerCase().includes(q);
    return matchSec && matchQ;
  });

  const spy = US_MARKET_DATA.find((u) => u.ticker === 'SPY');
  const qqq = US_MARKET_DATA.find((u) => u.ticker === 'QQQ');
  const iwm = US_MARKET_DATA.find((u) => u.ticker === 'IWM');
  const spyCtx = liveMarket.usSnapshotsBySymbol['SPY']?.marketContext;
  const ust10y = spyCtx?.treasury?.yield10Y ?? null;
  const ust2y = spyCtx?.treasury?.yield2Y ?? null;
  const slope2s10s =
    ust10y !== null && ust2y !== null && Number.isFinite(ust10y) && Number.isFinite(ust2y)
      ? Math.round((ust10y - ust2y) * 100)
      : null;
  const vixVal = spyCtx?.vixLevel ?? GLOBAL_INDICATORS.find((g) => g.id === 'vix')?.value ?? Number.NaN;
  const vixDelta = GLOBAL_INDICATORS.find((g) => g.id === 'vix')?.deltaPct;

  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant="default" tag="Wall Street en Vivo">
        SPY:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">
          {spy && Number.isFinite(spy.price) ? `US$ ${fmtNum(spy.price, 2)}` : '—'}
        </strong>{' '}
        ({fmtPct(spy?.deltaPct, 2)}) · QQQ:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">{fmtPct(qqq?.deltaPct, 2)}</strong> · VIX:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">{fmtNum(vixVal, 2)}</strong> · UST 10Y:{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">{fmtPct(ust10y, 2, false)}</strong>.
      </InsightBanner>

      {/* Estructura superior de 5 índices macro alargados */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard
          title="S&P 500 (SPY)"
          heroValue={spy && Number.isFinite(spy.price) ? `US$ ${fmtNum(spy.price, 2)}` : '—'}
          deltaPct={spy?.deltaPct}
          subtitle={`CEDEAR SPY: $ ${fmtNum(spy?.cedearArsPrice, 0)} · Ratio 20:1`}
        />
        <KPICard
          title="Nasdaq 100 (QQQ)"
          heroValue={qqq && Number.isFinite(qqq.price) ? `US$ ${fmtNum(qqq.price, 2)}` : '—'}
          deltaPct={qqq?.deltaPct}
          subtitle={`CEDEAR QQQ: $ ${fmtNum(qqq?.cedearArsPrice, 0)} · Ratio 20:1`}
        />
        <KPICard
          title="Russell 2000 (IWM)"
          heroValue={iwm && Number.isFinite(iwm.price) ? `US$ ${fmtNum(iwm.price, 2)}` : '—'}
          deltaPct={iwm?.deltaPct}
          subtitle={`CEDEAR IWM: $ ${fmtNum(iwm?.cedearArsPrice, 0)} · Ratio 10:1`}
        />
        <KPICard
          title="US Treasury 10Y Yield"
          heroValue={ust10y !== null && Number.isFinite(ust10y) ? `${fmtNum(ust10y, 2)} %` : '—'}
          subtitle={`Spread 2Y/10Y: ${slope2s10s !== null ? `${slope2s10s >= 0 ? '+' : ''}${slope2s10s} pb` : '—'}`}
        />
        <KPICard
          title="CBOE VIX (Volatilidad S&P)"
          heroValue={fmtNum(vixVal, 2)}
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
        const strongCent = te?.confluenceClusters?.strongestClusterCentroid ?? null;
        const strongScore = te?.confluenceClusters?.strongestClusterStrength ?? null;
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
              <div className="text-[13px] font-bold text-[#FFFFFF]">
                Curva Tasas EE.UU. &amp; Lectura Cuantitativa SPY (Piezas 15–18)
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
                <span className="px-2 py-0.5 rounded bg-[#0B0E14] border border-[#232733] text-[#D1D4DC]">
                  {spySnap?.feedMode ?? 'SIN FEED'}
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
                  CONFLUENCIA &lt; 0.15 ATR
                </div>
                <div className="font-mono-num text-[15px] font-bold text-[#38BDF8]">
                  {strongCent != null && Number.isFinite(strongCent)
                    ? `$ ${fmtNum(strongCent, 2)} (${strongScore != null ? fmtNum(strongScore, 0) : '—'})`
                    : '—'}
                </div>
                <div className="text-[11px] font-mono-num text-[#9CA3AF]">
                  RS ({rsClass}): {rsSpread != null && Number.isFinite(rsSpread) ? fmtPct(rsSpread * 100, 2) : '—'}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Universo de Acciones más líquidas (Heat Tiles apaisadas segmentables por sector) */}
      <div className="rounded-[10px] bg-[#131722] border border-[#232733] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-bold text-[#FFFFFF] tracking-tight">
              Top Acciones Más Líquidas de EE.UU. (NYSE / NASDAQ)
            </h3>
            <p className="text-[11.5px] text-[#787B86]">
              Click en cualquier acción para operar su CEDEAR o inspeccionar paridad CCL implícita
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="Filtrar ticker (NVDA, AAPL...)"
              className="px-3 py-1.5 rounded-[8px] bg-[#0B0E14] border border-[#232733] text-[12px] text-[#FFFFFF] placeholder:text-[#787B86] outline-none focus:border-[#3B82F6]"
            />
            <div className="flex items-center gap-1 bg-[#0B0E14] p-1 rounded-[8px] border border-[#232733] overflow-x-auto">
              {sectors.map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setSelectedSector(sec)}
                  className={`px-2.5 py-1 rounded-[6px] text-[11px] font-semibold cursor-pointer whitespace-nowrap transition-colors ${
                    selectedSector === sec
                      ? 'bg-[#1F2637] text-[#FFFFFF]'
                      : 'text-[#787B86] hover:text-[#D1D4DC]'
                  }`}
                >
                  {sec}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2.5">
          {filteredUS.map((item) => (
            <HeatTile
              key={item.ticker}
              ticker={item.ticker}
              color={item.color}
              deltaPct={item.deltaPct}
              price={Number.isFinite(item.price) ? `US$ ${fmtNum(item.price, 2)}` : '—'}
              subtitle={
                Number.isFinite(item.volMultiple)
                  ? `${fmtNum(item.volMultiple, 1)}x`
                  : Number.isFinite(item.cedearArsPrice)
                  ? `$${fmtNum(item.cedearArsPrice, 0)}`
                  : '—'
              }
              onClick={() =>
                onOpenOrderTicket({
                  ticker: item.ticker,
                  side: 'Compra',
                  price: item.cedearArsPrice,
                  qty: 10,
                  instrumentLabel: `CEDEAR ${item.name} (Ratio ${item.cedearRatio})`,
                })
              }
            />
          ))}
        </div>
      </div>
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
export const FuturesModule: React.FC = () => {
  const liveMarket = useLiveMarketState();
  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant="warn" tag="Curva Rofex / Sintético USD">
        {ROFEX_FUTURES.length > 0
          ? `Contratos activos de dólar futuro (${ROFEX_FUTURES.length} vencimientos).`
          : `Sin feed gratuito directo de MATBA-ROFEX en el runtime (${liveMarket.feedStatus}). Referencia TC Mayorista A3500 BCRA: ${
              liveMarket.macro?.variables.a3500 != null ? `$ ${fmtNum(liveMarket.macro.variables.a3500, 2)}` : '—'
            }.`}
      </InsightBanner>

      <div className="qc-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-right font-mono-num text-[12px]">
            <thead>
              <tr className="bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                <th className="py-2.5 px-3 text-left">Contrato Rofex</th>
                <th className="py-2.5 px-2.5">Vencimiento</th>
                <th className="py-2.5 px-2.5">Días</th>
                <th className="py-2.5 px-2.5">Ajuste ($)</th>
                <th className="py-2.5 px-2.5">Var. Día</th>
                <th className="py-2.5 px-2.5">Deval. Directa</th>
                <th className="py-2.5 px-2.5">TNA Implícita</th>
                <th className="py-2.5 px-2.5">TEA Implícita</th>
                <th className="py-2.5 px-2.5">LECAP Ref.</th>
                <th className="py-2.5 px-3 text-[#2EDC7E]">Tasa Sintética USD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {ROFEX_FUTURES.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-8 text-center font-sans text-[12px] text-[var(--text-tertiary)]">
                    No hay contratos Rofex en los conectores públicos gratuitos (Data912 / Open BYMA / BCRA). Todos los campos muestran — sin valores simulados.
                  </td>
                </tr>
              ) : (
                ROFEX_FUTURES.map((f) => (
                  <tr key={f.contract} className="h-9 hover:bg-[var(--surface-2)]">
                    <td className="px-3 text-left font-bold text-[var(--text-primary)]">{f.contract}</td>
                    <td className="px-2.5 text-[var(--text-secondary)]">{f.maturity}</td>
                    <td className="px-2.5 text-[var(--text-secondary)]">{f.days}d</td>
                    <td className="px-2.5 font-bold text-[var(--text-primary)]">$ {fmtNum(f.price, 1)}</td>
                    <td className="px-2.5">
                      <DeltaPill value={f.deltaPct} size="sm" />
                    </td>
                    <td className="px-2.5 text-[var(--text-secondary)]">{fmtPct(f.implicitDevalPct, 2)}</td>
                    <td className="px-2.5 font-semibold text-[#8B7CF6]">{fmtNum(f.tnaImplicit, 1)} %</td>
                    <td className="px-2.5 text-[var(--text-secondary)]">{fmtNum(f.teaImplicit, 1)} %</td>
                    <td className="px-2.5 text-[var(--text-secondary)]">
                      {f.lecapRefTicker} ({fmtNum(f.lecapTna, 1)}%)
                    </td>
                    <td className="px-3 font-bold text-[#2EDC7E]">{fmtPct(f.syntheticUsdRatePct, 2)} TNA</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

/* MÓDULO RELACIONES Y ARBITRAJES ESTADÍSTICOS */
export const RatiosModule: React.FC = () => {
  const liveMarket = useLiveMarketState();
  useEffect(() => {
    void requestRelations();
  }, []);

  const extremeCount = RATIO_PAIRS.filter((p) => Number.isFinite(p.zScore) && Math.abs(p.zScore) >= 1.5).length;

  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant="default" tag="Arbitraje Relativo">
        Monitoreando <strong className="text-[var(--text-primary)]">{RATIO_PAIRS.length} pares relativos</strong> (ventana
        60 ruedas) ·{' '}
        <strong className="text-[#F5B544]">
          {extremeCount} {extremeCount === 1 ? 'par' : 'pares'} fuera de banda (±1,5σ)
        </strong>{' '}
        ({liveMarket.feedStatus}).
      </InsightBanner>

      {RATIO_PAIRS.length === 0 ? (
        <div className="qc-card p-8 text-center text-[12px] text-[var(--text-tertiary)]">
          Cargando relaciones históricas de 60 ruedas desde /api/ar/relations ({liveMarket.feedStatus})...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {RATIO_PAIRS.map((pair) => (
            <div key={pair.id} className="qc-card qc-card-interactive p-4 flex flex-col justify-between gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--accent-primary)]">
                    {pair.category}
                  </span>
                  <h3 className="text-[15px] font-bold text-[var(--text-primary)]">{pair.pairTitle}</h3>
                </div>
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

              <div className="grid grid-cols-3 gap-2 p-2.5 rounded-[10px] bg-[var(--surface-2)] font-mono-num text-[12px]">
                <div>
                  <div className="text-[10px] text-[var(--text-tertiary)]">Valor Actual</div>
                  <div className="text-[16px] font-bold text-[var(--text-primary)]">
                    {fmtNum(pair.currentRatio, Number.isFinite(pair.currentRatio) && pair.currentRatio < 10 ? 2 : 0)}{' '}
                    {pair.unit}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--text-tertiary)]">Media 60d</div>
                  <div className="text-[14px] text-[var(--text-secondary)]">
                    {fmtNum(pair.mean90d, Number.isFinite(pair.mean90d) && pair.mean90d < 10 ? 2 : 0)} {pair.unit}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--text-tertiary)]">Percentil 60d</div>
                  <div className="text-[14px] font-semibold text-[#8B7CF6]">
                    {Number.isFinite(pair.percentile90d) ? `P${fmtNum(pair.percentile90d, 0)}` : '—'}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <p className="text-[12px] text-[var(--text-secondary)] leading-snug">{pair.recommendation}</p>
                <MiniSparkline data={pair.history} positive={!Number.isFinite(pair.zScore) || pair.zScore < 0} width={96} height={30} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/* MÓDULO POSICIONES (CARTERA Y RIESGO AGREGADO) */
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
  const totalVal = positions.reduce((acc, p) => acc + p.marketValueArs, 0);
  const totalPnlDay = positions.reduce((acc, p) => acc + p.pnlDayArs, 0);
  const totalTheta = positions.reduce((acc, p) => acc + p.thetaDayArs, 0);
  const dayPct = totalVal > 0 ? (totalPnlDay / totalVal) * 100 : Number.NaN;

  return (
    <div className="space-y-4 animate-module">
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
                  <td className="px-3 text-left font-bold text-[var(--text-primary)]">{p.ticker}</td>
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
