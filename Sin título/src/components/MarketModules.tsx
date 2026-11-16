import React, { useState } from 'react';
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
  AR_STOCKS,
  AR_GENERAL_PANEL_STOCKS,
  BONDS_DATA,
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
  tickFlashes: Record<string, 'up' | 'down' | null>;
  onSelectStock: (ticker: string) => void;
  onNavigate: (page: string) => void;
  onOpenOrderTicket: (preset: {
    ticker: string;
    side: 'Compra' | 'Venta';
    price: number;
    qty: number;
    instrumentLabel: string;
  }) => void;
}> = ({ tickFlashes, onSelectStock, onNavigate, onOpenOrderTicket }) => {
  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant="pos" tag="Resumen de Rueda">
        El S&P Merval avanza <strong className="text-[#22C55E] font-mono-num">+2,84 % en ARS</strong> y alcanza{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">US$ 1.948 CCL</strong> (+3,25 %) liderado por{' '}
        <strong className="text-[#22C55E]">Bancos (+3,9 %)</strong> · Los soberanos Globales comprimen{' '}
        <strong className="text-[#22C55E] font-mono-num">-41 pb de TIR</strong> en promedio y subieron de precio 14 de 15 especies.
      </InsightBanner>

      {/* KPIs Héroe de Inicio */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <KPICard
          title="S&P Merval en USD CCL"
          heroValue="US$ 1.948"
          deltaPct={3.25}
          badge="MÁX. 6 AÑOS"
          subtitle="En pesos: 2.276.840 pts | 15 en alza · 3 en baja"
          helpText="Índice S&P Merval dividido por el Dólar Contado con Liquidación implícito en ADRs."
          onClick={() => onNavigate('monitoreo')}
        />
        <KPICard
          title="TIR Mediana Soberanos HD"
          heroValue="11,32 %"
          deltaPct={-1.85}
          badge="-41 PB HOY"
          subtitle="Riesgo País: 742 pb | Spread Ley NY/AR: 77 pb"
          helpText="Tasa Interna de Retorno mediana de los bonos soberanos en dólares (AL29 a GD41)."
          onClick={() => onNavigate('bonos')}
        />
        <KPICard
          title="Volumen Relativo Merval"
          heroValue="$ 88,4 mil M"
          deltaPct={14.2}
          badge="1,9× HABITUAL"
          subtitle="GGAL y YPFD concentran el 38,8 % del flujo"
          helpText="Monto efectivo operado en acciones locales respecto de la mediana de 20 ruedas a igual hora."
          onClick={() => onNavigate('monitoreo')}
        />
        <KPICard
          title="VI Mediana Opciones GGAL"
          heroValue="51,4 %"
          deltaPct={-2.4}
          badge="PERCENTIL 22"
          subtitle="Percentil 22 anual · Sintético Jun: 34,8 % TNA"
          helpText="Volatilidad implícita ATM del vencimiento Junio comparada con su historia de 252 ruedas."
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
              price={`$${fmtNum(st.last, st.last < 1000 ? 1 : 0)}`}
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
                price={`$${fmtNum(st.last, st.last < 1000 ? 1 : 0)}`}
                onClick={() => onSelectStock('GGAL')}
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
  tickFlashes: Record<string, 'up' | 'down' | null>;
  onSelectStock: (ticker: string) => void;
  onOpenOrderTicket: (preset: {
    ticker: string;
    side: 'Compra' | 'Venta';
    price: number;
    qty: number;
    instrumentLabel: string;
  }) => void;
}> = ({ subPanel, onSelectSubPanel, density, tickFlashes, onSelectStock, onOpenOrderTicket }) => {
  const rowH =
    density === 'densa' ? 'h-8 text-[12px]' : density === 'comoda' ? 'h-11 text-[13px]' : 'h-9 text-[12px]';

  const panels: { id: MonitorSubPanel; label: string; count: number }[] = [
    { id: 'acciones', label: 'Acciones Líderes', count: AR_STOCKS.length },
    { id: 'bonos', label: 'Bonos y Letras', count: BONDS_DATA.length },
    { id: 'cedears', label: 'CEDEARs y ADRs', count: US_MARKET_DATA.length },
    { id: 'cauciones', label: 'Cauciones por Plazo', count: CAUCIONES_DATA.length },
  ];

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
            La mediana del panel sube <strong className="text-[#2EDC7E] font-mono-num">+2,02 %</strong> · Subieron de
            precio <strong className="text-[var(--text-primary)]">14 de 18 papeles</strong> con un múltiplo de volumen
            mediano de <strong className="text-[var(--text-primary)] font-mono-num">1,5×</strong> sobre lo habitual.
          </InsightBanner>
        )}
        {subPanel === 'bonos' && (
          <InsightBanner variant="pos" tag="Renta Fija">
            La TIR soberana comprimió <strong className="text-[#2EDC7E] font-mono-num">39 pb</strong> en promedio ·
            Subieron de precio <strong className="text-[var(--text-primary)]">9 de 10 bonos</strong> y las LECAP cortas
            operan en <strong className="text-[var(--text-primary)] font-mono-num">2,21 % TEM</strong>.
          </InsightBanner>
        )}
        {subPanel === 'cedears' && (
          <InsightBanner variant="default" tag="CEDEARs / Wall Street">
            El CCL implícito en CEDEARs promedia{' '}
            <strong className="text-[var(--text-primary)] font-mono-num">$ 1.168,80 (−0,42 %)</strong> con fuerte flujo
            en <strong className="text-[#2EDC7E]">NVDA (+2,95 %)</strong> y{' '}
            <strong className="text-[#2EDC7E]">MELI (+2,40 %)</strong>.
          </InsightBanner>
        )}
        {subPanel === 'cauciones' && (
          <InsightBanner variant="warn" tag="Liquidez / Cauciones">
            La caución a 1 día hábil opera en{' '}
            <strong className="text-[var(--text-primary)] font-mono-num">33,50 % TNA</strong> (39,85 % TEA) concentrando
            el <strong className="text-[var(--text-primary)]">68,4 %</strong> del volumen total ($ 284,5 mil M).
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
                        const tirBarW = Math.min(100, (b.tir / 32) * 100);
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
                              {b.currency === 'ARS' ? '$ ' : 'US$ '}
                              {fmtNum(b.price, 2)}
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
                                  {fmtNum(b.tir, 2)} %
                                </span>
                              </div>
                            </td>
                            <td
                              className={`px-2.5 font-semibold ${
                                b.tirDeltaPb < 0 ? 'text-[#2EDC7E]' : 'text-[#FF5C63]'
                              }`}
                            >
                              {b.tirDeltaPb > 0 ? `+${b.tirDeltaPb}` : `−${Math.abs(b.tirDeltaPb)}`} pb
                            </td>
                            <td className="px-2.5 text-[var(--text-secondary)]">{fmtNum(b.parity, 1)} %</td>
                            <td className="px-2.5 text-[var(--text-secondary)]">{fmtNum(b.modDuration, 2)} a</td>
                            <td className="px-2.5">
                              <span className="text-[var(--text-primary)]">{fmtMoneyCompact(b.volumeM)}</span>{' '}
                              <span className="text-[10px] text-[#8B7CF6] font-semibold">
                                {fmtNum(b.volMultiple, 1)}×
                              </span>
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
                    <td className="px-2.5 font-bold text-[#FFFFFF]">US$ {fmtNum(u.price, 2)}</td>
                    <td className="px-2.5">
                      <DeltaPill value={u.deltaPct} size="sm" />
                    </td>
                    <td className="px-2.5 text-[#9CA3AF]">{u.cedearRatio}</td>
                    <td className="px-2.5 font-bold text-[#38BDF8]">$ {fmtNum(u.cedearArsPrice, 0)}</td>
                    <td className="px-2.5 text-[#D1D4DC]">
                      $ {fmtNum((u.cedearArsPrice * u.cedearRatioNum) / u.price, 2)}
                    </td>
                    <td className="px-2.5 text-[#9CA3AF]">{fmtNum(u.iv30d, 1)} %</td>
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
          La brecha cambiaria opera en <strong className="text-[#2EDC7E] font-mono-num">8,4 %</strong> (mínimo de 5
          años), la inflación implícita breakeven entre LECAPs y CER perfora el{' '}
          <strong className="text-[var(--text-primary)] font-mono-num">1,8 % mensual</strong> y el BCRA acumula{' '}
          <strong className="text-[#2EDC7E] font-mono-num">+US$ 1.120 M</strong> de compras netas en el mes.
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

      {/* Calendario de Eventos Macroeconómicos y Licitaciones */}
      <div className="qc-card p-4 space-y-3">
        <h3 className="text-[14px] font-bold text-[var(--text-primary)]">
          Calendario Macro y Licitaciones del Tesoro / Fed (Próximos 7 días)
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
          {[
            {
              date: 'Mañana · 16:00 AR',
              country: 'AR · INDEC',
              event: 'Publicación IPC Nacional y Canasta Básica',
              consensus: 'Consenso REM: 2,1 % m/m · Break-even mercado: 1,8 %',
            },
            {
              date: 'Jueves · 15:00 AR',
              country: 'AR · MECON',
              event: 'Licitación Quincenal de LECAPs y BONCER',
              consensus: 'Vencimientos por $ 4,2 billones · Rollover esperado >110 %',
            },
            {
              date: 'Viernes · 09:30 AR',
              country: 'EE.UU. · BLS',
              event: 'Nóminas No Agrícolas (Non-Farm Payrolls) y Tasa Fed',
              consensus: 'Esperado +185k empleos · Treasury 10Y en 4,24 %',
            },
          ].map((ev) => (
            <div
              key={ev.event}
              className="p-3 rounded-[10px] bg-[var(--surface-2)] border border-[var(--border-subtle)] space-y-1"
            >
              <div className="flex items-center justify-between text-[11px] font-mono-num">
                <span className="text-[#5B8CFF] font-semibold">{ev.date}</span>
                <span className="px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-secondary)]">
                  {ev.country}
                </span>
              </div>
              <div className="font-bold text-[var(--text-primary)]">{ev.event}</div>
              <div className="text-[11px] text-[var(--text-secondary)]">{ev.consensus}</div>
            </div>
          ))}
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
  const [selectedSector, setSelectedSector] = useState<string>('Todos');
  const [searchQ, setSearchQ] = useState<string>('');

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

  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant="default" tag="Wall Street en Vivo">
        El <strong className="text-[#22C55E]">Nasdaq 100 (+1,14 %)</strong> lidera la rueda en Nueva York impulsado por
        semiconductores, mientras el <strong className="text-[var(--text-primary)]">VIX cae a 13,85 pts (−4,15 %)</strong>{' '}
        habilitando apetito por riesgo en emergentes (<strong className="text-[#22C55E]">EWZ +1,68 %</strong>).
      </InsightBanner>

      {/* Estructura superior de 5 índices macro alargados */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard
          title="S&P 500 (SPY)"
          heroValue="5.984,20"
          deltaPct={0.78}
          subtitle="CEDEAR SPY: $ 34.970 · Ratio 20:1"
        />
        <KPICard
          title="Nasdaq 100 (QQQ)"
          heroValue="518,90"
          deltaPct={1.14}
          subtitle="CEDEAR QQQ: $ 30.325 · Ratio 20:1"
        />
        <KPICard
          title="Russell 2000 (IWM)"
          heroValue="224,15"
          deltaPct={0.62}
          subtitle="CEDEAR IWM: $ 26.198 · Ratio 10:1"
        />
        <KPICard
          title="US Treasury 10Y Yield"
          heroValue="4,24 %"
          deltaPct={-0.95}
          badge="-4 PB HOY"
          subtitle="Curva 2Y/10Y: +16 pb · Favorece duration EM"
        />
        <KPICard
          title="CBOE VIX (Volatilidad S&P)"
          heroValue="13,85"
          deltaPct={-4.15}
          badge="PERCENTIL 18"
          subtitle="Régimen de baja volatilidad (<15 pts)"
        />
      </div>

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
              price={`US$ ${fmtNum(item.price, 2)}`}
              subtitle={`${fmtNum(item.volMultiple, 1)}x`}
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
  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant="pos" tag="Curva Soberana HD">
        La curva Hard Dollar opera con pendiente levemente invertida entre{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">12,42 % (AL30)</strong> y{' '}
        <strong className="text-[#2EDC7E] font-mono-num">10,89 % (GD35)</strong> · El spread por legislación NY vs. AR
        promedia apenas <strong className="text-[var(--text-primary)] font-mono-num">72 pb</strong>.
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
                text="Compara el rendimiento anual en USD de los bonos Ley Local (violeta) frente a los Globales Ley Nueva York (azul)."
              />
            </div>
            <div className="flex items-center gap-3 text-[11px] font-mono-num">
              <span className="text-[#8B7CF6]">● Ley Argentina (AL)</span>
              <span className="text-[#4BA3FF]">● Ley NY (GD)</span>
            </div>
          </div>

          <div className="h-64 w-full pt-2">
            <svg viewBox="0 0 560 220" className="w-full h-full overflow-visible">
              {[10, 11, 12, 13].map((t, i) => {
                const y = 180 - i * 44;
                return (
                  <g key={t}>
                    <line x1="45" y1={y} x2="530" y2={y} stroke="#1E1E2B" />
                    <text x="38" y={y + 3} textAnchor="end" fill="#6D6D84" fontSize="10" className="font-mono-num">
                      {t}%
                    </text>
                  </g>
                );
              })}

              {/* Curva Ley AR */}
              <path
                d="M 110 96 Q 230 74 440 128"
                fill="none"
                stroke="#8B7CF6"
                strokeWidth="2.2"
                className="chart-line-draw"
              />
              {/* Curva Ley NY */}
              <path
                d="M 165 108 Q 310 132 490 138"
                fill="none"
                stroke="#4BA3FF"
                strokeWidth="2.2"
                strokeDasharray="5 3"
              />

              {/* Nodos de Bonos */}
              {[
                { t: 'AL29', x: 110, y: 98, c: '#8B7CF6', tir: '11,84%' },
                { t: 'AL30', x: 160, y: 74, c: '#8B7CF6', tir: '12,42%' },
                { t: 'GD30', x: 170, y: 108, c: '#4BA3FF', tir: '11,65%' },
                { t: 'GD38', x: 370, y: 134, c: '#4BA3FF', tir: '11,02%' },
                { t: 'AL35', x: 435, y: 128, c: '#8B7CF6', tir: '11,18%' },
                { t: 'GD35', x: 448, y: 141, c: '#4BA3FF', tir: '10,89%' },
                { t: 'GD41', x: 495, y: 138, c: '#4BA3FF', tir: '10,95%' },
              ].map((pt) => (
                <g key={pt.t}>
                  <circle cx={pt.x} cy={pt.y} r="5" fill={pt.c} stroke="#08080D" strokeWidth="1.5" />
                  <text x={pt.x} y={pt.y - 9} textAnchor="middle" fill="#F3F3F9" fontSize="10" fontWeight="bold" className="font-mono-num">
                    {pt.t} ({pt.tir})
                  </text>
                </g>
              ))}
              <text x="290" y="208" textAnchor="middle" fill="#6D6D84" fontSize="10" className="font-mono-num">
                Modified Duration (Años) →
              </text>
            </svg>
          </div>
        </div>

        {/* Sensibilidad de Precio ante Compresión de Riesgo País */}
        <div className="lg:col-span-5 qc-card p-4 flex flex-col justify-between gap-3">
          <div>
            <h3 className="text-[14px] font-bold text-[var(--text-primary)] mb-1">
              Simulador de Upside por Compresión de TIR (Target 8,0 % / 9,0 %)
            </h3>
            <p className="text-[12px] text-[var(--text-secondary)]">
              Ganancia de capital estimada según la duration modificada de cada bono si Argentina converge al riesgo de
              países BB−.
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
              {BONDS_DATA.slice(0, 6).map((b) => {
                const up9 = Math.max(2, (b.tir - 9.0) * b.modDuration);
                const up8 = Math.max(4, (b.tir - 8.0) * b.modDuration);
                return (
                  <tr key={b.ticker} className="h-9">
                    <td className="text-left font-bold text-[var(--text-primary)]">{b.ticker}</td>
                    <td>{fmtNum(b.tir, 2)}%</td>
                    <td className="text-[var(--text-secondary)]">{fmtNum(b.modDuration, 2)}</td>
                    <td className="text-[#2EDC7E] font-semibold">+{fmtNum(up9, 1)} %</td>
                    <td className="text-[#2EDC7E] font-bold">+{fmtNum(up8, 1)} %</td>
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
  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant="call" tag="Curva Rofex / Sintético USD">
        Las tasas implícitas de dólar futuro operan entre{' '}
        <strong className="text-[var(--text-primary)] font-mono-num">26,3 % y 29,6 % TNA</strong>, debajo de la curva
        LECAP (29,8 % TNA), habilitando <strong className="text-[#2EDC7E]">Sintéticos en USD al +3,02 % anual</strong>.
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
              {ROFEX_FUTURES.map((f) => (
                <tr key={f.contract} className="h-9 hover:bg-[var(--surface-2)]">
                  <td className="px-3 text-left font-bold text-[var(--text-primary)]">{f.contract}</td>
                  <td className="px-2.5 text-[var(--text-secondary)]">{f.maturity}</td>
                  <td className="px-2.5 text-[var(--text-secondary)]">{f.days}d</td>
                  <td className="px-2.5 font-bold text-[var(--text-primary)]">$ {fmtNum(f.price, 1)}</td>
                  <td className="px-2.5">
                    <DeltaPill value={f.deltaPct} size="sm" />
                  </td>
                  <td className="px-2.5 text-[var(--text-secondary)]">+{fmtNum(f.implicitDevalPct, 2)} %</td>
                  <td className="px-2.5 font-semibold text-[#8B7CF6]">{fmtNum(f.tnaImplicit, 1)} %</td>
                  <td className="px-2.5 text-[var(--text-secondary)]">{fmtNum(f.teaImplicit, 1)} %</td>
                  <td className="px-2.5 text-[var(--text-secondary)]">
                    {f.lecapRefTicker} ({fmtNum(f.lecapTna, 1)}%)
                  </td>
                  <td className="px-3 font-bold text-[#2EDC7E]">+{fmtNum(f.syntheticUsdRatePct, 2)} % TNA</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

/* MÓDULO RELACIONES Y ARBITRAJES ESTADÍSTICOS */
export const RatiosModule: React.FC = () => {
  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant="default" tag="Arbitraje Relativo">
        Detectados <strong className="text-[var(--text-primary)]">2 pares fuera de su banda típica (±1,5σ)</strong>: el
        spread <strong className="text-[#2EDC7E]">GD30D / AL30D</strong> en piso de −1,72σ y el ratio{' '}
        <strong className="text-[#F5B544]">GGAL / BMA</strong> en techo de +1,86σ.
      </InsightBanner>

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
                  Math.abs(pair.zScore) >= 1.5
                    ? 'bg-[#35280F] text-[#F5B544] border border-[#F5B544]/40'
                    : 'bg-[#0E2F20] text-[#2EDC7E] border border-[#1C5C3C]'
                }`}
              >
                Z-Score: {pair.zScore > 0 ? '+' : '−'}
                {fmtNum(Math.abs(pair.zScore), 2)}σ
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 p-2.5 rounded-[10px] bg-[var(--surface-2)] font-mono-num text-[12px]">
              <div>
                <div className="text-[10px] text-[var(--text-tertiary)]">Valor Actual</div>
                <div className="text-[16px] font-bold text-[var(--text-primary)]">
                  {fmtNum(pair.currentRatio, pair.currentRatio < 10 ? 2 : 0)} {pair.unit}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-[var(--text-tertiary)]">Mediana 90d</div>
                <div className="text-[14px] text-[var(--text-secondary)]">
                  {fmtNum(pair.mean90d, pair.mean90d < 10 ? 2 : 0)} {pair.unit}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-[var(--text-tertiary)]">Percentil 90d</div>
                <div className="text-[14px] font-semibold text-[#8B7CF6]">P{pair.percentile90d}</div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <p className="text-[12px] text-[var(--text-secondary)] leading-snug">{pair.recommendation}</p>
              <MiniSparkline data={pair.history} positive={pair.zScore < 0} width={96} height={30} />
            </div>
          </div>
        ))}
      </div>
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

  return (
    <div className="space-y-4 animate-module">
      <InsightBanner variant="pos" tag="Cartera Consolidada">
        Tu portafolio suma <strong className="text-[var(--text-primary)] font-mono-num">$ {fmtNum(totalVal / 1e6, 2)} M</strong>{' '}
        con una ganancia en la rueda de{' '}
        <strong className="text-[#2EDC7E] font-mono-num">+$ {fmtNum(totalPnlDay / 1e6, 2)} M (+2,12 %)</strong> y un
        devengamiento por Theta + tasa de{' '}
        <strong className="text-[#2EDC7E] font-mono-num">+$ {fmtNum(totalTheta, 0)} / día</strong>.
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
