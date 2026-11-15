import React, { useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, Layers, Search, Sparkles } from 'lucide-react';
import { DeltaPill, HelpTooltip, RangeBar } from '../DesignSystem';
import { fmtNum, fmtPct } from '../../data/marketData';
import type {
  ChartKeyLevels,
  HighlightLevelId,
  StockContextBannerInfo,
} from './stockDetailTypes';

export interface TickerQuickOption {
  readonly ticker: string;
  readonly name: string;
  readonly group: 'AR' | 'CEDEAR' | 'US';
}

const FEED_BADGE_MAP: Readonly<Record<string, { readonly label: string; readonly cls: string }>> = {
  LIVE: {
    label: 'LIVE',
    cls: 'border-[#2EDC7E]/40 bg-[#2EDC7E]/12 text-[#2EDC7E]',
  },
  EOD_CIERRE: {
    label: 'EOD_CIERRE',
    cls: 'border-[#4BA3FF]/40 bg-[#4BA3FF]/12 text-[#4BA3FF]',
  },
  DIFERIDO_20M: {
    label: 'DIFERIDO_20M',
    cls: 'border-[#F5B544]/40 bg-[#F5B544]/12 text-[#F5B544]',
  },
  PARTIAL: {
    label: 'PARTIAL',
    cls: 'border-[#F5B544]/40 bg-[#F5B544]/12 text-[#F5B544]',
  },
  NO_DATA: {
    label: 'NO_DATA',
    cls: 'border-[#FF5468]/40 bg-[#FF5468]/12 text-[#FF5468]',
  },
};

