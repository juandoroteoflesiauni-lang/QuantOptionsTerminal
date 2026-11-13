import React from 'react';
import { ArrowLeft, ArrowUpRight, Layers, ShieldAlert } from 'lucide-react';
import {
  NULL_DISPLAY,
  TerminalApiError,
  fmtCompactInt,
  fmtCompactUsd,
  fmtDecimalPct,
  fmtNum,
  fmtPct,
  fmtUsd,
  fmtUtcTimeET,
  isFiniteNum,
  type RuntimeWsBroadcast,
  type TerminalBarsResponse,
  type TerminalSnapshotResponse,
  type Timeframe,
} from '../api/terminalClient';
import { DEFAULT_WATCHLIST_SYMBOLS, resolveSymbolMeta } from '../data/marketData';
import { LuxAlgoCandleChart } from './charts/LuxAlgoCandleChart';
import { DeltaPill, KPICard, NoDataPanel, StatusBadge, TickerChip } from './DesignSystem';

export interface StockDetailViewProps {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly rthOnly: boolean;
  readonly snapshot: TerminalSnapshotResponse | null;
  readonly barsData: TerminalBarsResponse | null;
  readonly snapshotLoading: boolean;
  readonly barsLoading: boolean;
  readonly snapshotError: TerminalApiError | Error | null;
  readonly barsError: TerminalApiError | Error | null;
  readonly liveWsEvent: RuntimeWsBroadcast | null;
  readonly onBack?: () => void;
  readonly onSelectSymbol: (symbol: string) => void;
  readonly onTimeframeChange: (tf: Timeframe) => void;
  readonly onRthToggle: (next: boolean) => void;
  readonly onOpenOptions: (symbol: string) => void;
  readonly onRetry: () => void;
}

