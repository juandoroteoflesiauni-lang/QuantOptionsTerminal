import React, { useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  Layers,
  Plus,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  NULL_DISPLAY,
  fmtCompactInt,
  fmtCompactUsd,
  fmtDecimalPct,
  fmtNum,
  fmtUsd,
  fmtUtcTimeET,
  isFiniteNum,
  type SerializedExposureSummary,
  type SerializedOptionContractRow,
  type TerminalSnapshotResponse,
  type TerminalUnusualResponse,
} from '../api/terminalClient';
import { KPICard, NoDataPanel, StatusBadge } from './DesignSystem';
import {
  CONTRACT_MULTIPLIER,
  evaluateRealStrategy,
  resolveContractIv,
  resolveContractPremium,
  type StrategyLegInput,
} from './options/engine';
import { VolatilitySurface } from './options/VolatilitySurface';

export type OptionsSubView = 'chain' | 'exposure' | 'surface' | 'payoff' | 'unusual';

export interface OptionsModuleProps {
  readonly symbol: string;
  readonly snapshot: TerminalSnapshotResponse | null;
  readonly unusual: TerminalUnusualResponse | null;
  readonly loading: boolean;
  readonly errorDetail: string | null;
  readonly subView: OptionsSubView;
  readonly onSubViewChange: (view: OptionsSubView) => void;
  readonly onRetry?: () => void;
}

type ExposureMetricKey = 'netGex' | 'callPutGex' | 'netDex' | 'netVannaExposure' | 'netCharmExposure' | 'oi';

