import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Layers,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  Zap,
} from 'lucide-react';
import {
  NULL_DISPLAY,
  TerminalApiError,
  fmtCompactInt,
  fmtCompactUsd,
  fmtDecimalPct,
  fmtNum,
  fmtUsd,
  fmtUtcTimeET,
  isFiniteNum,
  type TerminalSnapshotResponse,
  type TerminalUnusualResponse,
} from '../api/terminalClient';
import { DEFAULT_WATCHLIST_SYMBOLS, resolveSymbolMeta } from '../data/marketData';
import { HeatTile, InsightBanner, KPICard, NoDataPanel, StatusBadge } from './DesignSystem';

export type NavSection = 'overview' | 'detail' | 'options' | 'macro' | 'unusual';

export interface OverviewModuleProps {
  readonly symbol: string;
  readonly snapshot: TerminalSnapshotResponse | null;
  readonly unusual: TerminalUnusualResponse | null;
  readonly loading: boolean;
  readonly error: TerminalApiError | Error | null;
  readonly onSelectSymbol: (symbol: string) => void;
  readonly onNavigate: (section: NavSection) => void;
  readonly onRetry: () => void;
}

export const OverviewModule: React.FC<OverviewModuleProps> = ({
  symbol,
  snapshot,
  unusual,
  loading,
  error,
  onSelectSymbol,
  onNavigate,
  onRetry,
}) => {
  const errMsg =
    error instanceof TerminalApiError
      ? `${error.reason}: ${error.detail}`
      : error instanceof Error
        ? error.message
        : null;

  if (errMsg !== null && snapshot === null) {
    return (
      <NoDataPanel
        reason={error instanceof TerminalApiError ? error.reason : 'PROVIDER_ERROR'}
        detail={errMsg}
        onRetry={onRetry}
      />
    );
  }

  if (loading && snapshot === null) {
    return (
      <div className="p-8 rounded-[12px] bg-[#131722] border border-[#232733] text-center text-[13px] font-mono-num text-[#A4A4BA]">
        Cargando resumen cuantitativo multi-capa para {symbol}...
      </div>
    );
  }

  if (snapshot === null) {
    return (
      <NoDataPanel
        reason="NO_MARKET_DATA"
        detail={`Sin snapshot activo para ${symbol}.`}
        onRetry={onRetry}
      />
    );
  }

  const snap = snapshot.envelope.snapshot;
  const m = snap.metrics;
  const quotes = snapshot.marketContext.unifiedQuotes;
  const matchedQuote = quotes.find((q) => q.ticker === symbol) ?? null;

  const variant: 'pos' | 'neg' | 'warn' | 'default' =
    snap.directionalBias === 'STRONG_BULLISH' || snap.directionalBias === 'BULLISH'
      ? 'pos'
      : snap.directionalBias === 'STRONG_BEARISH' || snap.directionalBias === 'BEARISH'
        ? 'neg'
        : snapshot.marketContext.tailRiskAlert === true
          ? 'warn'
          : 'default';

  const activePillarsLabel =
    isFiniteNum(snap.activePillarsCount) && isFiniteNum(snap.totalPillarsCount)
      ? `${String(snap.activePillarsCount)}/${String(snap.totalPillarsCount)} pilares`
      : NULL_DISPLAY;

  return (
    <div className="space-y-4">
      <InsightBanner tag={`${symbol} · ${snapshot.status}`} variant={variant}>
        Sesgo <strong className="text-[#F3F3F9]">{snap.directionalBias}</strong> (Score{' '}
        <strong className="font-mono-num text-[#F3F3F9]">{fmtNum(snap.confluenceScore, 2)}</strong>) ·
        Regimen Gamma <strong className="text-[#38BDF8]">{snap.gammaRegime}</strong> · Macro VIX{' '}
        <strong className="text-[#F5B544]">{snapshot.marketContext.vixRegime}</strong>
      </InsightBanner>

      {/* Top KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <KPICard
          title={`${symbol} Spot`}
          heroValue={fmtUsd(m.spot ?? matchedQuote?.price, 2)}
          deltaPct={matchedQuote?.changePct}
          subtitle={`AsOf ${fmtUtcTimeET(snapshot.asOfUtcSec)} · Vol ${fmtCompactInt(matchedQuote?.volume)}`}
          badge={resolveSymbolMeta(symbol).venue}
          onClick={() => onNavigate('detail')}
        />
        <KPICard
          title="Confluencia Multi-Capa"
          heroValue={fmtNum(snap.confluenceScore, 2)}
          subtitle={`${snap.directionalBias} · ${activePillarsLabel}`}
          badge={snapshot.envelope.envelopeStatus}
          onClick={() => onNavigate('detail')}
        />
        <KPICard
          title="Net Dollar GEX / Walls"
          heroValue={fmtCompactUsd(m.netDollarGex)}
          subtitle={`CW ${fmtUsd(m.callWallStrike, 1)} · PW ${fmtUsd(m.putWallStrike, 1)} · Flip ${fmtUsd(m.gammaFlipSpot, 2)}`}
          badge={snap.gammaRegime}
          onClick={() => onNavigate('options')}
        />
        <KPICard
          title="IV 30D / VRP Spread"
          heroValue={fmtDecimalPct(m.iv30d, 2)}
          subtitle={`RV 5m: ${fmtDecimalPct(m.realizedVolAnnualized, 2)} · VRP: ${fmtDecimalPct(m.vrpSpread, 2, true)}`}
          badge={`ExpMove +- ${fmtDecimalPct(m.expectedMovePct, 2)}`}
          onClick={() => onNavigate('options')}
        />
      </div>

      {/* Unified Market Benchmarks + Quick Navigation Cards */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-7 rounded-[12px] bg-[#131722] border border-[#232733] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[14.5px] font-bold text-[#F3F3F9]">
                Snapshots Unificados en Vivo (Stocks / ETFs / Indices)
              </h3>
              <p className="text-[11.5px] text-[#787B86]">
                Click en cualquier ticker para recargar el terminal completo sobre datos reales
              </p>
            </div>
            <StatusBadge status={snapshot.status} />
          </div>

          {quotes.length === 0 ? (
            <div className="py-6 text-center text-[12px] font-mono-num text-[#6D6D84]">
              NO_DATA: Sin quotes unificados disponibles.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
              {quotes.map((q) => {
                const meta = resolveSymbolMeta(q.ticker);
                return (
                  <HeatTile
                    key={q.ticker}
                    ticker={q.ticker}
                    deltaPct={q.changePct}
                    price={fmtUsd(q.price, 2)}
                    subtitle={q.marketStatus ?? q.assetType.toUpperCase()}
                    color={meta.accentColor}
                    selected={q.ticker === symbol}
                    onClick={() => onSelectSymbol(q.ticker)}
                  />
                );
              })}
            </div>
          )}

          {/* Selector rapido Watchlist US */}
          <div className="pt-2 border-t border-[#1E1E2B] flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-mono-num text-[#6D6D84] mr-1">Watchlist US:</span>
            {DEFAULT_WATCHLIST_SYMBOLS.map((item) => (
              <button
                key={item.ticker}
                type="button"
                onClick={() => onSelectSymbol(item.ticker)}
                className={`px-2 py-0.5 rounded-[6px] text-[11px] font-mono-num border cursor-pointer ${
                  item.ticker === symbol
                    ? 'bg-[#241F48] text-[#F3F3F9] border-[#8B7CF6]'
                    : 'bg-[#0D1017] text-[#A4A4BA] border-[#1E1E2B] hover:text-[#F3F3F9]'
                }`}
              >
                {item.ticker}
              </button>
            ))}
          </div>
        </div>

        {/* Pilares Resumen + Acceso Directo a Modulos */}
        <div className="xl:col-span-5 rounded-[12px] bg-[#131722] border border-[#232733] p-4 space-y-3">
          <h3 className="text-[14.5px] font-bold text-[#F3F3F9]">
            Resumen de Pilares Cuantitativos ({symbol})
          </h3>
          <div className="divide-y divide-[#1E1E2B] text-[12px]">
            {snap.pillars.map((p) => (
              <div key={p.id} className="py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-[#F3F3F9] truncate">{p.label}</div>
                  <div className="text-[11px] font-mono-num text-[#787B86] truncate">
                    {p.summaryCode}
                  </div>
                </div>
                <div className="font-mono-num text-right shrink-0">
                  <span
                    className={`font-bold ${
                      !isFiniteNum(p.score)
                        ? 'text-[#6D6D84]'
                        : p.score > 0.1
                          ? 'text-[#2EDC7E]'
                          : p.score < -0.1
                            ? 'text-[#FF5C63]'
                            : 'text-[#F5B544]'
                    }`}
                  >
                    {fmtNum(p.score, 2)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tarjetas de Navegacion Directa entre Modulos */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {[
          {
            id: 'detail' as const,
            title: 'Grafico Vela & Microestructura',
            desc: 'Candlesticks en tiempo real con EMA21, AVWAP +-2s, zonas ON/IB, CVD y RSI(14).',
            icon: <TrendingUp className="w-4 h-4 text-[#38BDF8]" />,
            metric: `${snapshot.microstructure.mtf?.setupStatus ?? NULL_DISPLAY}`,
          },
          {
            id: 'options' as const,
            title: 'Desk de Opciones & GEX',
            desc: 'Cadena completa, griegas BSM/BAW propias, Call/Put Wall, Gamma Flip y Vol Surface.',
            icon: <Layers className="w-4 h-4 text-[#8B7CF6]" />,
            metric: `${snapshot.dataQuality.chainContractsUsable} contratos`,
          },
          {
            id: 'macro' as const,
            title: 'Curva US Treasury & VIX/SKEW',
            desc: 'Tasas 1M–10Y, SOFR live, regimen macro VIX y auditoria de calidad IV.',
            icon: <BarChart3 className="w-4 h-4 text-[#2EDC7E]" />,
            metric: `VIX ${fmtNum(snapshot.marketContext.vixLevel, 2)} · 10Y ${fmtDecimalPct(snapshot.marketContext.treasury.yield10Y, 2)}`,
          },
          {
            id: 'unusual' as const,
            title: 'Unusual Options Flow',
            desc: 'Lectura paginada de bloques, sweeps e ISOs por raiz OCC (SPXW vs SPX).',
            icon: <Zap className="w-4 h-4 text-[#F5B544]" />,
            metric:
              unusual !== null
                ? `${String(unusual.trades.length)} trades`
                : `Flow ${NULL_DISPLAY}`,
          },
        ].map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => onNavigate(card.id)}
            className="text-left p-4 rounded-[12px] bg-[#131722] border border-[#232733] hover:border-[#8B7CF6]/70 transition-colors cursor-pointer flex flex-col justify-between gap-2"
          >
            <div className="flex items-center justify-between">
              <div className="inline-flex items-center gap-2 font-bold text-[13.5px] text-[#F3F3F9]">
                {card.icon}
                {card.title}
              </div>
              <ArrowUpRight className="w-4 h-4 text-[#6D6D84]" />
            </div>
            <p className="text-[12px] text-[#787B86] leading-snug">{card.desc}</p>
            <div className="text-[11px] font-mono-num text-[#38BDF8] font-semibold">
              {card.metric}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

export interface MacroRatesModuleProps {
  readonly symbol: string;
  readonly snapshot: TerminalSnapshotResponse | null;
  readonly loading: boolean;
  readonly error: TerminalApiError | Error | null;
  readonly onRetry: () => void;
}

export const MacroRatesModule: React.FC<MacroRatesModuleProps> = ({
  symbol,
  snapshot,
  loading,
  error,
  onRetry,
}) => {
  const errMsg =
    error instanceof TerminalApiError
      ? `${error.reason}: ${error.detail}`
      : error instanceof Error
        ? error.message
        : null;

  if (errMsg !== null && snapshot === null) {
    return (
      <NoDataPanel
        reason={error instanceof TerminalApiError ? error.reason : 'PROVIDER_ERROR'}
        detail={errMsg}
        onRetry={onRetry}
      />
    );
  }

  if (loading && snapshot === null) {
    return (
      <div className="p-8 rounded-[12px] bg-[#131722] border border-[#232733] text-center text-[13px] font-mono-num text-[#A4A4BA]">
        Cargando curva US Treasury, SOFR y regimen VIX/SKEW...
      </div>
    );
  }

  if (snapshot === null) {
    return (
      <NoDataPanel
        reason="NO_MARKET_DATA"
        detail={`Sin contexto macro disponible para ${symbol}.`}
        onRetry={onRetry}
      />
    );
  }

  const mc = snapshot.marketContext;
  const dq = snapshot.dataQuality;
  const metrics = snapshot.envelope.snapshot.metrics;

  const curvePoints = [
    { label: 'SOFR', years: 1 / 365, rate: mc.treasury.sofr },
    { label: '1M', years: 1 / 12, rate: mc.treasury.yield1M },
    { label: '3M', years: 3 / 12, rate: mc.treasury.yield3M },
    { label: '1Y', years: 1, rate: mc.treasury.yield1Y },
    { label: '2Y', years: 2, rate: mc.treasury.yield2Y },
    { label: '10Y', years: 10, rate: mc.treasury.yield10Y },
  ];

  const finiteRates = curvePoints
    .map((pt) => pt.rate)
    .filter((r): r is number => isFiniteNum(r));
  const minR = finiteRates.length > 0 ? Math.min(...finiteRates) * 100 : 0;
  const maxR = finiteRates.length > 0 ? Math.max(...finiteRates) * 100 : 1;
  const rLow = Math.max(0, minR - 0.5);
  const rHigh = Math.max(rLow + 0.5, maxR + 0.5);

  const W = 560;
  const H = 220;
  const PL = 48;
  const PR = 20;
  const PT = 20;
  const PB = 32;

  const validCurveNodes = curvePoints.filter((pt) => isFiniteNum(pt.rate));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard
          title="VIX Spot"
          heroValue={fmtNum(mc.vixLevel, 2)}
          subtitle={`Regimen: ${mc.vixRegime}`}
        />
        <KPICard
          title="VIX Slope (1D-1W)"
          heroValue={fmtNum(mc.vixSlope, 3)}
          subtitle={`Position Multiplier: ${fmtNum(metrics.positionSizeMultiplier, 2)}x`}
        />
        <KPICard
          title="CBOE SKEW"
          heroValue={fmtNum(mc.skewLevel, 1)}
          subtitle={
            mc.tailRiskAlert === true
              ? 'ALERTA TAIL RISK ACTIVA'
              : mc.tailRiskAlert === false
                ? 'Sin alerta de cola extrema'
                : NULL_DISPLAY
          }
        />
        <KPICard
          title="US SOFR / r(30d)"
          heroValue={fmtDecimalPct(mc.treasury.sofr, 2)}
          subtitle={`r(30d) interp.: ${fmtDecimalPct(mc.treasury.rate30d, 2)}`}
        />
        <KPICard
          title={`Div. Yield Front (${symbol})`}
          heroValue={fmtDecimalPct(mc.treasury.dividendYieldFront, 2)}
          subtitle={`Fecha curva UST: ${mc.treasury.date ?? NULL_DISPLAY}`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Curva US Treasury */}
        <div className="lg:col-span-7 rounded-[12px] bg-[#131722] border border-[#232733] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[14px] font-bold text-[#F3F3F9]">
                Curva Soberana US Treasury + SOFR
              </h3>
              <p className="text-[11.5px] text-[#787B86] font-mono-num">
                Insumo directo para paridad put-call F = e^(rT) y griegas BSM/BAW ({mc.treasury.date ?? NULL_DISPLAY})
              </p>
            </div>
            <Activity className="w-4 h-4 text-[#4BA3FF]" />
          </div>

          {validCurveNodes.length < 2 ? (
            <div className="py-10 text-center text-[12px] font-mono-num text-[#6D6D84]">
              NO_DATA: curva de tasas insuficiente.
            </div>
          ) : (
            <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className="w-full h-auto select-none">
              {[0, 0.5, 1].map((t, i) => {
                const val = rLow + t * (rHigh - rLow);
                const y = H - PB - ((val - rLow) / (rHigh - rLow)) * (H - PT - PB);
                return (
                  <g key={`rt-${String(i)}`}>
                    <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="rgba(255,255,255,0.06)" />
                    <text
                      x={PL - 8}
                      y={y + 3.5}
                      textAnchor="end"
                      fill="#6D6D84"
                      fontSize="10"
                      className="font-mono-num"
                    >
                      {val.toFixed(2)}%
                    </text>
                  </g>
                );
              })}

              <path
                d={curvePoints
                  .map((pt, idx) => {
                    if (!isFiniteNum(pt.rate)) {
                      return '';
                    }
                    const x = PL + (idx / (curvePoints.length - 1)) * (W - PL - PR);
                    const y =
                      H -
                      PB -
                      ((pt.rate * 100 - rLow) / (rHigh - rLow)) * (H - PT - PB);
                    return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
                  })
                  .filter(Boolean)
                  .join(' ')}
                fill="none"
                stroke="#4BA3FF"
                strokeWidth={2.25}
              />

              {curvePoints.map((pt, idx) => {
                const x = PL + (idx / (curvePoints.length - 1)) * (W - PL - PR);
                const valid = isFiniteNum(pt.rate);
                const y = valid
                  ? H -
                    PB -
                    (((pt.rate as number) * 100 - rLow) / (rHigh - rLow)) * (H - PT - PB)
                  : H - PB;
                return (
                  <g key={pt.label}>
                    <text
                      x={x}
                      y={H - 10}
                      textAnchor="middle"
                      fill="#787B86"
                      fontSize="10.5"
                      className="font-mono-num"
                    >
                      {pt.label}
                    </text>
                    {valid && (
                      <>
                        <circle
                          cx={x}
                          cy={y}
                          r={4}
                          fill="#0D1017"
                          stroke="#4BA3FF"
                          strokeWidth={2}
                        />
                        <text
                          x={x}
                          y={y - 10}
                          textAnchor="middle"
                          fill="#F3F3F9"
                          fontSize="10"
                          className="font-mono-num"
                        >
                          {fmtDecimalPct(pt.rate, 2)}
                        </text>
                      </>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* Auditoria de Calidad Cuantitativa */}
        <div className="lg:col-span-5 rounded-[12px] bg-[#131722] border border-[#232733] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[14px] font-bold text-[#F3F3F9]">
              Auditoria de Datos &amp; Integridad
            </h3>
            {dq.warnings.length === 0 ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-mono-num text-[#2EDC7E]">
                <ShieldCheck className="w-3.5 h-3.5" /> LIMPIO
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] font-mono-num text-[#F5B544]">
                <AlertTriangle className="w-3.5 h-3.5" /> {dq.warnings.length} WARN
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 text-[12px] font-mono-num">
            <div className="p-2.5 rounded bg-[#0D1017]">
              <div className="text-[#6D6D84]">Contratos IV Propia</div>
              <div className="text-[#2EDC7E] font-bold">{dq.ownSolvedIvContracts}</div>
            </div>
            <div className="p-2.5 rounded bg-[#0D1017]">
              <div className="text-[#6D6D84]">Fallback IV Proveedor</div>
              <div className="text-[#F5B544] font-bold">{dq.providerFallbackIvContracts}</div>
            </div>
            <div className="p-2.5 rounded bg-[#0D1017]">
              <div className="text-[#6D6D84]">Expiries Paridad F/q</div>
              <div className="text-[#38BDF8] font-bold">{dq.parityExpiries}</div>
            </div>
            <div className="p-2.5 rounded bg-[#0D1017]">
              <div className="text-[#6D6D84]">Cadena Usable / Recibida</div>
              <div className="text-[#F3F3F9] font-bold">
                {dq.chainContractsUsable} / {dq.chainContractsReceived}
              </div>
            </div>
            <div className="p-2.5 rounded bg-[#0D1017] col-span-2 flex justify-between">
              <span className="text-[#6D6D84]">Campos No-Finitos (NaN-&gt;null)</span>
              <strong className="text-[#A4A4BA]">{snapshot.envelope.nonFiniteFieldCount}</strong>
            </div>
          </div>

          {dq.warnings.length > 0 && (
            <div className="max-h-36 overflow-y-auto space-y-1 text-[11px] font-mono-num text-[#F5B544]">
              {dq.warnings.map((w, i) => (
                <div key={i} className="p-2 rounded bg-[#35280F]/50 border border-[#F5B544]/25">
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export interface UnusualFlowModuleProps {
  readonly symbol: string;
  readonly unusual: TerminalUnusualResponse | null;
  readonly loading: boolean;
  readonly error: TerminalApiError | Error | null;
  readonly onRefresh: (opts: { readonly root?: string; readonly minPremium?: number }) => void;
}

export const UnusualFlowModule: React.FC<UnusualFlowModuleProps> = ({
  symbol,
  unusual,
  loading,
  error,
  onRefresh,
}) => {
  const [rootFilter, setRootFilter] = useState<string>('');
  const [minPremiumInput, setMinPremiumInput] = useState<string>('50000');

  const filteredTrades = useMemo(() => {
    if (unusual === null) {
      return [];
    }
    const minVal = Number(minPremiumInput);
    return unusual.trades.filter((tr) => {
      if (rootFilter.trim() !== '' && tr.root !== rootFilter.trim().toUpperCase()) {
        return false;
      }
      if (Number.isFinite(minVal) && minVal > 0 && isFiniteNum(tr.notional) && tr.notional < minVal) {
        return false;
      }
      return true;
    });
  }, [unusual, rootFilter, minPremiumInput]);

  const errMsg =
    error instanceof TerminalApiError
      ? `${error.reason}: ${error.detail}`
      : error instanceof Error
        ? error.message
        : null;

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-[12px] bg-[#131722] border border-[#232733] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Zap className="w-5 h-5 text-[#F5B544]" />
          <div>
            <h2 className="text-[16px] font-bold text-[#F3F3F9]">
              Unusual Options Trades ({symbol})
            </h2>
            <p className="text-[11.5px] font-mono-num text-[#787B86]">
              sip_timestamp nanosegundos convertidos a UTC seg · filtro OCC por subyacente y root
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[12px] font-mono-num">
          <input
            type="text"
            value={rootFilter}
            onChange={(e) => setRootFilter(e.target.value)}
            placeholder="Root (ej. SPXW)"
            className="w-32 px-2.5 py-1.5 rounded-[7px] bg-[#0D1017] border border-[#30303F] text-[#F3F3F9]"
          />
          <input
            type="number"
            value={minPremiumInput}
            onChange={(e) => setMinPremiumInput(e.target.value)}
            placeholder="Min USD"
            className="w-28 px-2.5 py-1.5 rounded-[7px] bg-[#0D1017] border border-[#30303F] text-[#F3F3F9]"
          />
          <button
            type="button"
            onClick={() => {
              const minP = Number(minPremiumInput);
              onRefresh({
                ...(rootFilter.trim() !== '' ? { root: rootFilter.trim().toUpperCase() } : {}),
                ...(Number.isFinite(minP) && minP > 0 ? { minPremium: minP } : {}),
              });
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[7px] bg-[#241F48] border border-[#8B7CF6]/60 text-[#F3F3F9] hover:brightness-110 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Consultar
          </button>
        </div>
      </div>

      {errMsg !== null ? (
        <NoDataPanel
          reason={error instanceof TerminalApiError ? error.reason : 'PROVIDER_ERROR'}
          detail={errMsg}
          onRetry={() => onRefresh({})}
        />
      ) : unusual === null ? (
        <div className="p-8 rounded-[12px] bg-[#131722] border border-[#232733] text-center text-[13px] font-mono-num text-[#6D6D84]">
          {loading ? 'Consultando flujo inusual...' : 'NO_DATA'}
        </div>
      ) : (
        <div className="rounded-[12px] bg-[#131722] border border-[#232733] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#232733] flex items-center justify-between text-[11.5px] font-mono-num text-[#787B86]">
            <span>
              Recibidos: {unusual.received} · Aceptados: {unusual.accepted} · Mostrados:{' '}
              {filteredTrades.length}
            </span>
            <StatusBadge status={unusual.status} />
          </div>

          {filteredTrades.length === 0 ? (
            <div className="p-8 text-center text-[12.5px] font-mono-num text-[#6D6D84]">
              NO_DATA: ningún trade coincide con los filtros actuales.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[560px]">
              <table className="w-full text-left text-[11.5px] font-mono-num">
                <thead className="sticky top-0 bg-[#0D1017] text-[#6D6D84] border-b border-[#1E1E2B]">
                  <tr>
                    <th className="py-2 px-3">Hora ET</th>
                    <th className="py-2 px-3">Root</th>
                    <th className="py-2 px-3">OCC</th>
                    <th className="py-2 px-3">Tipo</th>
                    <th className="py-2 px-3 text-right">Strike</th>
                    <th className="py-2 px-3">Venc.</th>
                    <th className="py-2 px-3 text-right">Precio</th>
                    <th className="py-2 px-3 text-right">Contratos</th>
                    <th className="py-2 px-3 text-right">Nocional USD</th>
                    <th className="py-2 px-3">Flags</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E1E2B]">
                  {filteredTrades.map((tr) => (
                    <tr
                      key={`${tr.ticker}-${tr.timestampNs}-${String(tr.sequenceNumber)}`}
                      className="hover:bg-[#171722]/70"
                    >
                      <td className="py-1.5 px-3 text-[#787B86]">{fmtUtcTimeET(tr.time)}</td>
                      <td className="py-1.5 px-3 font-bold text-[#38BDF8]">
                        {tr.root} <span className="text-[10px] text-[#6D6D84]">({tr.rootKind})</span>
                      </td>
                      <td className="py-1.5 px-3 text-[#F3F3F9]">{tr.ticker}</td>
                      <td className="py-1.5 px-3">
                        <span
                          className={`uppercase font-bold ${
                            tr.contractType === 'call'
                              ? 'text-[#4BA3FF]'
                              : tr.contractType === 'put'
                                ? 'text-[#E5558F]'
                                : 'text-[#6D6D84]'
                          }`}
                        >
                          {tr.contractType ?? NULL_DISPLAY}
                        </span>
                      </td>
                      <td className="py-1.5 px-3 text-right text-[#F3F3F9]">
                        {fmtUsd(tr.strike, 2)}
                      </td>
                      <td className="py-1.5 px-3 text-[#A4A4BA]">
                        {tr.expirationDate ?? NULL_DISPLAY}
                      </td>
                      <td className="py-1.5 px-3 text-right text-[#F3F3F9]">
                        {fmtUsd(tr.price, 2)}
                      </td>
                      <td className="py-1.5 px-3 text-right text-[#A4A4BA]">
                        {fmtCompactInt(tr.size)}
                      </td>
                      <td className="py-1.5 px-3 text-right font-bold text-[#2EDC7E]">
                        {fmtCompactUsd(tr.notional)}
                      </td>
                      <td className="py-1.5 px-3">
                        <div className="flex flex-wrap gap-1">
                          {tr.flags.length === 0 ? (
                            <span className="text-[#6D6D84]">{NULL_DISPLAY}</span>
                          ) : (
                            tr.flags.map((f) => (
                              <span
                                key={f}
                                className="px-1.5 py-0.5 rounded bg-[#14203D] text-[#5B8CFF] text-[10px]"
                              >
                                {f}
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