export const StockDetailHeader: React.FC<{
  readonly info: StockContextBannerInfo;
  readonly keyLevels: ChartKeyLevels;
  readonly highlightedLevel: HighlightLevelId;
  readonly onToggleHighlight: (id: Exclude<HighlightLevelId, null>) => void;
  readonly quickTickers: readonly TickerQuickOption[];
  readonly onSelectTicker: (ticker: string) => void;
  readonly onBackToMonitor: () => void;
  readonly onGoToOptions: (ticker: string) => void;
}> = ({
  info,
  keyLevels,
  highlightedLevel,
  onToggleHighlight,
  quickTickers,
  onSelectTicker,
  onBackToMonitor,
  onGoToOptions,
}) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filteredTickers = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return quickTickers.slice(0, 24);
    return quickTickers
      .filter((t) => t.ticker.includes(q) || t.name.toUpperCase().includes(q))
      .slice(0, 24);
  }, [quickTickers, query]);

  const feedStyle = FEED_BADGE_MAP[info.feedStatus] ?? {
    label: info.feedStatus || 'NO_DATA',
    cls: 'border-[#252536] bg-[#161622] text-[#A2A8C2]',
  };

  const pxPrefix = info.currencySymbol === 'USD' ? 'US$ ' : '$ ';
  const fmtSpot = (v: number | null) =>
    v !== null && Number.isFinite(v) ? `${pxPrefix}${fmtNum(v, 2)}` : '—';

  const levelChips: readonly {
    readonly id: Exclude<HighlightLevelId, null>;
    readonly label: string;
    readonly value: number | null;
    readonly color: string;
    readonly prefix?: string;
    readonly help: string;
  }[] = [
    {
      id: 'POC',
      label: 'POC',
      value: keyLevels.poc,
      color: '#FACC15',
      help: 'Point of Control (Volume Profile): nivel de mayor concentración de volumen transaccionado.',
    },
    {
      id: 'VAH',
      label: 'VAH',
      value: keyLevels.vah,
      color: '#60A5FA',
      help: 'Value Area High: techo del área de valor del 70 % de volumen.',
    },
    {
      id: 'VAL',
      label: 'VAL',
      value: keyLevels.val,
      color: '#60A5FA',
      help: 'Value Area Low: piso del área de valor del 70 % de volumen.',
    },
    {
      id: 'CALL_WALL',
      label: 'Call Wall',
      value: keyLevels.callWall,
      color: '#2EDC7E',
      help: 'Strike con máxima concentración de Call GEX positivo: resistencia institucional por cobertura dealer.',
    },
    {
      id: 'PUT_WALL',
      label: 'Put Wall',
      value: keyLevels.putWall,
      color: '#FF5468',
      help: 'Strike con máxima concentración de Put GEX: soporte institucional por cobertura dealer.',
    },
    {
      id: 'ZERO_GAMMA',
      label: 'Zero-Gamma',
      value: keyLevels.zeroGamma,
      color: '#A78BFA',
      help: 'Punto de inflexión donde GEX neto cruza cero y cambia la dinámica de cobertura dealer.',
    },
    {
      id: 'ATR14',
      label: 'ATR(14)',
      value: keyLevels.atr14,
      color: '#94A3B8',
      prefix: info.currencySymbol === 'USD' ? 'US$ ' : '$ ',
      help: 'Average True Range de 14 ruedas usado como unidad de volatilidad y bandas < 0.15 ATR.',
    },
  ];

  return (
    <header className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] px-4 py-3.5 flex flex-col gap-3">
      {/* Fila 1: Identidad, Precio y Métricas de Sesión */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onBackToMonitor}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] bg-[#161622] border border-[#252536] text-[12px] font-medium text-[#A2A8C2] hover:text-white hover:border-[#3A3A54] transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Monitor
          </button>

          {/* Selector rápido de Ticker */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setSearchOpen((v) => !v)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-[9px] bg-[#161622] border border-[#252536] hover:border-[#8B7CF6]/60 transition-colors"
            >
              <span className="font-mono-num text-[17px] font-bold tracking-tight text-white">
                {info.ticker}
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono-num font-semibold bg-[#1E1E2E] text-[#A2A8C2]">
                {info.marketLabel}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-[#7E85A3]" />
            </button>
            {searchOpen && (
              <div className="absolute left-0 top-full mt-1.5 w-72 rounded-[10px] bg-[#14141F] border border-[#2A2A3E] shadow-2xl z-50 p-2">
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-[7px] bg-[#0B0B12] border border-[#222232] mb-2">
                  <Search className="w-3.5 h-3.5 text-[#6E7491]" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Buscar ticker AR / CEDEAR / US..."
                    autoFocus
                    className="w-full bg-transparent text-[12px] text-white placeholder-[#5C627D] focus:outline-none"
                  />
                </div>
                <div className="max-h-64 overflow-y-auto flex flex-col gap-0.5">
                  {filteredTickers.map((t) => (
                    <button
                      key={`${t.group}:${t.ticker}`}
                      type="button"
                      onClick={() => {
                        setSearchOpen(false);
                        setQuery('');
                        onSelectTicker(t.ticker);
                      }}
                      className={`w-full flex items-center justify-between px-2 py-1.5 rounded-[6px] text-left text-[12px] transition-colors ${
                        t.ticker === info.ticker
                          ? 'bg-[#8B7CF6]/20 text-white'
                          : 'hover:bg-[#1C1C2B] text-[#CBD0E4]'
                      }`}
                    >
                      <span className="font-mono-num font-bold">{t.ticker}</span>
                      <span className="truncate mx-2 text-[11px] text-[#7E85A3]">{t.name}</span>
                      <span className="text-[10px] font-mono-num px-1 py-0.5 rounded bg-[#1E1E2B] text-[#8E95B3]">
                        {t.group}
                      </span>
                    </button>
                  ))}
                  {query.trim().length > 0 &&
                    !filteredTickers.some((x) => x.ticker === query.trim().toUpperCase()) && (
                      <button
                        type="button"
                        onClick={() => {
                          const target = query.trim().toUpperCase();
                          setSearchOpen(false);
                          setQuery('');
                          onSelectTicker(target);
                        }}
                        className="mt-1 w-full px-2 py-1.5 rounded-[6px] bg-[#8B7CF6]/15 border border-[#8B7CF6]/40 text-[11px] text-[#C4B8FF] font-mono-num"
                      >
                        Abrir ticker &ldquo;{query.trim().toUpperCase()}&rdquo; →
                      </button>
                    )}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-[#E8ECF8] truncate max-w-[260px]">
                {info.name}
              </span>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full border font-mono-num text-[10px] font-semibold tracking-wider ${feedStyle.cls}`}
              >
                {feedStyle.label}
              </span>
              {info.intradayProvenanceNote && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-[#8B7CF6]/40 bg-[#8B7CF6]/12 text-[#C8BEFF] font-mono-num text-[10px] font-semibold">
                  <Sparkles className="w-3 h-3" />
                  {info.intradayProvenanceNote}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Bloque Spot + Variación + Rango del día + Volumen + Vol.Rel */}
        <div className="flex flex-wrap items-center gap-5">
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono-num text-[26px] leading-none font-bold text-white tabular-nums">
              {fmtSpot(info.spot)}
            </span>
            <DeltaPill value={info.changePct ?? Number.NaN} size="md" />
          </div>

          <div className="hidden sm:flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wider text-[#787B86]">
              Rango Día
            </span>
            <RangeBar
              low={info.dayLow ?? Number.NaN}
              high={info.dayHigh ?? Number.NaN}
              current={info.spot ?? Number.NaN}
              prevClose={info.prevClose ?? undefined}
              widthClass="w-32"
            />
          </div>

          <div className="flex items-center gap-4 pl-2 border-l border-[#1E1E2B]">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-[#787B86]">
                Volumen
              </span>
              <span className="font-mono-num text-[13px] font-semibold text-[#E5E8F5] tabular-nums">
                {info.volumeCompact}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-[#787B86]">
                Vol. Relativo
              </span>
              <span
                className={`font-mono-num text-[13px] font-semibold tabular-nums ${
                  info.volRelative !== null && info.volRelative >= 1.5
                    ? 'text-[#2EDC7E]'
                    : 'text-[#E5E8F5]'
                }`}
              >
                {info.volRelative !== null && Number.isFinite(info.volRelative)
                  ? `${fmtNum(info.volRelative, 2)}x`
                  : '—'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onGoToOptions(info.ticker)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-[#8B7CF6]/18 border border-[#8B7CF6]/45 text-[12px] font-semibold text-[#C8BCFF] hover:bg-[#8B7CF6]/28 transition-colors"
            >
              <Layers className="w-3.5 h-3.5" />
              Opciones
            </button>
          </div>
        </div>
      </div>

      {/* Fila 2: Bloque Contextual Dual (AR con ADR vs AR Local/Bono vs US NBBO+CEDEAR) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2.5 border-t border-[#1A1A26]">
        {info.market === 'AR' && info.arHasAdr ? (
          <>
            <ContextMetricBox
              label={`ADR USD (${info.adrUsTicker ?? 'NYSE'}) · Massive`}
              value={
                info.adrUsdPrice !== null && Number.isFinite(info.adrUsdPrice)
                  ? `US$ ${fmtNum(info.adrUsdPrice, 2)}`
                  : '—'
              }
              sub={info.adrRatio ? `Ratio ${info.adrRatio}:1` : undefined}
            />
            <ContextMetricBox
              label="CCL Implícito del Papel"
              value={
                info.impliedCcl !== null && Number.isFinite(info.impliedCcl)
                  ? `$ ${fmtNum(info.impliedCcl, 2)}`
                  : '—'
              }
              sub={
                info.marketCclMedian !== null
                  ? `CCL Mediano: $ ${fmtNum(info.marketCclMedian, 2)}`
                  : undefined
              }
            />
            <ContextMetricBox
              label="Precio Teórico ARS (vs CCL)"
              value={
                info.theoreticalArsPrice !== null && Number.isFinite(info.theoreticalArsPrice)
                  ? `$ ${fmtNum(info.theoreticalArsPrice, 2)}`
                  : '—'
              }
            />
            <ContextMetricBox
              label="Brecha de Arbitraje %"
              value={fmtPct(info.arbitrageGapPct, 2)}
              tone={
                info.arbitrageGapPct === null
                  ? 'neutral'
                  : info.arbitrageGapPct <= -0.75
                  ? 'pos'
                  : info.arbitrageGapPct >= 0.75
                  ? 'neg'
                  : 'neutral'
              }
              sub={
                info.arbitrageGapPct === null
                  ? undefined
                  : info.arbitrageGapPct < 0
                  ? 'Descuento local BYMA'
                  : 'Prima local BYMA'
              }
            />
          </>
        ) : info.market === 'AR' ? (
          <>
            <ContextMetricBox
              label="Tipo de Activo BYMA"
              value={
                info.arAssetType === 'BOND'
                  ? 'Bono Soberano'
                  : info.arAssetType === 'CEDEAR'
                  ? 'CEDEAR BYMA'
                  : 'Acción Local'
              }
            />
            <ContextMetricBox
              label={info.arAssetType === 'BOND' ? 'TIR Anual / Paridad' : 'ADR Subyacente NYSE'}
              value={
                info.arAssetType === 'BOND'
                  ? `${fmtPct(info.bondTirPct, 2, false)} · ${info.bondParityPct !== null ? `${fmtNum(info.bondParityPct, 1)}%` : '—'}`
                  : 'Sin ADR NYSE'
              }
            />
            <ContextMetricBox
              label="Dólar CCL Mediano"
              value={
                info.marketCclMedian !== null && Number.isFinite(info.marketCclMedian)
                  ? `$ ${fmtNum(info.marketCclMedian, 2)}`
                  : '—'
              }
            />
            <ContextMetricBox
              label="Spot en USD (Deflactado)"
              value={
                info.spot !== null && info.marketCclMedian !== null && info.marketCclMedian > 0
                  ? `US$ ${fmtNum(info.spot / info.marketCclMedian, 2)}`
                  : '—'
              }
            />
          </>
        ) : (
          <>
            <ContextMetricBox
              label="NBBO Bid / Ask (Massive)"
              value={
                info.nbboBid !== null && info.nbboAsk !== null
                  ? `US$ ${fmtNum(info.nbboBid, 2)} / ${fmtNum(info.nbboAsk, 2)}`
                  : '—'
              }
              sub={
                info.nbboBidSize !== null || info.nbboAskSize !== null
                  ? `Size ${info.nbboBidSize ?? '—'} × ${info.nbboAskSize ?? '—'}`
                  : undefined
              }
            />
            <ContextMetricBox
              label="Spread NBBO %"
              value={
                info.nbboSpreadPct !== null && Number.isFinite(info.nbboSpreadPct)
                  ? `${fmtNum(info.nbboSpreadPct, 3)} %`
                  : '—'
              }
            />
            <ContextMetricBox
              label={`CEDEAR BYMA${info.cedearRatio ? ` (${info.cedearRatio}:1)` : ''}`}
              value={
                info.cedearArsPrice !== null && Number.isFinite(info.cedearArsPrice)
                  ? `${info.cedearTicker ?? info.ticker} · $ ${fmtNum(info.cedearArsPrice, 2)}`
                  : 'Sin CEDEAR en BYMA'
              }
            />
            <ContextMetricBox
              label="Desfase CCL vs Mediana"
              value={fmtPct(info.cedearCclMismatchPct, 2)}
              tone={
                info.cedearCclMismatchPct === null
                  ? 'neutral'
                  : info.cedearCclMismatchPct <= -0.75
                  ? 'pos'
                  : info.cedearCclMismatchPct >= 0.75
                  ? 'neg'
                  : 'neutral'
              }
              sub={
                info.impliedCcl !== null
                  ? `CCL papel: $ ${fmtNum(info.impliedCcl, 2)}`
                  : undefined
              }
            />
          </>
        )}
      </div>

      {/* Fila 3: Tira de Niveles Clave Interactivos (Click-to-Highlight) */}
      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#1A1A26]">
        <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[#7E85A3] mr-1">
          Niveles Clave (clic para resaltar)
        </span>
        {levelChips.map((chip) => {
          const isSelected = highlightedLevel === chip.id;
          const finite = chip.value !== null && Number.isFinite(chip.value);
          return (
            <div key={chip.id} className="inline-flex items-center gap-1">
              <button
                type="button"
                disabled={!finite}
                onClick={() => onToggleHighlight(chip.id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] border text-[11px] font-mono-num transition-all ${
                  isSelected
                    ? 'bg-[#8B7CF6]/22 border-[#8B7CF6] text-white shadow-[0_0_0_1px_rgba(139,124,246,0.45)]'
                    : finite
                    ? 'bg-[#161622] border-[#252536] text-[#D8DCF0] hover:border-[#3E3E5A] cursor-pointer'
                    : 'bg-[#13131D] border-[#1D1D2A] text-[#5D637A] cursor-not-allowed'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: finite ? chip.color : '#42475B' }}
                />
                <span className="text-[#8E95B3] font-sans">{chip.label}:</span>
                <span className="font-semibold tabular-nums">
                  {finite ? `${chip.prefix ?? pxPrefix}${fmtNum(chip.value, 2)}` : '—'}
                </span>
              </button>
              <HelpTooltip title={chip.label} text={chip.help} />
            </div>
          );
        })}
      </div>
    </header>
  );
};

const ContextMetricBox: React.FC<{
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly tone?: 'neutral' | 'pos' | 'neg';
}> = ({ label, value, sub, tone = 'neutral' }) => {
  const valCls =
    tone === 'pos'
      ? 'text-[#2EDC7E]'
      : tone === 'neg'
      ? 'text-[#FF5468]'
      : 'text-[#F0F2FA]';
  return (
    <div className="px-3 py-2 rounded-[9px] bg-[#0B0B12] border border-[#1B1B28] flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.05em] text-[#7C829F] truncate">
        {label}
      </span>
      <span className={`font-mono-num text-[13px] font-semibold tabular-nums ${valCls}`}>
        {value}
      </span>
      {sub && (
        <span className="text-[10px] font-mono-num text-[#686E8A] truncate">{sub}</span>
      )}
    </div>
  );
};
