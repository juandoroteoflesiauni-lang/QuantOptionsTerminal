import React, { useMemo, useState } from 'react';
import { type OptionExpiryGroup, fmtNum } from '../../data/marketData';
import type { ArOptionsQuantEnginesDto, ArOptionsResponse, UsSnapshotResponseDto, UsVolSurfaceResponseDto } from '../../data/liveTypes';
import type { StratLeg } from './engine';
import { computeActiveExpiryVrpAndRegime } from '../../../../src/core/options/volAnalyticsSuite';
import { computeActiveExpirySkewAndIvRegime } from '../../../../src/core/options/volMetrics';
import { computeForwardIvTermStructure } from '../../../../src/core/options/volSurface';
import {
  BLOCKED_SHORT_DTE_TOOLTIP,
  formatDteLabel,
  oratsVolToPct,
} from '../../../../src/core/options/zeroDteFixes';
import {
  type UnifiedQuantEnginesDto,
  type VolAnalyticsExpirySuiteDto,
  type VolAnalyticsSuiteDto,
  type VolHistoryHorizon,
  type VolSuiteCompositeSmilePointDto,
  type VolSuiteDualSurfaceNodeDto,
  type VolSuiteExpectedConeDto,
  type VolSuiteHistoryPointDto,
  type VolSuiteOperativeRegimeCode,
  type VolSuiteRatioRowDto,
  type VolSuiteSmilePointDto,
  type VolSuiteStructureCostDto,
  buildSvgLinePath,
  computeNumericExtent,
  fmtNullableNumber,
  fmtSignedNullable,
  resolveActiveVolAnalyticsSuite,
  resolveExpiryVolSuite,
  resolveUnifiedQuantEngines,
  sliceHistorySeriesByHorizon,
} from './optionsDerived';

export type VolatilitySubTabId =
  | 'resumen'
  | 'sonrisa'
  | 'historica'
  | 'paridad'
  | 'estructuras'
  | 'dual';

type SmileXAxisMode = 'MONEYNESS' | 'STRIKE' | 'DELTA';

export interface VolatilitySuiteViewProps {
  readonly underlying: string;
  readonly stockName: string;
  readonly spot: number;
  readonly activeExpiry: OptionExpiryGroup | null;
  readonly expiries: readonly OptionExpiryGroup[];
  readonly onSelectExpiry: (expiryId: string) => void;
  readonly effectiveTlrPct: number;
  readonly liveOptions: ArOptionsResponse | undefined;
  readonly activeQuantEngines: ArOptionsQuantEnginesDto | null;
  readonly usSnapshot: UsSnapshotResponseDto | undefined;
  readonly usVolSurface?: UsVolSurfaceResponseDto | null;
  readonly onSendToBuilder: (legs: StratLeg[]) => void;
}

const SUB_TABS: readonly { readonly id: VolatilitySubTabId; readonly num: string; readonly label: string }[] = [
  { id: 'resumen', num: '01', label: 'Resumen & Cono' },
  { id: 'sonrisa', num: '02', label: 'Sonrisa & Matriz' },
  { id: 'historica', num: '03', label: 'Histórica & Estacionalidad' },
  { id: 'paridad', num: '04', label: 'Paridad & Tasas' },
  { id: 'estructuras', num: '05', label: 'Estructuras & Costo BS2002' },
  { id: 'dual', num: '06', label: 'Dual BYMA vs OPRA' },
];

const HORIZONS: readonly VolHistoryHorizon[] = ['1M', '3M', '6M', '1A', 'TODO'];

function regimePillStyle(code: VolSuiteOperativeRegimeCode): string {
  switch (code) {
    case 'VENTA_PRIMA_CUBIERTA':
      return 'bg-[#E5C76B]/10 text-[#E5C76B] border-[#E5C76B]/30';
    case 'COMPRA_CONVEXIDAD_CALENDAR':
      return 'bg-[#38BDF8]/10 text-[#38BDF8] border-[#38BDF8]/30';
    case 'NO_SHORT_PREMIUM_RISK':
      return 'bg-[#F43F5E]/10 text-[#F43F5E] border-[#F43F5E]/40';
    case 'NEUTRAL_SELECTIVO':
      return 'bg-[#B794F4]/10 text-[#B794F4] border-[#B794F4]/30';
    default:
      return 'bg-[#16161D] text-[#9CA3AF] border-[#252532]';
  }
}

function ratioRowToLegs(row: VolSuiteRatioRowDto): StratLeg[] {
  const optType = row.side === 'CALL' ? 'C' : 'P';
  return [
    { side: 1, type: optType, K: row.longStrike, ratio: 1 },
    { side: -1, type: optType, K: row.shortStrike, ratio: 2 },
  ];
}

function structureItemToLegs(item: VolSuiteStructureCostDto): StratLeg[] | null {
  if (item.id === 'BULL_CALL_5' && item.strikes.length >= 2) {
    const k1 = item.strikes[0];
    const k2 = item.strikes[1];
    if (k1 === undefined || k2 === undefined) return null;
    return [
      { side: 1, type: 'C', K: k1, ratio: 1 },
      { side: -1, type: 'C', K: k2, ratio: 1 },
    ];
  }
  if (item.id === 'BEAR_PUT_5' && item.strikes.length >= 2) {
    const kHi = item.strikes[0];
    const kLo = item.strikes[1];
    if (kHi === undefined || kLo === undefined) return null;
    return [
      { side: 1, type: 'P', K: kHi, ratio: 1 },
      { side: -1, type: 'P', K: kLo, ratio: 1 },
    ];
  }
  if (item.id === 'BUTTERFLY_SYM' && item.strikes.length >= 3) {
    const k0 = item.strikes[0];
    const k1 = item.strikes[1];
    const k2 = item.strikes[2];
    if (k0 === undefined || k1 === undefined || k2 === undefined) return null;
    return [
      { side: 1, type: 'C', K: k0, ratio: 1 },
      { side: -1, type: 'C', K: k1, ratio: 2 },
      { side: 1, type: 'C', K: k2, ratio: 1 },
    ];
  }
  return null;
}

function buildLinearTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count < 2) return [];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + i * step);
}