export const OptionsModule: React.FC<OptionsModuleProps> = ({
  symbol,
  snapshot,
  unusual,
  loading,
  errorDetail,
  subView,
  onSubViewChange,
  onRetry,
}) => {
  const [selectedExpiry, setSelectedExpiry] = useState<string>('FRONT');
  const [typeFilter, setTypeFilter] = useState<'all' | 'call' | 'put'>('all');
  const [exposureMetric, setExposureMetric] = useState<ExposureMetricKey>('netGex');
  const [legs, setLegs] = useState<readonly StrategyLegInput[]>([]);

  const volSurface = snapshot?.volSurfaceSummary ?? null;
  const exposure = snapshot?.exposureSummary ?? null;
  const metrics = snapshot?.envelope.snapshot.metrics ?? null;
  const spot = metrics?.spot ?? null;

  const expirations = useMemo(() => {
    if (volSurface === null) {
      return [] as string[];
    }
    const set = new Set<string>();
    for (const s of volSurface.slices) {
      set.add(s.expirationDate);
    }
    for (const c of volSurface.contracts) {
      set.add(c.expirationDate);
    }
    return Array.from(set).sort();
  }, [volSurface]);

  const activeExpiry = useMemo(() => {
    if (expirations.length === 0) {
      return '';
    }
    if (selectedExpiry === 'ALL') {
      return 'ALL';
    }
    if (selectedExpiry !== 'FRONT' && expirations.includes(selectedExpiry)) {
      return selectedExpiry;
    }
    return volSurface?.frontSlice?.expirationDate ?? expirations[0] ?? '';
  }, [expirations, selectedExpiry, volSurface]);

  const filteredContracts = useMemo(() => {
    if (volSurface === null) {
      return [] as readonly SerializedOptionContractRow[];
    }
    return volSurface.contracts
      .filter((c) => (activeExpiry === '' || activeExpiry === 'ALL' ? true : c.expirationDate === activeExpiry))
      .filter((c) => (typeFilter === 'all' ? true : c.contractType === typeFilter))
      .sort((a, b) => a.strike - b.strike || (a.contractType === 'call' ? -1 : 1));
  }, [volSurface, activeExpiry, typeFilter]);

  const addLegFromContract = (contract: SerializedOptionContractRow, side: 1 | -1): void => {
    setLegs((prev) => {
      const existing = prev.find((l) => l.contract.ticker === contract.ticker && l.side === side);
      if (existing !== undefined) {
        return prev.map((l) =>
          l.id === existing.id ? { ...l, qty: l.qty + 1 } : l,
        );
      }
      return [
        ...prev,
        {
          id: `${contract.ticker}-${side === 1 ? 'L' : 'S'}-${String(Date.now())}-${String(prev.length)}`,
          contract,
          side,
          qty: 1,
        },
      ];
    });
    onSubViewChange('payoff');
  };

  const applyRealPreset = (preset: 'straddle' | 'call_spread' | 'iron_condor'): void => {
    if (!isFiniteNum(spot) || volSurface === null || volSurface.contracts.length === 0) {
      return;
    }
    const targetExpiry = activeExpiry !== 'ALL' && activeExpiry !== '' ? activeExpiry : expirations[0] ?? '';
    const pool = volSurface.contracts.filter((c) => c.expirationDate === targetExpiry);
    const calls = pool
      .filter((c) => c.contractType === 'call' && resolveContractPremium(c) !== null)
      .sort((a, b) => a.strike - b.strike);
    const puts = pool
      .filter((c) => c.contractType === 'put' && resolveContractPremium(c) !== null)
      .sort((a, b) => a.strike - b.strike);

    if (calls.length === 0 || puts.length === 0) {
      return;
    }

    const nearestCall = calls.reduce((best, c) =>
      Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best,
    );
    const nearestPut = puts.reduce((best, c) =>
      Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best,
    );

    if (preset === 'straddle') {
      setLegs([
        { id: `preset-sc-${nearestCall.ticker}`, contract: nearestCall, side: 1, qty: 1 },
        { id: `preset-sp-${nearestPut.ticker}`, contract: nearestPut, side: 1, qty: 1 },
      ]);
      return;
    }

    if (preset === 'call_spread') {
      const otmCall = calls.find((c) => c.strike > nearestCall.strike);
      if (otmCall !== undefined) {
        setLegs([
          { id: `preset-lc-${nearestCall.ticker}`, contract: nearestCall, side: 1, qty: 1 },
          { id: `preset-sc-${otmCall.ticker}`, contract: otmCall, side: -1, qty: 1 },
        ]);
      }
      return;
    }

    const otmShortCall = calls.find((c) => c.strike > spot);
    const otmLongCall =
      otmShortCall !== undefined ? calls.find((c) => c.strike > otmShortCall.strike) : undefined;
    const otmShortPut = [...puts].reverse().find((p) => p.strike < spot);
    const otmLongPut =
      otmShortPut !== undefined
        ? [...puts].reverse().find((p) => p.strike < otmShortPut.strike)
        : undefined;
    if (otmShortCall && otmLongCall && otmShortPut && otmLongPut) {
      setLegs([
        { id: `preset-lp-${otmLongPut.ticker}`, contract: otmLongPut, side: 1, qty: 1 },
        { id: `preset-sp-${otmShortPut.ticker}`, contract: otmShortPut, side: -1, qty: 1 },
        { id: `preset-sc-${otmShortCall.ticker}`, contract: otmShortCall, side: -1, qty: 1 },
        { id: `preset-lc-${otmLongCall.ticker}`, contract: otmLongCall, side: 1, qty: 1 },
      ]);
    }
  };

  const strategyEval = useMemo(
    () =>
      evaluateRealStrategy(
        legs,
        spot,
        snapshot?.asOfUtcSec ?? null,
        snapshot?.marketContext.treasury.rate30d ?? null,
        snapshot?.marketContext.treasury.dividendYieldFront ?? null,
      ),
    [legs, spot, snapshot],
  );

  if (errorDetail !== null && snapshot === null) {
    return <NoDataPanel reason="PROVIDER_ERROR" detail={errorDetail} onRetry={onRetry} />;
  }

  if (loading && snapshot === null) {
    return (
      <div className="p-8 rounded-[12px] bg-[#131722] border border-[#232733] text-center text-[13px] font-mono-num text-[#A4A4BA]">
        Cargando cadena de opciones, griegas propias y exposicion de dealers para {symbol}...
      </div>
    );
  }

  if (snapshot === null) {
    return (
      <NoDataPanel
        reason="NO_MARKET_DATA"
        detail={`Sin snapshot de opciones disponible para ${symbol}.`}
        onRetry={onRetry}
      />
    );
  }

  const tabs: readonly { id: OptionsSubView; label: string; icon: React.ReactNode }[] = [
    { id: 'chain', label: 'Cadena y Griegas', icon: <Layers className="w-3.5 h-3.5" /> },
    { id: 'exposure', label: 'Dealer GEX / DEX', icon: <BarChart3 className="w-3.5 h-3.5" /> },
    { id: 'surface', label: 'Vol Surface', icon: <Activity className="w-3.5 h-3.5" /> },
    { id: 'payoff', label: `Simulador (${String(legs.length)})`, icon: <Plus className="w-3.5 h-3.5" /> },
    { id: 'unusual', label: 'Unusual Flow', icon: <Zap className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="space-y-4">
      {/* Encabezado Ejecutivo Opciones */}
      <div className="p-4 rounded-[12px] bg-[#131722] border border-[#232733] flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-[#241F48] border border-[#8B7CF6]/50 flex items-center justify-center font-mono-num font-bold text-[#F3F3F9]">
            {symbol.replace('I:', '').slice(0, 3)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[17px] font-bold text-[#F3F3F9]">{symbol} · Desk Opciones</h2>
              <StatusBadge status={snapshot.status} />
            </div>
            <div className="text-[11.5px] font-mono-num text-[#787B86] flex flex-wrap items-center gap-3">
              <span>
                Spot: <strong className="text-[#F3F3F9]">{fmtUsd(spot, 2)}</strong>
              </span>
              <span>
                Gamma Regime:{' '}
                <strong
                  className={
                    snapshot.envelope.snapshot.gammaRegime === 'POSITIVE_GAMMA'
                      ? 'text-[#2EDC7E]'
                      : snapshot.envelope.snapshot.gammaRegime === 'NEGATIVE_GAMMA'
                        ? 'text-[#FF5C63]'
                        : 'text-[#F5B544]'
                  }
                >
                  {snapshot.envelope.snapshot.gammaRegime}
                </strong>
              </span>
              <span>
                IV Own/Fallback:{' '}
                <strong className="text-[#F3F3F9]">
                  {snapshot.dataQuality.ownSolvedIvContracts} /{' '}
                  {snapshot.dataQuality.providerFallbackIvContracts}
                </strong>
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onSubViewChange(t.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-semibold transition-colors cursor-pointer ${
                subView === t.id
                  ? 'bg-[#241F48] text-[#F3F3F9] border border-[#8B7CF6]'
                  : 'bg-[#171722] text-[#A4A4BA] border border-[#232733] hover:text-[#F3F3F9]'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Strip transversal de Opciones */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <KPICard
          title="Call Wall"
          heroValue={fmtUsd(exposure?.callWallStrike ?? metrics?.callWallStrike, 2)}
          subtitle="Mayor GEX / OI Call"
        />
        <KPICard
          title="Put Wall"
          heroValue={fmtUsd(exposure?.putWallStrike ?? metrics?.putWallStrike, 2)}
          subtitle="Mayor soporte Put"
        />
        <KPICard
          title="Gamma Flip"
          heroValue={fmtUsd(exposure?.gammaFlipSpot ?? metrics?.gammaFlipSpot, 2)}
          subtitle={exposure?.gammaFlipStatus ?? NULL_DISPLAY}
        />
        <KPICard
          title="Expected Move"
          heroValue={fmtUsd(exposure?.expectedMove.formulaMove ?? metrics?.expectedMove, 2)}
          subtitle={`+-${fmtDecimalPct(exposure?.expectedMove.formulaMovePct ?? metrics?.expectedMovePct, 2)} · Straddle ${fmtUsd(exposure?.expectedMove.straddleMove, 2)}`}
        />
        <KPICard
          title="IV 30D / RV"
          heroValue={fmtDecimalPct(metrics?.iv30d, 2)}
          subtitle={`RV 5m: ${fmtDecimalPct(metrics?.realizedVolAnnualized, 2)}`}
        />
        <KPICard
          title="VRP Spread"
          heroValue={fmtDecimalPct(metrics?.vrpSpread, 2, true)}
          subtitle={`RR25: ${fmtDecimalPct(metrics?.riskReversal25, 2, true)}`}
        />
      </div>

      {/* Subtab 1: Cadena Real & Griegas */}
      {subView === 'chain' && (
        <div className="rounded-[12px] bg-[#131722] border border-[#232733] overflow-hidden">
          <div className="px-4 py-3 border-b border-[#232733] flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-semibold text-[#A4A4BA]">Vencimiento:</span>
              <select
                value={activeExpiry}
                onChange={(e) => setSelectedExpiry(e.target.value)}
                className="px-2.5 py-1 rounded-[6px] bg-[#0D1017] border border-[#30303F] text-[12px] font-mono-num text-[#F3F3F9]"
              >
                {expirations.map((exp) => (
                  <option key={exp} value={exp}>
                    {exp}
                  </option>
                ))}
                <option value="ALL">Todos ({expirations.length})</option>
              </select>

              <div className="inline-flex rounded-[6px] bg-[#0D1017] border border-[#1E1E2B] p-0.5 text-[11px] font-mono-num">
                {(['all', 'call', 'put'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTypeFilter(t)}
                    className={`px-2.5 py-1 rounded cursor-pointer uppercase ${
                      typeFilter === t ? 'bg-[#241F48] text-[#F3F3F9]' : 'text-[#6D6D84]'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <span className="text-[11px] font-mono-num text-[#6D6D84]">
              Mostrando {filteredContracts.length} contratos reales
            </span>
          </div>

          {filteredContracts.length === 0 ? (
            <div className="p-8 text-center text-[13px] font-mono-num text-[#6D6D84]">
              NO_DATA: sin contratos filtrados para {symbol}.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[540px]">
              <table className="w-full text-left text-[11.5px] font-mono-num">
                <thead className="sticky top-0 bg-[#0D1017] text-[#6D6D84] border-b border-[#1E1E2B] z-10">
                  <tr>
                    <th className="py-2 px-2.5">Tipo</th>
                    <th className="py-2 px-2.5 text-right">Strike</th>
                    <th className="py-2 px-2.5">Exp</th>
                    <th className="py-2 px-2.5 text-right">Bid</th>
                    <th className="py-2 px-2.5 text-right">Ask</th>
                    <th className="py-2 px-2.5 text-right">Mid</th>
                    <th className="py-2 px-2.5 text-right">IV</th>
                    <th className="py-2 px-2.5 text-center">Src</th>
                    <th className="py-2 px-2.5 text-right">Delta</th>
                    <th className="py-2 px-2.5 text-right">Gamma</th>
                    <th className="py-2 px-2.5 text-right">Theta/d</th>
                    <th className="py-2 px-2.5 text-right">Vega 1%</th>
                    <th className="py-2 px-2.5 text-right">OI</th>
                    <th className="py-2 px-2.5 text-right">Vol</th>
                    <th className="py-2 px-2.5 text-center">Estrategia</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E1E2B]">
                  {filteredContracts.map((c) => {
                    const iv = resolveContractIv(c);
                    const isCall = c.contractType === 'call';
                    const isNearAtm = isFiniteNum(spot) && Math.abs(c.strike - spot) <= spot * 0.005;
                    return (
                      <tr
                        key={c.ticker}
                        className={`hover:bg-[#171722]/80 ${
                          isNearAtm ? 'bg-[#241F48]/25' : ''
                        }`}
                      >
                        <td className="py-1.5 px-2.5">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                              isCall
                                ? 'bg-[#0F2641] text-[#4BA3FF]'
                                : 'bg-[#3A1631] text-[#E5558F]'
                            }`}
                          >
                            {c.contractType}
                          </span>
                        </td>
                        <td className="py-1.5 px-2.5 text-right font-bold text-[#F3F3F9]">
                          ${fmtNum(c.strike, 2)}
                        </td>
                        <td className="py-1.5 px-2.5 text-[#787B86]">{c.expirationDate}</td>
                        <td className="py-1.5 px-2.5 text-right text-[#A4A4BA]">{fmtNum(c.bid, 2)}</td>
                        <td className="py-1.5 px-2.5 text-right text-[#A4A4BA]">{fmtNum(c.ask, 2)}</td>
                        <td className="py-1.5 px-2.5 text-right text-[#F3F3F9] font-semibold">
                          {fmtNum(c.mid, 2)}
                        </td>
                        <td
                          className={`py-1.5 px-2.5 text-right ${
                            iv !== null ? 'text-[#38BDF8]' : 'text-[#6D6D84]'
                          }`}
                        >
                          {fmtDecimalPct(iv, 2)}
                        </td>
                        <td className="py-1.5 px-2.5 text-center">
                          <span
                            className={`text-[10px] ${
                              c.ivSource === 'OWN'
                                ? 'text-[#2EDC7E]'
                                : c.ivSource === 'PROVIDER'
                                  ? 'text-[#F5B544]'
                                  : 'text-[#6D6D84]'
                            }`}
                          >
                            {c.ivSource}
                          </span>
                        </td>
                        <td className="py-1.5 px-2.5 text-right text-[#A4A4BA]">
                          {fmtNum(c.delta, 3)}
                        </td>
                        <td className="py-1.5 px-2.5 text-right text-[#A4A4BA]">
                          {fmtNum(c.gamma, 4)}
                        </td>
                        <td className="py-1.5 px-2.5 text-right text-[#FF5C63]">
                          {fmtNum(c.thetaDaily, 3)}
                        </td>
                        <td className="py-1.5 px-2.5 text-right text-[#A4A4BA]">
                          {fmtNum(c.vegaPer1Pct, 3)}
                        </td>
                        <td className="py-1.5 px-2.5 text-right text-[#F3F3F9]">
                          {fmtCompactInt(c.openInterest)}
                        </td>
                        <td className="py-1.5 px-2.5 text-right text-[#787B86]">
                          {fmtCompactInt(c.volume)}
                        </td>
                        <td className="py-1.5 px-2.5 text-center">
                          <div className="inline-flex gap-1">
                            <button
                              type="button"
                              onClick={() => addLegFromContract(c, 1)}
                              className="px-1.5 py-0.5 rounded bg-[#0E2F20] text-[#2EDC7E] border border-[#1C5C3C] hover:brightness-125 cursor-pointer"
                            >
                              +B
                            </button>
                            <button
                              type="button"
                              onClick={() => addLegFromContract(c, -1)}
                              className="px-1.5 py-0.5 rounded bg-[#331519] text-[#FF5C63] border border-[#6C2931] hover:brightness-125 cursor-pointer"
                            >
                              -S
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Subtab 2: Dealer Exposure Profile */}
      {subView === 'exposure' && (
        <DealerExposurePanel
          symbol={symbol}
          spot={spot}
          exposure={exposure}
          selectedMetric={exposureMetric}
          onSelectMetric={setExposureMetric}
        />
      )}

      {/* Subtab 3: Volatility Surface */}
      {subView === 'surface' && (
        <VolatilitySurface
          symbol={symbol}
          spot={spot}
          volSurface={volSurface}
          realizedVol={metrics?.realizedVolAnnualized ?? null}
        />
      )}

      {/* Subtab 4: Simulador Multi-Leg sobre contratos reales */}
      {subView === 'payoff' && (
        <div className="space-y-4">
          <div className="p-4 rounded-[12px] bg-[#131722] border border-[#232733] flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-[14px] font-bold text-[#F3F3F9]">
                Constructor Multi-Leg Real ({symbol})
              </h3>
              <p className="text-[12px] text-[#787B86]">
                Solo usa primas mid reales, IV propia y tasas r/q del backend (cero strikes sinteticos)
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => applyRealPreset('straddle')}
                className="px-2.5 py-1 rounded-[6px] bg-[#171722] border border-[#30303F] text-[11.5px] font-mono-num text-[#F3F3F9] hover:border-[#8B7CF6] cursor-pointer"
              >
                + Straddle ATM
              </button>
              <button
                type="button"
                onClick={() => applyRealPreset('call_spread')}
                className="px-2.5 py-1 rounded-[6px] bg-[#171722] border border-[#30303F] text-[11.5px] font-mono-num text-[#F3F3F9] hover:border-[#8B7CF6] cursor-pointer"
              >
                + Bull Call Spread
              </button>
              <button
                type="button"
                onClick={() => applyRealPreset('iron_condor')}
                className="px-2.5 py-1 rounded-[6px] bg-[#171722] border border-[#30303F] text-[11.5px] font-mono-num text-[#F3F3F9] hover:border-[#8B7CF6] cursor-pointer"
              >
                + Iron Condor
              </button>
              {legs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setLegs([])}
                  className="px-2.5 py-1 rounded-[6px] bg-[#331519] border border-[#6C2931] text-[11.5px] font-mono-num text-[#FF5C63] cursor-pointer"
                >
                  Limpiar
                </button>
              )}
            </div>
          </div>

          {legs.length === 0 ? (
            <div className="p-8 rounded-[12px] bg-[#131722] border border-[#232733] text-center text-[13px] text-[#787B86]">
              Agrega patas desde "Cadena y Griegas" (`+B` / `-S`) o carga un preset real arriba.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-5 rounded-[12px] bg-[#131722] border border-[#232733] p-4 space-y-3">
                <h4 className="text-[13px] font-bold text-[#F3F3F9]">Patas Seleccionadas</h4>
                <div className="space-y-2">
                  {legs.map((leg) => {
                    const prem = resolveContractPremium(leg.contract);
                    const iv = resolveContractIv(leg.contract);
                    return (
                      <div
                        key={leg.id}
                        className="p-2.5 rounded-[8px] bg-[#0D1017] border border-[#1E1E2B] flex items-center justify-between gap-2 text-[11.5px] font-mono-num"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`font-bold ${
                                leg.side === 1 ? 'text-[#2EDC7E]' : 'text-[#FF5C63]'
                              }`}
                            >
                              {leg.side === 1 ? 'LONG' : 'SHORT'} x{leg.qty}
                            </span>
                            <span className="text-[#F3F3F9] font-semibold">
                              ${fmtNum(leg.contract.strike, 2)}{' '}
                              {leg.contract.contractType.toUpperCase()}
                            </span>
                            <span className="text-[#6D6D84]">{leg.contract.expirationDate}</span>
                          </div>
                          <div className="text-[10.5px] text-[#787B86] mt-0.5">
                            Mid: {fmtUsd(prem, 2)} · IV: {fmtDecimalPct(iv, 2)} · Δ{' '}
                            {fmtNum(leg.contract.delta, 3)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={leg.qty}
                            onChange={(e) => {
                              const nextQty = Math.max(1, Math.min(100, Number(e.target.value) || 1));
                              setLegs((prev) =>
                                prev.map((l) => (l.id === leg.id ? { ...l, qty: nextQty } : l)),
                              );
                            }}
                            className="w-12 px-1.5 py-0.5 rounded bg-[#171722] border border-[#30303F] text-right text-[#F3F3F9]"
                          />
                          <button
                            type="button"
                            onClick={() => setLegs((prev) => prev.filter((l) => l.id !== leg.id))}
                            className="p-1 rounded text-[#FF5C63] hover:bg-[#331519] cursor-pointer"
                            aria-label="Eliminar pata"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {strategyEval !== null && (
                  <div className="pt-2 border-t border-[#1E1E2B] grid grid-cols-2 gap-2 text-[11.5px] font-mono-num">
                    <div className="p-2 rounded bg-[#0D1017]">
                      <div className="text-[#6D6D84]">Flujo Neto ({CONTRACT_MULTIPLIER}x)</div>
                      <div
                        className={`font-bold ${
                          isFiniteNum(strategyEval.netDebitOrCredit)
                            ? strategyEval.netDebitOrCredit >= 0
                              ? 'text-[#2EDC7E]'
                              : 'text-[#F5B544]'
                            : 'text-[#6D6D84]'
                        }`}
                      >
                        {fmtUsd(strategyEval.netDebitOrCredit, 2)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-[#0D1017]">
                      <div className="text-[#6D6D84]">Max Gain / Loss</div>
                      <div className="text-[#F3F3F9] font-bold">
                        {fmtUsd(strategyEval.maxProfit, 0)} / {fmtUsd(strategyEval.maxLoss, 0)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-[#0D1017]">
                      <div className="text-[#6D6D84]">Net Delta / Theta</div>
                      <div className="text-[#A4A4BA]">
                        {fmtNum(strategyEval.netDelta, 1)} / {fmtUsd(strategyEval.netThetaDaily, 2)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-[#0D1017]">
                      <div className="text-[#6D6D84]">Breakevens</div>
                      <div className="text-[#38BDF8]">
                        {strategyEval.breakevens.length > 0
                          ? strategyEval.breakevens.map((b) => `$${fmtNum(b, 2)}`).join(', ')
                          : NULL_DISPLAY}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="lg:col-span-7 rounded-[12px] bg-[#131722] border border-[#232733] p-4">
                <h4 className="text-[13px] font-bold text-[#F3F3F9] mb-2">
                  Curva de Payoff P&amp;L (Vencimiento vs T+0 BSM)
                </h4>
                <RealPayoffSvg strategyEval={strategyEval} spot={spot} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Subtab 5: Unusual Options Flow */}
      {subView === 'unusual' && (
        <div className="rounded-[12px] bg-[#131722] border border-[#232733] overflow-hidden">
          <div className="px-4 py-3 border-b border-[#232733] flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-[14px] font-bold text-[#F3F3F9]">
                Flujo Inusual de Opciones (/options/v1/unusual-trades)
              </h3>
              <p className="text-[11.5px] text-[#787B86] font-mono-num">
                Aceptados: {unusual !== null ? String(unusual.accepted) : NULL_DISPLAY} · Filtrados:{' '}
                {unusual !== null ? String(unusual.filteredOut) : NULL_DISPLAY} · Raiz distingue
                SPXW vs SPX
              </p>
            </div>
            <StatusBadge status={unusual?.status ?? 'NO_DATA'} />
          </div>

          {unusual === null || unusual.trades.length === 0 ? (
            <div className="p-8 text-center text-[13px] font-mono-num text-[#6D6D84]">
              NO_DATA: sin trades inusuales devueltos para {symbol}.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[520px]">
              <table className="w-full text-left text-[11.5px] font-mono-num">
                <thead className="sticky top-0 bg-[#0D1017] text-[#6D6D84] border-b border-[#1E1E2B]">
                  <tr>
                    <th className="py-2 px-3">Hora (ET)</th>
                    <th className="py-2 px-3">Root</th>
                    <th className="py-2 px-3">Contrato OCC</th>
                    <th className="py-2 px-3">Tipo</th>
                    <th className="py-2 px-3 text-right">Strike</th>
                    <th className="py-2 px-3">Exp</th>
                    <th className="py-2 px-3 text-right">Prima</th>
                    <th className="py-2 px-3 text-right">Size</th>
                    <th className="py-2 px-3 text-right">Nocional</th>
                    <th className="py-2 px-3">Flags</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E1E2B]">
                  {unusual.trades.map((tr) => (
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

const DealerExposurePanel: React.FC<{
  readonly symbol: string;
  readonly spot: number | null;
  readonly exposure: SerializedExposureSummary | null;
  readonly selectedMetric: ExposureMetricKey;
  readonly onSelectMetric: (m: ExposureMetricKey) => void;
}> = ({ symbol, spot, exposure, selectedMetric, onSelectMetric }) => {
  if (exposure === null || exposure.byStrike.length === 0) {
    return (
      <div className="p-8 rounded-[12px] bg-[#131722] border border-[#232733] text-center space-y-2">
        <StatusBadge status="NO_DATA" label="NO_DATA · EXPOSURE" />
        <p className="text-[13px] font-mono-num text-[#6D6D84]">
          Sin datos de exposicion de dealers por strike para {symbol}.
        </p>
      </div>
    );
  }

  // Seleccionar ventana cercana al Spot para legibilidad del perfil por strike
  const sortedStrikes = [...exposure.byStrike].sort((a, b) => a.strike - b.strike);
  const windowRows = isFiniteNum(spot)
    ? sortedStrikes.filter((row) => Math.abs(row.strike - spot) <= spot * 0.12).slice(-32)
    : sortedStrikes.slice(0, 32);

  const visibleRows = windowRows.length > 0 ? windowRows : sortedStrikes.slice(0, 32);

  const maxAbs = Math.max(
    1e-9,
    ...visibleRows.flatMap((row) => {
      if (selectedMetric === 'callPutGex') {
        return [
          isFiniteNum(row.callGex) ? Math.abs(row.callGex) : 0,
          isFiniteNum(row.putGex) ? Math.abs(row.putGex) : 0,
        ];
      }
      if (selectedMetric === 'oi') {
        return [row.callOi, row.putOi];
      }
      const val = row[selectedMetric];
      return [isFiniteNum(val) ? Math.abs(val) : 0];
    }),
  );

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-[12px] bg-[#131722] border border-[#232733] flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-6 text-[12px] font-mono-num">
          <div>
            <div className="text-[#6D6D84]">Net Dollar GEX</div>
            <div className="text-[15px] font-bold text-[#F3F3F9]">
              {fmtCompactUsd(exposure.netGex)}
            </div>
          </div>
          <div>
            <div className="text-[#6D6D84]">Net DEX ($)</div>
            <div className="text-[15px] font-bold text-[#38BDF8]">
              {fmtCompactUsd(exposure.netDex)}
            </div>
          </div>
          <div>
            <div className="text-[#6D6D84]">Vanna Exposure</div>
            <div className="text-[15px] font-bold text-[#8B7CF6]">
              {fmtCompactUsd(exposure.netVannaExposure)}
            </div>
          </div>
          <div>
            <div className="text-[#6D6D84]">Charm Exposure</div>
            <div className="text-[15px] font-bold text-[#F5B544]">
              {fmtCompactUsd(exposure.netCharmExposure)}
            </div>
          </div>
          <div>
            <div className="text-[#6D6D84]">Calidad Cadena</div>
            <div className="text-[13px] font-semibold text-[#A4A4BA]">
              {exposure.quality.usableContracts}/{exposure.quality.activeContracts} usables · Omitidos:{' '}
              {exposure.quality.skippedContracts} ({fmtDecimalPct(exposure.quality.skippedOiShare, 1)} OI)
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 text-[11px] font-mono-num">
          {(
            [
              ['netGex', 'Net GEX'],
              ['callPutGex', 'Call / Put GEX'],
              ['netDex', 'Net DEX'],
              ['netVannaExposure', 'Vanna'],
              ['netCharmExposure', 'Charm'],
              ['oi', 'Open Interest'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => onSelectMetric(key)}
              className={`px-2.5 py-1 rounded-[6px] border cursor-pointer ${
                selectedMetric === key
                  ? 'bg-[#241F48] text-[#F3F3F9] border-[#8B7CF6]'
                  : 'bg-[#0D1017] text-[#A4A4BA] border-[#1E1E2B]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Perfil visual por Strike */}
      <div className="p-4 rounded-[12px] bg-[#131722] border border-[#232733] space-y-1.5">
        {visibleRows.map((row) => {
          const isCallWall = exposure.callWallStrike === row.strike;
          const isPutWall = exposure.putWallStrike === row.strike;
          const isSpotNearest = isFiniteNum(spot) && Math.abs(row.strike - spot) <= spot * 0.004;

          if (selectedMetric === 'callPutGex' || selectedMetric === 'oi') {
            const leftVal =
              selectedMetric === 'oi'
                ? row.putOi
                : isFiniteNum(row.putGex)
                  ? Math.abs(row.putGex)
                  : null;
            const rightVal =
              selectedMetric === 'oi'
                ? row.callOi
                : isFiniteNum(row.callGex)
                  ? Math.abs(row.callGex)
                  : null;
            const leftPct = leftVal !== null ? Math.min(100, (leftVal / maxAbs) * 100) : 0;
            const rightPct = rightVal !== null ? Math.min(100, (rightVal / maxAbs) * 100) : 0;
            return (
              <div
                key={row.strike}
                className={`grid grid-cols-[1fr_92px_1fr] items-center gap-2 py-0.5 text-[11px] font-mono-num ${
                  isSpotNearest ? 'bg-[#241F48]/30 rounded px-1' : ''
                }`}
              >
                <div className="flex items-center justify-end gap-2">
                  <span className="text-[#FF5C63]">
                    {selectedMetric === 'oi'
                      ? fmtCompactInt(row.putOi)
                      : fmtCompactUsd(row.putGex)}
                  </span>
                  <div className="w-40 h-2.5 bg-[#0D1017] rounded-l overflow-hidden flex justify-end">
                    <div
                      className="h-full bg-[#FF5C63]/80"
                      style={{ width: `${String(leftPct)}%` }}
                    />
                  </div>
                </div>
                <div className="text-center font-bold text-[#F3F3F9]">
                  ${fmtNum(row.strike, 1)}
                  {isCallWall ? ' CW' : isPutWall ? ' PW' : ''}
                </div>
                <div className="flex items-center justify-start gap-2">
                  <div className="w-40 h-2.5 bg-[#0D1017] rounded-r overflow-hidden">
                    <div
                      className="h-full bg-[#2EDC7E]/80"
                      style={{ width: `${String(rightPct)}%` }}
                    />
                  </div>
                  <span className="text-[#2EDC7E]">
                    {selectedMetric === 'oi'
                      ? fmtCompactInt(row.callOi)
                      : fmtCompactUsd(row.callGex)}
                  </span>
                </div>
              </div>
            );
          }

          const val = row[selectedMetric];
          const valid = isFiniteNum(val);
          const pctWidth = valid ? Math.min(100, (Math.abs(val) / maxAbs) * 100) : 0;
          const isPositive = valid && val >= 0;

          return (
            <div
              key={row.strike}
              className={`grid grid-cols-[84px_1fr_96px] items-center gap-3 py-0.5 text-[11px] font-mono-num ${
                isSpotNearest ? 'bg-[#241F48]/30 rounded px-1' : ''
              }`}
            >
              <span className="font-bold text-[#F3F3F9]">
                ${fmtNum(row.strike, 1)}
                {isCallWall ? ' [CW]' : isPutWall ? ' [PW]' : ''}
              </span>
              <div className="h-2.5 bg-[#0D1017] rounded overflow-hidden">
                {valid && (
                  <div
                    className={`h-full rounded ${isPositive ? 'bg-[#2EDC7E]/80' : 'bg-[#FF5C63]/80'}`}
                    style={{ width: `${String(pctWidth)}%` }}
                  />
                )}
              </div>
              <span
                className={`text-right ${
                  !valid ? 'text-[#6D6D84]' : isPositive ? 'text-[#2EDC7E]' : 'text-[#FF5C63]'
                }`}
              >
                {fmtCompactUsd(val)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const RealPayoffSvg: React.FC<{
  readonly strategyEval: ReturnType<typeof evaluateRealStrategy>;
  readonly spot: number | null;
}> = ({ strategyEval, spot }) => {
  if (strategyEval === null) {
    return (
      <div className="h-64 flex items-center justify-center text-[12px] font-mono-num text-[#6D6D84]">
        {NULL_DISPLAY} (Sin datos suficientes para evaluar payoff)
      </div>
    );
  }

  const expiryVals = strategyEval.points
    .map((p) => p.expiryPnl)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const t0Vals = strategyEval.points
    .map((p) => p.t0TheoreticalPnl)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const allVals = [...expiryVals, ...t0Vals, 0];

  if (expiryVals.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-[12px] font-mono-num text-[#6D6D84]">
        NO_DATA: Alguna pata seleccionada no posee mid/lastPrice valido.
      </div>
    );
  }

  const yMin = Math.min(...allVals);
  const yMax = Math.max(...allVals);
  const ySpan = Math.max(yMax - yMin, 1);
  const xMin = strategyEval.minSpot;
  const xMax = strategyEval.maxSpot;
  const xSpan = Math.max(xMax - xMin, 1e-4);

  const W = 720;
  const H = 280;
  const PL = 64;
  const PR = 18;
  const PT = 18;
  const PB = 34;

  const mx = (s: number): number => PL + ((s - xMin) / xSpan) * (W - PL - PR);
  const my = (v: number): number => H - PB - ((v - yMin) / ySpan) * (H - PT - PB);
  const zeroY = my(0);

  const expiryPath = strategyEval.points
    .filter((p): p is typeof p & { readonly expiryPnl: number } => p.expiryPnl !== null)
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${mx(p.spot).toFixed(1)},${my(p.expiryPnl).toFixed(1)}`)
    .join(' ');

  const t0Path = strategyEval.points
    .filter(
      (p): p is typeof p & { readonly t0TheoreticalPnl: number } =>
        p.t0TheoreticalPnl !== null,
    )
    .map(
      (p, idx) =>
        `${idx === 0 ? 'M' : 'L'}${mx(p.spot).toFixed(1)},${my(p.t0TheoreticalPnl).toFixed(1)}`,
    )
    .join(' ');

  return (
    <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className="w-full h-auto select-none">
      <line x1={PL} y1={zeroY} x2={W - PR} y2={zeroY} stroke="rgba(255,255,255,0.22)" />
      <text
        x={PL - 8}
        y={zeroY + 4}
        textAnchor="end"
        fill="#A4A4BA"
        fontSize="10"
        className="font-mono-num"
      >
        $0
      </text>
      <text
        x={PL - 8}
        y={PT + 8}
        textAnchor="end"
        fill="#2EDC7E"
        fontSize="10"
        className="font-mono-num"
      >
        {fmtUsd(yMax, 0)}
      </text>
      <text
        x={PL - 8}
        y={H - PB}
        textAnchor="end"
        fill="#FF5C63"
        fontSize="10"
        className="font-mono-num"
      >
        {fmtUsd(yMin, 0)}
      </text>

      {isFiniteNum(spot) && spot >= xMin && spot <= xMax && (
        <g>
          <line
            x1={mx(spot)}
            y1={PT}
            x2={mx(spot)}
            y2={H - PB}
            stroke="#F5B544"
            strokeDasharray="4 4"
          />
          <text
            x={mx(spot)}
            y={H - 10}
            textAnchor="middle"
            fill="#F5B544"
            fontSize="10.5"
            className="font-mono-num"
          >
            Spot ${fmtNum(spot, 2)}
          </text>
        </g>
      )}

      {expiryPath !== '' && (
        <path d={expiryPath} fill="none" stroke="#2EDC7E" strokeWidth={2.25} />
      )}
      {t0Path !== '' && (
        <path d={t0Path} fill="none" stroke="#38BDF8" strokeWidth={1.75} strokeDasharray="5 4" />
      )}
    </svg>
  );
};