export const StockDetailView: React.FC<StockDetailViewProps> = ({
  symbol,
  timeframe,
  rthOnly,
  snapshot,
  barsData,
  snapshotLoading,
  barsLoading,
  snapshotError,
  barsError,
  liveWsEvent,
  onBack,
  onSelectSymbol,
  onTimeframeChange,
  onRthToggle,
  onOpenOptions,
  onRetry,
}) => {
  const meta = resolveSymbolMeta(symbol);
  const envSnap = snapshot?.envelope.snapshot ?? null;
  const metrics = envSnap?.metrics ?? null;
  const matchedQuote =
    snapshot?.marketContext.unifiedQuotes.find((q) => q.ticker === symbol) ?? null;

  const spot = metrics?.spot ?? matchedQuote?.price ?? null;
  const oa = snapshot?.openingAuction ?? null;
  const micro = snapshot?.microstructure ?? null;

  const snapshotErrMsg =
    snapshotError instanceof TerminalApiError
      ? `${snapshotError.reason}: ${snapshotError.detail}`
      : snapshotError instanceof Error
        ? snapshotError.message
        : null;

  return (
    <div className="space-y-4">
      {/* Header Ticker */}
      <div className="p-4 rounded-[12px] bg-[#131722] border border-[#232733] flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="p-2 rounded-[8px] bg-[#171722] border border-[#232733] text-[#A4A4BA] hover:text-[#F3F3F9] cursor-pointer"
              aria-label="Volver al resumen"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center font-mono-num font-bold text-white text-[13px]"
            style={{ backgroundColor: meta.accentColor }}
          >
            {symbol.replace('I:', '').slice(0, 3)}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[18px] font-bold text-[#F3F3F9]">
                {symbol} — {meta.name}
              </h1>
              {snapshot !== null ? (
                <StatusBadge status={snapshot.status} />
              ) : snapshotError !== null ? (
                <StatusBadge status="NO_DATA" />
              ) : null}
              <span className="text-[11px] font-mono-num text-[#787B86]">{meta.venue}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              {DEFAULT_WATCHLIST_SYMBOLS.slice(0, 6).map((item) => (
                <TickerChip
                  key={item.ticker}
                  ticker={item.ticker}
                  color={item.accentColor}
                  selected={item.ticker === symbol}
                  onClick={() => onSelectSymbol(item.ticker)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-5">
          <div className="text-right">
            <div className="text-[10.5px] uppercase tracking-wider text-[#6D6D84] font-semibold">
              Precio Spot ({fmtUtcTimeET(snapshot?.asOfUtcSec ?? barsData?.asOfUtcSec ?? null)})
            </div>
            <div className="flex items-baseline justify-end gap-2.5">
              <span
                className={`font-mono-num text-[24px] font-bold ${
                  isFiniteNum(spot) ? 'text-[#F3F3F9]' : 'text-[#6D6D84]'
                }`}
              >
                {fmtUsd(spot, 2)}
              </span>
              <DeltaPill value={matchedQuote?.changePct} size="md" />
            </div>
          </div>

          <button
            type="button"
            onClick={() => onOpenOptions(symbol)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[8px] bg-[#241F48] border border-[#8B7CF6]/60 text-[12.5px] font-semibold text-[#F3F3F9] hover:brightness-110 cursor-pointer"
          >
            <Layers className="w-4 h-4 text-[#8B7CF6]" />
            Cadena &amp; GEX
            <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Warning banner si snapshot devolvio error pero barras siguen o viceversa */}
      {snapshotErrMsg !== null && (
        <NoDataPanel
          reason={snapshotError instanceof TerminalApiError ? snapshotError.reason : 'PROVIDER_ERROR'}
          detail={snapshotErrMsg}
          onRetry={onRetry}
        />
      )}

      {/* Grafico Candlestick + Overlays + Sub-Panes con @luxalgo/vela */}
      <LuxAlgoCandleChart
        symbol={symbol}
        timeframe={timeframe}
        rthOnly={rthOnly}
        barsData={barsData}
        extraKeyLevels={envSnap?.keyLevels ?? []}
        loading={barsLoading}
        error={barsError}
        liveWsEvent={liveWsEvent}
        onRetry={onRetry}
        onTimeframeChange={onTimeframeChange}
        onRthToggle={onRthToggle}
      />

      {/* Resumen KPI Cuantitativo */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <KPICard
          title="Confluence Score"
          heroValue={fmtNum(envSnap?.confluenceScore, 2)}
          subtitle={
            envSnap !== null
              ? `${envSnap.directionalBias} · ${
                  envSnap.activePillarsCount !== null && envSnap.totalPillarsCount !== null
                    ? `${String(envSnap.activePillarsCount)}/${String(envSnap.totalPillarsCount)}`
                    : NULL_DISPLAY
                } pilares`
              : snapshotLoading
                ? 'Evaluando...'
                : NULL_DISPLAY
          }
        />
        <KPICard
          title="Gamma Regime"
          heroValue={envSnap?.gammaRegime ?? NULL_DISPLAY}
          subtitle={`GEX: ${fmtCompactUsd(metrics?.netDollarGex)}`}
        />
        <KPICard
          title="Call / Put Wall"
          heroValue={`${fmtNum(metrics?.callWallStrike, 1)} / ${fmtNum(metrics?.putWallStrike, 1)}`}
          subtitle={`Gamma Flip: ${fmtUsd(metrics?.gammaFlipSpot, 2)}`}
        />
        <KPICard
          title="IV 30D vs RV"
          heroValue={`${fmtDecimalPct(metrics?.iv30d, 1)} / ${fmtDecimalPct(metrics?.realizedVolAnnualized, 1)}`}
          subtitle={`VRP: ${fmtDecimalPct(metrics?.vrpSpread, 2, true)}`}
        />
        <KPICard
          title="Session CVD"
          heroValue={fmtCompactInt(metrics?.currentSessionCvd)}
          subtitle={`Mode: ${micro?.cvd?.deltaMode ?? NULL_DISPLAY}`}
        />
        <KPICard
          title="RSI (14)"
          heroValue={fmtNum(metrics?.latestRsi ?? micro?.rsiDivergences?.latestRsi, 2)}
          subtitle={`SMT (${micro?.smtDivergences?.correlatedSymbol ?? meta.defaultCorrelated}): ${micro?.smtDivergences?.status ?? NULL_DISPLAY}`}
        />
      </div>

      {/* Grilla 3 columnas: Confluencia 6 Pilares + Subasta de Apertura + Niveles Clave & MTF */}
      {snapshot !== null && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* Columna 1: Orquestador Multi-Capa (6 Pilares) */}
          <div className="rounded-[12px] bg-[#131722] border border-[#232733] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-bold text-[#F3F3F9]">
                Pilares de Confluencia (Bloques A+B+C)
              </h3>
              <StatusBadge status={snapshot.envelope.envelopeStatus} />
            </div>
            <div className="space-y-2">
              {snapshot.envelope.snapshot.pillars.map((pillar) => {
                const validScore = isFiniteNum(pillar.score);
                const scoreColor = !validScore
                  ? 'text-[#6D6D84]'
                  : pillar.score > 0.15
                    ? 'text-[#2EDC7E]'
                    : pillar.score < -0.15
                      ? 'text-[#FF5C63]'
                      : 'text-[#F5B544]';
                return (
                  <div
                    key={pillar.id}
                    className="p-2.5 rounded-[8px] bg-[#0D1017] border border-[#1E1E2B] flex items-center justify-between gap-2 text-[12px]"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-[#F3F3F9] truncate">{pillar.label}</div>
                      <div className="text-[11px] font-mono-num text-[#787B86] truncate">
                        {pillar.summaryCode}
                      </div>
                    </div>
                    <div className="text-right font-mono-num shrink-0">
                      <div className={`font-bold ${scoreColor}`}>
                        {fmtNum(pillar.score, 2)}
                      </div>
                      <div className="text-[10.5px] text-[#6D6D84]">
                        w={fmtNum(pillar.weight, 2)} · {pillar.status}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {snapshot.dataQuality.warnings.length > 0 && (
              <div className="p-2.5 rounded-[8px] bg-[#35280F]/60 border border-[#F5B544]/30 text-[11px] font-mono-num text-[#F5B544] space-y-1">
                <div className="flex items-center gap-1.5 font-bold">
                  <ShieldAlert className="w-3.5 h-3.5" /> Advertencias de calidad
                </div>
                {snapshot.dataQuality.warnings.map((w, i) => (
                  <div key={i}>• {w}</div>
                ))}
              </div>
            )}
          </div>

          {/* Columna 2: Subasta de Apertura y Liquidez Pre-Market */}
          <div className="rounded-[12px] bg-[#131722] border border-[#232733] p-4 space-y-3">
            <h3 className="text-[14px] font-bold text-[#F3F3F9]">
              Subasta de Apertura (04:00–10:30 ET)
            </h3>
            {oa === null ? (
              <div className="py-8 text-center text-[12px] font-mono-num text-[#6D6D84]">
                NO_DATA: Sin lectura de Subasta de Apertura.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 text-[12px] font-mono-num">
                <div className="p-2.5 rounded bg-[#0D1017] border border-[#1E1E2B]">
                  <div className="text-[#6D6D84]">Balance / Riesgo Inv.</div>
                  <div className="text-[#F3F3F9] font-semibold mt-0.5">{oa.balanceType}</div>
                  <div className="text-[11px] text-[#38BDF8]">{oa.inventoryRisk}</div>
                </div>
                <div className="p-2.5 rounded bg-[#0D1017] border border-[#1E1E2B]">
                  <div className="text-[#6D6D84]">Apertura / IB</div>
                  <div className="text-[#F3F3F9] font-semibold mt-0.5">
                    {oa.openingType} ({oa.openingDirection})
                  </div>
                  <div className="text-[11px] text-[#8B7CF6]">IB: {oa.ibClassification}</div>
                </div>
                <div className="p-2 rounded bg-[#0D1017]">
                  <span className="text-[#6D6D84]">PMH / PML:</span>{' '}
                  <strong className="text-[#F3F3F9]">
                    {fmtNum(oa.pmh, 2)} / {fmtNum(oa.pml, 2)}
                  </strong>
                </div>
                <div className="p-2 rounded bg-[#0D1017]">
                  <span className="text-[#6D6D84]">ON POC:</span>{' '}
                  <strong className="text-[#E5558F]">{fmtNum(oa.onPoc, 2)}</strong>
                </div>
                <div className="p-2 rounded bg-[#0D1017]">
                  <span className="text-[#6D6D84]">ON VAH / VAL:</span>{' '}
                  <strong className="text-[#34D3C7]">
                    {fmtNum(oa.onVah, 2)} / {fmtNum(oa.onVal, 2)}
                  </strong>
                </div>
                <div className="p-2 rounded bg-[#0D1017]">
                  <span className="text-[#6D6D84]">IBH / IBL:</span>{' '}
                  <strong className="text-[#8B7CF6]">
                    {fmtNum(oa.ibh, 2)} / {fmtNum(oa.ibl, 2)}
                  </strong>
                </div>
                <div className="p-2 rounded bg-[#0D1017]">
                  <span className="text-[#6D6D84]">IB Width / ATR14d:</span>{' '}
                  <strong className="text-[#F3F3F9]">
                    {fmtNum(oa.ibWidth, 2)} / {fmtNum(oa.atr14d, 2)}
                  </strong>
                </div>
                <div className="p-2 rounded bg-[#0D1017]">
                  <span className="text-[#6D6D84]">True Gap (ATR) / 08:30:</span>{' '}
                  <strong className="text-[#F3F3F9]">
                    {fmtNum(oa.gapPct, 2)}x · {oa.macro0830SpikeDetected ? 'SPIKE' : 'NORMAL'}
                  </strong>
                </div>
              </div>
            )}

            {/* Cascada MTF */}
            <div className="pt-2 border-t border-[#1E1E2B] space-y-2">
              <div className="text-[12.5px] font-bold text-[#F3F3F9]">
                Estructura Multi-Timeframe (1D → 4H → 15M → 5M)
              </div>
              {micro?.mtf === null || micro?.mtf === undefined ? (
                <div className="text-[12px] font-mono-num text-[#6D6D84]">
                  {NULL_DISPLAY}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 text-[11.5px] font-mono-num">
                  <div className="p-2 rounded bg-[#0D1017]">
                    <span className="text-[#6D6D84]">Macro Effective:</span>{' '}
                    <strong className="text-[#F3F3F9]">{micro.mtf.effectiveMacroRegime}</strong>
                  </div>
                  <div className="p-2 rounded bg-[#0D1017]">
                    <span className="text-[#6D6D84]">Setup Status:</span>{' '}
                    <strong className="text-[#38BDF8]">{micro.mtf.setupStatus}</strong>
                  </div>
                  <div className="p-2 rounded bg-[#0D1017]">
                    <span className="text-[#6D6D84]">SMA200 1D / 50 4H:</span>{' '}
                    <strong className="text-[#A4A4BA]">
                      {fmtNum(micro.mtf.sma200_1d, 2)} / {fmtNum(micro.mtf.sma50_4h, 2)}
                    </strong>
                  </div>
                  <div className="p-2 rounded bg-[#0D1017]">
                    <span className="text-[#6D6D84]">EMA21 15M / HMA55:</span>{' '}
                    <strong className="text-[#A4A4BA]">
                      {fmtNum(micro.mtf.ema21_15m, 2)} / {fmtNum(micro.mtf.hma55, 2)}
                    </strong>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Columna 3: Escalera de Key Levels ordenada por precio */}
          <div className="rounded-[12px] bg-[#131722] border border-[#232733] p-4 space-y-3">
            <h3 className="text-[14px] font-bold text-[#F3F3F9]">
              Escalera de Niveles Clave ({symbol})
            </h3>
            <div className="max-h-[320px] overflow-y-auto divide-y divide-[#1E1E2B] text-[12px] font-mono-num">
              {snapshot.envelope.snapshot.keyLevels
                .filter((lvl) => isFiniteNum(lvl.price))
                .slice()
                .sort((a, b) => (b.price as number) - (a.price as number))
                .map((lvl) => {
                  const distPct =
                    isFiniteNum(spot) && spot > 0 && isFiniteNum(lvl.price)
                      ? ((lvl.price - spot) / spot) * 100
                      : null;
                  return (
                    <div key={lvl.name} className="py-1.5 flex items-center justify-between gap-2">
                      <div>
                        <span className="font-bold text-[#F3F3F9]">{lvl.name}</span>
                        <span className="ml-2 text-[10.5px] text-[#6D6D84]">{lvl.source}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span
                          className={
                            !isFiniteNum(distPct)
                              ? 'text-[#6D6D84]'
                              : distPct >= 0
                                ? 'text-[#2EDC7E]'
                                : 'text-[#FF5C63]'
                          }
                        >
                          {fmtPct(distPct, 2, true)}
                        </span>
                        <span className="font-bold text-[#F3F3F9] w-20 text-right">
                          ${fmtNum(lvl.price, 2)}
                        </span>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