export const VolatilitySuiteView: React.FC<VolatilitySuiteViewProps> = ({
  underlying,
  stockName,
  spot,
  activeExpiry,
  expiries,
  onSelectExpiry,
  effectiveTlrPct,
  liveOptions,
  activeQuantEngines,
  usSnapshot,
  usVolSurface,
  onSendToBuilder,
}) => {
  const [activeTab, setActiveTab] = useState<VolatilitySubTabId>('resumen');
  const [onlyOtm, setOnlyOtm] = useState<boolean>(true);
  const [smileXAxis, setSmileXAxis] = useState<SmileXAxisMode>('MONEYNESS');
  const [showPriorSmile, setShowPriorSmile] = useState<boolean>(false);
  const [horizon, setHorizon] = useState<VolHistoryHorizon>('1A');

  const suite = useMemo(
    () =>
      resolveActiveVolAnalyticsSuite({
        liveOptions,
        liveQuantEngines: activeQuantEngines,
        usSnapshot,
      }),
    [liveOptions, activeQuantEngines, usSnapshot],
  );

  const expirySuite = useMemo(
    () => resolveExpiryVolSuite(suite, activeExpiry?.id ?? null),
    [suite, activeExpiry?.id],
  );

  const unifiedQuant = useMemo(
    () => resolveUnifiedQuantEngines(activeQuantEngines, usSnapshot),
    [activeQuantEngines, usSnapshot],
  );


  const displaySpot =
    suite?.spot !== null && suite?.spot !== undefined && Number.isFinite(suite.spot)
      ? suite.spot
      : spot;
  const activeSmile = expirySuite
    ? onlyOtm
      ? expirySuite.smileOtmOnly
      : expirySuite.smileAll
    : null;
  const hist = suite?.historicalConditional ?? null;
  const activeVrp = useMemo(() => {
    const activeDte = expirySuite?.daysToExpiry ?? activeExpiry?.daysToExpiry ?? null;
    const activeCode = expirySuite?.expiryCode ?? activeExpiry?.id ?? null;
    const interpAtm =
      activeSmile?.atmIvPct !== null &&
      activeSmile?.atmIvPct !== undefined &&
      Number.isFinite(activeSmile.atmIvPct) &&
      activeSmile.atmIvPct > 0
        ? activeSmile.atmIvPct
        : expirySuite?.smileOtmOnly.atmIvPct !== null &&
            expirySuite?.smileOtmOnly.atmIvPct !== undefined &&
            Number.isFinite(expirySuite.smileOtmOnly.atmIvPct) &&
            expirySuite.smileOtmOnly.atmIvPct > 0
          ? expirySuite.smileOtmOnly.atmIvPct
          : null;
    const sameExpFallback =
      expirySuite?.smileAll.atmIvPct !== null &&
      expirySuite?.smileAll.atmIvPct !== undefined &&
      Number.isFinite(expirySuite.smileAll.atmIvPct) &&
      expirySuite.smileAll.atmIvPct > 0
        ? expirySuite.smileAll.atmIvPct
        : activeExpiry && Number.isFinite(activeExpiry.atmIV) && activeExpiry.atmIV > 0
          ? activeExpiry.atmIV
          : null;
    const rv23 =
      hist?.latestRv23Pct !== null &&
      hist?.latestRv23Pct !== undefined &&
      Number.isFinite(hist.latestRv23Pct) &&
      hist.latestRv23Pct > 0
        ? hist.latestRv23Pct
        : null;
    const rv20 =
      hist?.latestRv20Pct !== null &&
      hist?.latestRv20Pct !== undefined &&
      Number.isFinite(hist.latestRv20Pct) &&
      hist.latestRv20Pct > 0
        ? hist.latestRv20Pct
        : null;
    const histSeries = (hist?.historySeries ?? [])
      .map((p) => p.rvPct)
      .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0);
    return computeActiveExpiryVrpAndRegime({
      expiryCode: activeCode,
      daysToExpiry: activeDte,
      ivAtmActiveExpiryPct: interpAtm,
      sameExpiryFallbackIvAtmPct: sameExpFallback,
      rvReferencePct: rv23 ?? rv20,
      rvReferenceLabel: rv23 !== null ? 'RV23d' : 'RV20d',
      historicalRvSeriesPct: histSeries,
      historicalRvMinPct: hist?.quantiles.minPct ?? null,
      historicalRvMaxPct: hist?.quantiles.maxPct ?? null,
      fallbackIvRank: hist?.ivRank ?? null,
      fallbackIvPercentile: hist?.ivPercentile ?? null,
      spot: displaySpot,
      putWallStrike:
        usSnapshot?.exposureSummary?.putWallStrike ??
        liveOptions?.exposureSummary?.putWallStrike ??
        null,
      netGex:
        usSnapshot?.exposureSummary?.netGex ??
        liveOptions?.exposureSummary?.netGex ??
        null,
    });
  }, [expirySuite, activeSmile, activeExpiry, hist, displaySpot, usSnapshot, liveOptions]);
  const marketTag = suite?.market ?? (usSnapshot ? 'US' : 'BYMA');
  const currencyPrefix = marketTag === 'US' ? 'US$' : '$';
  const oratsSurface =
    usVolSurface?.surface?.status === 'OPERATIONAL' ? usVolSurface.surface : null;
  const oratsIvRank =
    usVolSurface?.ivRank?.status === 'OPERATIONAL' ? usVolSurface.ivRank.row : null;

  // Pieza 50: régimen de skew 25Δ (RR/BF) e IVR/IVP 1Y del vencimiento activo.
  // `row.callIV` / `row.putIV` ya vienen en puntos porcentuales (28.5) -> decimal exacto /100.
  const skewRegime = useMemo(() => {
    const contracts: {
      readonly strike: number;
      readonly contractType: 'call' | 'put';
      readonly iv: number | null;
      readonly delta: number | null;
    }[] = [];
    for (const row of activeExpiry?.rows ?? []) {
      const callIvDec =
        Number.isFinite(row.callIV) && row.callIV > 0 ? row.callIV / 100 : null;
      const putIvDec =
        Number.isFinite(row.putIV) && row.putIV > 0 ? row.putIV / 100 : null;
      contracts.push({
        strike: row.strike,
        contractType: 'call',
        iv: callIvDec,
        delta: Number.isFinite(row.callDelta) ? row.callDelta : null,
      });
      contracts.push({
        strike: row.strike,
        contractType: 'put',
        iv: putIvDec,
        delta: Number.isFinite(row.putDelta) ? row.putDelta : null,
      });
    }

    // Proxy RV 1Y explícito (últimas 252 sesiones) cuando ORATS /ivrank no está disponible.
    const historicalIv1y = (hist?.historySeries ?? []).slice(-252).map((p) =>
      p.rvPct !== null && p.rvPct !== undefined && Number.isFinite(p.rvPct) && p.rvPct > 0
        ? p.rvPct / 100
        : null,
    );

    const continuousRate = liveOptions?.continuousRate ?? null;
    const rateTna = liveOptions?.rateTna ?? null;
    const rateDec =
      continuousRate !== null && Number.isFinite(continuousRate)
        ? continuousRate
        : rateTna !== null && Number.isFinite(rateTna)
          ? Math.log(1 + rateTna / 100)
          : Number.NaN;

    return computeActiveExpirySkewAndIvRegime({
      spot: displaySpot,
      timeToExpiryYears:
        activeExpiry !== null && activeExpiry.daysToExpiry > 0
          ? activeExpiry.daysToExpiry / 365
          : Number.NaN,
      rate: rateDec,
      dividendYield: liveOptions?.dividendYield ?? Number.NaN,
      contracts,
      historicalIv1y,
    });
  }, [activeExpiry, displaySpot, hist, liveOptions]);

  // Prioridad de IVR/IVP: ORATS 1Y (US y OPERATIONAL) o Proxy RV 1Y del vencimiento activo.
  const ivRankOneYearDisplay = oratsIvRank?.ivRank1y ?? skewRegime.ivr;
  const ivRankOneYearSource =
    oratsIvRank?.ivRank1y !== null && oratsIvRank?.ivRank1y !== undefined
      ? 'ORATS 1Y'
      : skewRegime.ivr !== null
        ? 'Proxy RV 1Y'
        : '—';
  const ivPctOneYearDisplay = oratsIvRank?.ivPct1y ?? skewRegime.ivp;
  const ivPctOneYearSource =
    oratsIvRank?.ivPct1y !== null && oratsIvRank?.ivPct1y !== undefined
      ? 'ORATS 1Y'
      : skewRegime.ivp !== null
        ? 'Proxy RV 1Y'
        : '—';

  const benchmarkText = suite
    ? `${suite.benchmarkLabel}: ${fmtNullableNumber(suite.rateTeaPct, 2, '%')}`
    : `Tasa ref.: ${fmtNullableNumber(effectiveTlrPct, 2, '%')}`;

  const forwardSegments = useMemo(() => {
    const validPoints = expiries
      .map((exp) => {
        const rowMatch = suite?.moneynessMatrixOtm.rows.find((r) => r.expiryCode === exp.id);
        const ivPct = rowMatch?.atmIvPct ?? (Number.isFinite(exp.atmIV) ? exp.atmIV : null);
        return {
          expiryCode: exp.id,
          dte: exp.daysToExpiry,
          timeToExpiry: exp.daysToExpiry > 0 ? exp.daysToExpiry / 365 : Number.NaN,
          atmIv: ivPct !== null && Number.isFinite(ivPct) && ivPct > 0 ? ivPct / 100 : Number.NaN,
        };
      })
      .filter((p) => Number.isFinite(p.timeToExpiry) && p.timeToExpiry > 0 && Number.isFinite(p.atmIv) && p.atmIv > 0);
    return computeForwardIvTermStructure(validPoints);
  }, [expiries, suite?.moneynessMatrixOtm.rows]);

  const forwardSegmentByFarCode = useMemo(() => {
    const map = new Map<string, (typeof forwardSegments)[number]>();
    for (const seg of forwardSegments) {
      if (seg.farExpiryCode) {
        map.set(seg.farExpiryCode, seg);
      }
    }
    return map;
  }, [forwardSegments]);

  return (
    <div className="space-y-4">
      {/* Cabecera neutra superior "El Teórico" + selector de vencimiento */}
      <div className="rounded-[14px] bg-[#111116] border border-[#1C1C24] p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-[#16161F] border border-[#272734] text-[10px] font-bold tracking-wider uppercase text-[#38BDF8] font-mono-num">
                {marketTag}
              </span>
              <h2 className="text-[16px] font-extrabold text-[#F3F4F6] tracking-tight">
                {underlying} <span className="text-[#9CA3AF] font-semibold">· {stockName}</span>
              </h2>
              {hist && (
                <span
                  title={`Régimen alineado al vencimiento activo (${formatDteLabel(activeVrp.daysToExpiry)}) · VRP: ${fmtSignedNullable(activeVrp.vrpActiveExpiryPts, 1, ' pts')} vs ${activeVrp.rvReferenceLabel} (${fmtNullableNumber(activeVrp.rvReferencePct, 1, '%')})`}
                  className={`px-2.5 py-0.5 rounded-full border text-[10.5px] font-semibold ${regimePillStyle(
                    activeVrp.operativeRegime.code,
                  )}`}
                >
                  {activeVrp.operativeRegime.label}
                  {Number.isFinite(activeVrp.daysToExpiry) ? ` · ${formatDteLabel(activeVrp.daysToExpiry)}` : ''}
                </span>
              )}
            </div>
            <p className="text-[12px] text-[#9CA3AF]">
              Spot:{' '}
              <strong className="text-[#F9FAFB] font-mono-num">
                {Number.isFinite(displaySpot) ? `${currencyPrefix}${fmtNum(displaySpot, 2)}` : '—'}
              </strong>{' '}
              · {benchmarkText} · Motor:{' '}
              <span className="text-[#D1D5DB]">Bjerksund-Stensland 2002 &amp; Breeden-Litzenberger Q</span>
            </p>
          </div>

          {/* Selector sincronizado de vencimiento */}
          <div className="flex flex-wrap items-center gap-1.5">
            {expiries.length === 0 ? (
              <span className="text-[11px] text-[#6B7280] font-mono-num">Sin vencimientos activos</span>
            ) : (
              expiries.map((exp) => {
                const isSelected = exp.id === activeExpiry?.id;
                const rowMatch = suite?.moneynessMatrixOtm.rows.find((r) => r.expiryCode === exp.id);
                const atmLabel = fmtNullableNumber(rowMatch?.atmIvPct ?? (Number.isFinite(exp.atmIV) ? exp.atmIV : null), 1, '%');
                const fwdSeg = forwardSegmentByFarCode.get(exp.id);
                return (
                  <button
                    key={exp.id}
                    type="button"
                    onClick={() => onSelectExpiry(exp.id)}
                    title={
                      fwdSeg
                        ? fwdSeg.calendarArbFlag
                          ? `Inversión de varianza total respecto a ${fwdSeg.nearExpiryCode ?? 'vto previo'}`
                          : fwdSeg.forwardIv !== null
                            ? `Forward IV ${fwdSeg.nearExpiryCode ?? ''} → ${exp.id}: ${fmtNum(fwdSeg.forwardIv * 100, 1)}%`
                            : undefined
                        : undefined
                    }
                    className={`px-2.5 py-1.5 rounded-[8px] border text-left transition-colors ${
                      isSelected
                        ? 'bg-[#1D1E28] border-[#E5C76B]/60 text-[#F9FAFB]'
                        : 'bg-[#0A0A0D] border-[#1C1C24] text-[#9CA3AF] hover:border-[#2C2C38] hover:text-[#E5E7EB]'
                    }`}
                  >
                    <div className="text-[11px] font-bold leading-tight">{exp.label}</div>
                    <div className="text-[10px] font-mono-num text-[#6B7280]">
                      {formatDteLabel(exp.daysToExpiry)} · <span className="text-[#E5C76B]">{atmLabel}</span>
                      {fwdSeg && (
                        <>
                          {' '}·{' '}
                          {fwdSeg.calendarArbFlag ? (
                            <span className="text-rose-300 font-semibold">Arb Cal.</span>
                          ) : fwdSeg.forwardIv !== null ? (
                            <span className="text-[#38BDF8]">Fwd {fmtNum(fwdSeg.forwardIv * 100, 1)}%</span>
                          ) : null}
                        </>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Cinta de 5 KPIs descriptivos sin calificativos subjetivos */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
          <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">VI ATM OTM</div>
            <div className="text-[16px] font-extrabold font-mono-num text-[#E5C76B]">
              {fmtNullableNumber(activeVrp.ivAtmActiveExpiryPct, 1, '%')}
            </div>
            <div className="text-[10px] text-[#9CA3AF] font-mono-num">
              {Number.isFinite(activeVrp.daysToExpiry)
                ? activeVrp.daysToExpiry === 0
                  ? '0DTE (vence hoy)'
                  : `${String(activeVrp.daysToExpiry)}d al vto`
                : '—'}
            </div>
          </div>
          <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">RV 23 Ruedas</div>
            <div className="text-[16px] font-extrabold font-mono-num text-[#38BDF8]">
              {fmtNullableNumber(hist?.latestRv23Pct, 1, '%')}
            </div>
            <div className="text-[10px] text-[#9CA3AF] font-mono-num">
              20d: {fmtNullableNumber(hist?.latestRv20Pct, 1, '%')} · 60d: {fmtNullableNumber(hist?.latestRv60Pct, 1, '%')}
            </div>
          </div>
          <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">
              VRP ({Number.isFinite(activeVrp.daysToExpiry) ? `VI ${formatDteLabel(activeVrp.daysToExpiry)}` : 'VI'} − {activeVrp.rvReferenceLabel})
            </div>
            <div className="text-[16px] font-extrabold font-mono-num text-[#F3F4F6]">
              {fmtSignedNullable(activeVrp.vrpActiveExpiryPts, 1, ' pts')}
            </div>
            <div className="text-[10px] text-[#9CA3AF] font-mono-num">
              {activeVrp.rvReferenceLabel}: {fmtNullableNumber(activeVrp.rvReferencePct, 1, '%')} · RR 25Δ: {fmtSignedNullable(activeSmile?.riskReversal25DeltaPp, 1, ' pp')}
            </div>
          </div>
          <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">IV Rank / Percentil</div>
            <div className="text-[16px] font-extrabold font-mono-num text-[#B794F4]">
              {fmtNullableNumber(activeVrp.ivRankActiveExpiry, 0, '%')} <span className="text-[#6B7280]">/</span>{' '}
              {fmtNullableNumber(activeVrp.ivPercentileActiveExpiry, 0, '%')}
            </div>
            <div className="text-[10px] text-[#9CA3AF] font-mono-num">
              Muestra: {hist?.barsUsed ?? 0} ruedas
            </div>
          </div>
          <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">Mov. Diario Esperado</div>
            <div className="text-[16px] font-extrabold font-mono-num text-[#F3F4F6]">
              {expirySuite?.expectedCone.dailyMoveAbs != null
                ? `±${currencyPrefix}${fmtNum(expirySuite.expectedCone.dailyMoveAbs, 2)}`
                : '—'}
            </div>
            <div className="text-[10px] text-[#9CA3AF] font-mono-num">
              ±{fmtNullableNumber(expirySuite?.expectedCone.dailyMovePct, 2, '%')} / día
            </div>
          </div>
        </div>

        {/* Pieza 50: régimen de skew 25Δ e IVR/IVP 1Y (ORATS 1Y o Proxy RV 1Y) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">25Δ RR (Put − Call)</div>
            <div className="text-[16px] font-extrabold font-mono-num tabular-nums text-[#F3F4F6]">
              {fmtSignedNullable(skewRegime.rr25Pts, 1, ' pts')}
            </div>
            <div className="text-[10px] text-[#9CA3AF] font-mono-num tabular-nums">
              25P {fmtNullableNumber(skewRegime.iv25PutPct, 1, '%')} / 25C{' '}
              {fmtNullableNumber(skewRegime.iv25CallPct, 1, '%')}
            </div>
          </div>
          <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">25Δ BF (Curvatura)</div>
            <div className="text-[16px] font-extrabold font-mono-num tabular-nums text-[#F3F4F6]">
              {fmtSignedNullable(skewRegime.bf25Pts, 1, ' pts')}
            </div>
            <div className="text-[10px] text-[#9CA3AF] font-mono-num tabular-nums">
              ATM {fmtNullableNumber(skewRegime.ivAtmPct, 1, '%')}
            </div>
          </div>
          <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">IVR (1Y)</div>
            <div className="text-[16px] font-extrabold font-mono-num tabular-nums text-[#B794F4]">
              {fmtNullableNumber(ivRankOneYearDisplay, 1, '%')}
            </div>
            <div className="text-[10px] text-[#9CA3AF] font-mono-num">{ivRankOneYearSource}</div>
          </div>
          <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">IVP (1Y)</div>
            <div className="text-[16px] font-extrabold font-mono-num tabular-nums text-[#38BDF8]">
              {fmtNullableNumber(ivPctOneYearDisplay, 1, '%')}
            </div>
            <div className="text-[10px] text-[#9CA3AF] font-mono-num">{ivPctOneYearSource}</div>
          </div>
        </div>

        {/* Pieza 36: ORATS solo bajo demanda para Volatilidad US */}
        {marketTag === 'US' && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 border-t border-[#1C1C24] pt-3">
            <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">ORATS IV Rank 1Y</div>
              <div className="text-[15px] font-extrabold font-mono-num text-[#E5C76B]">
                {fmtNullableNumber(oratsIvRank?.ivRank1y ?? null, 1, '%')}
              </div>
            </div>
            <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">ORATS IV Percentile 1Y</div>
              <div className="text-[15px] font-extrabold font-mono-num text-[#B794F4]">
                {fmtNullableNumber(oratsIvRank?.ivPct1y ?? null, 1, '%')}
              </div>
            </div>
            <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">ORATS Ex-Earnings IV 30D</div>
              <div className="text-[15px] font-extrabold font-mono-num text-[#38BDF8]">
                {fmtNullableNumber(
                  Number.isFinite(oratsVolToPct(oratsSurface?.exErnIv30d))
                    ? oratsVolToPct(oratsSurface?.exErnIv30d)
                    : null,
                  2,
                  '%',
                )}
              </div>
              {oratsSurface?.iv20d != null && Number.isFinite(oratsVolToPct(oratsSurface.iv20d)) && (
                <div className="text-[10px] font-mono-num text-[#9CA3AF]">
                  IV 20D: {fmtNullableNumber(oratsVolToPct(oratsSurface.iv20d), 2, '%')}
                </div>
              )}
            </div>
            <div className="rounded-[10px] bg-[#0A0A0D] border border-[#1C1C24] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-[#6B7280]">ORATS Superficie smvVol</div>
              <div className="text-[15px] font-extrabold font-mono-num text-[#F3F4F6]">
                {oratsSurface?.strikes?.length != null && oratsSurface.strikes.length > 0
                  ? `${String(oratsSurface.strikes.length)} nodos`
                  : '—'}
              </div>
              <div className="text-[10px] font-mono-num text-[#9CA3AF]">
                {usVolSurface?.cacheState ?? '—'}
                {usVolSurface?.stale === true ? ' · stale' : ''}
              </div>
            </div>
          </div>
        )}

        {/* Navegación limpia de las 6 sub-pestañas */}
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-[#1C1C24]">
          {SUB_TABS.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 rounded-[8px] text-[12px] font-semibold transition-colors flex items-center gap-1.5 ${
                  active
                    ? 'bg-[#E5C76B] text-[#0A0A0D]'
                    : 'bg-[#0A0A0D] border border-[#1C1C24] text-[#9CA3AF] hover:text-[#F3F4F6] hover:border-[#2C2C38]'
                }`}
              >
                <span className={`font-mono-num text-[10px] ${active ? 'text-[#0A0A0D]/70' : 'text-[#6B7280]'}`}>
                  {tab.num}
                </span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Estado vacío si backend todavía no entregó el payload de Pieza 27 */}
      {!suite && (
        <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-6 text-center space-y-2">
          <div className="text-[14px] font-bold text-[#F3F4F6]">
            Suite cuantitativa de volatilidad pendiente de sincronización para {underlying}
          </div>
          <p className="text-[12px] text-[#9CA3AF]">
            No se recibieron suficientes contratos cotizados o barras históricas en vivo. Ningún valor fue interpolado ni inventado.
          </p>
        </div>
      )}

      {suite && activeTab === 'resumen' && (
        <Tab1ResumenCono
          suite={suite}
          expirySuite={expirySuite}
          unifiedQuant={unifiedQuant}
          spot={displaySpot}
          currencyPrefix={currencyPrefix}
          putWallStrike={
            usSnapshot?.exposureSummary?.putWallStrike ??
            liveOptions?.exposureSummary?.putWallStrike ??
            null
          }
          netGex={
            usSnapshot?.exposureSummary?.netGex ??
            liveOptions?.exposureSummary?.netGex ??
            null
          }
        />
      )}

      {suite && activeTab === 'sonrisa' && (
        <Tab2SonrisaMatriz
          suite={suite}
          expirySuite={expirySuite}
          spot={displaySpot}
          currencyPrefix={currencyPrefix}
          onlyOtm={onlyOtm}
          onToggleOnlyOtm={setOnlyOtm}
          xAxisMode={smileXAxis}
          onChangeXAxisMode={setSmileXAxis}
          showPriorSmile={showPriorSmile}
          onTogglePriorSmile={setShowPriorSmile}
          onSelectExpiry={onSelectExpiry}
        />
      )}

      {suite && activeTab === 'historica' && (
        <Tab3HistoricaEstacionalidad
          suite={suite}
          horizon={horizon}
          onChangeHorizon={setHorizon}
          currencyPrefix={currencyPrefix}
        />
      )}

      {suite && activeTab === 'paridad' && (
        <Tab4ParidadTasas
          expirySuite={expirySuite}
          unifiedQuant={unifiedQuant}
          currencyPrefix={currencyPrefix}
        />
      )}

      {suite && activeTab === 'estructuras' && (
        <Tab5EstructurasCosto
          expirySuite={expirySuite}
          currencyPrefix={currencyPrefix}
          onSendToBuilder={onSendToBuilder}
        />
      )}

      {suite && activeTab === 'dual' && (
        <Tab6DualBymaOpra
          suite={suite}
          onGoToTab2={() => setActiveTab('sonrisa')}
        />
      )}
    </div>
  );
};

// ============================================================================
// Tab 1: Resumen & Cono Esperado (Q vs Lognormal)
// ============================================================================

const Tab1ResumenCono: React.FC<{
  readonly suite: VolAnalyticsSuiteDto;
  readonly expirySuite: VolAnalyticsExpirySuiteDto | null;
  readonly unifiedQuant: UnifiedQuantEnginesDto | null;
  readonly spot: number;
  readonly currencyPrefix: string;
  readonly putWallStrike: number | null;
  readonly netGex: number | null;
}> = ({ suite, expirySuite, unifiedQuant, spot, currencyPrefix, putWallStrike, netGex }) => {
  // Pieza 46.1: gate DTE < 3 para anualización Buy-Write / Cobertura Sintética.
  const buyWriteRateBlocked =
    (expirySuite?.daysToExpiry != null && expirySuite.daysToExpiry < 3) ||
    unifiedQuant?.buyWrite?.rateStatus === 'BLOCKED_SHORT_DTE';
  const hist = suite.historicalConditional;
  const cone = expirySuite?.expectedCone ?? null;
  const tab1Vrp = useMemo(
    () =>
      computeActiveExpiryVrpAndRegime({
        expiryCode: expirySuite?.expiryCode ?? suite.activeExpiryCode,
        daysToExpiry: expirySuite?.daysToExpiry ?? null,
        ivAtmActiveExpiryPct: expirySuite?.smileOtmOnly.atmIvPct ?? null,
        sameExpiryFallbackIvAtmPct: expirySuite?.smileAll.atmIvPct ?? null,
        rvReferencePct: hist.latestRv23Pct ?? hist.latestRv20Pct ?? null,
        rvReferenceLabel: hist.latestRv23Pct != null ? 'RV23d' : 'RV20d',
        historicalRvMinPct: hist.quantiles.minPct,
        historicalRvMaxPct: hist.quantiles.maxPct,
        fallbackIvRank: hist.ivRank,
        fallbackIvPercentile: hist.ivPercentile,
        spot,
        putWallStrike,
        netGex,
      }),
    [expirySuite, suite.activeExpiryCode, hist, spot, putWallStrike, netGex],
  );
  const ivPctRank = Number.isFinite(tab1Vrp.ivPercentileActiveExpiry)
    ? tab1Vrp.ivPercentileActiveExpiry
    : hist.ivPercentile;

  return (
    <div className="space-y-4">
      {/* Banner descriptivo de régimen + barra de cuantiles */}
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-[#6B7280] font-semibold">
              Lectura Empírica de Régimen ({Number.isFinite(tab1Vrp.daysToExpiry) ? `Vto ${formatDteLabel(tab1Vrp.daysToExpiry)}` : 'Vto activo'} vs {tab1Vrp.rvReferenceLabel})
            </div>
            <div
              className={`text-[14px] font-bold mt-0.5 ${
                tab1Vrp.operativeRegime.code === 'NO_SHORT_PREMIUM_RISK' ? 'text-[#F43F5E]' : 'text-[#F3F4F6]'
              }`}
            >
              {tab1Vrp.operativeRegime.label}
            </div>
            <p className="text-[12px] text-[#9CA3AF] mt-0.5">{tab1Vrp.operativeRegime.rationale}</p>
          </div>
          <div className="text-right font-mono-num text-[11px] text-[#9CA3AF]">
            <div>
              VI ATM ({Number.isFinite(tab1Vrp.daysToExpiry) ? formatDteLabel(tab1Vrp.daysToExpiry) : 'activo'}):{' '}
              <strong className="text-[#E5C76B]">{fmtNullableNumber(tab1Vrp.ivAtmActiveExpiryPct, 1, '%')}</strong>
              {' · '}VRP:{' '}
              <strong className="text-[#F3F4F6]">{fmtSignedNullable(tab1Vrp.vrpActiveExpiryPts, 1, ' pts')}</strong>
            </div>
            <div>
              {tab1Vrp.rvReferenceLabel}:{' '}
              <strong className="text-[#38BDF8]">{fmtNullableNumber(tab1Vrp.rvReferencePct, 1, '%')}</strong>
              {' · '}Mediana hist.:{' '}
              <strong className="text-[#38BDF8]">{fmtNullableNumber(hist.quantiles.medianPct, 1, '%')}</strong>
            </div>
          </div>
        </div>

        {/* Barra de cuantiles históricos */}
        <div className="space-y-1.5 pt-1">
          <div className="flex justify-between text-[10px] font-mono-num text-[#6B7280]">
            <span>Mín {fmtNullableNumber(hist.quantiles.minPct, 1, '%')}</span>
            <span>P20 {fmtNullableNumber(hist.quantiles.p20Pct, 1, '%')}</span>
            <span>Med {fmtNullableNumber(hist.quantiles.medianPct, 1, '%')}</span>
            <span>P80 {fmtNullableNumber(hist.quantiles.p80Pct, 1, '%')}</span>
            <span>Máx {fmtNullableNumber(hist.quantiles.maxPct, 1, '%')}</span>
          </div>
          <div className="relative h-2 rounded-full bg-[#16161F] overflow-hidden border border-[#242430]">
            <div
              className="h-full bg-gradient-to-r from-[#38BDF8] via-[#B794F4] to-[#E5C76B]"
              style={{
                width: `${ivPctRank !== null && Number.isFinite(ivPctRank) ? Math.max(2, Math.min(100, ivPctRank)) : 0}%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Gráficos: Cono Esperado (izq) + Densidad Breeden-Litzenberger Q vs Lognormal (der) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ExpectedConeChart
          cone={cone}
          spot={spot}
          daysToExpiry={expirySuite?.daysToExpiry ?? 0}
          currencyPrefix={currencyPrefix}
        />
        <DensityComparisonChart
          cone={cone}
          spot={spot}
          currencyPrefix={currencyPrefix}
        />
      </div>

      {/* Cinta inferior: P vs Q, Buy-Write, Calendar Roll & Confluencia */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2 text-[12px] font-mono-num">
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#B794F4]">
            Divergencia Empírica P vs. Riesgo-Neutral Q
          </div>
          <div className="flex justify-between text-[#9CA3AF]">
            <span>Media Q / Desv. Q</span>
            <span className="text-[#F3F4F6]">
              {unifiedQuant?.qDistribution?.meanQ != null ? `${currencyPrefix}${fmtNum(unifiedQuant.qDistribution.meanQ, 1)}` : '—'} ·{' '}
              {unifiedQuant?.qDistribution?.stdDevQ != null ? `±${currencyPrefix}${fmtNum(unifiedQuant.qDistribution.stdDevQ, 1)}` : '—'}
            </span>
          </div>
          <div className="flex justify-between text-[#9CA3AF]">
            <span>Colas &gt; 3σ (P Empírica)</span>
            <span className="text-[#E5C76B]">
              {hist.extremeSessions.length} eventos · P-tail{' '}
              {fmtNullableNumber(unifiedQuant?.pDistribution?.tailFrequencyPct, 1, '%')}
            </span>
          </div>
          {(unifiedQuant?.pqDivergence?.levels ?? []).slice(0, 3).map((lv) => (
            <div key={lv.label} className="flex justify-between text-[11px] pt-1 border-t border-[#1C1C24]">
              <span className="text-[#D1D5DB]">{lv.label}</span>
              <span className="text-[#38BDF8]">
                P {lv.probP != null ? `${fmtNum(lv.probP * 100, 1)}%` : '—'} vs Q{' '}
                {lv.probQ != null ? `${fmtNum(lv.probQ * 100, 1)}%` : '—'}
              </span>
            </div>
          ))}
        </div>

        <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2 text-[12px] font-mono-num">
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#E5C76B]">
            Buy-Write &amp; Cobertura Sistemática
          </div>
          <div className="flex justify-between text-[#9CA3AF]">
            <span>Breakeven Cubierto</span>
            <span className="text-[#F3F4F6]">
              {unifiedQuant?.buyWrite?.breakevenPrice != null
                ? `${currencyPrefix}${fmtNum(unifiedQuant.buyWrite.breakevenPrice, 2)}`
                : '—'}
            </span>
          </div>
          <div className="flex justify-between text-[#9CA3AF]">
            <span>Tasa Estática Anualizada</span>
            <span
              className="text-[#38BDF8]"
              title={buyWriteRateBlocked ? BLOCKED_SHORT_DTE_TOOLTIP : undefined}
            >
              {!buyWriteRateBlocked && unifiedQuant?.buyWrite?.staticAnnualizedTna != null
                ? `${fmtNum(unifiedQuant.buyWrite.staticAnnualizedTna, 1)}%`
                : '—'}
            </span>
          </div>
          <div className="flex justify-between text-[#9CA3AF]">
            <span>Tasa Ejercida Anualizada</span>
            <span
              className="text-[#34D399]"
              title={buyWriteRateBlocked ? BLOCKED_SHORT_DTE_TOOLTIP : undefined}
            >
              {!buyWriteRateBlocked && unifiedQuant?.buyWrite?.assignedAnnualizedTna != null
                ? `${fmtNum(unifiedQuant.buyWrite.assignedAnnualizedTna, 1)}%`
                : '—'}
            </span>
          </div>
          <div className="flex justify-between text-[#9CA3AF]">
            <span>Tasa Efectiva Anualizada</span>
            <span
              className="text-[#E5C76B]"
              title={buyWriteRateBlocked ? BLOCKED_SHORT_DTE_TOOLTIP : undefined}
            >
              {!buyWriteRateBlocked && unifiedQuant?.buyWrite?.annualizedRate != null
                ? `${fmtNum(unifiedQuant.buyWrite.annualizedRate * 100, 1)}%`
                : '—'}
            </span>
          </div>
          <div className="flex justify-between text-[#9CA3AF] pt-1 border-t border-[#1C1C24]">
            <span>P_Q(&gt; Spot)</span>
            <span className="text-[#B794F4]">{fmtNullableNumber(cone?.probQAboveSpotPct, 1, '%')}</span>
          </div>
        </div>

        <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2 text-[12px] font-mono-num">
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-[#38BDF8]">
            Calendar Roll &amp; Confluencia Estructural
          </div>
          <div className="flex justify-between text-[#9CA3AF]">
            <span>Crédito Neto Calendar Roll</span>
            <span className="text-[#F3F4F6]">
              {unifiedQuant?.calendarRoll?.netRollCredit != null
                ? `${currencyPrefix}${fmtNum(unifiedQuant.calendarRoll.netRollCredit, 2)}`
                : '—'}
            </span>
          </div>
          <div className="flex justify-between text-[#9CA3AF]">
            <span>Roll Yield Anual s/ Spot</span>
            <span className="text-[#38BDF8]">
              {unifiedQuant?.calendarRoll?.annualizedRollYieldOnSpot != null
                ? `${fmtNum(unifiedQuant.calendarRoll.annualizedRollYieldOnSpot, 1)}%`
                : '—'}
            </span>
          </div>
          <div className="flex justify-between text-[#9CA3AF]">
            <span>Régimen Curva</span>
            <span className="text-[#E5C76B]">{suite.moneynessMatrixOtm.termRegime}</span>
          </div>
          <div className="flex justify-between text-[#9CA3AF] pt-1 border-t border-[#1C1C24]">
            <span>Centroide Confluencia (&lt; 0,15 ATR)</span>
            <span className="text-[#38BDF8]">
              {unifiedQuant?.confluenceClusters?.strongestClusterCentroid != null
                ? `${currencyPrefix}${fmtNum(unifiedQuant.confluenceClusters.strongestClusterCentroid, 2)}`
                : '—'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

const ExpectedConeChart: React.FC<{
  readonly cone: VolSuiteExpectedConeDto | null;
  readonly spot: number;
  readonly daysToExpiry: number;
  readonly currencyPrefix: string;
}> = ({ cone, spot, daysToExpiry, currencyPrefix }) => {
  const ready =
    cone !== null &&
    cone.status === 'OK' &&
    Number.isFinite(spot) &&
    spot > 0 &&
    daysToExpiry > 0 &&
    cone.lower1Sigma !== null &&
    cone.upper1Sigma !== null &&
    cone.lower2Sigma !== null &&
    cone.upper2Sigma !== null;

  if (!ready || !cone) {
    return (
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 flex items-center justify-center min-h-[260px] text-[12px] text-[#6B7280]">
        Cono esperado sin datos suficientes para el vencimiento actual.
      </div>
    );
  }

  const w = 520;
  const h = 230;
  const padL = 56;
  const padR = 76;
  const padT = 22;
  const padB = 30;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const extent = computeNumericExtent([cone.lower2Sigma, cone.upper2Sigma, spot], 0.12, spot * 0.05);
  const mapX = (tFrac: number) => padL + tFrac * plotW;
  const mapY = (price: number) => padT + ((extent.max - price) / (extent.max - extent.min)) * plotH;

  const steps = 16;
  const up1Half = (cone.upper1Sigma ?? spot) - spot;
  const dn1Half = spot - (cone.lower1Sigma ?? spot);
  const up2Half = (cone.upper2Sigma ?? spot) - spot;
  const dn2Half = spot - (cone.lower2Sigma ?? spot);

  const upper1Pts: { x: number; y: number }[] = [];
  const lower1Pts: { x: number; y: number }[] = [];
  const upper2Pts: { x: number; y: number }[] = [];
  const lower2Pts: { x: number; y: number }[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const tFrac = i / steps;
    const rt = Math.sqrt(tFrac);
    upper1Pts.push({ x: mapX(tFrac), y: mapY(spot + up1Half * rt) });
    lower1Pts.push({ x: mapX(tFrac), y: mapY(spot - dn1Half * rt) });
    upper2Pts.push({ x: mapX(tFrac), y: mapY(spot + up2Half * rt) });
    lower2Pts.push({ x: mapX(tFrac), y: mapY(spot - dn2Half * rt) });
  }

  const poly2 = [
    ...upper2Pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    ...lower2Pts.slice().reverse().map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
  ].join(' ');

  const poly1 = [
    ...upper1Pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    ...lower1Pts.slice().reverse().map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
  ].join(' ');

  const yTicks = buildLinearTicks(extent.min, extent.max, 4);

  return (
    <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-bold text-[#F3F4F6]">Cono Esperado (±1σ / ±2σ) al Vencimiento</h3>
          <p className="text-[11px] text-[#9CA3AF]">
            Horizonte {daysToExpiry}d · 1σ = ±{fmtNullableNumber(cone.horizonMove1SigmaPct, 1, '%')} · Diario ={' '}
            {fmtNullableNumber(cone.dailyMovePct, 2, '%')}
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10.5px] font-mono-num text-[#9CA3AF]">
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#E5C76B]/30 border border-[#E5C76B]" /> ±1σ
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-[#38BDF8]/20 border border-[#38BDF8]" /> ±2σ
          </span>
        </div>
      </div>

      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto block">
        {yTicks.map((val, idx) => {
          const y = mapY(val);
          return (
            <g key={idx}>
              <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#1C1C24" strokeDasharray="3 3" />
              <text x={padL - 6} y={y + 3} textAnchor="end" fill="#6B7280" fontSize="9.5" className="font-mono-num">
                {currencyPrefix}
                {fmtNum(val, val >= 100 ? 0 : 1)}
              </text>
            </g>
          );
        })}

        <polygon points={poly2} fill="rgba(56, 189, 248, 0.10)" />
        <polygon points={poly1} fill="rgba(229, 199, 107, 0.14)" />

        <path
          d={upper2Pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
          fill="none"
          stroke="#38BDF8"
          strokeWidth="1.4"
          strokeDasharray="4 3"
        />
        <path
          d={lower2Pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
          fill="none"
          stroke="#38BDF8"
          strokeWidth="1.4"
          strokeDasharray="4 3"
        />
        <path
          d={upper1Pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
          fill="none"
          stroke="#E5C76B"
          strokeWidth="1.8"
        />
        <path
          d={lower1Pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
          fill="none"
          stroke="#E5C76B"
          strokeWidth="1.8"
        />

        <line x1={padL} y1={mapY(spot)} x2={w - padR} y2={mapY(spot)} stroke="#6B7280" strokeDasharray="2 3" />

        {/* Etiquetas en el borde derecho */}
        <text x={w - padR + 5} y={mapY(cone.upper2Sigma ?? spot) + 3} fill="#38BDF8" fontSize="9.5" className="font-mono-num">
          +2σ {fmtNullableNumber(cone.upper2Sigma, 1)}
        </text>
        <text x={w - padR + 5} y={mapY(cone.upper1Sigma ?? spot) + 3} fill="#E5C76B" fontSize="9.5" className="font-mono-num">
          +1σ {fmtNullableNumber(cone.upper1Sigma, 1)}
        </text>
        <text x={w - padR + 5} y={mapY(cone.lower1Sigma ?? spot) + 3} fill="#E5C76B" fontSize="9.5" className="font-mono-num">
          -1σ {fmtNullableNumber(cone.lower1Sigma, 1)}
        </text>
        <text x={w - padR + 5} y={mapY(cone.lower2Sigma ?? spot) + 3} fill="#38BDF8" fontSize="9.5" className="font-mono-num">
          -2σ {fmtNullableNumber(cone.lower2Sigma, 1)}
        </text>

        <text x={padL} y={h - 8} fill="#6B7280" fontSize="9.5" className="font-mono-num">
          Hoy
        </text>
        <text x={w - padR} y={h - 8} textAnchor="end" fill="#6B7280" fontSize="9.5" className="font-mono-num">
          {daysToExpiry === 0 ? '0DTE' : `T+${String(daysToExpiry)}d`}
        </text>
      </svg>
    </div>
  );
};

const DensityComparisonChart: React.FC<{
  readonly cone: VolSuiteExpectedConeDto | null;
  readonly spot: number;
  readonly currencyPrefix: string;
}> = ({ cone, spot, currencyPrefix }) => {
  const nodes = cone?.comparisonNodes ?? [];
  if (!cone || cone.status !== 'OK' || nodes.length < 3) {
    return (
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 flex items-center justify-center min-h-[260px] text-[12px] text-[#6B7280]">
        Densidad implícita Breeden-Litzenberger Q pendiente de nodos suficientes en la cadena.
      </div>
    );
  }

  const w = 520;
  const h = 230;
  const padL = 44;
  const padR = 20;
  const padT = 22;
  const padB = 30;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const xExtent = computeNumericExtent(
    nodes.map((n) => n.strike),
    0.02,
    1,
  );
  const yExtent = computeNumericExtent(
    [0, ...nodes.flatMap((n) => [n.densityQ, n.lognormalDensity])],
    0.1,
    1e-4,
  );
  const mapX = (s: number) => padL + ((s - xExtent.min) / (xExtent.max - xExtent.min)) * plotW;
  const mapY = (d: number) => padT + ((yExtent.max - d) / (yExtent.max - yExtent.min)) * plotH;

  const qPath = buildSvgLinePath(
    nodes.map((n) => ({ x: n.strike, y: n.densityQ })),
    mapX,
    mapY,
  );
  const lnPath = buildSvgLinePath(
    nodes.map((n) => ({ x: n.strike, y: n.lognormalDensity })),
    mapX,
    mapY,
  );
  const xTicks = buildLinearTicks(xExtent.min, xExtent.max, 5);
  const spotInRange = Number.isFinite(spot) && spot >= xExtent.min && spot <= xExtent.max;

  return (
    <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-bold text-[#F3F4F6]">Densidad Breeden-Litzenberger Q vs. Lognormal</h3>
          <p className="text-[11px] text-[#9CA3AF] font-mono-num">
            P_Q(&gt; Spot): <strong className="text-[#B794F4]">{fmtNullableNumber(cone.probQAboveSpotPct, 1, '%')}</strong>{' '}
            · P_Q(&lt; −10%): <strong className="text-[#38BDF8]">{fmtNullableNumber(cone.probQBelowMinus10Pct, 1, '%')}</strong>
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10.5px] font-mono-num text-[#9CA3AF]">
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-[#B794F4]" /> Q Implícita
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-[#38BDF8] border-b border-dashed border-[#38BDF8]" /> Lognormal
          </span>
        </div>
      </div>

      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto block">
        <line x1={padL} y1={h - padB} x2={w - padR} y2={h - padB} stroke="#1C1C24" />
        {spotInRange && (
          <g>
            <line
              x1={mapX(spot)}
              y1={padT}
              x2={mapX(spot)}
              y2={h - padB}
              stroke="#E5C76B"
              strokeWidth="1.2"
              strokeDasharray="3 3"
            />
            <text x={mapX(spot) + 4} y={padT + 10} fill="#E5C76B" fontSize="9.5" className="font-mono-num">
              Spot {currencyPrefix}
              {fmtNum(spot, 1)}
            </text>
          </g>
        )}
        <path d={lnPath} fill="none" stroke="#38BDF8" strokeWidth="1.5" strokeDasharray="4 3" />
        <path d={qPath} fill="none" stroke="#B794F4" strokeWidth="2.2" />

        {xTicks.map((val, idx) => (
          <text
            key={idx}
            x={mapX(val)}
            y={h - 10}
            textAnchor="middle"
            fill="#6B7280"
            fontSize="9.5"
            className="font-mono-num"
          >
            {currencyPrefix}
            {fmtNum(val, val >= 100 ? 0 : 1)}
          </text>
        ))}
      </svg>
    </div>
  );
};

// ============================================================================
// Tab 2: Sonrisa de Volatilidad (Calls vs Puts OTM) & Matriz de Moneyness
// ============================================================================

const Tab2SonrisaMatriz: React.FC<{
  readonly suite: VolAnalyticsSuiteDto;
  readonly expirySuite: VolAnalyticsExpirySuiteDto | null;
  readonly spot: number;
  readonly currencyPrefix: string;
  readonly onlyOtm: boolean;
  readonly onToggleOnlyOtm: (next: boolean) => void;
  readonly xAxisMode: SmileXAxisMode;
  readonly onChangeXAxisMode: (next: SmileXAxisMode) => void;
  readonly showPriorSmile: boolean;
  readonly onTogglePriorSmile: (next: boolean) => void;
  readonly onSelectExpiry: (expiryId: string) => void;
}> = ({
  suite,
  expirySuite,
  spot,
  currencyPrefix,
  onlyOtm,
  onToggleOnlyOtm,
  xAxisMode,
  onChangeXAxisMode,
  showPriorSmile,
  onTogglePriorSmile,
  onSelectExpiry,
}) => {
  const smile = expirySuite ? (onlyOtm ? expirySuite.smileOtmOnly : expirySuite.smileAll) : null;
  const priorSmile = expirySuite?.priorSmile ?? null;
  const matrix = onlyOtm ? suite.moneynessMatrixOtm : suite.moneynessMatrixAll;

  const [hoveredPoint, setHoveredPoint] = useState<{
    readonly side: 'CALL' | 'PUT';
    readonly pt: VolSuiteSmilePointDto;
  } | null>(null);

  const mapPointX = (pt: VolSuiteSmilePointDto): number => {
    if (xAxisMode === 'STRIKE') return pt.strike;
    if (xAxisMode === 'DELTA') return pt.delta ?? pt.moneynessPct / 100;
    return pt.moneynessPct;
  };

  const mapPriorX = (pt: VolSuiteCompositeSmilePointDto): number | null => {
    if (xAxisMode === 'MONEYNESS') return pt.moneynessPct;
    if (xAxisMode === 'STRIKE') return pt.strike;
    return null;
  };

  const w = 780;
  const h = 290;
  const padL = 50;
  const padR = 24;
  const padT = 22;
  const padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const callPts = (smile?.callPoints ?? []).filter((p) => p.ivPct !== null && Number.isFinite(p.ivPct));
  const putPts = (smile?.putPoints ?? []).filter((p) => p.ivPct !== null && Number.isFinite(p.ivPct));
  const priorPts =
    showPriorSmile && priorSmile
      ? priorSmile.compositeOtmPoints.filter((p) => p.ivPct !== null && mapPriorX(p) !== null)
      : [];

  const allX: number[] = [
    ...callPts.map(mapPointX),
    ...putPts.map(mapPointX),
    ...priorPts.map((p) => mapPriorX(p)).filter((v): v is number => v !== null),
  ];
  const allY: (number | null)[] = [
    ...callPts.map((p) => p.ivPct),
    ...putPts.map((p) => p.ivPct),
    ...priorPts.map((p) => p.ivPct),
  ];

  const xExtent = computeNumericExtent(allX, 0.06, xAxisMode === 'DELTA' ? 1 : 10);
  const yExtent = computeNumericExtent(allY, 0.12, 10);
  const mapX = (x: number) => padL + ((x - xExtent.min) / (xExtent.max - xExtent.min)) * plotW;
  const mapY = (y: number) => padT + ((yExtent.max - y) / (yExtent.max - yExtent.min)) * plotH;

  const callSorted = callPts.slice().sort((a, b) => mapPointX(a) - mapPointX(b));
  const putSorted = putPts.slice().sort((a, b) => mapPointX(a) - mapPointX(b));
  const priorSorted = priorPts.slice().sort((a, b) => (mapPriorX(a) ?? 0) - (mapPriorX(b) ?? 0));

  const callPath = buildSvgLinePath(
    callSorted.map((p) => ({ x: mapPointX(p), y: p.ivPct })),
    mapX,
    mapY,
  );
  const putPath = buildSvgLinePath(
    putSorted.map((p) => ({ x: mapPointX(p), y: p.ivPct })),
    mapX,
    mapY,
  );
  const priorPath = buildSvgLinePath(
    priorSorted.map((p) => ({ x: mapPriorX(p) ?? 0, y: p.ivPct })),
    mapX,
    mapY,
  );

  const spotRefX = xAxisMode === 'MONEYNESS' ? 0 : xAxisMode === 'STRIKE' ? spot : null;
  const xTicks = buildLinearTicks(xExtent.min, xExtent.max, 7);
  const yTicks = buildLinearTicks(yExtent.min, yExtent.max, 5);

  // Term Structure chart setup
  const termRows = matrix.rows.filter((r) => r.atmIvPct !== null && Number.isFinite(r.atmIvPct));
  const tw = 420;
  const th = 190;
  const tPadL = 44;
  const tPadR = 20;
  const tPadT = 20;
  const tPadB = 28;
  const tXExt = computeNumericExtent(
    termRows.map((r) => r.daysToExpiry),
    0.1,
    15,
  );
  const tYExt = computeNumericExtent(
    termRows.map((r) => r.atmIvPct),
    0.15,
    5,
  );
  const mapTX = (d: number) => tPadL + ((d - tXExt.min) / (tXExt.max - tXExt.min)) * (tw - tPadL - tPadR);
  const mapTY = (iv: number) => tPadT + ((tYExt.max - iv) / (tYExt.max - tYExt.min)) * (th - tPadT - tPadB);
  const termPath = buildSvgLinePath(
    termRows.map((r) => ({ x: r.daysToExpiry, y: r.atmIvPct })),
    mapTX,
    mapTY,
  );

  return (
    <div className="space-y-4">
      {/* Controles y lectura de Skew */}
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[12px] text-[#E5E7EB] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyOtm}
                onChange={(e) => onToggleOnlyOtm(e.target.checked)}
                className="accent-[#E5C76B] rounded"
              />
              <span>Solo OTM (recomendado)</span>
            </label>

            <label
              className={`flex items-center gap-2 text-[12px] select-none ${
                priorSmile ? 'text-[#E5E7EB] cursor-pointer' : 'text-[#6B7280] cursor-not-allowed'
              }`}
              title={
                priorSmile
                  ? `Curva de hace ${priorSmile.tradingDaysAgo} ruedas (${priorSmile.dateKey})`
                  : 'Historial de snapshots diarios aún en acumulación (requiere 5–10 ruedas)'
              }
            >
              <input
                type="checkbox"
                checked={showPriorSmile && priorSmile !== null}
                disabled={priorSmile === null}
                onChange={(e) => onTogglePriorSmile(e.target.checked)}
                className="accent-[#38BDF8] rounded"
              />
              <span>
                {priorSmile
                  ? `Curva anterior (−${priorSmile.tradingDaysAgo} ruedas)`
                  : 'Curva anterior (5–10 ruedas en acumulación)'}
              </span>
            </label>
          </div>

          <div className="flex items-center gap-1 bg-[#111116] border border-[#1C1C24] rounded-[8px] p-0.5 text-[11px]">
            {(
              [
                { id: 'MONEYNESS', label: 'Moneyness (%)' },
                { id: 'STRIKE', label: 'Strike ($)' },
                { id: 'DELTA', label: 'Delta (Δ)' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChangeXAxisMode(opt.id)}
                className={`px-2.5 py-1 rounded-[6px] font-semibold transition-colors ${
                  xAxisMode === opt.id ? 'bg-[#1D1E28] text-[#F9FAFB]' : 'text-[#9CA3AF] hover:text-[#E5E7EB]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Banner de advertencia DTE corto cuando se incluyen ITM */}
        {!onlyOtm && smile?.isShortDteSlice && (
          <div className="rounded-[8px] bg-[#E5C76B]/10 border border-[#E5C76B]/30 px-3 py-2 text-[11.5px] text-[#E5C76B]">
            Advertencia DTE corto ({expirySuite?.daysToExpiry ?? '—'}d): incluir contratos ITM introduce dispersión extrema por valor extrínseco casi nulo y spreads bid/ask amplios.
          </div>
        )}

        {/* Chips de métrica de sonrisa */}
        <div className="flex flex-wrap items-center gap-4 text-[11.5px] font-mono-num text-[#9CA3AF] border-t border-[#1C1C24] pt-2.5">
          <span>
            Calls <span className="inline-block w-2 h-2 rounded-full bg-[#E5C76B] mx-1" /> Wing:{' '}
            <strong className="text-[#E5C76B]">{fmtNullableNumber(smile?.callWingAvgIvPct, 1, '%')}</strong>
          </span>
          <span>
            Puts <span className="inline-block w-2 h-2 rounded-full bg-[#B794F4] mx-1" /> Wing:{' '}
            <strong className="text-[#B794F4]">{fmtNullableNumber(smile?.putWingAvgIvPct, 1, '%')}</strong>
          </span>
          <span>
            IV 25Δ Put: <strong className="text-[#B794F4]">{fmtNullableNumber(smile?.iv25DeltaPutPct, 1, '%')}</strong>
          </span>
          <span>
            IV 25Δ Call: <strong className="text-[#E5C76B]">{fmtNullableNumber(smile?.iv25DeltaCallPct, 1, '%')}</strong>
          </span>
          <span>
            RR 25Δ (C−P): <strong className="text-[#F3F4F6]">{fmtSignedNullable(smile?.riskReversal25DeltaPp, 1, ' pp')}</strong>
          </span>
          {onlyOtm && smile && smile.excludedItmCount > 0 && (
            <span className="text-[#6B7280] ml-auto">({smile.excludedItmCount} ITM filtradas)</span>
          )}
        </div>

        {/* Gráfico SVG de Sonrisa separada Calls vs Puts */}
        {callPts.length === 0 && putPts.length === 0 ? (
          <div className="min-h-[240px] flex items-center justify-center text-[12px] text-[#6B7280]">
            Sin puntos de sonrisa válidos para el vencimiento seleccionado.
          </div>
        ) : (
          <div className="relative">
            {hoveredPoint && (
              <div className="mb-2 px-3 py-1.5 rounded-[8px] bg-[#14141B] border border-[#272736] flex flex-wrap items-center gap-4 text-[11px] font-mono-num">
                <span className={hoveredPoint.side === 'CALL' ? 'text-[#E5C76B] font-bold' : 'text-[#B794F4] font-bold'}>
                  {hoveredPoint.side} {currencyPrefix}
                  {fmtNum(hoveredPoint.pt.strike, 2)}
                </span>
                <span className="text-[#D1D5DB]">IV: {fmtNullableNumber(hoveredPoint.pt.ivPct, 2, '%')}</span>
                <span className="text-[#9CA3AF]">Moneyness: {fmtSignedNullable(hoveredPoint.pt.moneynessPct, 1, '%')}</span>
                <span className="text-[#9CA3AF]">Δ: {fmtNullableNumber(hoveredPoint.pt.delta, 2)}</span>
                <span className="text-[#9CA3AF]">
                  Bid/Ask: {fmtNullableNumber(hoveredPoint.pt.bid, 2)} / {fmtNullableNumber(hoveredPoint.pt.ask, 2)}
                </span>
                <span className="text-[#6B7280]">
                  Vol: {fmtNullableNumber(hoveredPoint.pt.volume, 0)} · OI: {fmtNullableNumber(hoveredPoint.pt.openInterest, 0)}
                </span>
              </div>
            )}

            <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto block">
              {yTicks.map((val, i) => {
                const y = mapY(val);
                return (
                  <g key={i}>
                    <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#1C1C24" strokeDasharray="3 3" />
                    <text x={padL - 8} y={y + 3} textAnchor="end" fill="#6B7280" fontSize="10" className="font-mono-num">
                      {fmtNum(val, 1)}%
                    </text>
                  </g>
                );
              })}

              {spotRefX !== null && spotRefX >= xExtent.min && spotRefX <= xExtent.max && (
                <g>
                  <line
                    x1={mapX(spotRefX)}
                    y1={padT}
                    x2={mapX(spotRefX)}
                    y2={h - padB}
                    stroke="#38BDF8"
                    strokeDasharray="3 3"
                    strokeWidth="1.2"
                  />
                  <text x={mapX(spotRefX) + 4} y={padT + 10} fill="#38BDF8" fontSize="9.5" className="font-mono-num">
                    Spot ATM
                  </text>
                </g>
              )}

              {priorPath && (
                <path d={priorPath} fill="none" stroke="#94A3B8" strokeWidth="1.5" strokeDasharray="4 4" opacity={0.85} />
              )}
              {putPath && <path d={putPath} fill="none" stroke="#B794F4" strokeWidth="2.2" />}
              {callPath && <path d={callPath} fill="none" stroke="#E5C76B" strokeWidth="2.2" />}

              {putSorted.map((pt, idx) =>
                pt.ivPct !== null ? (
                  <circle
                    key={`p-${idx}`}
                    cx={mapX(mapPointX(pt))}
                    cy={mapY(pt.ivPct)}
                    r={hoveredPoint?.pt.strike === pt.strike && hoveredPoint.side === 'PUT' ? 5.5 : 3.5}
                    fill="#B794F4"
                    stroke="#0A0A0D"
                    strokeWidth="1.2"
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredPoint({ side: 'PUT', pt })}
                  />
                ) : null,
              )}

              {callSorted.map((pt, idx) =>
                pt.ivPct !== null ? (
                  <circle
                    key={`c-${idx}`}
                    cx={mapX(mapPointX(pt))}
                    cy={mapY(pt.ivPct)}
                    r={hoveredPoint?.pt.strike === pt.strike && hoveredPoint.side === 'CALL' ? 5.5 : 3.5}
                    fill="#E5C76B"
                    stroke="#0A0A0D"
                    strokeWidth="1.2"
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredPoint({ side: 'CALL', pt })}
                  />
                ) : null,
              )}

              {xTicks.map((val, idx) => (
                <text
                  key={idx}
                  x={mapX(val)}
                  y={h - 10}
                  textAnchor="middle"
                  fill="#6B7280"
                  fontSize="10"
                  className="font-mono-num"
                >
                  {xAxisMode === 'MONEYNESS'
                    ? `${val > 0 ? '+' : ''}${fmtNum(val, 0)}%`
                    : xAxisMode === 'DELTA'
                      ? fmtNum(val, 2)
                      : `${currencyPrefix}${fmtNum(val, val >= 100 ? 0 : 1)}`}
                </text>
              ))}
            </svg>
          </div>
        )}
      </div>

      {/* Term Structure + Matriz Normalizada por Moneyness */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-4 rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-[13px] font-bold text-[#F3F4F6]">Estructura Temporal ATM</h3>
              <p className="text-[11px] text-[#9CA3AF] font-mono-num">
                Spread largo − corto: {fmtSignedNullable(matrix.termSpreadPp, 1, ' pp')}
              </p>
            </div>
            <span className="px-2 py-0.5 rounded bg-[#16161F] border border-[#272736] text-[10px] font-bold font-mono-num text-[#38BDF8]">
              {matrix.termRegime}
            </span>
          </div>

          {termRows.length === 0 ? (
            <div className="h-[170px] flex items-center justify-center text-[12px] text-[#6B7280]">
              Sin datos ATM por vencimiento.
            </div>
          ) : (
            <svg viewBox={`0 0 ${tw} ${th}`} className="w-full h-auto block">
              {termPath && <path d={termPath} fill="none" stroke="#38BDF8" strokeWidth="2" />}
              {termRows.map((row) => {
                if (row.atmIvPct === null) return null;
                const cx = mapTX(row.daysToExpiry);
                const cy = mapTY(row.atmIvPct);
                const selected = row.expiryCode === expirySuite?.expiryCode;
                return (
                  <g
                    key={row.expiryCode}
                    className="cursor-pointer"
                    onClick={() => onSelectExpiry(row.expiryCode)}
                  >
                    <circle
                      cx={cx}
                      cy={cy}
                      r={selected ? 5.5 : 3.8}
                      fill={selected ? '#E5C76B' : '#38BDF8'}
                      stroke="#0A0A0D"
                      strokeWidth="1.5"
                    />
                    <text
                      x={cx}
                      y={cy - 8}
                      textAnchor="middle"
                      fill={selected ? '#E5C76B' : '#D1D5DB'}
                      fontSize="9"
                      className="font-mono-num"
                    >
                      {fmtNum(row.atmIvPct, 1)}%
                    </text>
                    <text x={cx} y={th - 8} textAnchor="middle" fill="#6B7280" fontSize="9" className="font-mono-num">
                      {row.daysToExpiry}d
                    </text>
                  </g>
                );
              })}
            </svg>
          )}

          {(() => {
            const localForwardSegments = computeForwardIvTermStructure(
              matrix.rows
                .filter(
                  (r) =>
                    r.daysToExpiry > 0 &&
                    r.atmIvPct !== null &&
                    Number.isFinite(r.atmIvPct) &&
                    r.atmIvPct > 0,
                )
                .map((r) => ({
                  expiryCode: r.expiryCode,
                  dte: r.daysToExpiry,
                  timeToExpiry: r.daysToExpiry / 365,
                  atmIv: (r.atmIvPct as number) / 100,
                })),
            );
            if (localForwardSegments.length === 0) return null;
            return (
              <div className="pt-2 border-t border-[#1C1C24] space-y-1.5">
                <div className="text-[10px] uppercase tracking-wider text-[#6B7280] font-semibold">
                  Forward IV entre vencimientos
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {localForwardSegments.slice(0, 5).map((seg) => (
                    <div
                      key={`${seg.nearExpiryCode ?? 'N'}_${seg.farExpiryCode ?? 'F'}`}
                      className="flex items-center justify-between rounded-[7px] bg-[#111118] border border-[#1C1C26] px-2.5 py-1 text-[11px] font-mono-num"
                    >
                      <span className="text-[#9CA3AF]">
                        {seg.nearExpiryCode ?? 'T1'} → {seg.farExpiryCode ?? 'T2'}
                      </span>
                      {seg.calendarArbFlag ? (
                        <span className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 text-[10px] font-semibold">
                          Arb. Cal. (Var≤0)
                        </span>
                      ) : seg.forwardIv !== null && Number.isFinite(seg.forwardIv) ? (
                        <span className="font-bold text-[#38BDF8]">{fmtNum(seg.forwardIv * 100, 1)}%</span>
                      ) : (
                        <span className="text-[#6B7280]">—</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>

        <div className="xl:col-span-8 rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2 overflow-x-auto">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-[13px] font-bold text-[#F3F4F6]">Matriz Normalizada por Moneyness (%)</h3>
              <p className="text-[11px] text-[#9CA3AF]">
                Interpolación lineal sin extrapolación fuera del rango observado (‘—’ fuera de cobertura).
              </p>
            </div>
          </div>

          <table className="w-full text-[11.5px] font-mono-num border-collapse">
            <thead>
              <tr className="border-b border-[#1C1C24] text-[#6B7280]">
                <th className="py-1.5 px-2 text-left">Vencimiento</th>
                <th className="py-1.5 px-2 text-right">Días</th>
                {matrix.offsetsPct.map((off) => (
                  <th key={off} className="py-1.5 px-2 text-right">
                    {off === 0 ? 'ATM 0%' : `${off > 0 ? '+' : ''}${off}%`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => {
                const isSel = row.expiryCode === expirySuite?.expiryCode;
                return (
                  <tr
                    key={row.expiryCode}
                    onClick={() => onSelectExpiry(row.expiryCode)}
                    className={`border-b border-[#15151E] cursor-pointer transition-colors ${
                      isSel ? 'bg-[#171722]' : 'hover:bg-[#12121A]'
                    }`}
                  >
                    <td className="py-1.5 px-2 font-sans font-semibold text-[#E5E7EB] whitespace-nowrap">
                      {row.expiryLabel}
                    </td>
                    <td className="py-1.5 px-2 text-right text-[#9CA3AF]">{row.daysToExpiry}d</td>
                    {row.cells.map((cell) => (
                      <td
                        key={cell.offsetPct}
                        className={`py-1.5 px-2 text-right ${
                          cell.ivPct === null
                            ? 'text-[#4B5563]'
                            : cell.offsetPct === 0
                              ? 'text-[#38BDF8] font-bold'
                              : cell.offsetPct < 0
                                ? 'text-[#B794F4]'
                                : 'text-[#E5C76B]'
                        }`}
                      >
                        {fmtNullableNumber(cell.ivPct, 1, '%')}
                      </td>
                    ))}
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

// ============================================================================
// Tab 3: Histórica, Rolling RV, Tabla Condicional & Estacionalidad
// ============================================================================

const Tab3HistoricaEstacionalidad: React.FC<{
  readonly suite: VolAnalyticsSuiteDto;
  readonly horizon: VolHistoryHorizon;
  readonly onChangeHorizon: (h: VolHistoryHorizon) => void;
  readonly currencyPrefix: string;
}> = ({ suite, horizon, onChangeHorizon, currencyPrefix }) => {
  const hist = suite.historicalConditional;
  const visibleSeries = useMemo(
    () => sliceHistorySeriesByHorizon(hist.historySeries, horizon),
    [hist.historySeries, horizon],
  );
  const [hoveredBar, setHoveredBar] = useState<VolSuiteHistoryPointDto | null>(null);

  const w = 780;
  const h = 230;
  const padL = 50;
  const padR = 20;
  const padT = 20;
  const padB = 30;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const yVals: (number | null)[] = [
    ...visibleSeries.map((p) => p.rvPct),
    hist.currentEvalVolPct,
  ];
  const yExt = computeNumericExtent(yVals, 0.12, 10);
  const mapX = (idx: number) =>
    visibleSeries.length <= 1 ? padL + plotW / 2 : padL + (idx / (visibleSeries.length - 1)) * plotW;
  const mapY = (val: number) => padT + ((yExt.max - val) / (yExt.max - yExt.min)) * plotH;

  const rvPath = buildSvgLinePath(
    visibleSeries.map((pt, idx) => ({ x: idx, y: pt.rvPct })),
    mapX,
    mapY,
  );
  const yTicks = buildLinearTicks(yExt.min, yExt.max, 4);

  const rvWindowItems = [
    { key: 'RV 20 ruedas', data: suite.rvWindows.rv20 },
    { key: 'RV 60 ruedas', data: suite.rvWindows.rv60 },
    { key: 'RV 120 ruedas', data: suite.rvWindows.rv120 },
  ];

  return (
    <div className="space-y-4">
      {/* Gráfico RV histórica vs VI actual */}
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-[13px] font-bold text-[#F3F4F6]">
              Serie Histórica RV 23 Ruedas vs. Volatilidad Implícita Actual
            </h3>
            <p className="text-[11px] text-[#9CA3AF] font-mono-num">
              {hoveredBar
                ? `${hoveredBar.date} · Cierre ${currencyPrefix}${fmtNullableNumber(hoveredBar.close, 2)} · RV23 ${fmtNullableNumber(hoveredBar.rvPct, 1, '%')}`
                : `${visibleSeries.length} ruedas visibles (de ${hist.barsUsed} cargadas)`}
            </p>
          </div>
          <div className="flex items-center gap-1 bg-[#111116] border border-[#1C1C24] rounded-[8px] p-0.5 text-[11px] font-mono-num">
            {HORIZONS.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => onChangeHorizon(opt)}
                className={`px-2.5 py-1 rounded-[6px] font-semibold transition-colors ${
                  horizon === opt ? 'bg-[#38BDF8] text-[#0A0A0D]' : 'text-[#9CA3AF] hover:text-[#F3F4F6]'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>

        {visibleSeries.length < 2 ? (
          <div className="h-[190px] flex items-center justify-center text-[12px] text-[#6B7280]">
            Sin suficientes barras históricas diarias para trazar la serie de volatilidad realizada.
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${w} ${h}`}
            className="w-full h-auto block"
            onMouseLeave={() => setHoveredBar(null)}
          >
            {yTicks.map((val, idx) => {
              const y = mapY(val);
              return (
                <g key={idx}>
                  <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#1C1C24" strokeDasharray="3 3" />
                  <text x={padL - 8} y={y + 3} textAnchor="end" fill="#6B7280" fontSize="10" className="font-mono-num">
                    {fmtNum(val, 1)}%
                  </text>
                </g>
              );
            })}

            {hist.currentEvalVolPct !== null && Number.isFinite(hist.currentEvalVolPct) && (
              <g>
                <line
                  x1={padL}
                  y1={mapY(hist.currentEvalVolPct)}
                  x2={w - padR}
                  y2={mapY(hist.currentEvalVolPct)}
                  stroke="#E5C76B"
                  strokeWidth="1.4"
                  strokeDasharray="5 4"
                />
                <text
                  x={w - padR - 4}
                  y={mapY(hist.currentEvalVolPct) - 5}
                  textAnchor="end"
                  fill="#E5C76B"
                  fontSize="10"
                  className="font-mono-num"
                >
                  VI actual {fmtNum(hist.currentEvalVolPct, 1)}%
                </text>
              </g>
            )}

            <path d={rvPath} fill="none" stroke="#38BDF8" strokeWidth="2" />

            {/* Bandas invisibles para hover rápido por rueda */}
            {visibleSeries.map((pt, idx) => (
              <rect
                key={`${pt.date}-${idx}`}
                x={mapX(idx) - Math.max(2, plotW / visibleSeries.length / 2)}
                y={padT}
                width={Math.max(4, plotW / visibleSeries.length)}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoveredBar(pt)}
              />
            ))}

            <text x={padL} y={h - 8} fill="#6B7280" fontSize="9.5" className="font-mono-num">
              {visibleSeries[0]?.date ?? ''}
            </text>
            <text x={w - padR} y={h - 8} textAnchor="end" fill="#6B7280" fontSize="9.5" className="font-mono-num">
              {visibleSeries[visibleSeries.length - 1]?.date ?? ''}
            </text>
          </svg>
        )}
      </div>

      {/* Distribución Rolling RV 20d / 60d / 120d */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {rvWindowItems.map((item) => (
          <div key={item.key} className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2 text-[12px] font-mono-num">
            <div className="flex items-center justify-between">
              <span className="font-sans font-bold text-[#F3F4F6] text-[12.5px]">{item.key}</span>
              <span className="text-[#38BDF8] font-bold">{fmtNullableNumber(item.data.currentPct, 1, '%')}</span>
            </div>
            <div className="grid grid-cols-5 gap-1 pt-1 border-t border-[#1C1C24] text-[10.5px] text-center">
              <div>
                <div className="text-[#6B7280]">Mín</div>
                <div className="text-[#D1D5DB]">{fmtNullableNumber(item.data.minPct, 1)}</div>
              </div>
              <div>
                <div className="text-[#6B7280]">P25</div>
                <div className="text-[#D1D5DB]">{fmtNullableNumber(item.data.p25Pct, 1)}</div>
              </div>
              <div>
                <div className="text-[#6B7280]">Med</div>
                <div className="text-[#38BDF8] font-bold">{fmtNullableNumber(item.data.medianPct, 1)}</div>
              </div>
              <div>
                <div className="text-[#6B7280]">P75</div>
                <div className="text-[#D1D5DB]">{fmtNullableNumber(item.data.p75Pct, 1)}</div>
              </div>
              <div>
                <div className="text-[#6B7280]">Máx</div>
                <div className="text-[#D1D5DB]">{fmtNullableNumber(item.data.maxPct, 1)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabla condicional histórica "Qué pasó las otras veces" */}
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2 overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-[13px] font-bold text-[#F3F4F6]">
              Qué pasó las otras veces (Quintiles Históricos de Volatilidad a +30d)
            </h3>
            <p className="text-[11px] text-[#9CA3AF]">
              Lectura empírica sin etiquetas subjetivas · {hist.pairedObservations} pares históricos observados.
            </p>
          </div>
        </div>

        <table className="w-full text-[12px] font-mono-num border-collapse">
          <thead>
            <tr className="border-b border-[#1C1C24] text-[#6B7280]">
              <th className="py-2 px-2 text-left">Quintil</th>
              <th className="py-2 px-2 text-left">Rango Vol</th>
              <th className="py-2 px-2 text-right">Ruedas</th>
              <th className="py-2 px-2 text-right">Δ Vol +30d</th>
              <th className="py-2 px-2 text-right">Retorno Suby. +30d</th>
              <th className="py-2 px-2 text-right">% Veces Vol Bajó</th>
            </tr>
          </thead>
          <tbody>
            {hist.buckets.map((b) => (
              <tr
                key={b.id}
                className={`border-b border-[#15151E] ${b.isCurrent ? 'bg-[#161924] text-[#F9FAFB]' : 'text-[#D1D5DB]'}`}
              >
                <td className="py-2 px-2 font-sans font-semibold flex items-center gap-2">
                  <span>{b.label}</span>
                  {b.isCurrent && (
                    <span className="px-1.5 py-0.5 rounded bg-[#E5C76B]/20 text-[#E5C76B] text-[9.5px] font-mono-num">
                      ACTUAL
                    </span>
                  )}
                </td>
                <td className="py-2 px-2 text-[#9CA3AF]">{b.rangeLabel}</td>
                <td className="py-2 px-2 text-right">{b.occurrences}</td>
                <td className="py-2 px-2 text-right">
                  {fmtSignedNullable(b.avgVolChange30dPts, 1, ' pts')}
                </td>
                <td className="py-2 px-2 text-right">
                  {fmtSignedNullable(b.avgUnderlyingReturn30dPct, 2, '%')}
                </td>
                <td className="py-2 px-2 text-right text-[#38BDF8]">
                  {fmtNullableNumber(b.pctVolDecreased, 1, '%')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Estacionalidad mensual + Eventos extremos > 3 sigma */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-7 rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2 overflow-x-auto">
          <h3 className="text-[13px] font-bold text-[#F3F4F6]">Estacionalidad Mensual</h3>
          <table className="w-full text-[11.5px] font-mono-num border-collapse">
            <thead>
              <tr className="border-b border-[#1C1C24] text-[#6B7280]">
                <th className="py-1.5 px-2 text-left">Mes</th>
                <th className="py-1.5 px-2 text-right">Muestras</th>
                <th className="py-1.5 px-2 text-right">Ret. Mensual</th>
                <th className="py-1.5 px-2 text-right">Vol Anualizada</th>
                <th className="py-1.5 px-2 text-right">% Meses +</th>
              </tr>
            </thead>
            <tbody>
              {hist.seasonalityMonths.map((m) => (
                <tr key={m.monthIndex} className="border-b border-[#15151E] text-[#D1D5DB]">
                  <td className="py-1.5 px-2 font-sans font-semibold">{m.monthLabel}</td>
                  <td className="py-1.5 px-2 text-right text-[#9CA3AF]">
                    {m.monthsSampled}m ({m.tradingDays}d)
                  </td>
                  <td
                    className={`py-1.5 px-2 text-right ${
                      m.avgMonthlyReturnPct !== null && m.avgMonthlyReturnPct >= 0 ? 'text-[#34D399]' : 'text-[#F87171]'
                    }`}
                  >
                    {fmtSignedNullable(m.avgMonthlyReturnPct, 2, '%')}
                  </td>
                  <td className="py-1.5 px-2 text-right text-[#38BDF8]">
                    {fmtNullableNumber(m.annualizedVolPct, 1, '%')}
                  </td>
                  <td className="py-1.5 px-2 text-right">{fmtNullableNumber(m.positiveMonthRatePct, 0, '%')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="xl:col-span-5 rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2 overflow-x-auto">
          <h3 className="text-[13px] font-bold text-[#F3F4F6]">Sesiones Extremas (&gt; 3σ Históricas)</h3>
          {hist.extremeSessions.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-[#6B7280]">
              Sin sesiones diarias fuera de ±3σ en las últimas {hist.barsUsed} ruedas.
            </div>
          ) : (
            <table className="w-full text-[11.5px] font-mono-num border-collapse">
              <thead>
                <tr className="border-b border-[#1C1C24] text-[#6B7280]">
                  <th className="py-1.5 px-2 text-left">Fecha</th>
                  <th className="py-1.5 px-2 text-right">Ret. Simple</th>
                  <th className="py-1.5 px-2 text-right">Z-Score</th>
                  <th className="py-1.5 px-2 text-right">Dir.</th>
                </tr>
              </thead>
              <tbody>
                {hist.extremeSessions.slice(0, 12).map((s) => (
                  <tr key={`${s.date}-${s.time}`} className="border-b border-[#15151E]">
                    <td className="py-1.5 px-2 text-[#D1D5DB]">{s.date}</td>
                    <td
                      className={`py-1.5 px-2 text-right font-bold ${
                        s.direction === 'UP' ? 'text-[#34D399]' : 'text-[#F87171]'
                      }`}
                    >
                      {fmtSignedNullable(s.simpleReturnPct, 2, '%')}
                    </td>
                    <td className="py-1.5 px-2 text-right text-[#E5C76B]">{fmtNullableNumber(s.zScore, 2, 'σ')}</td>
                    <td className="py-1.5 px-2 text-right text-[#9CA3AF]">{s.direction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Tab 4: Paridad Call-Put Strike por Strike & Tasas Sintéticas Bid/Ask (TEA)
// ============================================================================

const Tab4ParidadTasas: React.FC<{
  readonly expirySuite: VolAnalyticsExpirySuiteDto | null;
  readonly unifiedQuant: UnifiedQuantEnginesDto | null;
  readonly currencyPrefix: string;
}> = ({ expirySuite, unifiedQuant, currencyPrefix }) => {
  const parity = expirySuite?.parity ?? null;

  if (!parity || parity.status !== 'OK' || parity.strikes.length === 0) {
    return (
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-6 text-center text-[12px] text-[#6B7280]">
        Sin pares Call/Put simultáneos en el vencimiento actual para estimar paridad strike por strike.
      </div>
    );
  }

  const isShortDteBlocked =
    parity.daysToExpiry < 3 ||
    parity.impliedRateStatus === 'BLOCKED_SHORT_DTE' ||
    (unifiedQuant?.syntheticRates as { readonly impliedRateStatus?: string } | null | undefined)
      ?.impliedRateStatus === 'BLOCKED_SHORT_DTE';
  const borrowLabel = isShortDteBlocked
    ? 'BLOCKED_SHORT_DTE'
    : unifiedQuant?.syntheticRates?.borrowRegime ?? '—';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-3 font-mono-num">
          <div className="text-[10px] uppercase text-[#6B7280]">{parity.benchmarkLabel}</div>
          <div className="text-[16px] font-extrabold text-[#38BDF8]">
            {fmtNullableNumber(parity.benchmarkTeaPct, 2, '%')}
          </div>
          <div className="text-[10px] text-[#9CA3AF]">Benchmark TEA · {parity.daysToExpiry}d</div>
        </div>
        <div
          title={isShortDteBlocked ? 'DTE < 3: anualización de tasa implícita sintética suspendida' : undefined}
          className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-3 font-mono-num"
        >
          <div className="text-[10px] uppercase text-[#6B7280]">TEA Mid Mediana</div>
          <div className="text-[16px] font-extrabold text-[#F3F4F6]">
            {isShortDteBlocked ? '—' : fmtNullableNumber(parity.medianMidTeaPct, 2, '%')}
          </div>
          <div className="text-[10px] text-[#9CA3AF]">
            {isShortDteBlocked ? 'DTE < 3 (bloqueado)' : 'Sintético medio C − P'}
          </div>
        </div>
        <div
          title={isShortDteBlocked ? 'DTE < 3: anualización de tasa implícita sintética suspendida' : undefined}
          className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-3 font-mono-num"
        >
          <div className="text-[10px] uppercase text-[#6B7280]">Mejor TEA Tomadora</div>
          <div className="text-[16px] font-extrabold text-[#E5C76B]">
            {isShortDteBlocked ? '—' : fmtNullableNumber(parity.bestTomadoraTeaPct, 2, '%')}
          </div>
          <div className="text-[10px] text-[#9CA3AF]">
            {isShortDteBlocked
              ? 'DTE < 3 (bloqueado)'
              : `Base ${parity.bestTomadoraStrike !== null ? `${currencyPrefix}${fmtNum(parity.bestTomadoraStrike, 2)}` : '—'}`}
          </div>
        </div>
        <div
          title={isShortDteBlocked ? 'DTE < 3: anualización de tasa implícita sintética suspendida' : undefined}
          className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-3 font-mono-num"
        >
          <div className="text-[10px] uppercase text-[#6B7280]">Mejor TEA Colocadora</div>
          <div className="text-[16px] font-extrabold text-[#B794F4]">
            {isShortDteBlocked ? '—' : fmtNullableNumber(parity.bestColocadoraTeaPct, 2, '%')}
          </div>
          <div className="text-[10px] text-[#9CA3AF]">
            {isShortDteBlocked
              ? 'DTE < 3 (bloqueado)'
              : `Base ${parity.bestColocadoraStrike !== null ? `${currencyPrefix}${fmtNum(parity.bestColocadoraStrike, 2)}` : '—'}`}
          </div>
        </div>
        <div
          title={isShortDteBlocked ? 'DTE < 3: alerta HARD_TO_BORROW_SQUEEZE_ALERT bloqueada por T < 3/365' : undefined}
          className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-3 font-mono-num"
        >
          <div className="text-[10px] uppercase text-[#6B7280]">Borrow / Conv-Rev</div>
          <div className="text-[14px] font-extrabold text-[#38BDF8]">
            {borrowLabel}
          </div>
          <div className="text-[10px] text-[#9CA3AF]">
            {isShortDteBlocked
              ? 'HTB bloqueado (DTE < 3)'
              : `Edge: ${
                  unifiedQuant?.conversionReversal?.netEdgeVsRiskFreeBps != null
                    ? `${fmtNum(unifiedQuant.conversionReversal.netEdgeVsRiskFreeBps, 0)} bps`
                    : '—'
                }`}
          </div>
        </div>
      </div>

      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2 overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-bold text-[#F3F4F6]">Paridad Call–Put Strike por Strike</h3>
          <span className="text-[11px] text-[#9CA3AF]">
            Tomadora = +Call Ask / −Put Bid / −Spot Bid · Colocadora = −Call Bid / +Put Ask / +Spot Ask
          </span>
        </div>

        <table className="w-full text-[11.5px] font-mono-num border-collapse">
          <thead>
            <tr className="border-b border-[#1C1C24] text-[#6B7280]">
              <th className="py-2 px-2 text-right">Strike</th>
              <th className="py-2 px-2 text-right">IV Call</th>
              <th className="py-2 px-2 text-right">IV Put</th>
              <th className="py-2 px-2 text-right">C−P (pp)</th>
              <th className="py-2 px-2 text-right">Fwd Sintético</th>
              <th className="py-2 px-2 text-right">TEA Mid</th>
              <th className="py-2 px-2 text-right">TEA Tomadora</th>
              <th className="py-2 px-2 text-right">TEA Colocadora</th>
              <th className="py-2 px-2 text-right">Edge Tom. (bps)</th>
              <th className="py-2 px-2 text-right">Edge Col. (bps)</th>
            </tr>
          </thead>
          <tbody>
            {parity.strikes.map((row) => (
              <tr key={row.strike} className="border-b border-[#15151E] hover:bg-[#12121A]">
                <td className="py-1.5 px-2 text-right font-bold text-[#F3F4F6]">
                  {currencyPrefix}
                  {fmtNum(row.strike, 2)}
                </td>
                <td className="py-1.5 px-2 text-right text-[#E5C76B]">{fmtNullableNumber(row.callIvPct, 1, '%')}</td>
                <td className="py-1.5 px-2 text-right text-[#B794F4]">{fmtNullableNumber(row.putIvPct, 1, '%')}</td>
                <td className="py-1.5 px-2 text-right text-[#9CA3AF]">{fmtSignedNullable(row.ivSpreadPp, 1)}</td>
                <td className="py-1.5 px-2 text-right text-[#D1D5DB]">
                  {row.syntheticForwardMid !== null ? `${currencyPrefix}${fmtNum(row.syntheticForwardMid, 2)}` : '—'}
                </td>
                <td className="py-1.5 px-2 text-right text-[#D1D5DB]">
                  {fmtNullableNumber(row.midImpliedTeaPct, 2, '%')}
                </td>
                <td
                  className={`py-1.5 px-2 text-right font-semibold ${
                    row.canBorrowBelowBenchmark ? 'text-[#34D399]' : 'text-[#D1D5DB]'
                  }`}
                >
                  {fmtNullableNumber(row.teaTomadoraPct, 2, '%')}
                </td>
                <td
                  className={`py-1.5 px-2 text-right font-semibold ${
                    row.canLendAboveBenchmark ? 'text-[#34D399]' : 'text-[#D1D5DB]'
                  }`}
                >
                  {fmtNullableNumber(row.teaColocadoraPct, 2, '%')}
                </td>
                <td
                  className={`py-1.5 px-2 text-right ${
                    row.canBorrowBelowBenchmark ? 'text-[#34D399]' : 'text-[#6B7280]'
                  }`}
                >
                  {fmtSignedNullable(row.edgeTomadoraBps, 0)}
                </td>
                <td
                  className={`py-1.5 px-2 text-right ${
                    row.canLendAboveBenchmark ? 'text-[#34D399]' : 'text-[#6B7280]'
                  }`}
                >
                  {fmtSignedNullable(row.edgeColocadoraBps, 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ============================================================================
// Tab 5: Estructuras & Costo Relativo Histórico BS2002
// ============================================================================

const Tab5EstructurasCosto: React.FC<{
  readonly expirySuite: VolAnalyticsExpirySuiteDto | null;
  readonly currencyPrefix: string;
  readonly onSendToBuilder: (legs: StratLeg[]) => void;
}> = ({ expirySuite, currencyPrefix, onSendToBuilder }) => {
  const rs = expirySuite?.ratiosAndStructures ?? null;

  if (!rs || rs.status !== 'OK') {
    return (
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-6 text-center text-[12px] text-[#6B7280]">
        Sin cadenas con liquidez suficiente para calcular ratios 1:N ni costo relativo BS2002.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Estructuras de riesgo definido y Percentil BS2002 */}
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-3">
        <div>
          <h3 className="text-[13px] font-bold text-[#F3F4F6]">
            Estructuras de Riesgo Definido — Costo Relativo vs. Historial Bjerksund-Stensland 2002
          </h3>
          <p className="text-[11px] text-[#9CA3AF]">
            Comparación objetiva entre el débito de mercado actual y el costo histórico simulado bajo BS2002 con la serie de volatilidad realizada.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {rs.structures.map((item) => {
            const pct = item.bs2002HistoricalPercentile;
            const buildableLegs = structureItemToLegs(item);
            return (
              <div
                key={item.id}
                className="rounded-[12px] bg-[#111116] border border-[#1C1C24] p-3.5 space-y-2.5 text-[12px]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-bold text-[#F3F4F6]">{item.name}</div>
                    <div className="text-[10.5px] font-mono-num text-[#9CA3AF]">
                      {item.legsLabel} · Fuente: {item.priceSource}
                    </div>
                  </div>
                  {buildableLegs && (
                    <button
                      type="button"
                      onClick={() => onSendToBuilder(buildableLegs)}
                      className="px-2.5 py-1 rounded-[6px] bg-[#E5C76B] text-[#0A0A0D] text-[10.5px] font-bold hover:bg-[#F0D685] transition-colors shrink-0"
                    >
                      + Armar
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2 font-mono-num text-[11px] pt-1 border-t border-[#1C1C24]">
                  <div>
                    <div className="text-[#6B7280]">Débito / Ancho</div>
                    <div className="text-[#F3F4F6] font-bold">
                      {currencyPrefix}
                      {fmtNullableNumber(item.netDebit, 2)} / {currencyPrefix}
                      {fmtNullableNumber(item.width, 2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#6B7280]">Costo % Ancho</div>
                    <div className="text-[#38BDF8] font-bold">{fmtNullableNumber(item.costPctOfWidth, 1, '%')}</div>
                  </div>
                  <div>
                    <div className="text-[#6B7280]">Beneficio Máx / R:R</div>
                    <div className="text-[#E5C76B]">
                      {currencyPrefix}
                      {fmtNullableNumber(item.maxProfit, 2)} · {fmtNullableNumber(item.rewardRiskRatio, 2)}x
                    </div>
                  </div>
                  <div>
                    <div className="text-[#6B7280]">Breakeven</div>
                    <div className="text-[#D1D5DB]">
                      {currencyPrefix}
                      {fmtNullableNumber(item.breakevenLow, 2)}
                      {item.breakevenHigh !== null ? ` – ${currencyPrefix}${fmtNum(item.breakevenHigh, 2)}` : ''}
                    </div>
                  </div>
                </div>

                {/* Barra de percentil BS2002 */}
                <div className="space-y-1 pt-1 border-t border-[#1C1C24]">
                  <div className="flex justify-between text-[10.5px] font-mono-num">
                    <span className="text-[#9CA3AF]">Percentil BS2002 ({item.bs2002HistoricalObs} ruedas)</span>
                    <strong className="text-[#B794F4]">P{fmtNullableNumber(pct, 0)}</strong>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-[#1C1C24] overflow-hidden">
                    <div
                      className="h-full bg-[#B794F4]"
                      style={{
                        width: `${pct !== null && Number.isFinite(pct) ? Math.max(2, Math.min(100, pct)) : 0}%`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] font-mono-num text-[#6B7280]">
                    <span>Mín {fmtNullableNumber(item.bs2002HistoricalMinPct, 1, '%')}</span>
                    <span>Med {fmtNullableNumber(item.bs2002HistoricalMedianPct, 1, '%')}</span>
                    <span>Máx {fmtNullableNumber(item.bs2002HistoricalMaxPct, 1, '%')}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tablas de Ratios 1:N Call & Put */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RatioTable
          title={
            (expirySuite?.smileOtmOnly.atmIvPct ?? expirySuite?.smileAll.atmIvPct ?? 0) > 0
              ? 'Ratios 1:N Calls (Financiación OTM +1σ / +2σ)'
              : 'Ratios 1:N Calls (Financiación OTM +5% / +10% / +15%)'
          }
          accentColor="text-[#E5C76B]"
          rows={rs.callRatios}
          currencyPrefix={currencyPrefix}
          onSendToBuilder={onSendToBuilder}
        />
        <RatioTable
          title={
            (expirySuite?.smileOtmOnly.atmIvPct ?? expirySuite?.smileAll.atmIvPct ?? 0) > 0
              ? 'Ratios 1:N Puts (Financiación OTM −1σ / −2σ)'
              : 'Ratios 1:N Puts (Financiación OTM −5% / −10% / −15%)'
          }
          accentColor="text-[#B794F4]"
          rows={rs.putRatios}
          currencyPrefix={currencyPrefix}
          onSendToBuilder={onSendToBuilder}
        />
      </div>
    </div>
  );
};

const RatioTable: React.FC<{
  readonly title: string;
  readonly accentColor: string;
  readonly rows: readonly VolSuiteRatioRowDto[];
  readonly currencyPrefix: string;
  readonly onSendToBuilder: (legs: StratLeg[]) => void;
}> = ({ title, accentColor, rows, currencyPrefix, onSendToBuilder }) => {
  const validRows = rows.filter(
    (r) =>
      ((r.longPrice ?? 0) > 0.005 || (r.shortPrice ?? 0) > 0.005) &&
      (r.shortPrice ?? 0) > 0.005,
  );
  return (
    <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2 overflow-x-auto">
      <h3 className={`text-[12.5px] font-bold ${accentColor}`}>{title}</h3>
      {validRows.length === 0 ? (
        <div className="py-6 text-center text-[12px] text-[#6B7280]">Sin primas válidas en este vencimiento</div>
      ) : (
        <table className="w-full text-[11.5px] font-mono-num border-collapse">
          <thead>
            <tr className="border-b border-[#1C1C24] text-[#6B7280]">
              <th className="py-1.5 px-2 text-right">Compra</th>
              <th className="py-1.5 px-2 text-right">Venta ({validRows[0]?.side})</th>
              <th className="py-1.5 px-2 text-right">Lotes OTM / 1</th>
              <th className="py-1.5 px-2 text-right">Neto 1x2</th>
              <th className="py-1.5 px-2 text-right">BE Extremo</th>
              <th className="py-1.5 px-2 text-right">Acción</th>
            </tr>
          </thead>
          <tbody>
            {validRows.map((r) => (
            <tr key={`${r.side}-${r.longStrike}-${r.shortStrike}`} className="border-b border-[#15151E]">
              <td className="py-1.5 px-2 text-right text-[#F3F4F6]">
                {currencyPrefix}
                {fmtNum(r.longStrike, 1)}
              </td>
              <td className="py-1.5 px-2 text-right text-[#D1D5DB]">
                {currencyPrefix}
                {fmtNum(r.shortStrike, 1)}{' '}
                <span className="text-[#6B7280] text-[10px]">
                  ({fmtSignedNullable(r.shortMoneynessPct, 1, '%')})
                </span>
              </td>
              <td className="py-1.5 px-2 text-right text-[#38BDF8] font-bold">
                {fmtNullableNumber(r.otmLotsPerBought, 2, 'x')}
              </td>
              <td className="py-1.5 px-2 text-right text-[#D1D5DB]">
                {r.netCash1x2 !== null ? `${currencyPrefix}${fmtNum(r.netCash1x2, 2)}` : '—'}
              </td>
              <td className="py-1.5 px-2 text-right text-[#9CA3AF]">
                {r.outerBreakeven1x2 !== null ? `${currencyPrefix}${fmtNum(r.outerBreakeven1x2, 1)}` : '—'}
              </td>
              <td className="py-1.5 px-2 text-right">
                <button
                  type="button"
                  onClick={() => onSendToBuilder(ratioRowToLegs(r))}
                  className="px-2 py-0.5 rounded bg-[#1A1A24] border border-[#2D2D3D] text-[#E5E7EB] hover:border-[#E5C76B] text-[10.5px] font-sans font-semibold transition-colors"
                >
                  + Armar 1x2
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
    </div>
  );
};

// ============================================================================
// Tab 6: Superficie Dual BYMA vs OPRA (ADR)
// ============================================================================

const Tab6DualBymaOpra: React.FC<{
  readonly suite: VolAnalyticsSuiteDto;
  readonly onGoToTab2: () => void;
}> = ({ suite, onGoToTab2 }) => {
  const dual = suite.dualSurface;
  const [hoveredNode, setHoveredNode] = useState<VolSuiteDualSurfaceNodeDto | null>(null);

  if (!suite.hasDualAdr) {
    return (
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-8 text-center space-y-3">
        <div className="text-[14px] font-bold text-[#F3F4F6]">
          {suite.nonDualMessage ?? 'Activo sin ADR dual — Ver estructura completa en Tab 2'}
        </div>
        <button
          type="button"
          onClick={onGoToTab2}
          className="px-4 py-2 rounded-[8px] bg-[#38BDF8] text-[#0A0A0D] text-[12px] font-bold hover:bg-[#60CCF9] transition-colors"
        >
          Ir a Sonrisa &amp; Matriz (Tab 2)
        </button>
      </div>
    );
  }

  if (!dual || dual.status !== 'OK' || dual.nodes.length === 0) {
    return (
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-6 text-center text-[12px] text-[#6B7280]">
        El subyacente {suite.underlying} opera con ADR dual, pero la cadena OPRA o la paridad CCL aún no reunió nodos válidos para este ciclo.
      </div>
    );
  }

  const w = 780;
  const h = 250;
  const padL = 50;
  const padR = 24;
  const padT = 22;
  const padB = 32;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const xExt = computeNumericExtent(
    dual.nodes.map((n) => n.offsetPct),
    0.05,
    10,
  );
  const yExt = computeNumericExtent(
    dual.nodes.flatMap((n) => [n.bymaIvPct, n.opraAdrIvPct, n.theoreticalBymaIvPct]),
    0.15,
    10,
  );
  const mapX = (off: number) => padL + ((off - xExt.min) / (xExt.max - xExt.min)) * plotW;
  const mapY = (iv: number) => padT + ((yExt.max - iv) / (yExt.max - yExt.min)) * plotH;

  const bymaPath = buildSvgLinePath(
    dual.nodes.map((n) => ({ x: n.offsetPct, y: n.bymaIvPct })),
    mapX,
    mapY,
  );
  const opraPath = buildSvgLinePath(
    dual.nodes.map((n) => ({ x: n.offsetPct, y: n.opraAdrIvPct })),
    mapX,
    mapY,
  );
  const theoPath = buildSvgLinePath(
    dual.nodes.map((n) => ({ x: n.offsetPct, y: n.theoreticalBymaIvPct })),
    mapX,
    mapY,
  );
  const yTicks = buildLinearTicks(yExt.min, yExt.max, 4);

  return (
    <div className="space-y-4">
      {/* KPIs Duales */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2.5 font-mono-num">
        <div className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-3">
          <div className="text-[10px] uppercase text-[#6B7280]">BYMA / {dual.adrTicker} ADR</div>
          <div className="text-[14px] font-bold text-[#F3F4F6]">
            ${fmtNullableNumber(dual.bymaSpotArs, 1)} / US${fmtNullableNumber(dual.adrSpotUsd, 2)}
          </div>
          <div className="text-[10px] text-[#9CA3AF]">Ratio {dual.adrRatio ?? '—'}:1</div>
        </div>
        <div className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-3">
          <div className="text-[10px] uppercase text-[#6B7280]">CCL Implícito</div>
          <div className="text-[15px] font-extrabold text-[#38BDF8]">${fmtNullableNumber(dual.cclImplicit, 2)}</div>
          <div className="text-[10px] text-[#9CA3AF]">Vol CCL {fmtNullableNumber(dual.cclAnnualVolPct, 1, '%')}</div>
        </div>
        <div className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-3">
          <div className="text-[10px] uppercase text-[#6B7280]">Corr(ADR, CCL)</div>
          <div className="text-[15px] font-extrabold text-[#F3F4F6]">{fmtSignedNullable(dual.corrAdrCcl, 2)}</div>
          <div className="text-[10px] text-[#9CA3AF]">Diaria histórica</div>
        </div>
        <div className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-3">
          <div className="text-[10px] uppercase text-[#6B7280]">IV ATM BYMA</div>
          <div className="text-[15px] font-extrabold text-[#E5C76B]">{fmtNullableNumber(dual.bymaAtmIvPct, 1, '%')}</div>
          <div className="text-[10px] text-[#9CA3AF]">
            {dual.bymaExpiryCode} ({dual.bymaDays}d)
          </div>
        </div>
        <div className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-3">
          <div className="text-[10px] uppercase text-[#6B7280]">IV ATM OPRA ({dual.adrTicker})</div>
          <div className="text-[15px] font-extrabold text-[#B794F4]">{fmtNullableNumber(dual.opraAtmIvPct, 1, '%')}</div>
          <div className="text-[10px] text-[#9CA3AF]">
            {dual.opraExpiryDate} ({dual.opraDays}d)
          </div>
        </div>
        <div className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-3">
          <div className="text-[10px] uppercase text-[#6B7280]">Teórica BYMA CCL</div>
          <div className="text-[15px] font-extrabold text-[#38BDF8]">
            {fmtNullableNumber(dual.theoreticalAtmIvPct, 1, '%')}
          </div>
          <div className="text-[10px] text-[#9CA3AF]">
            Spread vs Teo: {fmtSignedNullable(dual.atmSpreadBymaVsTheoreticalPp, 1, ' pp')}
          </div>
        </div>
      </div>

      {/* Gráfico 3 curvas */}
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-[13px] font-bold text-[#F3F4F6]">
              Sonrisa Dual {dual.arUnderlying} (BYMA) vs {dual.adrTicker} (OPRA) vs Teórica (ADR + CCL)
            </h3>
            <p className="text-[11px] text-[#9CA3AF] font-mono-num">
              {hoveredNode
                ? `Moneyness ${hoveredNode.offsetPct > 0 ? '+' : ''}${hoveredNode.offsetPct}% · BYMA ${fmtNullableNumber(hoveredNode.bymaIvPct, 1, '%')} · OPRA ${fmtNullableNumber(hoveredNode.opraAdrIvPct, 1, '%')} · Teórica ${fmtNullableNumber(hoveredNode.theoreticalBymaIvPct, 1, '%')}`
                : 'Deslice sobre los nodos para inspeccionar el diferencial en puntos porcentuales (pp).'}
            </p>
          </div>
          <div className="flex items-center gap-3 text-[10.5px] font-mono-num text-[#9CA3AF]">
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 bg-[#E5C76B]" /> BYMA
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 bg-[#B794F4]" /> OPRA ADR
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 bg-[#38BDF8]" /> Teórica CCL
            </span>
          </div>
        </div>

        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto block">
          {yTicks.map((val, i) => {
            const y = mapY(val);
            return (
              <g key={i}>
                <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#1C1C24" strokeDasharray="3 3" />
                <text x={padL - 8} y={y + 3} textAnchor="end" fill="#6B7280" fontSize="10" className="font-mono-num">
                  {fmtNum(val, 1)}%
                </text>
              </g>
            );
          })}

          {theoPath && <path d={theoPath} fill="none" stroke="#38BDF8" strokeWidth="1.8" strokeDasharray="4 3" />}
          {opraPath && <path d={opraPath} fill="none" stroke="#B794F4" strokeWidth="2.1" />}
          {bymaPath && <path d={bymaPath} fill="none" stroke="#E5C76B" strokeWidth="2.2" />}

          {dual.nodes.map((node) => {
            const cx = mapX(node.offsetPct);
            return (
              <g
                key={node.offsetPct}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredNode(node)}
              >
                {node.bymaIvPct !== null && <circle cx={cx} cy={mapY(node.bymaIvPct)} r={3.5} fill="#E5C76B" />}
                {node.opraAdrIvPct !== null && <circle cx={cx} cy={mapY(node.opraAdrIvPct)} r={3.5} fill="#B794F4" />}
                {node.theoreticalBymaIvPct !== null && (
                  <circle cx={cx} cy={mapY(node.theoreticalBymaIvPct)} r={3} fill="#38BDF8" />
                )}
                <text x={cx} y={h - 10} textAnchor="middle" fill="#6B7280" fontSize="9.5" className="font-mono-num">
                  {node.offsetPct > 0 ? '+' : ''}
                  {node.offsetPct}%
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Tabla comparativa nodo por nodo */}
      <div className="rounded-[14px] bg-[#0A0A0D] border border-[#1C1C24] p-4 overflow-x-auto">
        <table className="w-full text-[11.5px] font-mono-num border-collapse">
          <thead>
            <tr className="border-b border-[#1C1C24] text-[#6B7280]">
              <th className="py-1.5 px-2 text-right">Moneyness</th>
              <th className="py-1.5 px-2 text-right">IV BYMA</th>
              <th className="py-1.5 px-2 text-right">IV OPRA ({dual.adrTicker})</th>
              <th className="py-1.5 px-2 text-right">IV Teórica (ADR+CCL)</th>
              <th className="py-1.5 px-2 text-right">BYMA − OPRA (pp)</th>
              <th className="py-1.5 px-2 text-right">BYMA − Teórica (pp)</th>
            </tr>
          </thead>
          <tbody>
            {dual.nodes.map((n) => (
              <tr key={n.offsetPct} className="border-b border-[#15151E]">
                <td className="py-1.5 px-2 text-right font-bold text-[#F3F4F6]">
                  {n.offsetPct === 0 ? 'ATM 0%' : `${n.offsetPct > 0 ? '+' : ''}${n.offsetPct}%`}
                </td>
                <td className="py-1.5 px-2 text-right text-[#E5C76B]">{fmtNullableNumber(n.bymaIvPct, 1, '%')}</td>
                <td className="py-1.5 px-2 text-right text-[#B794F4]">{fmtNullableNumber(n.opraAdrIvPct, 1, '%')}</td>
                <td className="py-1.5 px-2 text-right text-[#38BDF8]">
                  {fmtNullableNumber(n.theoreticalBymaIvPct, 1, '%')}
                </td>
                <td className="py-1.5 px-2 text-right text-[#D1D5DB]">
                  {fmtSignedNullable(n.spreadBymaMinusOpraPp, 1, ' pp')}
                </td>
                <td className="py-1.5 px-2 text-right text-[#D1D5DB]">
                  {fmtSignedNullable(n.spreadBymaMinusTheoreticalPp, 1, ' pp')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
