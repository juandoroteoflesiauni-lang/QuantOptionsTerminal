import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  Plus,
  Trash2,
  Send,
  Layers,
  TrendingUp,
  Activity,
  Grid,
  BarChart3,
  Wrench,
  Bell,
  HelpCircle,
  AlignLeft,
  Search,
  Map as MapIcon,
} from 'lucide-react';
import {
  AR_STOCKS,
  GGAL_OPTION_EXPIRIES,
  US_MARKET_DATA,
  fmtMoneyCompact,
  fmtNum,
  fmtPct,
  OptionChainRow,
} from '../data/marketData';
import {
  requestOptionsCatalysts,
  requestOptionsChain,
  requestOptionsUniverse,
  requestUsVolSurface,
  useLiveMarketState,
} from '../data/liveRuntimeBridge';
import {
  OPTIONS_FAVORITE_KEYS,
  parseOptionsUnderlyingKey,
} from '../data/optionsUnderlying';
import { OptionsSymbolSelector } from './OptionsSymbolSelector';
import {
  getMarketStreamMetaClock,
  useAtomicMarketQuote,
  useLivePriceFlash,
  useMarketStreamMeta,
} from '../api/useMarketLiveStream';
import { VirtualizedOptionChainTable } from './options/VirtualizedOptionChainTable';
import {
  HelpTooltip,
  InsightBanner,
} from './DesignSystem';
import { CompanyLogo } from './common/CompanyLogo';
import {
  COMMISSION_RATE,
  FX_EASE,
  HIST_MEDIAN_IV,
  LOT,
  PricedLeg,
  atmIv,
  bsPrice,
  fk,
  makeMarket,
  ncdf,
  priceLegs,
} from './options/engine';
import { InteractiveOptionPriceMap } from './options/map/InteractiveOptionPriceMap';
import { VolatilitySuiteView } from './options/VolatilitySuiteView';
import {
  computeVerticalSpreadMetrics,
  isValidButterflyStrikes,
  type LiquiditySemaphore,
} from '../../../src/core/options/verticalSpreads';
import {
  type BidirectionalFlowRow,
  type BuilderLeg,
  type EnrichedChainRow,
  type StrategyFamilyId,
  type VisualPayoffCardData,
  buildBidirectionalFlow,
  buildEnrichedChainForExpiry,
  buildLiveStrategyCardsAndRows,
  computeBuilderAnalytics,
  computeInlineMarkersForRows,
  readOptionHoldingsFromStorage,
  resolveActiveVolAnalyticsSuite,
  resolveExpiryVolSuite,
} from './options/optionsDerived';
import {
  type CreditOptionQuoteInput,
  type CreditStructureCandidate,
  type CreditStructureKind,
  type SpreadExecutionMode,
  rankCreditStructures,
  resolveDefaultSpreadModeFromRegime,
} from '../../../src/core/terminal/structureOptimizer';
import { evaluateCatalystWindow } from '../../../src/core/options/catalysts';
import {
  computeForwardIvTermStructure,
  type ForwardIvSegmentResult,
} from '../../../src/core/options/volSurface';
import { computeActiveExpiryVrpAndRegime } from '../../../src/core/options/volAnalyticsSuite';
import { classifyDealerGammaRegimeFromSummary } from '../../../src/core/options/exposure';
import { extractRiskNeutralDistributionQ } from '../../../src/core/options/probabilisticDivergence';
import {
  SHORT_PREMIUM_RISK_MESSAGE,
  buildHardenedBlDensity,
  evaluateShortPremiumBreaker,
  formatDteLabel,
  hoursToCloseEt,
} from '../../../src/core/options/zeroDteFixes';
import type { WhatIfOptionLeg } from '../../../src/core/options/whatIfPayoff';
import { WhatIfPayoffSimulator } from './options/WhatIfPayoffSimulator';

export type OptionsSubView =
  | 'mapa'
  | 'estrategias'
  | 'spreads'
  | 'flujo'
  | 'cadena'
  | 'volatilidad'
  | 'armado';

/* Pieza 32: badge de origen del feed de opciones US (Tradier Live + ORATS o
   Massive + ORATS) expuesto por /api/us/providers-status. */
type UsProvidersStatusDto = {
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
        const json = (await res.json()) as UsProvidersStatusDto;
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

interface StrategyFamilyItem {
  id: StrategyFamilyId;
  label: string;
  svgPath: string;
}

const STRATEGY_FAMILIES: StrategyFamilyItem[] = [
  { id: 'bull_spread', label: 'Bull spread', svgPath: 'M2 11 L7 11 L13 3 L18 3' },
  { id: 'bear_spread', label: 'Bear spread', svgPath: 'M2 3 L7 3 L13 11 L18 11' },
  { id: 'mariposas', label: 'Mariposas', svgPath: 'M2 11 L6 11 L10 2 L14 11 L18 11' },
  { id: 'condores', label: 'Cóndores', svgPath: 'M2 11 L5 11 L8 3 L12 3 L15 11 L18 11' },
  { id: 'conos', label: 'Conos', svgPath: 'M2 2 L10 12 L18 2' },
  { id: 'cunas', label: 'Cuñas', svgPath: 'M2 3 L7 11 L13 11 L18 3' },
  { id: 'sinteticos', label: 'Sintéticos', svgPath: 'M3 12 L17 2' },
  { id: 'ratios', label: 'Ratios', svgPath: 'M2 9 L8 9 L12 3 L18 12' },
  { id: 'calendarios', label: 'Calendarios', svgPath: 'M2 11 Q10 1 18 11' },
  { id: 'compradas', label: 'Compradas', svgPath: 'M2 11 L10 11 L18 2' },
  { id: 'lanzadas', label: 'Lanzadas', svgPath: 'M2 3 L10 3 L18 12' },
  { id: 'lanz_cubierto', label: 'Lanz. cubierto', svgPath: 'M2 12 L10 4 L18 4' },
  { id: 'married_put', label: 'Married put', svgPath: 'M2 10 L10 10 L18 2' },
  { id: 'collar', label: 'Collar', svgPath: 'M2 11 L6 11 L14 3 L18 3' },
];

function getLiquiditySemaphoreBadgeStyle(sem?: LiquiditySemaphore | string): string {
  if (sem === 'GREEN') return 'bg-[#22C55E]/15 text-[#22C55E] border-[#22C55E]/40';
  if (sem === 'YELLOW') return 'bg-[#EAB308]/15 text-[#EAB308] border-[#EAB308]/40';
  if (sem === 'RED') return 'bg-[#EF4444]/15 text-[#EF4444] border-[#EF4444]/40';
  return 'bg-[#1F2433] text-[#787B86] border-[#2D3242]';
}

/* ============================================================================
   COMPONENTE DE TARJETA DE PAYOFF
   ============================================================================ */
const PayoffStrategyCard: React.FC<{
  card: VisualPayoffCardData;
  onExecute: (card: VisualPayoffCardData) => void;
  isSelected?: boolean;
  onInspect?: (card: VisualPayoffCardData) => void;
}> = ({ card, onExecute, isSelected = false, onInspect }) => {
  const clipAboveId = `clip-above-${card.id}`;
  const clipBelowId = `clip-below-${card.id}`;

  const zeroY = 74;
  const halfSpanY = 48;
  const xStart = 38;
  const xWidth = 250;

  const svgPts = card.points.map((pt) => ({
    x: xStart + (pt.x / 100) * xWidth,
    y: zeroY - pt.y * halfSpanY,
  }));

  const polylineStr = svgPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPolygonStr = `${xStart},${zeroY} ${polylineStr} ${xStart + xWidth},${zeroY}`;
  const spotX = xStart + (card.spotLinePct / 100) * xWidth;
  const targetX = card.targetLinePct !== undefined ? xStart + (card.targetLinePct / 100) * xWidth : null;

  return (
    <div
      className={`rounded-[12px] bg-[#12141A] border p-5 flex flex-col justify-between gap-4 transition-all ${
        isSelected
          ? 'border-[#38BDF8]/80 shadow-[0_0_0_1px_rgba(56,189,248,0.35)]'
          : 'border-[#232733] hover:border-[#343A4D]'
      }`}
    >
      {/* Header de la Card */}
      <div className="space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[16px] font-bold text-[#FFFFFF] tracking-tight">{card.title}</h3>
          {card.bidAskPctOfMid !== undefined && Number.isFinite(card.bidAskPctOfMid) && (
            <span
              title={`Semáforo de liquidez Bid-Ask % del Mid: ${fmtNum(card.bidAskPctOfMid, 1)}% (${card.liquiditySemaphore ?? '—'}) · Verde <5% · Amarillo 5-15% · Rojo >15%`}
              className={`shrink-0 px-2 py-0.5 rounded-full border font-mono-num text-[10px] font-semibold ${getLiquiditySemaphoreBadgeStyle(card.liquiditySemaphore)}`}
            >
              ● {fmtNum(card.bidAskPctOfMid, 1)}% Mid
            </span>
          )}
        </div>
        <p className="text-[12.5px] text-[#9CA3AF] leading-snug">{card.subtitle}</p>
        {card.note && <p className="text-[12px] text-[#D1D4DC] pt-1 font-medium">{card.note}</p>}
      </div>

      {/* Gráfico SVG de Payoff a Expiración */}
      <div className="pt-1">
        <svg viewBox="0 0 302 152" className="w-full h-36 overflow-visible">
          <defs>
            <clipPath id={clipAboveId}>
              <rect x={xStart} y="10" width={xWidth} height={zeroY - 10} />
            </clipPath>
            <clipPath id={clipBelowId}>
              <rect x={xStart} y={zeroY} width={xWidth} height="68" />
            </clipPath>
          </defs>

          <line x1={xStart} y1="30" x2={xStart + xWidth} y2="30" stroke="#1E222D" strokeWidth="1" />
          <line x1={xStart} y1={zeroY} x2={xStart + xWidth} y2={zeroY} stroke="#363B4C" strokeWidth="1" />
          <line x1={xStart} y1="118" x2={xStart + xWidth} y2="118" stroke="#1E222D" strokeWidth="1" />

          <text x="32" y="33" textAnchor="end" fill="#787B86" fontSize="9.5" className="font-mono-num">
            {card.yLabels[0]}
          </text>
          <text x="32" y={zeroY + 3} textAnchor="end" fill="#787B86" fontSize="9.5" className="font-mono-num">
            {card.yLabels[1]}
          </text>
          <text x="32" y="121" textAnchor="end" fill="#787B86" fontSize="9.5" className="font-mono-num">
            {card.yLabels[2]}
          </text>

          <polygon points={areaPolygonStr} fill="#143D29" fillOpacity="0.82" clipPath={`url(#${clipAboveId})`} />
          <polygon points={areaPolygonStr} fill="#461B1F" fillOpacity="0.82" clipPath={`url(#${clipBelowId})`} />

          {card.breakevenLabels?.map((be) => {
            const bx = xStart + (be.xPct / 100) * xWidth;
            return (
              <g key={be.label}>
                <line x1={bx} y1="22" x2={bx} y2="128" stroke="#6D7282" strokeWidth="1" />
                <text x={bx} y="17" textAnchor="middle" fill="#9CA3AF" fontSize="9.5" className="font-mono-num">
                  {be.label}
                </text>
              </g>
            );
          })}

          <line x1={spotX} y1="20" x2={spotX} y2="128" stroke="#A4A8B8" strokeWidth="1.2" strokeDasharray="3 3" />

          {targetX !== null && (
            <line x1={targetX} y1="20" x2={targetX} y2="128" stroke="#FFFFFF" strokeWidth="1.6" />
          )}

          <polyline
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={polylineStr}
          />

          {card.xLabels.map((xl, idx) => {
            const xPos = xStart + 22 + (idx / Math.max(1, card.xLabels.length - 1)) * (xWidth - 44);
            return (
              <text
                key={`${xl}-${idx}`}
                x={xPos}
                y="144"
                textAnchor="middle"
                fill="#787B86"
                fontSize="9.5"
                className="font-mono-num"
              >
                {xl}
              </text>
            );
          })}
        </svg>
      </div>

      {/* Métricas Key-Value al pie */}
      <div className="space-y-2 pt-1 text-[13px]">
        <div className="flex items-center justify-between">
          <span className="text-[#9CA3AF]">{card.metrics.label1}</span>
          <span
            className={`font-mono-num font-bold ${
              card.metrics.color1 === 'green' ? 'text-[#22C55E]' : 'text-[#FFFFFF]'
            }`}
          >
            {card.metrics.val1}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[#9CA3AF]">{card.metrics.label2}</span>
          <span
            className={`font-mono-num font-bold ${
              card.metrics.color2 === 'red' ? 'text-[#EF4444]' : 'text-[#FFFFFF]'
            }`}
          >
            {card.metrics.val2}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[#9CA3AF]">{card.metrics.label3}</span>
          <span
            className={`font-mono-num font-bold ${
              card.metrics.color3 === 'green'
                ? 'text-[#22C55E]'
                : card.metrics.color3 === 'red'
                  ? 'text-[#EF4444]'
                  : 'text-[#FFFFFF]'
            }`}
          >
            {card.metrics.val3}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[#9CA3AF]">{card.metrics.label4}</span>
          <span className="font-mono-num font-bold text-[#FFFFFF]">{card.metrics.val4}</span>
        </div>
      </div>

      <div className="pt-2 flex items-center justify-between gap-2">
        {onInspect ? (
          <button
            type="button"
            onClick={() => onInspect(card)}
            className={`px-2.5 py-1 rounded-[7px] border text-[12px] font-semibold transition-colors cursor-pointer ${
              isSelected
                ? 'border-[#38BDF8]/60 bg-[#38BDF8]/15 text-[#38BDF8]'
                : 'border-[#2D3242] bg-[#0B0E14] text-[#9CA3AF] hover:text-white'
            }`}
          >
            {isSelected ? 'En Inspector ✓' : 'Simular What-If'}
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => onExecute(card)}
          className="text-[13.5px] font-bold text-[#FFFFFF] hover:text-[#22C55E] transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <span>Armar esta →</span>
        </button>
      </div>
    </div>
  );
};

function legFromRow(
  row: OptionChainRow,
  type: 'Call' | 'Put',
  side: 'Compra' | 'Venta',
  qty = 10
): BuilderLeg {
  const isCall = type === 'Call';
  const rawPx = isCall ? row.callLast || row.callAsk || row.callBid : row.putLast || row.putAsk || row.putBid;
  const ivPct = isCall ? row.callIV : row.putIV;
  const delta = isCall ? row.callDelta : row.putDelta;
  const theta = isCall ? row.callTheta : row.putTheta;
  return {
    id: `leg-${type.toLowerCase()}-${row.strike}-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    side,
    type,
    strike: row.strike,
    qty,
    premium: Number.isFinite(rawPx) && rawPx > 0 ? +rawPx.toFixed(2) : 0,
    iv: Number.isFinite(ivPct) && ivPct > 0 ? +ivPct.toFixed(1) : 45,
    delta: Number.isFinite(delta) ? +delta.toFixed(2) : isCall ? 0.5 : -0.5,
    theta: Number.isFinite(theta) ? +theta.toFixed(2) : 0,
  };
}

function findAtmIdx(rows: readonly OptionChainRow[], spot: number): number {
  if (rows.length === 0) return -1;
  if (!Number.isFinite(spot) || spot <= 0) return Math.floor(rows.length / 2);
  let bestIdx = 0;
  let bestDist = Infinity;
  rows.forEach((r, i) => {
    const d = Math.abs(r.strike - spot);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  });
  return bestIdx;
}

/* ============================================================================
   CONVERSORES PUROS PARA SIMULADOR PAYOFF WHAT-IF (PIEZA 46)
   ============================================================================ */
function buildWhatIfLegsFromPricedLegs(
  pricedLegs: readonly PricedLeg[],
  defaultDays: number,
  fallbackIvDec: number,
): { readonly legs: readonly WhatIfOptionLeg[]; readonly horizonDte: number } {
  const validDaysList: number[] = [];
  const legs: WhatIfOptionLeg[] = [];
  for (let i = 0; i < pricedLegs.length; i += 1) {
    const leg = pricedLegs[i];
    if (!leg) continue;
    const d = leg.days !== undefined && Number.isFinite(leg.days) && leg.days > 0 ? leg.days : defaultDays;
    if (Number.isFinite(d) && d > 0) validDaysList.push(d);
    const iv =
      Number.isFinite(leg.iv) && leg.iv > 0
        ? leg.iv
        : Number.isFinite(fallbackIvDec) && fallbackIvDec > 0
          ? fallbackIvDec
          : Number.NaN;
    if (!Number.isFinite(leg.K) || leg.K <= 0 || !Number.isFinite(d) || d <= 0 || !Number.isFinite(iv) || !Number.isFinite(leg.premium)) {
      return { legs: [], horizonDte: Math.max(1, Math.round(defaultDays || 1)) };
    }
    legs.push({
      id: `strat-leg-${i}-${leg.type}-${leg.K}`,
      contractType: leg.type === 'C' ? 'call' : 'put',
      strike: leg.K,
      quantity: leg.side * leg.ratio,
      iv,
      timeToExpiry: d / 365,
      entryPrice: leg.premium,
    });
  }
  const horizonDte =
    validDaysList.length > 0
      ? Math.min(...validDaysList)
      : Number.isFinite(defaultDays) && defaultDays > 0
        ? defaultDays
        : 1;
  return { legs, horizonDte };
}

function buildWhatIfLegsFromCreditCandidate(
  candidate: CreditStructureCandidate,
  daysToExpiry: number,
  fallbackIvDec: number,
): readonly WhatIfOptionLeg[] {
  if (!Number.isFinite(daysToExpiry) || daysToExpiry <= 0) return [];
  const legs: WhatIfOptionLeg[] = [];
  for (let i = 0; i < candidate.legs.length; i += 1) {
    const leg = candidate.legs[i];
    if (!leg) continue;
    const iv =
      Number.isFinite(leg.iv) && leg.iv > 0
        ? leg.iv
        : Number.isFinite(fallbackIvDec) && fallbackIvDec > 0
          ? fallbackIvDec
          : Number.NaN;
    if (!Number.isFinite(iv) || iv <= 0 || !Number.isFinite(leg.executionPrice)) return [];
    legs.push({
      id: `cred-leg-${i}-${leg.contractType}-${leg.strike}`,
      contractType: leg.contractType,
      strike: leg.strike,
      quantity: (leg.side === 'BUY' ? 1 : -1) * leg.quantity,
      iv,
      timeToExpiry: daysToExpiry / 365,
      entryPrice: leg.executionPrice,
    });
  }
  return legs;
}

function buildWhatIfLegsFromDebitCell(
  cell: SpreadCellMetric,
  rows: readonly OptionChainRow[],
  daysToExpiry: number,
  fallbackIvDec: number,
): readonly WhatIfOptionLeg[] {
  if (!Number.isFinite(daysToExpiry) || daysToExpiry <= 0) return [];
  const longRow = rows.find((r) => Math.abs(r.strike - cell.longStrike) < 1e-6);
  const shortRow = rows.find((r) => Math.abs(r.strike - cell.shortStrike) < 1e-6);
  const isCall = cell.side === 'CALL';
  const rawLongPx = isCall
    ? longRow?.callAsk && longRow.callAsk > 0
      ? longRow.callAsk
      : longRow?.callLast
    : longRow?.putAsk && longRow.putAsk > 0
      ? longRow.putAsk
      : longRow?.putLast;
  const rawShortPx = isCall
    ? shortRow?.callBid && shortRow.callBid > 0
      ? shortRow.callBid
      : shortRow?.callLast
    : shortRow?.putBid && shortRow.putBid > 0
      ? shortRow.putBid
      : shortRow?.putLast;
  const longIvRaw = isCall ? longRow?.callIV : longRow?.putIV;
  const shortIvRaw = isCall ? shortRow?.callIV : shortRow?.putIV;
  const longIv = longIvRaw && Number.isFinite(longIvRaw) && longIvRaw > 0 ? longIvRaw / 100 : fallbackIvDec;
  const shortIv = shortIvRaw && Number.isFinite(shortIvRaw) && shortIvRaw > 0 ? shortIvRaw / 100 : fallbackIvDec;
  if (!Number.isFinite(longIv) || longIv <= 0 || !Number.isFinite(shortIv) || shortIv <= 0) return [];

  const shortEntry = rawShortPx !== undefined && Number.isFinite(rawShortPx) && rawShortPx >= 0 ? rawShortPx : 0;
  const longEntry =
    rawLongPx !== undefined && Number.isFinite(rawLongPx) && rawLongPx > 0
      ? rawLongPx
      : shortEntry + cell.debit;

  return [
    {
      id: `deb-long-${cell.side}-${cell.longStrike}`,
      contractType: isCall ? 'call' : 'put',
      strike: cell.longStrike,
      quantity: 1,
      iv: longIv,
      timeToExpiry: daysToExpiry / 365,
      entryPrice: longEntry,
    },
    {
      id: `deb-short-${cell.side}-${cell.shortStrike}`,
      contractType: isCall ? 'call' : 'put',
      strike: cell.shortStrike,
      quantity: -1,
      iv: shortIv,
      timeToExpiry: daysToExpiry / 365,
      entryPrice: shortEntry,
    },
  ];
}

/* ============================================================================
   COMPONENTE PRINCIPAL: `OptionsModule`
   ============================================================================ */
type SpreadCellMetric = {
  readonly side: 'CALL' | 'PUT';
  readonly longStrike: number;
  readonly shortStrike: number;
  readonly widthBases: 1 | 2 | 3 | 4;
  readonly widthArs: number;
  readonly debit: number;
  readonly maxProfit: number;
  readonly ratio: number;
  readonly breakeven: number;
  readonly beDistPct: number;
  readonly probBePct: number;
  readonly edgePct: number;
  readonly usesEodRef: boolean;
  readonly bidAskPctOfMid: number;
  readonly liquiditySemaphore: LiquiditySemaphore;
  readonly eligibleForAutoRanking: boolean;
};

type DetailedSpreadRow = {
  readonly base: string;
  readonly strikeNum: number;
  readonly c1: SpreadCellMetric | null;
  readonly c2: SpreadCellMetric | null;
  readonly c3: SpreadCellMetric | null;
  readonly c4: SpreadCellMetric | null;
  readonly p1: SpreadCellMetric | null;
  readonly p2: SpreadCellMetric | null;
  readonly p3: SpreadCellMetric | null;
  readonly p4: SpreadCellMetric | null;
  readonly spotMarkerAfter?: string;
  readonly sigmaMarkerAfter?: string;
};

function buildDetailedSpreadMatrix(
  rows: readonly OptionChainRow[],
  spot: number,
  oneSigmaHigh: number,
  daysToExpiry: number,
  rateDec: number,
  atmIvDec: number,
  filter: 'donde_estoy' | 'cerca' | 'tenencia' | 'todas',
  isUsMarket: boolean,
): readonly DetailedSpreadRow[] {
  if (rows.length < 2) return [];
  const formatStrike = (value: number): string =>
    isUsMarket ? fmtNum(value, 2) : fk(value);
  const formatPriceValue = (value: number, decimals = 2): string =>
    fmtNum(value, isUsMarket ? 2 : decimals);
  const formatSigmaValue = (value: number): string => fmtNum(value, isUsMarket ? 2 : 0);
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const visible = sorted.filter((r) => {
    if (!Number.isFinite(spot) || spot <= 0 || filter === 'todas') return true;
    const dist = Math.abs(r.strike - spot) / spot;
    if (filter === 'donde_estoy') return dist <= 0.08;
    if (filter === 'cerca') return dist <= 0.22;
    return dist <= 0.14;
  });
  const target = visible.length > 0 ? visible : sorted;

  const makeMetric = (
    longRow: OptionChainRow | undefined,
    shortRow: OptionChainRow | undefined,
    side: 'CALL' | 'PUT',
    widthBases: 1 | 2 | 3 | 4,
  ): SpreadCellMetric | null => {
    if (!longRow || !shortRow) return null;
    const result = computeVerticalSpreadMetrics({
      side,
      longLeg: {
        strike: longRow.strike,
        bid: side === 'CALL' ? longRow.callBid : longRow.putBid,
        ask: side === 'CALL' ? longRow.callAsk : longRow.putAsk,
        last: side === 'CALL' ? longRow.callLast : longRow.putLast,
      },
      shortLeg: {
        strike: shortRow.strike,
        bid: side === 'CALL' ? shortRow.callBid : shortRow.putBid,
        ask: side === 'CALL' ? shortRow.callAsk : shortRow.putAsk,
        last: side === 'CALL' ? shortRow.callLast : shortRow.putLast,
      },
      spot,
      daysToExpiry,
      rateDec,
      atmIvDec,
    });
    if (!result.valid) return null;

    return {
      side,
      longStrike: longRow.strike,
      shortStrike: shortRow.strike,
      widthBases,
      widthArs: result.width,
      debit: result.debit,
      maxProfit: result.maxProfit,
      ratio: result.rewardRiskRatio,
      breakeven: result.breakeven,
      beDistPct: result.breakevenDistPct,
      probBePct: result.probAtBreakevenPct,
      edgePct: result.edgePct,
      usesEodRef: result.longUsesEodRef || result.shortUsesEodRef,
      bidAskPctOfMid: result.bidAskPctOfMid,
      liquiditySemaphore: result.liquiditySemaphore,
      eligibleForAutoRanking: result.eligibleForAutoRanking,
    };
  };

  let insertedSpot = false;
  let insertedSigma = false;

  return target.map((row, idx) => {
    const fullIdx = sorted.findIndex((s) => s.strike === row.strike);
    const next = target[idx + 1];
    let spotMarkerAfter: string | undefined;
    if (!insertedSpot && Number.isFinite(spot) && next && row.strike <= spot && next.strike > spot) {
      insertedSpot = true;
      spotMarkerAfter = `SPOT $${formatPriceValue(spot, isUsMarket ? 2 : 1)}`;
    }
    let sigmaMarkerAfter: string | undefined;
    if (
      !insertedSigma &&
      Number.isFinite(oneSigmaHigh) &&
      next &&
      row.strike <= oneSigmaHigh &&
      next.strike > oneSigmaHigh
    ) {
      insertedSigma = true;
      sigmaMarkerAfter = `+1σ ($${formatSigmaValue(oneSigmaHigh)})`;
    }

    return {
      base: formatStrike(row.strike),
      strikeNum: row.strike,
      // Call Bull Spread: Long Call strike bajo -> Short Call k bases más alto
      c1: makeMetric(row, sorted[fullIdx + 1], 'CALL', 1),
      c2: makeMetric(row, sorted[fullIdx + 2], 'CALL', 2),
      c3: makeMetric(row, sorted[fullIdx + 3], 'CALL', 3),
      c4: makeMetric(row, sorted[fullIdx + 4], 'CALL', 4),
      // Put Bear Spread: Long Put strike alto -> Short Put k bases más bajo
      p1: makeMetric(row, sorted[fullIdx - 1], 'PUT', 1),
      p2: makeMetric(row, sorted[fullIdx - 2], 'PUT', 2),
      p3: makeMetric(row, sorted[fullIdx - 3], 'PUT', 3),
      p4: makeMetric(row, sorted[fullIdx - 4], 'PUT', 4),
      ...(spotMarkerAfter !== undefined ? { spotMarkerAfter } : {}),
      ...(sigmaMarkerAfter !== undefined ? { sigmaMarkerAfter } : {}),
    };
  });
}

export const OptionsModule: React.FC<{
  activeSubView: OptionsSubView;
  onSelectSubView: (v: OptionsSubView) => void;
  selectedUnderlying: string;
  onSelectUnderlying: (ticker: string) => void;
  density: 'densa' | 'normal' | 'comoda';
  onOpenOrderTicket: (preset: {
    ticker: string;
    side: 'Compra' | 'Venta';
    price: number;
    qty: number;
    instrumentLabel: string;
  }) => void;
}> = ({
  activeSubView,
  onSelectSubView,
  selectedUnderlying,
  onSelectUnderlying,
  density,
  onOpenOrderTicket,
}) => {
  const liveMarket = useLiveMarketState();
  const selectedUnderlyingKey = parseOptionsUnderlyingKey(selectedUnderlying).key;
  const underlyingMeta = parseOptionsUnderlyingKey(selectedUnderlyingKey);
  const upperUnderlying = underlyingMeta.symbol;
  const isUsMarket = underlyingMeta.market === 'US';
  const optionCurrency = underlyingMeta.currency;
  // Pieza 32: origen del feed de opciones US (Tradier Live + ORATS / Massive + ORATS).
  const usOptionsFeedBadge = useUsOptionsFeedBadge();
  const [symbolSelectorOpen, setSymbolSelectorOpen] = useState(false);

  useEffect(() => {
    void requestOptionsUniverse();
  }, []);

  useEffect(() => {
    void requestOptionsChain(selectedUnderlyingKey);
  }, [selectedUnderlyingKey]);

  // Pieza 36: ORATS se consulta solo al abrir Volatilidad en un subyacente US.
  useEffect(() => {
    if (!isUsMarket || activeSubView !== 'volatilidad') return;
    void requestUsVolSurface(selectedUnderlyingKey);
  }, [activeSubView, isUsMarket, selectedUnderlyingKey]);

  // Pieza 46: catalizadores Earnings + calendario macro FOMC / CPI en subyacentes US.
  useEffect(() => {
    if (!isUsMarket) return;
    void requestOptionsCatalysts(selectedUnderlyingKey);
  }, [isUsMarket, selectedUnderlyingKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSymbolSelectorOpen((v) => !v);
        return;
      }
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        event.preventDefault();
        setSymbolSelectorOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Estado del Header de Opciones
  const [selectedExpiryId, setSelectedExpiryId] = useState<string>('');
  const [expiryDropdownOpen, setExpiryDropdownOpen] = useState(false);
  const [tlrShiftPp, setTlrShiftPp] = useState<number>(0);
  const [showOnboardingBanner, setShowOnboardingBanner] = useState(true);

  // Estado del Módulo 1: Estrategias
  const [strategyMode, setStrategyMode] = useState<'familia' | 'objetivo'>('familia');
  const [selectedFamily, setSelectedFamily] = useState<StrategyFamilyId>('sugeridas');
  const [selectedStrategyInspectorId, setSelectedStrategyInspectorId] = useState<string | null>(null);
  const [marketBias, setMarketBias] = useState<'Alcista' | 'Lateral' | 'Bajista' | 'Se mueve'>('Lateral');
  const [objectiveBias, setObjectiveBias] = useState<
    'Muy bajista' | 'Bajista' | 'Lateral' | 'Se mueve' | 'Alcista' | 'Muy alcista'
  >('Alcista');
  const [targetPrice, setTargetPrice] = useState<number>(Number.NaN);
  const [maxRiskInput, setMaxRiskInput] = useState<string>('sin tope');
  const [probabilityWeight, setProbabilityWeight] = useState<number>(55);
  const [optimizerDir, setOptimizerDir] = useState<'BULLISH' | 'BEARISH'>('BULLISH');

  // Estado del Módulo 2: Spreads (Pieza 46: toggle Débito / Crédito conectado al régimen)
  const [spreadFilter, setSpreadFilter] = useState<'donde_estoy' | 'cerca' | 'tenencia' | 'todas'>('cerca');
  const [spreadViewMode, setSpreadViewMode] = useState<'pares' | 'escalera'>('escalera');
  const [selectedSpreadCell, setSelectedSpreadCell] = useState<SpreadCellMetric | null>(null);
  const [spreadModeOverride, setSpreadModeOverride] = useState<{
    readonly token: string;
    readonly mode: SpreadExecutionMode;
  } | null>(null);
  const [creditKindFilter, setCreditKindFilter] = useState<'ALL' | CreditStructureKind>('ALL');
  const [selectedCreditId, setSelectedCreditId] = useState<string | null>(null);

  // Estado del Módulo 3: Flujo
  const [flowUnit, setFlowUnit] = useState<'lotes' | '$'>('lotes');
  const [flowPeriod, setFlowPeriod] = useState<'hoy' | 'anterior' | 'vencimiento'>('hoy');

  // Estado de Cadena Completa y Armado a Mano
  const [expandedExpiries, setExpandedExpiries] = useState<Record<string, boolean>>({});
  const [colMode, setColMode] = useState<'completa' | 'griegas' | 'valortiempo' | 'liquidez'>('completa');
  const [onlySigmaRange, setOnlySigmaRange] = useState(false);
  const [sigmaMultiplier, setSigmaMultiplier] = useState<1 | 1.5 | 2>(1);
  const [quoteClickTarget, setQuoteClickTarget] = useState<'ticket' | 'armado'>('ticket');
  const [holdingsRefreshTick, setHoldingsRefreshTick] = useState(0);
  const [legs, setLegs] = useState<BuilderLeg[]>([]);
  const [builderSeedKey, setBuilderSeedKey] = useState<string>('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onRefreshHoldings = () => setHoldingsRefreshTick((n) => n + 1);
    window.addEventListener('storage', onRefreshHoldings);
    window.addEventListener('focus', onRefreshHoldings);
    return () => {
      window.removeEventListener('storage', onRefreshHoldings);
      window.removeEventListener('focus', onRefreshHoldings);
    };
  }, []);

  const optionHoldingsMap = useMemo(
    () => readOptionHoldingsFromStorage(),
    [holdingsRefreshTick, activeSubView, upperUnderlying]
  );

  // Sliders de simulación en vivo del Armado a Mano
  const [simSpot, setSimSpot] = useState<number>(Number.NaN);
  const [simDaysLeft, setSimDaysLeft] = useState<number>(30);
  const [simIvShift, setSimIvShift] = useState<number>(0);
  const [simTlr, setSimTlr] = useState<number>(Number.NaN);

  const liveOptions = liveMarket.optionsByUnderlying[selectedUnderlyingKey];
  const liveOptionsExt = liveOptions as
    | (NonNullable<typeof liveOptions> & {
        readonly quantEnginesByExpiry?: Readonly<
          Record<string, NonNullable<typeof liveOptions>['quantEngines']>
        >;
      })
    | undefined;
  const primaryLiquidCode = liveOptions?.primaryLiquidExpiryCode ?? null;
  const contractMultiplier = liveOptions?.lotSize ?? Number.NaN;

  useEffect(() => {
    setSelectedExpiryId('');
    setExpiryDropdownOpen(false);
    setSelectedCreditId(null);
    setSelectedStrategyInspectorId(null);
  }, [upperUnderlying]);

  const catalogStock =
    underlyingMeta.market === 'AR' ? AR_STOCKS.find((s) => s.ticker === upperUnderlying) ?? AR_STOCKS[0] : undefined;
  const overviewStock =
    underlyingMeta.market === 'AR'
      ? liveMarket.overview?.mervalStocks.find((s) => s.ticker === upperUnderlying) ??
        liveMarket.overview?.generalPanelStocks.find((s) => s.ticker === upperUnderlying) ??
        liveMarket.overview?.cedears.find((s) => s.ticker === upperUnderlying)
      : undefined;
  const usMeta = underlyingMeta.market === 'US' ? US_MARKET_DATA.find((u) => u.ticker === upperUnderlying) : undefined;

  const stockName =
    usMeta?.name ??
    overviewStock?.name ??
    catalogStock?.name ??
    liveMarket.optionsUnderlyings.find((u) => u.key === selectedUnderlyingKey)?.name ??
    upperUnderlying;
  const displayDeltaPct =
    usMeta?.deltaPct ?? overviewStock?.deltaPct ?? catalogStock?.deltaPct ?? Number.NaN;
  const usUnderlying = underlyingMeta.market === 'US';
  const liveUnderlyingQuote = useAtomicMarketQuote(usUnderlying ? 'US' : 'AR', upperUnderlying, 250);
  const liveStreamMeta = useMarketStreamMeta(1_000);
  const displaySpot =
    liveUnderlyingQuote !== null &&
    Number.isFinite(liveUnderlyingQuote.price) &&
    liveUnderlyingQuote.price > 0
      ? liveUnderlyingQuote.price
      : liveOptions?.spot ?? overviewStock?.last ?? catalogStock?.last ?? Number.NaN;
  const headerSpot = liveUnderlyingQuote?.price ?? displaySpot;
  const headerDeltaPct = liveUnderlyingQuote?.changePct ?? displayDeltaPct;
  const headerFlash = useLivePriceFlash(liveUnderlyingQuote?.price ?? null);
  const liveClock = liveStreamMeta.isFresh ? getMarketStreamMetaClock(liveStreamMeta) : null;

  const activeExpiry = useMemo(() => {
    if (GGAL_OPTION_EXPIRIES.length === 0) return null;
    return (
      GGAL_OPTION_EXPIRIES.find((e) => e.id === selectedExpiryId) ??
      (primaryLiquidCode ? GGAL_OPTION_EXPIRIES.find((e) => e.id === primaryLiquidCode) : undefined) ??
      GGAL_OPTION_EXPIRIES[0] ??
      null
    );
  }, [selectedExpiryId, primaryLiquidCode, liveMarket.version]);

  const activeQuantEngines = useMemo(() => {
    if (!liveOptionsExt) return null;
    if (
      activeExpiry?.id &&
      liveOptionsExt.quantEnginesByExpiry &&
      Object.prototype.hasOwnProperty.call(liveOptionsExt.quantEnginesByExpiry, activeExpiry.id)
    ) {
      return liveOptionsExt.quantEnginesByExpiry[activeExpiry.id] ?? liveOptionsExt.quantEngines ?? null;
    }
    return liveOptionsExt.quantEngines ?? null;
  }, [liveOptionsExt, activeExpiry?.id]);

  const liveTlrPct =
    liveOptions?.rateTna ??
    liveMarket.macro?.variables.badlarTna ??
    liveMarket.macro?.variables.tamarTna ??
    null;
  const effectiveTlrPct =
    liveTlrPct !== null && Number.isFinite(liveTlrPct)
      ? Math.max(0, liveTlrPct + tlrShiftPp)
      : Number.NaN;
  const effectiveRateDec =
    tlrShiftPp === 0 && liveOptions?.continuousRate !== null && liveOptions?.continuousRate !== undefined
      ? liveOptions.continuousRate
      : Number.isFinite(effectiveTlrPct)
        ? Math.log(1 + effectiveTlrPct / 100)
        : Number.NaN;

  const labMarket = useMemo(() => {
    const days = activeExpiry?.daysToExpiry ?? 0;
    const strikes = activeExpiry?.rows.map((r) => r.strike);
    return makeMarket(
      upperUnderlying,
      displaySpot,
      days,
      effectiveRateDec,
      activeExpiry?.label ?? '—',
      activeExpiry?.id ?? '—',
      strikes,
      isUsMarket ? 'US' : 'AR',
    );
  }, [upperUnderlying, displaySpot, activeExpiry, effectiveRateDec, isUsMarket]);

  // Sincronizar targetPrice, simSpot, simDaysLeft, simTlr y patas iniciales reales al cambiar subyacente / llegar cadena
  useEffect(() => {
    if (Number.isFinite(displaySpot) && displaySpot > 0) {
      setTargetPrice((prev) =>
        Number.isFinite(prev) && prev > 0 && builderSeedKey.startsWith(`${upperUnderlying}:`)
          ? prev
          : Math.round(displaySpot * 1.1)
      );
      setSimSpot((prev) =>
        Number.isFinite(prev) && prev > 0 && builderSeedKey.startsWith(`${upperUnderlying}:`)
          ? prev
          : Math.round(displaySpot)
      );
    }
  }, [displaySpot, upperUnderlying, builderSeedKey]);

  useEffect(() => {
    if (activeExpiry) {
      setSimDaysLeft(Math.max(1, activeExpiry.daysToExpiry));
    }
  }, [activeExpiry?.id]);

  useEffect(() => {
    if (Number.isFinite(effectiveTlrPct)) {
      setSimTlr(effectiveTlrPct);
    }
  }, [effectiveTlrPct]);

  useEffect(() => {
    if (!activeExpiry || activeExpiry.rows.length === 0) return;
    const seedToken = `${upperUnderlying}:${activeExpiry.id}`;
    if (builderSeedKey === seedToken) return;
    const rows = activeExpiry.rows;
    const atmI = findAtmIdx(rows, displaySpot);
    const r0 = rows[atmI] ?? rows[0];
    const r1 = rows[Math.min(rows.length - 1, Math.max(0, atmI + 1))] ?? r0;
    if (r0 && r1) {
      setLegs([
        legFromRow(r0, 'Call', 'Compra', 10),
        ...(r1.strike !== r0.strike ? [legFromRow(r1, 'Call', 'Venta', 10)] : []),
      ]);
      setBuilderSeedKey(seedToken);
    }
  }, [activeExpiry, upperUnderlying, displaySpot, builderSeedKey]);

  const loadIntoBuilder = (pricedLegs: PricedLeg[], units: number) => {
    setLegs(
      pricedLegs.map((l, i) => ({
        id: `lab-${Date.now()}-${i}`,
        side: l.side > 0 ? 'Compra' : 'Venta',
        type: l.type === 'C' ? 'Call' : 'Put',
        strike: l.K,
        qty: l.ratio * units,
        premium: Number.isFinite(l.premium) ? l.premium : 0,
        iv: Number.isFinite(l.iv) ? +(l.iv * 100).toFixed(1) : 45,
        delta: Number.isFinite(l.delta) ? +l.delta.toFixed(2) : 0,
        theta: Number.isFinite(l.thetaDay) ? +l.thetaDay.toFixed(2) : 0,
      }))
    );
    setBuilderSeedKey(`${upperUnderlying}:custom`);
    onSelectSubView('armado');
  };

  // Header 1-sigma, VI ATM y TIR sintética sincronizados al vencimiento seleccionado
  // Pieza 46.1: DTE calendario ET (0 = 0DTE). `activeDays` conserva un piso intradiario real
  // (horas hasta el cierre 16:00 ET) para que T nunca sea 0 en las fórmulas de tiempo.
  const activeDte = activeExpiry?.daysToExpiry ?? Number.NaN;
  const activeDays =
    activeExpiry === undefined || activeExpiry === null
      ? 0
      : activeExpiry.daysToExpiry > 0
        ? activeExpiry.daysToExpiry
        : Math.max(
            Number.isFinite(hoursToCloseEt(Date.now())) ? hoursToCloseEt(Date.now()) / 24 : 0,
            0.25 / 24,
          );
  const isZeroDte = activeDte === 0;
  const activeVolSuite = useMemo(
    () =>
      resolveActiveVolAnalyticsSuite({
        liveOptions,
        liveQuantEngines: activeQuantEngines,
        usSnapshot: liveMarket.usSnapshotsBySymbol[upperUnderlying],
      }),
    [liveOptions, activeQuantEngines, liveMarket.usSnapshotsBySymbol, upperUnderlying],
  );
  const activeVolSuiteExpiry = useMemo(
    () => resolveExpiryVolSuite(activeVolSuite, activeExpiry?.id ?? null),
    [activeVolSuite, activeExpiry?.id],
  );
  const activeAtmIvDec = useMemo(() => {
    if (activeExpiry && Number.isFinite(activeExpiry.atmIV) && activeExpiry.atmIV > 0) {
      return activeExpiry.atmIV / 100;
    }
    const suiteAtmOtm = activeVolSuiteExpiry?.smileOtmOnly.atmIvPct;
    if (suiteAtmOtm !== null && suiteAtmOtm !== undefined && Number.isFinite(suiteAtmOtm) && suiteAtmOtm > 0) {
      return suiteAtmOtm / 100;
    }
    const suiteAtmAll = activeVolSuiteExpiry?.smileAll.atmIvPct;
    if (suiteAtmAll !== null && suiteAtmAll !== undefined && Number.isFinite(suiteAtmAll) && suiteAtmAll > 0) {
      return suiteAtmAll / 100;
    }
    if (activeExpiry && activeExpiry.rows.length > 0 && Number.isFinite(displaySpot) && displaySpot > 0) {
      const sortedNear = [...activeExpiry.rows]
        .sort((a, b) => Math.abs(a.strike - displaySpot) - Math.abs(b.strike - displaySpot))
        .slice(0, 2);
      const nearIvs: number[] = [];
      for (const r of sortedNear) {
        if (r.strike >= displaySpot - 1e-6 && Number.isFinite(r.callIV) && r.callIV > 0 && r.callIV < 999) {
          nearIvs.push(r.callIV / 100);
        }
        if (r.strike <= displaySpot + 1e-6 && Number.isFinite(r.putIV) && r.putIV > 0 && r.putIV < 999) {
          nearIvs.push(r.putIV / 100);
        }
      }
      if (nearIvs.length > 0) {
        return nearIvs.reduce((acc, v) => acc + v, 0) / nearIvs.length;
      }
    }
    const termIv = activeDays > 0 ? atmIv(activeDays) : Number.NaN;
    return Number.isFinite(termIv) && termIv > 0 ? termIv : Number.NaN;
  }, [activeExpiry, activeVolSuiteExpiry, displaySpot, activeDays]);

  const activeParity = activeVolSuiteExpiry?.parity ?? null;
  const isHeaderTirBlockedShortDte =
    (activeDays > 0 && activeDays < 3) ||
    activeParity?.impliedRateStatus === 'BLOCKED_SHORT_DTE' ||
    (activeQuantEngines?.syntheticRates as { readonly impliedRateStatus?: string } | null | undefined)
      ?.impliedRateStatus === 'BLOCKED_SHORT_DTE';
  const headerImpliedTirPct = useMemo(() => {
    if (isHeaderTirBlockedShortDte) {
      return Number.NaN;
    }
    if (
      activeParity?.medianMidTeaPct !== null &&
      activeParity?.medianMidTeaPct !== undefined &&
      Number.isFinite(activeParity.medianMidTeaPct)
    ) {
      return activeParity.medianMidTeaPct;
    }
    const synthTna = activeQuantEngines?.syntheticRates?.medianImpliedTna;
    if (synthTna !== null && synthTna !== undefined && Number.isFinite(synthTna)) {
      return synthTna * 100;
    }
    return Number.NaN;
  }, [isHeaderTirBlockedShortDte, activeParity, activeQuantEngines]);
  const headerOneSigmaAbs =
    Number.isFinite(displaySpot) &&
    displaySpot > 0 &&
    Number.isFinite(activeAtmIvDec) &&
    activeAtmIvDec > 0 &&
    activeDays > 0
      ? displaySpot * activeAtmIvDec * Math.sqrt(activeDays / 365)
      : (liveOptions?.exposureSummary?.expectedMoveAbs ?? Number.NaN);
  const headerOneSigmaPct =
    Number.isFinite(headerOneSigmaAbs) && Number.isFinite(displaySpot) && displaySpot > 0
      ? (headerOneSigmaAbs / displaySpot) * 100
      : Number.NaN;

  const targetSuggestedPct =
    Number.isFinite(targetPrice) && Number.isFinite(displaySpot) && displaySpot > 0
      ? (((targetPrice - displaySpot) / displaySpot) * 100).toFixed(1).replace('.', ',')
      : '—';

  // Derivados dinámicos reales
  const { cards: visiblePayoffCards, rows: comparisonRows } = useMemo(
    () =>
      buildLiveStrategyCardsAndRows(labMarket, {
        strategyMode,
        selectedFamily,
        marketBias,
        targetPrice,
      }),
    [labMarket, strategyMode, selectedFamily, marketBias, targetPrice]
  );

  const detailedSpreadRows: readonly DetailedSpreadRow[] = useMemo(
    () =>
      buildDetailedSpreadMatrix(
        activeExpiry?.rows ?? [],
        displaySpot,
        activeExpiry?.oneSigmaHigh ?? Number.NaN,
        activeDays,
        effectiveRateDec,
        activeAtmIvDec,
        spreadFilter,
        isUsMarket,
      ),
    [activeExpiry, displaySpot, activeDays, effectiveRateDec, activeAtmIvDec, spreadFilter, isUsMarket, liveMarket.version],
  );

  const spreadSummaryStats = useMemo(() => {
    const allCells: SpreadCellMetric[] = [];
    for (const r of detailedSpreadRows) {
      for (const c of [r.c1, r.c2, r.c3, r.c4, r.p1, r.p2, r.p3, r.p4]) {
        if (c !== null && c.eligibleForAutoRanking && c.debit >= 0.1 - 1e-12) {
          allCells.push(c);
        }
      }
    }
    const callCells = allCells.filter((c) => c.side === 'CALL').sort((a, b) => b.ratio - a.ratio);
    const putCells = allCells.filter((c) => c.side === 'PUT').sort((a, b) => b.ratio - a.ratio);
    const bestEdgeCell = [...allCells]
      .filter((c) => Number.isFinite(c.edgePct))
      .sort((a, b) => b.edgePct - a.edgePct)[0] ?? null;
    return {
      totalValid: allCells.length,
      bestCall: callCells[0] ?? null,
      bestPut: putCells[0] ?? null,
      bestEdgeCell,
      focusedCell: selectedSpreadCell ?? bestEdgeCell ?? callCells[0] ?? putCells[0] ?? null,
    };
  }, [detailedSpreadRows, selectedSpreadCell]);

  // Pieza 46: Régimen activo -> preselección Crédito / Débito + ranking de Credit Spreads & Iron Condors
  const activeDividendYield =
    liveOptions && activeDays >= 3 && Number.isFinite(liveOptions.dividendYield)
      ? liveOptions.dividendYield
      : 0;

  // Pieza 46.1: circuit breaker de venta de prima (dte <= 1 o Short Gamma bajo el Put Wall).
  const shortPremiumBreaker = useMemo(
    () =>
      evaluateShortPremiumBreaker({
        dte: activeDte,
        spot: displaySpot,
        putWall: liveOptions?.exposureSummary?.putWallStrike ?? activeQuantEngines?.flowAdjustedGex?.putWallStrike ?? null,
        netGex: liveOptions?.exposureSummary?.netGex ?? Number.NaN,
      }),
    [activeDte, displaySpot, liveOptions?.exposureSummary, activeQuantEngines?.flowAdjustedGex],
  );

  const baseRegimeCode = useMemo(() => {
    const precomputed = (
      activeVolSuiteExpiry as
        | { readonly activeExpiryVrp?: { readonly operativeRegime?: { readonly code?: string } } }
        | null
        | undefined
    )?.activeExpiryVrp?.operativeRegime?.code;
    if (
      precomputed === 'VENTA_PRIMA_CUBIERTA' ||
      precomputed === 'COMPRA_CONVEXIDAD_CALENDAR' ||
      precomputed === 'NEUTRAL_SELECTIVO' ||
      precomputed === 'NO_SHORT_PREMIUM_RISK' ||
      precomputed === 'NO_DATA'
    ) {
      return precomputed;
    }
    const rv23 = activeVolSuite?.historicalConditional?.latestRv23Pct;
    const rv20 = activeVolSuite?.historicalConditional?.latestRv20Pct ?? liveOptions?.realizedVol20d;
    const ivPct = Number.isFinite(activeAtmIvDec) && activeAtmIvDec > 0 ? activeAtmIvDec * 100 : null;
    const rvRef =
      rv23 !== null && rv23 !== undefined && Number.isFinite(rv23) && rv23 > 0
        ? rv23
        : rv20 !== null && rv20 !== undefined && Number.isFinite(rv20) && rv20 > 0
          ? rv20
          : null;
    if (ivPct === null && rvRef === null) return 'NO_DATA' as const;
    return computeActiveExpiryVrpAndRegime({
      expiryCode: activeExpiry?.id ?? null,
      daysToExpiry: Number.isFinite(activeDte) ? activeDte : activeDays,
      ivAtmActiveExpiryPct: ivPct,
      sameExpiryFallbackIvAtmPct: ivPct,
      rvReferencePct: rvRef,
      rvReferenceLabel:
        rv23 !== null && rv23 !== undefined && Number.isFinite(rv23) ? 'RV23d' : 'RV20d',
      historicalRvSeriesPct: [],
      spot: displaySpot,
      putWallStrike:
        liveOptions?.exposureSummary?.putWallStrike ??
        activeQuantEngines?.flowAdjustedGex?.putWallStrike ??
        null,
      netGex: liveOptions?.exposureSummary?.netGex ?? null,
    }).operativeRegime.code;
  }, [
    activeVolSuiteExpiry,
    activeVolSuite,
    liveOptions,
    activeAtmIvDec,
    activeExpiry?.id,
    activeDte,
    activeDays,
    displaySpot,
    activeQuantEngines?.flowAdjustedGex?.putWallStrike,
  ]);

  const activeRegimeCode =
    shortPremiumBreaker.blocked && baseRegimeCode === 'VENTA_PRIMA_CUBIERTA'
      ? ('NO_SHORT_PREMIUM_RISK' as const)
      : baseRegimeCode;

  const spreadModeToken = `${upperUnderlying}:${activeExpiry?.id ?? ''}`;
  const autoSpreadMode: SpreadExecutionMode = useMemo(
    () =>
      shortPremiumBreaker.autoSelectCreditMode
        ? resolveDefaultSpreadModeFromRegime(activeRegimeCode)
        : 'DEBIT',
    [activeRegimeCode, shortPremiumBreaker.autoSelectCreditMode],
  );
  const activeSpreadMode: SpreadExecutionMode =
    spreadModeOverride?.token === spreadModeToken ? spreadModeOverride.mode : autoSpreadMode;

  const activeBlDensityNodes = useMemo(() => {
    // Pieza 46.1: serie suavizada exclusivamente (filtro iv/bid/spread -> PCHIP en w(k) -> grilla uniforme
    // proporcional a expectedMove -> max(0, pdf) -> área = 1). Sin fallback a densidad cruda.
    if (
      !activeExpiry ||
      activeExpiry.rows.length < 5 ||
      !Number.isFinite(displaySpot) ||
      displaySpot <= 0 ||
      activeDays <= 0 ||
      !Number.isFinite(effectiveRateDec) ||
      !Number.isFinite(activeAtmIvDec) ||
      activeAtmIvDec <= 0
    ) {
      return [];
    }
    const nodes: { strike: number; iv: number | null; bid: number; ask?: number }[] = [];
    for (const r of activeExpiry.rows) {
      const isCall = r.strike >= displaySpot;
      const ivPct = isCall ? r.callIV : r.putIV;
      const bid = isCall ? r.callBid : r.putBid;
      const ask = isCall ? r.callAsk : r.putAsk;
      nodes.push({
        strike: r.strike,
        iv: Number.isFinite(ivPct) && ivPct > 0 ? ivPct / 100 : null,
        bid,
        ...(Number.isFinite(ask) ? { ask } : {}),
      });
    }
    const tYears = activeDays / 365;
    const extracted = buildHardenedBlDensity({
      spot: displaySpot,
      rate: effectiveRateDec,
      dividendYield: activeDividendYield,
      timeToExpiry: tYears,
      dte: Number.isFinite(activeDte) ? activeDte : activeDays,
      expectedMove: displaySpot * activeAtmIvDec * Math.sqrt(Math.max(tYears, 1 / (252 * 6.5))),
      nodes,
    });
    return extracted.status === 'OK' ? extracted.nodes : [];
  }, [activeExpiry, displaySpot, activeDays, activeDte, effectiveRateDec, activeDividendYield, activeAtmIvDec]);

  const creditRankingResult = useMemo(() => {
    const quotes: CreditOptionQuoteInput[] = [];
    for (const row of activeExpiry?.rows ?? []) {
      if (!Number.isFinite(row.strike) || row.strike <= 0) continue;
      if (Number.isFinite(row.callBid) && Number.isFinite(row.callAsk) && row.callBid > 0 && row.callAsk >= row.callBid) {
        quotes.push({
          strike: row.strike,
          contractType: 'call',
          bid: row.callBid,
          ask: row.callAsk,
          ...(Number.isFinite(row.callIV) && row.callIV > 0 ? { iv: row.callIV / 100 } : {}),
          ...(Number.isFinite(row.callDelta) ? { delta: row.callDelta } : {}),
          ...(Number.isFinite(row.callGamma) ? { gamma: row.callGamma } : {}),
          ...(Number.isFinite(row.callTheta) ? { thetaDaily: row.callTheta } : {}),
          ...(Number.isFinite(row.callVega) ? { vegaPer1Pct: row.callVega } : {}),
        });
      }
      if (Number.isFinite(row.putBid) && Number.isFinite(row.putAsk) && row.putBid > 0 && row.putAsk >= row.putBid) {
        quotes.push({
          strike: row.strike,
          contractType: 'put',
          bid: row.putBid,
          ask: row.putAsk,
          ...(Number.isFinite(row.putIV) && row.putIV > 0 ? { iv: row.putIV / 100 } : {}),
          ...(Number.isFinite(row.putDelta) ? { delta: row.putDelta } : {}),
          ...(Number.isFinite(row.putGamma) ? { gamma: row.putGamma } : {}),
          ...(Number.isFinite(row.putTheta) ? { thetaDaily: row.putTheta } : {}),
          ...(Number.isFinite(row.putVega) ? { vegaPer1Pct: row.putVega } : {}),
        });
      }
    }
    return rankCreditStructures({
      spot: displaySpot,
      daysToExpiry: activeDays,
      rate: effectiveRateDec,
      dividendYield: activeDividendYield,
      atmIv: activeAtmIvDec,
      lotSize: Number.isFinite(contractMultiplier) && contractMultiplier > 0 ? contractMultiplier : LOT,
      contracts: quotes,
      densityNodes: activeBlDensityNodes,
      operativeRegimeCode: activeRegimeCode,
    });
  }, [
    activeExpiry?.rows,
    displaySpot,
    activeDays,
    effectiveRateDec,
    activeDividendYield,
    activeAtmIvDec,
    contractMultiplier,
    activeBlDensityNodes,
    activeRegimeCode,
  ]);

  const focusedCreditCandidate: CreditStructureCandidate | null = useMemo(() => {
    const list = creditRankingResult.allCandidates;
    if (selectedCreditId !== null) {
      const hit = list.find((c) => c.id === selectedCreditId);
      if (hit) return hit;
    }
    return (
      creditRankingResult.bestIronCondor ??
      creditRankingResult.bestBullPut ??
      creditRankingResult.bestBearCall ??
      list[0] ??
      null
    );
  }, [creditRankingResult, selectedCreditId]);

  const catalystWindow = useMemo(() => {
    const rawCat = isUsMarket ? liveMarket.optionsCatalystsBySymbol[upperUnderlying] ?? null : null;
    const activeExpDto = liveOptions?.expiries.find((e) => e.expiryCode === activeExpiry?.id);
    const activeExpUtcSec =
      activeExpDto && Number.isFinite(activeExpDto.expiryUtcSec) && activeExpDto.expiryUtcSec > 0
        ? activeExpDto.expiryUtcSec
        : liveOptions?.asOfUtcSec && activeDays > 0
          ? liveOptions.asOfUtcSec + Math.round(activeDays * 86_400)
          : null;
    const nowSec = rawCat?.asOfUtcSec ?? liveOptions?.asOfUtcSec ?? Math.floor(Date.now() / 1_000);
    return evaluateCatalystWindow({
      asOfUtcSec: nowSec,
      activeExpiryUtcSec: activeExpUtcSec,
      nextEarnings: rawCat?.nextEarnings ?? null,
      lastEarnings: rawCat?.lastEarnings ?? null,
      macroEvents: rawCat?.macroEvents ?? [],
    });
  }, [
    isUsMarket,
    liveMarket.optionsCatalystsBySymbol,
    upperUnderlying,
    liveOptions,
    activeExpiry?.id,
    activeDays,
  ]);

  const { forwardIvSegments, forwardSegmentByFarCode } = useMemo(() => {
    const localSegments = computeForwardIvTermStructure(
      GGAL_OPTION_EXPIRIES.filter((e) => e.daysToExpiry > 0 && Number.isFinite(e.atmIV) && e.atmIV > 0).map(
        (e) => ({
          expiryCode: e.id,
          dte: e.daysToExpiry,
          timeToExpiry: e.daysToExpiry / 365,
          atmIv: e.atmIV / 100,
        }),
      ),
    );
    const map = new Map<string, ForwardIvSegmentResult>();
    for (const seg of localSegments) {
      if (seg.farExpiryCode) map.set(seg.farExpiryCode, seg);
    }
    for (const srvSeg of liveOptions?.forwardIvSegments ?? []) {
      if (srvSeg.farExpiryCode && !map.has(srvSeg.farExpiryCode)) {
        map.set(srvSeg.farExpiryCode, {
          nearExpiryCode: srvSeg.nearExpiryCode,
          farExpiryCode: srvSeg.farExpiryCode,
          nearExpirySec: srvSeg.nearExpirySec,
          farExpirySec: srvSeg.farExpirySec,
          nearDte: srvSeg.nearDte,
          farDte: srvSeg.farDte,
          nearTimeToExpiry: srvSeg.nearTimeToExpiry,
          farTimeToExpiry: srvSeg.farTimeToExpiry,
          nearIv: srvSeg.nearIv ?? Number.NaN,
          farIv: srvSeg.farIv ?? Number.NaN,
          forwardVariance: srvSeg.forwardVariance ?? Number.NaN,
          forwardIv: srvSeg.forwardIv,
          calendarArbFlag: srvSeg.calendarArbFlag,
          status: srvSeg.status,
        });
      }
    }
    return {
      forwardIvSegments: localSegments,
      forwardSegmentByFarCode: map,
    };
  }, [liveOptions?.forwardIvSegments, liveMarket.version]);

  const dealerGammaReport = useMemo(() => {
    const expSum = liveOptions?.exposureSummary ?? null;
    if (!expSum || expSum.netGex === null || !Number.isFinite(expSum.netGex)) {
      return classifyDealerGammaRegimeFromSummary({
        spot: displaySpot,
        netGex: Number.NaN,
        callWallStrike: Number.NaN,
        putWallStrike: Number.NaN,
        gammaFlipSpot: Number.NaN,
        usableContracts: 0,
        usableOpenInterest: 0,
      });
    }
    const inferredOiFromStrikes = (expSum.byStrike ?? []).reduce(
      (acc, s) =>
        acc +
        (s.callOi !== null && Number.isFinite(s.callOi) ? s.callOi : 0) +
        (s.putOi !== null && Number.isFinite(s.putOi) ? s.putOi : 0),
      0,
    );
    const inferredContractsFromStrikes = (expSum.byStrike ?? []).filter(
      (s) => (s.callOi ?? 0) > 0 || (s.putOi ?? 0) > 0,
    ).length;
    const usableContracts = expSum.quality?.usableContracts ?? inferredContractsFromStrikes;
    const usableOpenInterest = expSum.quality?.usableOpenInterest ?? inferredOiFromStrikes;
    const flipStatus =
      expSum.gammaFlipStatus === 'unique' ||
      expSum.gammaFlipStatus === 'no_crossing' ||
      expSum.gammaFlipStatus === 'multiple_crossings' ||
      expSum.gammaFlipStatus === 'indeterminate'
        ? expSum.gammaFlipStatus
        : null;
    return classifyDealerGammaRegimeFromSummary({
      spot: displaySpot,
      netGex: expSum.netGex,
      callWallStrike: expSum.callWallStrike ?? activeQuantEngines?.flowAdjustedGex?.callWallStrike ?? Number.NaN,
      putWallStrike: expSum.putWallStrike ?? activeQuantEngines?.flowAdjustedGex?.putWallStrike ?? Number.NaN,
      gammaFlipSpot: expSum.gammaFlipSpot ?? Number.NaN,
      gammaFlipStatus: flipStatus,
      usableContracts,
      usableOpenInterest,
    });
  }, [liveOptions?.exposureSummary, displaySpot, activeQuantEngines?.flowAdjustedGex]);

  const exposureByStrikeMap = useMemo(() => {
    const map = new Map<
      number,
      {
        readonly callGex: number | null;
        readonly putGex: number | null;
        readonly netGex: number | null;
        readonly callOi: number | null;
        readonly putOi: number | null;
      }
    >();
    for (const s of liveOptions?.exposureSummary?.byStrike ?? []) {
      map.set(s.strike, {
        callGex: s.callGex,
        putGex: s.putGex,
        netGex: s.netGex,
        callOi: s.callOi,
        putOi: s.putOi,
      });
    }
    return map;
  }, [liveOptions?.exposureSummary?.byStrike]);

  const focusedStrategyCard = useMemo(() => {
    if (visiblePayoffCards.length === 0) return null;
    if (selectedStrategyInspectorId !== null) {
      const hit = visiblePayoffCards.find((c) => c.id === selectedStrategyInspectorId);
      if (hit) return hit;
    }
    return visiblePayoffCards[0] ?? null;
  }, [visiblePayoffCards, selectedStrategyInspectorId]);

  const activeTickAggression = useMemo(() => {
    type AgresionTicksShape = {
      readonly askPct: number | null;
      readonly bidPct: number | null;
      readonly neutralPct: number | null;
      readonly netBiasPct: number | null;
      readonly direction: 'COMPRADOR' | 'VENDEDOR' | 'EQUILIBRADO';
      readonly label: string;
      readonly totalNotional: number | null;
      readonly classifiedContracts: number | null;
      readonly method: 'LEE_READY_BBO' | 'TICK_VARIATION_EOD';
    };
    const qeExt = activeQuantEngines as
      | (NonNullable<typeof activeQuantEngines> & {
          readonly agresionTicks?: AgresionTicksShape | null;
        })
      | null;
    if (qeExt?.agresionTicks) return qeExt.agresionTicks;
    const flowExt = qeExt?.orderFlowArs as
      | (NonNullable<NonNullable<typeof activeQuantEngines>['orderFlowArs']> & {
          readonly agresionTicks?: AgresionTicksShape | null;
        })
      | null
      | undefined;
    if (flowExt?.agresionTicks) return flowExt.agresionTicks;
    const rawUsSnap = liveMarket.usSnapshotsBySymbol[upperUnderlying];
    const usTe = rawUsSnap?.terminalEngines as
      | (NonNullable<NonNullable<typeof rawUsSnap>['terminalEngines']> & {
          readonly agresionTicks?: AgresionTicksShape | null;
        })
      | null
      | undefined;
    return usTe?.agresionTicks ?? null;
  }, [activeQuantEngines, liveMarket.usSnapshotsBySymbol, upperUnderlying]);

  const flowSummary = useMemo(
    () =>
      buildBidirectionalFlow(activeExpiry?.rows ?? [], displaySpot, flowUnit, {
        market: underlyingMeta.market,
        contractMultiplier,
      }),
    [activeExpiry, displaySpot, flowUnit, underlyingMeta.market, contractMultiplier, liveMarket.version]
  );

  const builderAnalytics = useMemo(
    () =>
      computeBuilderAnalytics(
        legs,
        simSpot,
        simDaysLeft,
        simIvShift,
        simTlr,
        displaySpot,
        activeExpiry?.daysToExpiry ?? 30,
        activeExpiry?.rows ?? []
      ),
    [legs, simSpot, simDaysLeft, simIvShift, simTlr, displaySpot, activeExpiry, liveMarket.version]
  );

  const formatStrike = (value: number): string =>
    isUsMarket ? fmtNum(value, 2) : fk(value);
  const formatPrice = (value: number, decimals = 2): string =>
    fmtNum(value, isUsMarket ? 2 : decimals);
  const formatSigma = (value: number): string => fmtNum(value, isUsMarket ? 2 : 0);

  const subViews: { id: OptionsSubView; label: string; icon: React.ReactNode }[] = [
    { id: 'mapa', label: 'Mapa', icon: <MapIcon className="w-3.5 h-3.5" /> },
    { id: 'estrategias', label: 'Estrategias', icon: <TrendingUp className="w-3.5 h-3.5" /> },
    { id: 'spreads', label: 'Spreads', icon: <Grid className="w-3.5 h-3.5" /> },
    { id: 'flujo', label: 'Flujo', icon: <BarChart3 className="w-3.5 h-3.5" /> },
    { id: 'cadena', label: 'Cadena completa', icon: <Layers className="w-3.5 h-3.5" /> },
    { id: 'volatilidad', label: 'Volatilidad', icon: <Activity className="w-3.5 h-3.5" /> },
    { id: 'armado', label: 'Armado a mano', icon: <Wrench className="w-3.5 h-3.5" /> },
  ];

  const getSpreadPillColor = (val: number) => {
    if (!Number.isFinite(val)) return 'bg-[#181C27] text-[#6D7282] border border-[#232733]';
    if (val <= 1.55) return 'bg-[#113523] text-[#4ADE80] border border-[#1E5638]';
    if (val <= 2.18) return 'bg-[#362E14] text-[#FACC15] border border-[#5A4B1C]';
    return 'bg-[#3B181C] text-[#F87171] border border-[#64252C]';
  };

  const syncTimeLabel = liveOptions?.asOfUtcSec
    ? new Date(liveOptions.asOfUtcSec * 1000).toLocaleTimeString('es-AR')
    : liveMarket.lastSyncUtcSec
      ? new Date(liveMarket.lastSyncUtcSec * 1000).toLocaleTimeString('es-AR')
      : '—';

  const builderRows = activeExpiry?.rows ?? [];
  const atmBuilderIdx = findAtmIdx(builderRows, displaySpot);
  const availableStrikes =
    builderRows.length > 0
      ? builderRows.map((r) => r.strike)
      : labMarket.strikes;

  const addLegFromAtmOffset = (type: 'Call' | 'Put', offset: number) => {
    const idx = Math.min(Math.max(0, atmBuilderIdx + offset), Math.max(0, builderRows.length - 1));
    const row = builderRows[idx];
    if (row) {
      setLegs((prev) => [...prev, legFromRow(row, type, 'Compra', 10)]);
      return;
    }
    const baseStrike =
      availableStrikes[Math.floor(availableStrikes.length / 2)] ??
      (Number.isFinite(displaySpot) ? Math.round(displaySpot) : 0);
    setLegs((prev) => [
      ...prev,
      {
        id: `leg-${type}-${Date.now()}`,
        side: 'Compra',
        type,
        strike: baseStrike,
        qty: 10,
        premium: 0,
        iv: Number.isFinite(activeAtmIvDec) ? +(activeAtmIvDec * 100).toFixed(1) : 45,
        delta: type === 'Call' ? 0.5 : -0.5,
        theta: 0,
      },
    ]);
  };

  const simSliderMin =
    Number.isFinite(displaySpot) && displaySpot > 0 ? Math.max(1, Math.round(displaySpot * 0.72)) : 100;
  const simSliderMax =
    Number.isFinite(displaySpot) && displaySpot > 0 ? Math.round(displaySpot * 1.32) : 10000;
  const simSliderStep =
    Number.isFinite(displaySpot) && displaySpot > 0 ? Math.max(1, Math.round(displaySpot * 0.005)) : 10;

  return (
    <div className="space-y-5 animate-module">
      {/* =====================================================================
          1. HEADER DEL ACTIVO SUBYACENTE Y DATOS CLAVE
          ===================================================================== */}
      <div className="rounded-[12px] bg-[#0D1017] border border-[#1E222D] px-5 py-3.5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-3">
              <CompanyLogo ticker={upperUnderlying} name={stockName} size="lg" />
              <div>
                <button
                  type="button"
                  onClick={() => setSymbolSelectorOpen(true)}
                  title="Selector de subyacente · Ctrl+K o /"
                  className="group inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 -mx-1 hover:bg-[#161A25] transition-colors cursor-pointer"
                >
                  <span className="text-[20px] font-extrabold text-[#FFFFFF] tracking-tight">
                    {upperUnderlying}
                  </span>
                  <span className="rounded-full border border-[#232733] bg-[#0B0E14] px-1.5 py-0.5 font-mono-num text-[10px] font-semibold text-[#9CA3AF]">
                    {underlyingMeta.market} · {underlyingMeta.venue}
                  </span>
                  <ChevronDown className="w-4 h-4 text-[#9CA3AF] transition-colors group-hover:text-white" />
                </button>
                <div className="text-[12px] text-[#787B86] leading-none">{stockName}</div>
              </div>
            </div>

            <div className="flex flex-col">
              <span className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                ÚLTIMO
              </span>
              <div className="flex flex-wrap items-baseline gap-2.5">
                <span
                  className={`rounded px-1 font-mono-num tabular-nums text-[22px] font-extrabold tracking-tight ${
                    !Number.isFinite(headerDeltaPct)
                      ? 'text-[#FFFFFF]'
                      : headerDeltaPct < 0
                        ? 'text-[#F23645]'
                        : 'text-[#22C55E]'
                  }`}
                  style={{
                    backgroundColor: headerFlash === null ? 'transparent' : headerFlash === 'up' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                  }}
                >
                  {fmtNum(headerSpot, 2)}
                </span>
                <span className="text-[12px] font-mono-num text-[#787B86]">
                  {optionCurrency}
                </span>
                <span
                  className={`font-mono-num text-[13px] font-semibold ${
                    !Number.isFinite(headerDeltaPct)
                      ? 'text-[#787B86]'
                      : headerDeltaPct < 0
                        ? 'text-[#F23645]'
                        : 'text-[#22C55E]'
                  }`}
                >
                  {Number.isFinite(headerDeltaPct)
                    ? `${headerDeltaPct > 0 ? '+' : ''}${fmtNum(headerDeltaPct, 2)} %`
                    : '—'}
                </span>

                <button
                  type="button"
                  title="Estado de feed de opciones"
                  className="text-[#787B86] hover:text-[#D1D4DC] p-1 cursor-pointer"
                >
                  <Bell className="w-3.5 h-3.5" />
                </button>

                <div className="hidden md:flex items-center gap-2 text-[12px] text-[#9CA3AF]">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      liveOptions?.feedStatus === 'LIVE' ? 'bg-[#22C55E]' : 'border border-[#9CA3AF]'
                    }`}
                  />
                  <span className="underline decoration-dotted underline-offset-4 text-[#D1D4DC]">
                    {liveMarket.marketStateLabel} ({liveOptions?.feedStatus ?? liveMarket.feedStatus})
                  </span>
                  <span className="font-mono-num text-[#6D7282]">{syncTimeLabel}</span>
                  {liveUnderlyingQuote !== null && liveClock !== null && (
                    <span className="rounded-full border border-[#22C55E]/35 bg-[#22C55E]/10 px-2 py-0.5 font-mono-num text-[10px] font-semibold text-[#22C55E]">
                      ● Tiempo real {liveClock}
                    </span>
                  )}
                  <span
                    className={`rounded-full border px-2 py-0.5 font-mono-num text-[10px] font-semibold ${
                      usOptionsFeedBadge === 'TRADIER LIVE + ORATS'
                        ? 'border-[#22C55E]/40 bg-[#22C55E]/10 text-[#22C55E]'
                        : usOptionsFeedBadge === 'MASSIVE + ORATS'
                          ? 'border-[#38BDF8]/40 bg-[#38BDF8]/10 text-[#38BDF8]'
                          : 'border-[#232733] bg-[#0B0E14] text-[#787B86]'
                    }`}
                    title="Origen del feed de opciones US: puntas bid/ask/size y griegas (Tradier Live o Massive) + superficie ORATS (smvVol, IV Rank, impliedMove)"
                  >
                    {usOptionsFeedBadge ?? 'ORIGEN —'}
                  </span>
                  {(isUsMarket || catalystWindow.status !== 'NO_DATA') && (
                    <span
                      title={catalystWindow.detailLabel}
                      className={`rounded-full border px-2 py-0.5 font-mono-num text-[10px] font-semibold ${
                        catalystWindow.severity === 'DANGER'
                          ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                          : catalystWindow.severity === 'WARNING'
                            ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                            : 'border-[#232733] bg-[#0B0E14] text-[#9CA3AF]'
                      }`}
                    >
                      {catalystWindow.badgeLabel}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-6 ml-auto">
            <div className="relative">
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                VTO.
              </div>
              <button
                type="button"
                onClick={() => setExpiryDropdownOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 font-mono-num text-[14px] font-bold text-[#FFFFFF] hover:text-[#EAB308] cursor-pointer"
                title="Seleccionar vencimiento (con Forward IV consecutiva)"
              >
                <span>
                  {activeExpiry ? `${activeExpiry.label} · ${formatDteLabel(activeExpiry.daysToExpiry)}` : 'Sin vtos · —'}
                </span>
                {activeExpiry && (() => {
                  const fwdSeg = forwardSegmentByFarCode.get(activeExpiry.id);
                  if (!fwdSeg) return null;
                  if (fwdSeg.calendarArbFlag) {
                    return (
                      <span className="rounded border border-rose-500/45 bg-rose-500/15 px-1.5 py-0.2 text-[9.5px] font-semibold text-rose-300">
                        Arb Cal.
                      </span>
                    );
                  }
                  if (fwdSeg.forwardIv !== null && Number.isFinite(fwdSeg.forwardIv)) {
                    return (
                      <span className="rounded border border-[#38BDF8]/40 bg-[#38BDF8]/10 px-1.5 py-0.2 text-[9.5px] font-semibold text-[#38BDF8]">
                        Fwd {fmtNum(fwdSeg.forwardIv * 100, 1)}%
                      </span>
                    );
                  }
                  return null;
                })()}
                <ChevronDown className="w-3.5 h-3.5 text-[#787B86]" />
              </button>

              {expiryDropdownOpen && (
                <div className="absolute right-0 mt-2 w-80 rounded-[10px] border border-[#2A2F3D] bg-[#0E1118] shadow-2xl z-40 p-1.5 space-y-1">
                  <div className="px-2 py-1 text-[10px] font-mono-num uppercase tracking-wider text-[#787B86] flex items-center justify-between border-b border-[#1E222D]">
                    <span>Vencimiento · DTE</span>
                    <span>ATM / Forward IV</span>
                  </div>
                  {GGAL_OPTION_EXPIRIES.length === 0 ? (
                    <div className="px-2 py-2 text-[11px] font-mono-num text-[#787B86]">
                      Sin vencimientos disponibles
                    </div>
                  ) : (
                    GGAL_OPTION_EXPIRIES.map((exp) => {
                      const isSel = exp.id === activeExpiry?.id;
                      const fwdSeg = forwardSegmentByFarCode.get(exp.id);
                      const hasArb = forwardIvSegments.some(
                        (s) => (s.farExpiryCode === exp.id || s.nearExpiryCode === exp.id) && s.calendarArbFlag,
                      );
                      return (
                        <button
                          key={exp.id}
                          type="button"
                          onClick={() => {
                            setSelectedExpiryId(exp.id);
                            setExpiryDropdownOpen(false);
                          }}
                          className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[7px] text-left font-mono-num text-[11.5px] transition-colors cursor-pointer ${
                            isSel
                              ? 'bg-[#1D2230] text-[#FFFFFF] border border-[#EAB308]/45'
                              : 'text-[#D1D4DC] hover:bg-[#161A24]'
                          }`}
                        >
                          <div className="flex flex-col">
                            <span className="font-bold">{exp.label}</span>
                            <span className="text-[10px] text-[#787B86]">{exp.daysToExpiry === 0 ? `${formatDteLabel(0)} (vence hoy)` : `${String(exp.daysToExpiry)}d al vto`}</span>
                          </div>
                          <div className="text-right flex flex-col items-end">
                            <span className="text-[#EAB308] font-semibold">
                              {Number.isFinite(exp.atmIV) && exp.atmIV > 0 ? `IV ${fmtNum(exp.atmIV, 1)}%` : 'IV —'}
                            </span>
                            {fwdSeg ? (
                              fwdSeg.calendarArbFlag ? (
                                <span className="text-[10px] font-semibold text-rose-300">
                                  Arb. Cal. (Fwd Var≤0)
                                </span>
                              ) : fwdSeg.forwardIv !== null && Number.isFinite(fwdSeg.forwardIv) ? (
                                <span className="text-[10px] text-[#38BDF8]">
                                  Fwd {fwdSeg.nearExpiryCode}→: {fmtNum(fwdSeg.forwardIv * 100, 1)}%
                                </span>
                              ) : (
                                <span className="text-[10px] text-[#6D7282]">Fwd —</span>
                              )
                            ) : hasArb ? (
                              <span className="text-[10px] text-rose-300">Arb. Cal.</span>
                            ) : (
                              <span className="text-[10px] text-[#6D7282]">Front</span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            <div>
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                IV ATM
              </div>
              <div
                title="Volatilidad implícita ATM real del vencimiento activo"
                className="font-mono-num text-[14px] font-bold text-[#EAB308]"
              >
                {Number.isFinite(activeAtmIvDec) && activeAtmIvDec > 0
                  ? `${fmtNum(activeAtmIvDec * 100, 1)}%`
                  : '—'}
              </div>
            </div>

            <div>
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                TIR
              </div>
              <div
                title={
                  isHeaderTirBlockedShortDte
                    ? 'DTE < 3: anualización de tasa implícita sintética y alerta HTB suspendidas por amplificación de ruido bid-ask (T < 3/365)'
                    : 'Tasa implícita sintética anualizada del vencimiento activo'
                }
                className="inline-flex items-center gap-1.5 font-mono-num text-[14px] font-bold text-[#FFFFFF]"
              >
                <span>
                  {!isHeaderTirBlockedShortDte && Number.isFinite(headerImpliedTirPct)
                    ? `${fmtNum(headerImpliedTirPct, 1)}%`
                    : '—'}
                </span>
                {isHeaderTirBlockedShortDte && (
                  <span className="px-1.5 py-0.2 rounded bg-[#1F2433] border border-[#3E465E] text-[9.5px] font-semibold text-[#9CA3AF]">
                    DTE &lt; 3
                  </span>
                )}
              </div>
            </div>

            <div>
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                TLR
              </div>
              <button
                type="button"
                onClick={() => setTlrShiftPp((s) => (s === 0 ? 5 : s === 5 ? -5 : 0))}
                title="Tasa libre de riesgo BADLAR/TAMAR en vivo (click para sensibilizar ±5pp)"
                className="inline-flex items-center gap-1 font-mono-num text-[14px] font-bold text-[#FFFFFF] hover:text-[#EAB308] cursor-pointer"
              >
                <span>{Number.isFinite(effectiveTlrPct) ? `${fmtNum(effectiveTlrPct, 1)}%` : '—'}</span>
                <ChevronDown className="w-3.5 h-3.5 text-[#787B86]" />
              </button>
            </div>

            <div>
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                DIV.
              </div>
              <div className="font-mono-num text-[14px] font-bold text-[#787B86]">
                {liveOptions && activeDays >= 3 && Number.isFinite(liveOptions.dividendYield)
                  ? `${fmtNum(liveOptions.dividendYield * 100, 1)}%`
                  : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Favoritos / Plazas líquidas (selector completo en Ctrl+K / /) */}
        <div className="pt-2 border-t border-[#1E222D]/60 flex items-center gap-1.5 overflow-x-auto">
          <span className="text-[10px] font-mono-num uppercase tracking-wider text-[#6D7282] mr-1 shrink-0">
            Favoritos:
          </span>
          {OPTIONS_FAVORITE_KEYS.map((key) => {
            const meta = liveMarket.optionsUnderlyings.find((u) => u.key === key);
            const symbol = parseOptionsUnderlyingKey(key).symbol;
            const active = key === selectedUnderlyingKey;
            return (
              <button
                key={`opt-under-${key}`}
                type="button"
                onClick={() => onSelectUnderlying(key)}
                title={meta ? `${meta.name} · ${meta.market} · ${meta.currency}` : symbol}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono-num font-semibold transition-colors cursor-pointer shrink-0 ${
                  active
                    ? 'bg-[#211B3A] border-[#8B7CF6]/70 text-[#FFFFFF]'
                    : 'bg-[#090B10] border-[#1E222D] text-[#9CA3AF] hover:text-[#FFFFFF] hover:border-[#2E3446]'
                }`}
              >
                <CompanyLogo ticker={symbol} size="xs" />
                <span>{key === 'US:GGAL' ? 'GGAL·US' : symbol}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setSymbolSelectorOpen(true)}
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#232733] bg-[#0B0E14] px-2.5 py-1 text-[11px] font-semibold text-[#9CA3AF] hover:border-[#2E3446] hover:text-white cursor-pointer"
          >
            <Search className="w-3.5 h-3.5" />
            <span>Buscar</span>
            <kbd className="rounded bg-[#161A25] px-1 font-mono-num text-[10px]">Ctrl K</kbd>
          </button>
        </div>

        {/* Navegación interna de los 7 módulos de Opciones */}
        <div className="pt-2.5 border-t border-[#1E222D] flex items-center justify-between gap-2 overflow-x-auto">
          <div className="flex items-center gap-1.5">
            {subViews.map((sv) => {
              const active = activeSubView === sv.id;
              return (
                <button
                  key={sv.id}
                  type="button"
                  onClick={() => onSelectSubView(sv.id)}
                  className={`relative inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
                    active
                      ? 'text-[#0B0E14]'
                      : 'text-[#9CA3AF] hover:text-[#FFFFFF] hover:bg-[#161A25]'
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="options-subview-pill"
                      className="absolute inset-0 rounded-full bg-[#EAECEF]"
                      transition={{ duration: 0.4, ease: FX_EASE }}
                    />
                  )}
                  <span className="relative inline-flex items-center gap-1.5">
                    {sv.icon}
                    <span>{sv.label}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <span className="text-[11px] font-mono-num text-[#787B86] hidden lg:inline">
            {Number.isFinite(headerOneSigmaAbs) && Number.isFinite(headerOneSigmaPct) && activeExpiry
              ? `1σ hoy = $${formatSigma(headerOneSigmaAbs)} (±${fmtNum(headerOneSigmaPct, 1)}% al ${activeExpiry.label})`
              : '1σ hoy = —'}
          </span>
        </div>
      </div>

      {/* =====================================================================
          2. MÓDULO 1: ARMADOR DE ESTRATEGIAS (POR FAMILIA / POR OBJETIVO)
          ===================================================================== */}
      {activeSubView === 'estrategias' && (
        <div className="space-y-6">
          {showOnboardingBanner && (
            <div className="rounded-[12px] bg-[#141311] border border-[#3E3522] px-6 py-4 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="text-[14px] font-bold text-[#FFFFFF]">Primera vez en Estrategias</div>
                <p className="text-[13px] text-[#9CA3AF]">
                  Los armados que permite la cadena real de hoy, ordenados, para abrir en el Armador o enviar al Ticket.
                </p>
              </div>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setShowOnboardingBanner(false)}
                  className="text-[13px] text-[#9CA3AF] hover:text-white cursor-pointer"
                >
                  Ahora no
                </button>
                <button
                  type="button"
                  onClick={() => setShowOnboardingBanner(false)}
                  className="px-4 py-1.5 rounded-full bg-[#E5C158] hover:bg-[#F3D16A] text-[#0B0E14] text-[13px] font-bold cursor-pointer"
                >
                  Entendido
                </button>
              </div>
            </div>
          )}

          <div className="rounded-[12px] bg-[#101218] border border-[#232733] p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center bg-[#0B0D12] border border-[#232733] rounded-full p-1">
                <button
                  type="button"
                  onClick={() => setStrategyMode('familia')}
                  className={`px-4 py-2 rounded-full text-[13px] font-bold cursor-pointer transition-all ${
                    strategyMode === 'familia'
                      ? 'bg-[#EAECEF] text-[#0B0E14]'
                      : 'text-[#9CA3AF] hover:text-white'
                  }`}
                >
                  Por familia
                </button>
                <button
                  type="button"
                  onClick={() => setStrategyMode('objetivo')}
                  className={`px-4 py-2 rounded-full text-[13px] font-bold cursor-pointer transition-all ${
                    strategyMode === 'objetivo'
                      ? 'bg-[#EAECEF] text-[#0B0E14]'
                      : 'text-[#9CA3AF] hover:text-white'
                  }`}
                >
                  Por objetivo
                </button>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-[10px] bg-[#0B0D12] border border-[#1E222D]">
                <CompanyLogo ticker={upperUnderlying} name={stockName} size="sm" />
                <span className="font-mono-num text-[12px] font-bold text-[#FFFFFF]">
                  {upperUnderlying}
                </span>
                <span className="text-[11px] text-[#787B86] hidden sm:inline">
                  · {stockName}
                </span>
              </div>
            </div>

            {strategyMode === 'familia' && (
              <div className="space-y-4">
                <div className="flex items-center gap-1.5 text-[13px] text-[#9CA3AF]">
                  <span>Clickeá una familia o filtrá por sesgo para evaluar estrategias sobre la cadena viva.</span>
                  <HelpCircle className="w-3.5 h-3.5 text-[#6D7282]" />
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedFamily('sugeridas')}
                  className={`w-full py-2.5 rounded-[8px] font-bold text-[13.5px] transition-colors cursor-pointer ${
                    selectedFamily === 'sugeridas'
                      ? 'bg-[#EAECEF] text-[#0B0E14]'
                      : 'bg-[#161922] text-[#D1D4DC] hover:bg-[#1E222E]'
                  }`}
                >
                  Sugeridas
                </button>

                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-y-3 gap-x-4 px-2 py-2">
                  {STRATEGY_FAMILIES.map((fam) => {
                    const isSelected = selectedFamily === fam.id;
                    return (
                      <button
                        key={fam.id}
                        type="button"
                        onClick={() =>
                          setSelectedFamily((prev) => (prev === fam.id ? 'sugeridas' : fam.id))
                        }
                        className={`inline-flex items-center gap-2.5 py-1.5 px-2 rounded-[8px] text-[13px] transition-colors cursor-pointer text-left ${
                          isSelected
                            ? 'bg-[#1E2330] text-[#FFFFFF] font-bold'
                            : 'text-[#9CA3AF] hover:text-[#FFFFFF]'
                        }`}
                      >
                        <svg width="20" height="14" viewBox="0 0 20 14" className="shrink-0">
                          <path
                            d={fam.svgPath}
                            fill="none"
                            stroke={isSelected ? '#22C55E' : '#787B86'}
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span className="truncate">{fam.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <span className="text-[13px] text-[#9CA3AF]">Tu lectura del papel:</span>
                  {(['Alcista', 'Lateral', 'Bajista', 'Se mueve'] as const).map((bias) => (
                    <button
                      key={bias}
                      type="button"
                      onClick={() => setMarketBias(bias)}
                      className={`px-3.5 py-1.5 rounded-full text-[13px] font-bold transition-all cursor-pointer ${
                        marketBias === bias
                          ? 'bg-[#EAECEF] text-[#0B0E14]'
                          : 'text-[#9CA3AF] hover:text-white'
                      }`}
                    >
                      {bias}
                    </button>
                  ))}
                  <span className="text-[13px] text-[#9CA3AF] ml-2">
                    {Number.isFinite(activeAtmIvDec) && Number.isFinite(HIST_MEDIAN_IV) ? (
                      activeAtmIvDec > HIST_MEDIAN_IV ? (
                        <>
                          Primas <strong className="text-[#EAB308]">caras vs. historia</strong>: VI ATM{' '}
                          {fmtNum(activeAtmIvDec * 100, 1)}% vs. {fmtNum(HIST_MEDIAN_IV * 100, 1)}%.
                        </>
                      ) : (
                        <>
                          Primas <strong className="text-[#22C55E]">accesibles vs. historia</strong>: VI ATM{' '}
                          {fmtNum(activeAtmIvDec * 100, 1)}% vs. {fmtNum(HIST_MEDIAN_IV * 100, 1)}%.
                        </>
                      )
                    ) : (
                      'Diagnóstico VI vs. historia: —'
                    )}
                  </span>
                </div>
              </div>
            )}

            {strategyMode === 'objetivo' && (
              <div className="space-y-4">
                <div className="flex items-center gap-1.5 text-[13px] text-[#9CA3AF]">
                  <span>Las figuras que sirven para tu precio, rankeadas para compararlas rápido.</span>
                  <HelpCircle className="w-3.5 h-3.5 text-[#6D7282]" />
                </div>

                <div className="rounded-[12px] bg-[#0E1015] border border-[#232733] p-5 space-y-5">
                  <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 bg-[#161922] p-1.5 rounded-full">
                    {(
                      [
                        { id: 'Muy bajista', icon: '↓↓', mult: 0.85 },
                        { id: 'Bajista', icon: '↓', mult: 0.93 },
                        { id: 'Lateral', icon: '→', mult: 1.0 },
                        { id: 'Se mueve', icon: '↔', mult: 1.15 },
                        { id: 'Alcista', icon: '↑', mult: 1.1 },
                        { id: 'Muy alcista', icon: '↑↑', mult: 1.2 },
                      ] as const
                    ).map((preset) => {
                      const active = objectiveBias === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            setObjectiveBias(preset.id);
                            if (Number.isFinite(displaySpot) && displaySpot > 0) {
                              setTargetPrice(Math.round(displaySpot * preset.mult));
                            }
                          }}
                          className={`py-2 px-3 rounded-full text-[12.5px] font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer transition-all ${
                            active ? 'bg-[#EAECEF] text-[#0B0E14]' : 'text-[#9CA3AF] hover:text-white'
                          }`}
                        >
                          <span className="font-mono-num text-[11px]">{preset.icon}</span>
                          <span>{preset.id}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center gap-4 text-[13px]">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[#9CA3AF]">termina en</span>
                      <input
                        type="number"
                        step={Math.max(10, Math.round((displaySpot || 100) * 0.01))}
                        value={Number.isFinite(targetPrice) ? targetPrice : ''}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setTargetPrice(Number.isFinite(v) && v > 0 ? v : Number.NaN);
                        }}
                        className="w-28 px-3 py-1.5 rounded-[8px] bg-[#181B24] border border-[#2D3242] font-mono-num font-bold text-[#FFFFFF] text-right outline-none focus:border-[#EAECEF]"
                      />
                      <span className="font-mono-num font-semibold text-[#22C55E]">
                        {targetSuggestedPct !== '—'
                          ? `${Number(targetSuggestedPct.replace(',', '.')) >= 0 ? '+' : ''}${targetSuggestedPct}% objetivo`
                          : '—'}
                      </span>
                    </div>

                    <div className="flex items-center gap-2.5">
                      <span className="text-[#9CA3AF]">arriesgo hasta</span>
                      <input
                        type="text"
                        value={maxRiskInput}
                        onChange={(e) => setMaxRiskInput(e.target.value)}
                        className="w-28 px-3 py-1.5 rounded-[8px] bg-[#181B24] border border-[#2D3242] font-mono-num text-[#9CA3AF] text-right outline-none focus:border-[#EAECEF]"
                      />
                      <span className="text-[#9CA3AF]">por lote</span>
                    </div>

                    <div className="flex items-center gap-3 flex-1 min-w-[240px]">
                      <span className="text-[#9CA3AF] whitespace-nowrap">más retorno</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={probabilityWeight}
                        onChange={(e) => setProbabilityWeight(Number(e.target.value))}
                        className="flex-1 accent-[#EAECEF] cursor-pointer"
                      />
                      <span className="text-[#9CA3AF] whitespace-nowrap">más probable</span>
                    </div>
                  </div>

                  <p className="text-[12.5px] text-[#9CA3AF]">
                    {activeExpiry && Number.isFinite(headerOneSigmaAbs)
                      ? `Vencimiento elegido: ${activeExpiry.label} (${activeExpiry.daysToExpiry === 0 ? '0DTE — vence hoy' : `${String(activeExpiry.daysToExpiry)} días`}). Desvío esperado 1σ = $${fmtNum(headerOneSigmaAbs, 0)}.`
                      : 'Esperando cotizaciones reales de opciones para calcular 1σ.'}
                  </p>
                </div>
              </div>
            )}
          </div>

          {visiblePayoffCards.length === 0 ? (
            <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-6 text-[13px] text-[#9CA3AF]">
              Sin estrategias evaluables todavía para {upperUnderlying} con el filtro actual. Esperando cadena de opciones en vivo...
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {visiblePayoffCards.map((card) => (
                  <PayoffStrategyCard
                    key={card.id}
                    card={card}
                    isSelected={focusedStrategyCard?.id === card.id}
                    onInspect={(c) => setSelectedStrategyInspectorId(c.id)}
                    onExecute={(c) => {
                      loadIntoBuilder(c.pricedLegs, 1);
                    }}
                  />
                ))}
              </div>

              {focusedStrategyCard && (() => {
                const { legs: whatIfLegs, horizonDte } = buildWhatIfLegsFromPricedLegs(
                  focusedStrategyCard.pricedLegs,
                  activeDays,
                  activeAtmIvDec,
                );
                if (whatIfLegs.length === 0) return null;
                return (
                  <div className="rounded-[12px] bg-[#101218] border border-[#38BDF8]/35 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#38BDF8]">
                          INSPECTOR ACTIVO · ESTRATEGIA SELECCIONADA
                        </div>
                        <div className="text-[14px] font-bold text-[#FFFFFF]">
                          {focusedStrategyCard.title}{' '}
                          <span className="text-[12px] font-normal text-[#9CA3AF]">
                            — {focusedStrategyCard.subtitle}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => loadIntoBuilder(focusedStrategyCard.pricedLegs, 1)}
                        className="px-3 py-1 rounded bg-[#38BDF8]/20 border border-[#38BDF8]/50 text-[#38BDF8] hover:bg-[#38BDF8]/30 text-[11.5px] font-semibold cursor-pointer"
                      >
                        Pasar a Armado a mano →
                      </button>
                    </div>
                    <WhatIfPayoffSimulator
                      key={`strat-whatif-${upperUnderlying}-${focusedStrategyCard.id}-${String(horizonDte)}-${isZeroDte ? '0dte' : 'dte'}`}
                      structureLabel={focusedStrategyCard.title}
                      spot={displaySpot}
                      rate={Number.isFinite(effectiveRateDec) ? effectiveRateDec : 0}
                      dividendYield={activeDividendYield}
                      horizonDte={horizonDte}
                      zeroDte={isZeroDte}
                      legs={whatIfLegs}
                      currencyPrefix={isUsMarket ? 'US$' : '$'}
                      contractMultiplier={Number.isFinite(contractMultiplier) && contractMultiplier > 0 ? contractMultiplier : LOT}
                      callWallStrike={Number.isFinite(dealerGammaReport.callWallStrike) ? dealerGammaReport.callWallStrike : null}
                      putWallStrike={Number.isFinite(dealerGammaReport.putWallStrike) ? dealerGammaReport.putWallStrike : null}
                      zeroGammaSpot={Number.isFinite(dealerGammaReport.zeroGammaSpot) ? dealerGammaReport.zeroGammaSpot : null}
                    />
                  </div>
                );
              })()}
            </div>
          )}

          {/* OPTIMITZADOR CUANTITATIVO — LAS 3 MANERAS DE JUGARLA (PIEZA 18) */}
          {!(strategyMode === 'familia' && selectedFamily === 'calendarios') && (() => {
            const qe = activeQuantEngines;
            const optRes =
              optimizerDir === 'BEARISH'
                ? qe?.structureOptimizerBearish ?? null
                : qe?.structureOptimizerBullish ?? null;
            const costPct = qe?.structureCostPercentile ?? null;
            const picked = optRes
              ? [
                  { role: 'Mayor Probabilidad (PoP ℙ)', tone: '#22C55E', item: optRes.bestByPop },
                  { role: 'Mayor Valor Esperado (+EV)', tone: '#38BDF8', item: optRes.bestByExpectedValue },
                  { role: 'Mayor Asimetría / Convexidad', tone: '#C084FC', item: optRes.bestByConvexity },
                ]
              : [];
            return (
              <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-[15px] font-extrabold text-[#FFFFFF] tracking-tight">
                        Las 3 Maneras de Jugarla — Optimizador Neto Bid/Ask + Fricciones (Motor 10)
                      </h3>
                      {costPct && costPct.status === 'OK' && (
                        <span className="px-2 py-0.5 rounded bg-[#0B0E14] border border-[#232733] font-mono-num text-[10.5px] text-[#EAB308]">
                          Costo P{costPct.percentile != null ? fmtNum(costPct.percentile, 0) : '—'} ({costPct.regime})
                        </span>
                      )}
                    </div>
                    <p className="text-[12px] text-[#9CA3AF]">
                      Rankeado sobre distribución empírica ℙ, descontando puntas Bid/Ask reales, aranceles BYMA/OPRA e IVA.
                    </p>
                  </div>

                  <div className="inline-flex items-center bg-[#0B0D12] border border-[#232733] rounded-full p-1 text-[12px]">
                    {(['BULLISH', 'BEARISH'] as const).map((dir) => (
                      <button
                        key={dir}
                        type="button"
                        onClick={() => setOptimizerDir(dir)}
                        className={`px-3 py-1 rounded-full font-bold cursor-pointer transition-colors ${
                          optimizerDir === dir ? 'bg-[#EAECEF] text-[#0B0E14]' : 'text-[#9CA3AF] hover:text-white'
                        }`}
                      >
                        {dir === 'BULLISH' ? 'Alcista' : 'Bajista'}
                      </button>
                    ))}
                  </div>
                </div>

                {!optRes || optRes.status !== 'OK' || picked.every((p) => p.item === null) ? (
                  <div className="text-[12px] font-mono-num text-[#787B86] p-3 rounded bg-[#0B0E14] border border-[#1E222D]">
                    NO_DATA — Se requieren puntas Bid/Ask ejecutables y distribución empírica ℙ válida para {upperUnderlying}.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
                    {picked.map((slot) => {
                      const s = slot.item;
                      return (
                        <div
                          key={slot.role}
                          className="p-4 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] flex flex-col justify-between gap-3"
                        >
                          <div className="space-y-2">
                            <div className="text-[10.5px] font-mono-num font-bold uppercase tracking-wider" style={{ color: slot.tone }}>
                              {slot.role}
                            </div>
                            <div className="text-[14px] font-bold text-[#FFFFFF]">
                              {s ? s.label : '—'}
                            </div>
                            {s && (
                              <div className="space-y-1 text-[11px] font-mono-num text-[#9CA3AF]">
                                {s.legs.map((lg, i) => (
                                  <div key={`${lg.strike ?? i}-${lg.contractType}-${lg.side}`} className="flex justify-between">
                                    <span>
                                      {lg.side === 'BUY' ? '+1x' : '-1x'} {lg.contractType.toUpperCase()} {lg.strike ?? '—'} (×{lg.quantity})
                                    </span>
                                    <span className="text-[#FFFFFF]">
                                      @ {lg.executionPrice != null ? `$${fmtNum(lg.executionPrice, 2)}` : '—'}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {s ? (
                            <div className="pt-2.5 border-t border-[#1E222D] grid grid-cols-2 gap-y-1.5 gap-x-2 text-[11.5px] font-mono-num">
                              <div className="text-[#9CA3AF]">Caja Neta</div>
                              <div className={`text-right font-bold ${(s.netDebitOrCredit ?? 0) >= 0 ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}>
                                {s.netDebitOrCredit != null ? `$${fmtNum(s.netDebitOrCredit, 0)}` : '—'}
                              </div>
                              <div className="text-[#9CA3AF]">PoP (ℙ) / +EV</div>
                              <div className="text-right text-[#FFFFFF]">
                                {s.pop != null ? `${fmtNum(s.pop * 100, 1)}%` : '—'} ·{' '}
                                {s.expectedValue != null ? `$${fmtNum(s.expectedValue, 0)}` : '—'}
                              </div>
                              <div className="text-[#9CA3AF]">Fricciones (Ar.+IVA)</div>
                              <div className="text-right text-[#D1D4DC]">
                                {s.totalFriction != null ? `$${fmtNum(s.totalFriction, 0)}` : '—'}
                              </div>
                              <div className="text-[#9CA3AF]">Convexidad / BE</div>
                              <div className="text-right text-[#38BDF8]">
                                {s.convexityScore != null ? fmtNum(s.convexityScore, 2) : '—'} ·{' '}
                                {s.breakevenPrices[0] != null ? `$${fmtNum(s.breakevenPrices[0], 1)}` : '—'}
                              </div>
                            </div>
                          ) : (
                            <div className="text-[11.5px] text-[#787B86] font-mono-num">Sin candidato líquido (—).</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* TABLA COMPARATIVA */}
          <div className="rounded-[12px] bg-[#101218] border border-[#232733] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-right text-[13px]">
                <thead>
                  <tr className="border-b border-[#232733] bg-[#0D1017] text-[11.5px] font-medium text-[#787B86]">
                    <th className="py-3 px-4 text-left">estrategia</th>
                    <th className="py-3 px-3">caja</th>
                    <th className="py-3 px-3">máx gan</th>
                    <th className="py-3 px-3">máx pérd</th>
                    <th className="py-3 px-3">gana/pierde</th>
                    <th className="py-3 px-3">crece</th>
                    <th className="py-3 px-3">prob</th>
                    <th className="py-3 px-3">Δ</th>
                    <th className="py-3 px-3">$ por día</th>
                    <th className="py-3 px-3">relación</th>
                    <th className="py-3 px-4">empates</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E222D] font-mono-num">
                  {comparisonRows.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="py-6 text-center text-[#787B86]">
                        Sin estrategias disponibles para comparar.
                      </td>
                    </tr>
                  ) : (
                    comparisonRows.map((row) => (
                      <tr
                        key={row.id}
                        onClick={() =>
                          onOpenOrderTicket({
                            ticker: row.name,
                            side: row.cajaNum >= 0 ? 'Venta' : 'Compra',
                            price: Number.isFinite(row.cajaNum) ? Math.abs(row.cajaNum) / LOT : 0,
                            qty: 1,
                            instrumentLabel: `${row.name} (${upperUnderlying})`,
                          })
                        }
                        className="hover:bg-[#171B26] transition-colors cursor-pointer"
                      >
                        <td className="py-3.5 px-4 text-left font-sans">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[#FFFFFF] text-[13.5px]">{row.name}</span>
                            {row.tag && (
                              <span className="px-1.5 py-0.5 rounded bg-[#1F2433] text-[#9CA3AF] font-mono-num text-[10.5px]">
                                {row.tag}
                              </span>
                            )}
                            {row.bidAskPctOfMid !== undefined && Number.isFinite(row.bidAskPctOfMid) && (
                              <span
                                title={`Bid-Ask % del Mid: ${fmtNum(row.bidAskPctOfMid, 1)}% (${row.liquiditySemaphore ?? '—'})`}
                                className={`px-1.5 py-0.5 rounded-full border font-mono-num text-[10px] font-semibold ${getLiquiditySemaphoreBadgeStyle(row.liquiditySemaphore)}`}
                              >
                                ● {fmtNum(row.bidAskPctOfMid, 1)}% Mid
                              </span>
                            )}
                          </div>
                          <div className="text-[11.5px] text-[#787B86] mt-0.5">{row.desc}</div>
                        </td>
                        <td className={`py-3.5 px-3 font-semibold ${row.cajaNum >= 0 ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}>
                          {row.caja}
                        </td>
                        <td className="py-3.5 px-3 text-[#22C55E] font-semibold">{row.maxGan}</td>
                        <td className="py-3.5 px-3 text-[#EF4444] font-semibold">{row.maxPerd}</td>
                        <td className="py-3.5 px-3 text-[#FFFFFF]">{row.ganaPierde}</td>
                        <td className={`py-3.5 px-3 ${row.crece.startsWith('-') ? 'text-[#EF4444]' : 'text-[#787B86]'}`}>
                          {row.crece}
                        </td>
                        <td className="py-3.5 px-3 text-[#FFFFFF] font-semibold">{row.prob}</td>
                        <td className="py-3.5 px-3 text-[#FFFFFF]">{row.delta}</td>
                        <td className="py-3.5 px-3 text-[#22C55E] font-semibold">{row.porDia}</td>
                        <td className="py-3.5 px-3 text-[#FFFFFF]">{row.relacion}</td>
                        <td className="py-3.5 px-4 text-[#9CA3AF] text-[12px] leading-tight">
                          <div>{row.empates[0]}</div>
                          {row.empates[1] && <div>{row.empates[1]}</div>}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          3. MÓDULO 2: MATRIZ DE SPREADS (ESCALERA / PARES)
          ===================================================================== */}
      {activeSubView === 'spreads' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-[24px] font-extrabold text-[#FFFFFF] tracking-tight">Spreads</h2>
                <HelpTooltip
                  title="Matriz Débito / Ranking Crédito por Régimen"
                  text="Alterna entre spreads de Débito (Convexidad) y estrategias de Crédito (Bull Put, Bear Call, Iron Condor) filtradas por crédito mínimo >= 0,10 y Bid-Ask % del Mid <= 35%."
                />
                {activeRegimeCode !== 'NO_DATA' && (
                  <span
                    className={`rounded-full border px-2.5 py-0.5 font-mono-num text-[10.5px] font-semibold ${
                      activeRegimeCode === 'NO_SHORT_PREMIUM_RISK'
                        ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                        : activeRegimeCode === 'VENTA_PRIMA_CUBIERTA'
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                          : activeRegimeCode === 'COMPRA_CONVEXIDAD_CALENDAR'
                            ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                            : 'border-[#232733] bg-[#0B0E14] text-[#9CA3AF]'
                    }`}
                  >
                    Régimen:{' '}
                    {activeRegimeCode === 'NO_SHORT_PREMIUM_RISK'
                      ? SHORT_PREMIUM_RISK_MESSAGE
                      : activeRegimeCode === 'VENTA_PRIMA_CUBIERTA'
                        ? 'Venta de Prima Cubierta → Crédito'
                        : activeRegimeCode === 'COMPRA_CONVEXIDAD_CALENDAR'
                          ? 'Compra de Convexidad → Débito'
                          : 'Neutral Selectivo'}
                  </span>
                )}
                {shortPremiumBreaker.blocked && activeRegimeCode !== 'NO_SHORT_PREMIUM_RISK' && (
                  <span className="rounded-full border border-rose-500/50 bg-rose-500/15 px-2.5 py-0.5 font-mono-num text-[10.5px] font-semibold text-rose-300">
                    {SHORT_PREMIUM_RISK_MESSAGE}
                  </span>
                )}
              </div>
              <p className="text-[13px] text-[#9CA3AF]">
                {activeSpreadMode === 'CREDIT'
                  ? `Ranking cuantitativo de Bull Put, Bear Call e Iron Condors para ${upperUnderlying} (${activeExpiry?.label ?? '—'}) usando densidad neutral y griegas netas.`
                  : `Cada par de bases de ${upperUnderlying} (${activeExpiry?.label ?? '—'}), con Débito Neto, Ratio Max Profit / Débito, Breakeven y Edge implícito.`}
              </p>
            </div>

            <div className="inline-flex items-center rounded-full border border-[#2A3040] bg-[#0B0E14] p-1 text-[12px] font-bold">
              {(
                [
                  { id: 'CREDIT' as const, label: 'Crédito' },
                  { id: 'DEBIT' as const, label: 'Débito' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() =>
                    setSpreadModeOverride({ token: spreadModeToken, mode: opt.id })
                  }
                  className={`px-3.5 py-1 rounded-full transition-colors cursor-pointer ${
                    activeSpreadMode === opt.id
                      ? opt.id === 'CREDIT'
                        ? 'bg-emerald-500 text-[#090D14]'
                        : 'bg-[#38BDF8] text-[#090D14]'
                      : 'text-[#9CA3AF] hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {activeSpreadMode === 'CREDIT' ? (
            <div className="space-y-4">
              {/* Top 3 Tarjetas Adaptadas al Modo Crédito */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {(
                  [
                    {
                      title: 'MEJOR BULL PUT',
                      accent: 'text-emerald-400 border-emerald-500/35',
                      item: creditRankingResult.bestBullPut,
                    },
                    {
                      title: 'MEJOR BEAR CALL',
                      accent: 'text-amber-400 border-amber-500/35',
                      item: creditRankingResult.bestBearCall,
                    },
                    {
                      title: 'MEJOR IRON CONDOR',
                      accent: 'text-cyan-300 border-cyan-500/35',
                      item: creditRankingResult.bestIronCondor,
                    },
                  ] as const
                ).map((slot) => {
                  const cand = slot.item;
                  const isSel = cand !== null && focusedCreditCandidate?.id === cand.id;
                  const ccy = isUsMarket ? 'US$' : '$';
                  return (
                    <button
                      key={slot.title}
                      type="button"
                      disabled={cand === null}
                      onClick={() => {
                        if (cand) setSelectedCreditId(cand.id);
                      }}
                      className={`text-left rounded-[10px] bg-[#101218] border p-3.5 space-y-1.5 transition-all ${
                        isSel
                          ? 'border-[#38BDF8] ring-1 ring-[#38BDF8]/40'
                          : 'border-[#232733] hover:border-[#343B4E]'
                      } ${cand ? 'cursor-pointer' : 'opacity-75 cursor-default'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-[10.5px] font-mono-num uppercase tracking-wider font-bold ${slot.accent.split(' ')[0]}`}>
                          {slot.title}
                        </span>
                        {cand && Number.isFinite(cand.bidAskPctOfMid) && (
                          <span
                            className={`px-2 py-0.5 rounded-full border font-mono-num text-[10px] font-semibold ${getLiquiditySemaphoreBadgeStyle(cand.liquiditySemaphore)}`}
                          >
                            ● {fmtNum(cand.bidAskPctOfMid, 1)}% Mid
                          </span>
                        )}
                      </div>
                      {cand ? (
                        <>
                          <div className="font-mono-num text-[14.5px] font-extrabold text-[#FFFFFF]">
                            {cand.label}
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] font-mono-num text-[#D1D4DC]">
                            <span>
                              Créd/Ancho:{' '}
                              <strong className="text-emerald-400">
                                {fmtNum(cand.creditPctOfWidth, 1)}%
                              </strong>{' '}
                              ({ccy} {fmtNum(cand.netCreditPerShare, 2)})
                            </span>
                            <span>
                              POP ({cand.popSource === 'BL_DENSITY' ? 'BL' : 'LN'}):{' '}
                              <strong className="text-[#FFFFFF]">
                                {Number.isFinite(cand.pop) ? `${fmtNum(cand.pop * 100, 1)}%` : '—'}
                              </strong>
                            </span>
                            <span>
                              EV:{' '}
                              <strong className={cand.expectedValuePerShare >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                {Number.isFinite(cand.expectedValuePerShare) ? `${ccy} ${fmtNum(cand.expectedValuePerShare, 2)}` : '—'}
                              </strong>
                            </span>
                            <span>
                              Máx Pérd: <strong className="text-rose-400">{ccy} {fmtNum(cand.maxLossPerShare, 2)}</strong>
                            </span>
                            <span className="col-span-2 text-[#9CA3AF]">
                              |Θ/ν| neta:{' '}
                              <strong className="text-[#EAB308]">
                                {Number.isFinite(cand.absThetaToVegaRatio) ? fmtNum(cand.absThetaToVegaRatio, 2) : '—'}
                              </strong>{' '}
                              (Θ {Number.isFinite(cand.netThetaDaily) ? fmtNum(cand.netThetaDaily, 3) : '—'} / ν {Number.isFinite(cand.netVegaPer1Pct) ? fmtNum(cand.netVegaPer1Pct, 3) : '—'})
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className="text-[12px] font-mono-num text-[#787B86]">
                          Sin estructura líquida (Créd ≥ 0,10, Bid &gt; 0, B/A ≤ 35%)
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Inspector Activo Crédito + Simulador What-If */}
              {focusedCreditCandidate && (() => {
                const ccy = isUsMarket ? 'US$' : '$';
                const mult = Number.isFinite(contractMultiplier) && contractMultiplier > 0 ? contractMultiplier : LOT;
                const creditWhatIfLegs = buildWhatIfLegsFromCreditCandidate(
                  focusedCreditCandidate,
                  activeDays,
                  activeAtmIvDec,
                );
                return (
                  <div className="rounded-[12px] bg-[#101218] border border-[#38BDF8]/40 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#38BDF8]">
                          INSPECTOR ACTIVO (CRÉDITO) · {focusedCreditCandidate.label}
                        </div>
                        <div className="font-mono-num text-[13px] font-bold text-[#FFFFFF]">
                          Crédito {ccy} {fmtNum(focusedCreditCandidate.netCreditPerShare, 2)} ({fmtNum(focusedCreditCandidate.creditPctOfWidth, 1)}% ancho) · Máx Pérdida {ccy} {fmtNum(focusedCreditCandidate.maxLossContract, 0)}/cto · BE {focusedCreditCandidate.breakevens.map((b) => (Number.isFinite(b) && b > 0 ? formatStrike(b) : '—')).join(' / ')}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          onOpenOrderTicket({
                            ticker: focusedCreditCandidate.id,
                            side: 'Venta',
                            price: focusedCreditCandidate.netCreditPerShare * mult,
                            qty: 1,
                            instrumentLabel: `${focusedCreditCandidate.label} (${upperUnderlying})`,
                          })
                        }
                        className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-[#090D14] text-[11.5px] font-bold cursor-pointer"
                      >
                        Operar Crédito →
                      </button>
                    </div>
                    <WhatIfPayoffSimulator
                      key={`cred-whatif-${upperUnderlying}-${focusedCreditCandidate.id}-${isZeroDte ? '0dte' : 'dte'}`}
                      structureLabel={focusedCreditCandidate.label}
                      spot={displaySpot}
                      rate={Number.isFinite(effectiveRateDec) ? effectiveRateDec : 0}
                      dividendYield={activeDividendYield}
                      horizonDte={Math.max(1, Math.round(activeDays || 1))}
                      zeroDte={isZeroDte}
                      legs={creditWhatIfLegs}
                      currencyPrefix={isUsMarket ? 'US$' : '$'}
                      contractMultiplier={mult}
                      callWallStrike={Number.isFinite(dealerGammaReport.callWallStrike) ? dealerGammaReport.callWallStrike : null}
                      putWallStrike={Number.isFinite(dealerGammaReport.putWallStrike) ? dealerGammaReport.putWallStrike : null}
                      zeroGammaSpot={Number.isFinite(dealerGammaReport.zeroGammaSpot) ? dealerGammaReport.zeroGammaSpot : null}
                      breakevens={focusedCreditCandidate.breakevens}
                    />
                  </div>
                );
              })()}

              {/* Tabla Rankeada de Crédito */}
              <div className="rounded-[12px] bg-[#101218] border border-[#232733] overflow-hidden">
                <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#232733]">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {(
                      [
                        { id: 'ALL' as const, label: `Todos (${String(creditRankingResult.allCandidates.length)})` },
                        { id: 'BULL_PUT_SPREAD' as const, label: `Bull Put (${String(creditRankingResult.bullPutSpreads.length)})` },
                        { id: 'BEAR_CALL_SPREAD' as const, label: `Bear Call (${String(creditRankingResult.bearCallSpreads.length)})` },
                        { id: 'IRON_CONDOR' as const, label: `Iron Condor (${String(creditRankingResult.ironCondors.length)})` },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setCreditKindFilter(f.id)}
                        className={`px-3 py-1 rounded-full text-[11.5px] font-semibold border cursor-pointer transition-colors ${
                          creditKindFilter === f.id
                            ? 'bg-[#1F2433] text-[#FFFFFF] border-[#3E465E]'
                            : 'bg-transparent text-[#9CA3AF] border-[#262B38] hover:text-white'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[11px] font-mono-num text-[#787B86]">
                    Contratos líquidos: {String(creditRankingResult.liquidContractsCount)} · Filtrados: {String(creditRankingResult.skippedContractsCount)}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-right font-mono-num text-[12px]">
                    <thead>
                      <tr className="border-b border-[#232733] bg-[#0D1017] text-[11px] font-medium text-[#787B86]">
                        <th className="py-2.5 px-3 text-left">Estructura</th>
                        <th className="py-2.5 px-2.5 text-center">Tipo</th>
                        <th className="py-2.5 px-2.5">Crédito</th>
                        <th className="py-2.5 px-2.5">Créd/Ancho</th>
                        <th className="py-2.5 px-2.5">POP</th>
                        <th className="py-2.5 px-2.5">EV</th>
                        <th className="py-2.5 px-2.5">Máx Pérd</th>
                        <th className="py-2.5 px-2.5">|Θ/ν|</th>
                        <th className="py-2.5 px-3">Liquidez</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1E222D]">
                      {(() => {
                        const rowsToShow =
                          creditKindFilter === 'ALL'
                            ? creditRankingResult.allCandidates
                            : creditRankingResult.allCandidates.filter((c) => c.kind === creditKindFilter);
                        if (rowsToShow.length === 0) {
                          return (
                            <tr>
                              <td colSpan={9} className="py-6 text-center text-[#787B86]">
                                Sin estrategias de crédito líquidas con Crédito ≥ 0,10 y Bid-Ask ≤ 35% del Mid.
                              </td>
                            </tr>
                          );
                        }
                        const ccy = isUsMarket ? 'US$' : '$';
                        return rowsToShow.slice(0, 40).map((cand) => {
                          const isSel = focusedCreditCandidate?.id === cand.id;
                          return (
                            <tr
                              key={cand.id}
                              onClick={() => setSelectedCreditId(cand.id)}
                              className={`cursor-pointer transition-colors ${
                                isSel ? 'bg-[#171E2E]' : 'hover:bg-[#151922]'
                              }`}
                            >
                              <td className="py-2.5 px-3 text-left font-sans font-semibold text-[#FFFFFF]">
                                {cand.label}
                              </td>
                              <td className="py-2.5 px-2.5 text-center">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                    cand.kind === 'BULL_PUT_SPREAD'
                                      ? 'bg-emerald-500/15 text-emerald-300'
                                      : cand.kind === 'BEAR_CALL_SPREAD'
                                        ? 'bg-amber-500/15 text-amber-300'
                                        : 'bg-cyan-500/15 text-cyan-300'
                                  }`}
                                >
                                  {cand.kind === 'BULL_PUT_SPREAD'
                                    ? 'BULL PUT'
                                    : cand.kind === 'BEAR_CALL_SPREAD'
                                      ? 'BEAR CALL'
                                      : 'IRON CONDOR'}
                                </span>
                              </td>
                              <td className="py-2.5 px-2.5 text-emerald-400 font-bold">
                                {ccy} {fmtNum(cand.netCreditPerShare, 2)}
                              </td>
                              <td className="py-2.5 px-2.5 text-[#FFFFFF] font-semibold">
                                {fmtNum(cand.creditPctOfWidth, 1)}%
                              </td>
                              <td className="py-2.5 px-2.5 text-[#FFFFFF]">
                                {Number.isFinite(cand.pop) ? `${fmtNum(cand.pop * 100, 1)}%` : '—'}
                              </td>
                              <td
                                className={`py-2.5 px-2.5 font-semibold ${
                                  Number.isFinite(cand.expectedValuePerShare)
                                    ? cand.expectedValuePerShare >= 0
                                      ? 'text-emerald-400'
                                      : 'text-rose-400'
                                    : 'text-[#787B86]'
                                }`}
                              >
                                {Number.isFinite(cand.expectedValuePerShare)
                                  ? `${ccy} ${fmtNum(cand.expectedValuePerShare, 2)}`
                                  : '—'}
                              </td>
                              <td className="py-2.5 px-2.5 text-rose-400">
                                {ccy} {fmtNum(cand.maxLossPerShare, 2)}
                              </td>
                              <td className="py-2.5 px-2.5 text-[#EAB308]">
                                {Number.isFinite(cand.absThetaToVegaRatio)
                                  ? fmtNum(cand.absThetaToVegaRatio, 2)
                                  : '—'}
                              </td>
                              <td className="py-2.5 px-3">
                                <span
                                  className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${getLiquiditySemaphoreBadgeStyle(cand.liquiditySemaphore)}`}
                                >
                                  ● {fmtNum(cand.bidAskPctOfMid, 1)}%
                                </span>
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Panel Resumen de Decisión Spreads (Calls Bull & Puts Bear) */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-[10px] bg-[#101218] border border-[#232733] p-3.5 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#EAB308]">
                  MEJOR BULL CALL SPREAD ({spreadSummaryStats.bestCall ? `${spreadSummaryStats.bestCall.longStrike}/${spreadSummaryStats.bestCall.shortStrike}` : '—'})
                </div>
                {spreadSummaryStats.bestCall && Number.isFinite(spreadSummaryStats.bestCall.bidAskPctOfMid) && (
                  <span
                    title={`Semáforo Bid-Ask % del Mid: ${fmtNum(spreadSummaryStats.bestCall.bidAskPctOfMid, 1)}% (${spreadSummaryStats.bestCall.liquiditySemaphore})`}
                    className={`px-2 py-0.5 rounded-full border font-mono-num text-[10px] font-semibold ${getLiquiditySemaphoreBadgeStyle(spreadSummaryStats.bestCall.liquiditySemaphore)}`}
                  >
                    ● {fmtNum(spreadSummaryStats.bestCall.bidAskPctOfMid, 1)}% Mid
                  </span>
                )}
              </div>
              {spreadSummaryStats.bestCall ? (
                <>
                  <div className="font-mono-num text-[17px] font-extrabold text-[#FFFFFF]">
                    {fmtNum(spreadSummaryStats.bestCall.ratio, 2)}x R/B · Deb {isUsMarket ? 'US$' : '$'} {fmtNum(spreadSummaryStats.bestCall.debit, 2)}
                  </div>
                  <div className="text-[11px] font-mono-num text-[#9CA3AF]">
                    BE {isUsMarket ? 'US$' : '$'} {fmtNum(spreadSummaryStats.bestCall.breakeven, isUsMarket ? 2 : 0)} ({fmtPct(spreadSummaryStats.bestCall.beDistPct, 1)}) · Prob {fmtNum(spreadSummaryStats.bestCall.probBePct, 1)}% · Edge {fmtPct(spreadSummaryStats.bestCall.edgePct, 1)}
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-[#787B86] font-mono-num">Sin Call Spread líquido (Deb ≥ 0,10 y Bid &gt; 0)</div>
              )}
            </div>

            <div className="rounded-[10px] bg-[#101218] border border-[#232733] p-3.5 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#C084FC]">
                  MEJOR BEAR PUT SPREAD ({spreadSummaryStats.bestPut ? `${spreadSummaryStats.bestPut.longStrike}/${spreadSummaryStats.bestPut.shortStrike}` : '—'})
                </div>
                {spreadSummaryStats.bestPut && Number.isFinite(spreadSummaryStats.bestPut.bidAskPctOfMid) && (
                  <span
                    title={`Semáforo Bid-Ask % del Mid: ${fmtNum(spreadSummaryStats.bestPut.bidAskPctOfMid, 1)}% (${spreadSummaryStats.bestPut.liquiditySemaphore})`}
                    className={`px-2 py-0.5 rounded-full border font-mono-num text-[10px] font-semibold ${getLiquiditySemaphoreBadgeStyle(spreadSummaryStats.bestPut.liquiditySemaphore)}`}
                  >
                    ● {fmtNum(spreadSummaryStats.bestPut.bidAskPctOfMid, 1)}% Mid
                  </span>
                )}
              </div>
              {spreadSummaryStats.bestPut ? (
                <>
                  <div className="font-mono-num text-[17px] font-extrabold text-[#FFFFFF]">
                    {fmtNum(spreadSummaryStats.bestPut.ratio, 2)}x R/B · Deb {isUsMarket ? 'US$' : '$'} {fmtNum(spreadSummaryStats.bestPut.debit, 2)}
                  </div>
                  <div className="text-[11px] font-mono-num text-[#9CA3AF]">
                    BE {isUsMarket ? 'US$' : '$'} {fmtNum(spreadSummaryStats.bestPut.breakeven, isUsMarket ? 2 : 0)} ({fmtPct(spreadSummaryStats.bestPut.beDistPct, 1)}) · Prob {fmtNum(spreadSummaryStats.bestPut.probBePct, 1)}% · Edge {fmtPct(spreadSummaryStats.bestPut.edgePct, 1)}
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-[#787B86] font-mono-num">Sin Put Spread líquido (Deb ≥ 0,10 y Bid &gt; 0)</div>
              )}
            </div>

            <div className="rounded-[10px] bg-[#101218] border border-[#8B7CF6]/40 p-3.5 space-y-1 flex flex-col justify-between">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#A78BFA]">
                  INSPECTOR ACTIVO ({spreadSummaryStats.focusedCell ? `${spreadSummaryStats.focusedCell.side} ${spreadSummaryStats.focusedCell.longStrike}/${spreadSummaryStats.focusedCell.shortStrike}` : 'SELECCIONA CELDA'})
                </span>
                {spreadSummaryStats.focusedCell && (
                  <button
                    type="button"
                    onClick={() => {
                      const sel = spreadSummaryStats.focusedCell;
                      if (!sel) return;
                      onOpenOrderTicket({
                        ticker: `${sel.side}-SPREAD-${sel.longStrike}-${sel.shortStrike}`,
                        side: 'Compra',
                        price: sel.debit * LOT,
                        qty: 10,
                        instrumentLabel: `${sel.side === 'CALL' ? 'Bull Call' : 'Bear Put'} ${upperUnderlying} ${sel.longStrike}/${sel.shortStrike} (${sel.widthBases} bases)`,
                      });
                    }}
                    className="px-2 py-0.5 rounded bg-[#8B7CF6] hover:bg-[#7C6CE6] text-white text-[10.5px] font-semibold cursor-pointer"
                  >
                    Operar
                  </button>
                )}
              </div>
              {spreadSummaryStats.focusedCell ? (
                <>
                  <div className="font-mono-num text-[14px] font-bold text-[#FFFFFF]">
                    Débito $ {fmtNum(spreadSummaryStats.focusedCell.debit, 2)} ($ {fmtNum(spreadSummaryStats.focusedCell.debit * LOT, 0)}/lote) · Max Gain $ {fmtNum(spreadSummaryStats.focusedCell.maxProfit, 1)}
                  </div>
                  <div className="text-[11px] font-mono-num text-[#9CA3AF]">
                    R/B {fmtNum(spreadSummaryStats.focusedCell.ratio, 2)}x · BE $ {fmtNum(spreadSummaryStats.focusedCell.breakeven, 1)} ({fmtPct(spreadSummaryStats.focusedCell.beDistPct, 1)}) · Prob {fmtNum(spreadSummaryStats.focusedCell.probBePct, 1)}% · Edge {fmtPct(spreadSummaryStats.focusedCell.edgePct, 1)}
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-[#787B86] font-mono-num">Hacé click en una celda Call o Put para inspeccionar</div>
              )}
            </div>
          </div>

          {spreadSummaryStats.focusedCell && (() => {
            const debCell = spreadSummaryStats.focusedCell;
            const debitWhatIfLegs = buildWhatIfLegsFromDebitCell(
              debCell,
              activeExpiry?.rows ?? [],
              activeDays,
              activeAtmIvDec,
            );
            if (debitWhatIfLegs.length === 0) return null;
            return (
              <WhatIfPayoffSimulator
                key={`deb-whatif-${upperUnderlying}-${debCell.side}-${String(debCell.longStrike)}-${String(debCell.shortStrike)}-${isZeroDte ? '0dte' : 'dte'}`}
                structureLabel={`${debCell.side === 'CALL' ? 'Bull Call' : 'Bear Put'} ${String(debCell.longStrike)}/${String(debCell.shortStrike)}`}
                spot={displaySpot}
                rate={Number.isFinite(effectiveRateDec) ? effectiveRateDec : 0}
                dividendYield={activeDividendYield}
                horizonDte={Math.max(1, Math.round(activeDays || 1))}
                      zeroDte={isZeroDte}
                legs={debitWhatIfLegs}
                currencyPrefix={isUsMarket ? 'US$' : '$'}
                contractMultiplier={Number.isFinite(contractMultiplier) && contractMultiplier > 0 ? contractMultiplier : LOT}
                callWallStrike={Number.isFinite(dealerGammaReport.callWallStrike) ? dealerGammaReport.callWallStrike : null}
                putWallStrike={Number.isFinite(dealerGammaReport.putWallStrike) ? dealerGammaReport.putWallStrike : null}
                zeroGammaSpot={Number.isFinite(dealerGammaReport.zeroGammaSpot) ? dealerGammaReport.zeroGammaSpot : null}
                breakevens={[debCell.breakeven]}
              />
            );
          })()}

          <div className="rounded-[12px] bg-[#101218] border border-[#232733] overflow-hidden">
            <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 border-b border-[#232733]">
              <div className="flex items-center gap-2 flex-wrap">
                {(
                  [
                    { id: 'donde_estoy', label: 'cerca ATM (±8%)' },
                    { id: 'cerca', label: 'cerca del precio (±20%)' },
                    { id: 'todas', label: 'todas' },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setSpreadFilter(f.id)}
                    className={`px-3 py-1 rounded-full text-[12px] font-semibold border cursor-pointer transition-colors ${
                      spreadFilter === f.id
                        ? 'bg-[#1F2433] text-[#FFFFFF] border-[#3E465E]'
                        : 'bg-transparent text-[#9CA3AF] border-[#262B38] hover:text-white'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSpreadViewMode('pares')}
                  className={`px-3.5 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer ${
                    spreadViewMode === 'pares' ? 'bg-[#EAECEF] text-[#0B0E14]' : 'text-[#9CA3AF] hover:text-white'
                  }`}
                >
                  pares
                </button>
                <button
                  type="button"
                  onClick={() => setSpreadViewMode('escalera')}
                  className={`px-3.5 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer ${
                    spreadViewMode === 'escalera' ? 'bg-[#EAECEF] text-[#0B0E14]' : 'text-[#9CA3AF] hover:text-white'
                  }`}
                >
                  escalera
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-center font-mono-num text-[12.5px]">
                <thead>
                  <tr className="border-b border-[#232733] text-[11px] font-bold uppercase tracking-wider">
                    <th colSpan={spreadViewMode === 'pares' ? 1 : 4} className="py-2.5 bg-[#2B2819] text-[#EAB308]">
                      CALL
                    </th>
                    <th className="py-2.5 bg-[#161922] text-[#9CA3AF] w-28" />
                    <th colSpan={spreadViewMode === 'pares' ? 1 : 4} className="py-2.5 bg-[#261D30] text-[#C084FC]">
                      PUT
                    </th>
                  </tr>
                  <tr className="border-b border-[#232733] bg-[#13161F] text-[11.5px] font-medium text-[#9CA3AF]">
                    {spreadViewMode === 'escalera' && (
                      <>
                        <th className="py-2.5 px-3">4 bases</th>
                        <th className="py-2.5 px-3">3 bases</th>
                        <th className="py-2.5 px-3">2 bases</th>
                      </>
                    )}
                    <th className="py-2.5 px-3">1 base</th>
                    <th className="py-2.5 px-4 bg-[#1C202B] text-[#D1D4DC] font-semibold">BASE</th>
                    <th className="py-2.5 px-3">1 base</th>
                    {spreadViewMode === 'escalera' && (
                      <>
                        <th className="py-2.5 px-3">2 bases</th>
                        <th className="py-2.5 px-3">3 bases</th>
                        <th className="py-2.5 px-3">4 bases</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {detailedSpreadRows.length === 0 ? (
                    <tr>
                      <td colSpan={spreadViewMode === 'pares' ? 3 : 9} className="py-8 text-[#787B86]">
                        Sin puntas ni referencias de cierre suficientes en {upperUnderlying} para construir spreads verticales.
                      </td>
                    </tr>
                  ) : (
                    detailedSpreadRows.map((row) => {
                      const isAtmRow =
                        Number.isFinite(displaySpot) &&
                        displaySpot > 0 &&
                        Math.abs(row.strikeNum / displaySpot - 1) <= 0.025;
                      const callCols =
                        spreadViewMode === 'pares'
                          ? [{ metric: row.c1, width: 1 }]
                          : [
                              { metric: row.c4, width: 4 },
                              { metric: row.c3, width: 3 },
                              { metric: row.c2, width: 2 },
                              { metric: row.c1, width: 1 },
                            ];
                      const putCols =
                        spreadViewMode === 'pares'
                          ? [{ metric: row.p1, width: 1 }]
                          : [
                              { metric: row.p1, width: 1 },
                              { metric: row.p2, width: 2 },
                              { metric: row.p3, width: 3 },
                              { metric: row.p4, width: 4 },
                            ];

                      const renderSpreadCell = (cell: SpreadCellMetric | null, key: string) => (
                        <td key={key} className="py-2 px-1.5 align-top">
                          {cell !== null ? (
                            <button
                              type="button"
                              onClick={() => setSelectedSpreadCell(cell)}
                              onDoubleClick={() =>
                                onOpenOrderTicket({
                                  ticker: `${cell.side}-SPREAD-${cell.longStrike}-${cell.shortStrike}`,
                                  side: 'Compra',
                                  price: cell.debit * LOT,
                                  qty: 10,
                                  instrumentLabel: `${cell.side === 'CALL' ? 'Bull Call' : 'Bear Put'} ${upperUnderlying} ${cell.longStrike}/${cell.shortStrike} (${cell.widthBases} bases)`,
                                })
                              }
                              title={`Long ${cell.longStrike} / Short ${cell.shortStrike} · Débito $${fmtNum(cell.debit, 2)} · R/B ${fmtNum(cell.ratio, 2)}x · BE $${fmtNum(cell.breakeven, 1)} (${fmtPct(cell.beDistPct, 1)}) · Prob ${fmtNum(cell.probBePct, 1)}% · Edge ${fmtPct(cell.edgePct, 1)} (Click para inspeccionar · Doble click para operar)`}
                              className={`w-full rounded-[6px] px-1.5 py-1 flex flex-col items-center gap-0.5 cursor-pointer transition-all hover:bg-[#1E2434] ${
                                selectedSpreadCell?.longStrike === cell.longStrike &&
                                selectedSpreadCell?.shortStrike === cell.shortStrike &&
                                selectedSpreadCell?.side === cell.side
                                  ? 'ring-1 ring-[#8B7CF6] bg-[#1E1B33]'
                                  : ''
                              }`}
                            >
                              <div className="inline-flex items-center gap-1">
                                <span
                                  className={`px-2 py-0.5 rounded-full font-bold text-[11.5px] ${getSpreadPillColor(
                                    cell.ratio
                                  )}`}
                                >
                                  {fmtNum(cell.ratio, 2)}x
                                </span>
                                {Number.isFinite(cell.bidAskPctOfMid) && (
                                  <span
                                    className={`px-1.5 py-0.2 rounded-full border font-mono-num text-[8.5px] font-semibold ${getLiquiditySemaphoreBadgeStyle(cell.liquiditySemaphore)}`}
                                  >
                                    ● {fmtNum(cell.bidAskPctOfMid, 0)}%
                                  </span>
                                )}
                              </div>
                              <span className="text-[9.5px] font-mono-num text-[#9CA3AF] leading-tight whitespace-nowrap">
                                Deb {isUsMarket ? 'US$' : '$'}{fmtNum(cell.debit, isUsMarket ? 2 : 1)} · BE {fmtPct(cell.beDistPct, 1)}
                              </span>
                              <span
                                className={`text-[9.5px] font-mono-num leading-tight whitespace-nowrap ${
                                  Number.isFinite(cell.edgePct)
                                    ? cell.edgePct >= 0
                                      ? 'text-[#22C55E]'
                                      : 'text-[#9CA3AF]'
                                    : 'text-[#6D7282]'
                                }`}
                              >
                                P:{fmtNum(cell.probBePct, 0)}% · E:{fmtPct(cell.edgePct, 1)}
                              </span>
                            </button>
                          ) : (
                            <span className="text-[#6D7282] inline-block py-2">—</span>
                          )}
                        </td>
                      );

                      return (
                        <React.Fragment key={row.strikeNum}>
                          <tr className={`border-b border-[#1A1E29] ${isAtmRow ? 'bg-[#1B1F2A]' : 'hover:bg-[#161A24]'}`}>
                            {callCols.map((c, cIdx) => renderSpreadCell(c.metric, `c-${cIdx}`))}

                            <td className={`py-2.5 px-4 font-bold text-[#FFFFFF] align-middle ${isAtmRow ? 'bg-[#2A2F3D]' : 'bg-[#1C202B]'}`}>
                              {row.base}
                            </td>

                            {putCols.map((p, pIdx) => renderSpreadCell(p.metric, `p-${pIdx}`))}
                          </tr>

                          {row.spotMarkerAfter && (
                            <tr>
                              <td colSpan={spreadViewMode === 'pares' ? 3 : 9} className="p-0 relative h-0">
                                <div className="w-full border-t border-[#EAB308]/80 relative flex justify-center items-center">
                                  <span className="-top-2.5 px-2 py-0.2 rounded-full bg-[#EAB308] text-[#0B0E14] font-mono-num font-extrabold text-[10.5px] shadow">
                                    {row.spotMarkerAfter}
                                  </span>
                                </div>
                              </td>
                            </tr>
                          )}

                          {row.sigmaMarkerAfter && (
                            <tr>
                              <td colSpan={spreadViewMode === 'pares' ? 3 : 9} className="p-0 relative h-0">
                                <div className="w-full border-t border-dashed border-[#6D7282] relative flex justify-center items-center">
                                  <span className="-top-2.5 px-2 py-0.2 rounded-full bg-[#1C202B] border border-[#6D7282] text-[#D1D4DC] font-mono-num font-bold text-[10px]">
                                    {row.sigmaMarkerAfter}
                                  </span>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
            </>
          )}
        </div>
      )}

      {/* =====================================================================
          4. MÓDULO 3: FLUJO DE DINERO EN OPCIONES
          ===================================================================== */}
      {activeSubView === 'flujo' && (
        <div className="space-y-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[24px] font-extrabold text-[#FFFFFF] tracking-tight">Flujo</h2>
              <HelpTooltip
                title="Volumen, Gamma Exposure y Régimen de Dealers"
                text="Analiza el volumen operado por base, Pin/Max Pain y la exposición gamma de los dealers (Call Wall, Put Wall y Zero Gamma)."
              />
            </div>
            <p className="text-[13px] text-[#9CA3AF]">
              Volumen operado, Pin y niveles GEX en cada base de {upperUnderlying} ({activeExpiry?.label ?? '—'}).
            </p>
          </div>

          {/* Pieza 46: Régimen de Dealers (Long Gamma / Short Gamma) + Call Wall / Put Wall / Zero Gamma */}
          <div
            className={`rounded-[12px] border p-4 space-y-3 ${
              dealerGammaReport.regime === 'LONG_GAMMA'
                ? 'bg-emerald-950/25 border-emerald-500/45'
                : dealerGammaReport.regime === 'SHORT_GAMMA'
                  ? 'bg-rose-950/25 border-rose-500/45'
                  : 'bg-[#12141A] border-[#232733]'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`px-2.5 py-0.5 rounded-full border font-mono-num text-[11px] font-extrabold tracking-wide ${
                      dealerGammaReport.regime === 'LONG_GAMMA'
                        ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-300'
                        : dealerGammaReport.regime === 'SHORT_GAMMA'
                          ? 'border-rose-400/60 bg-rose-500/20 text-rose-300'
                          : 'border-[#33394A] bg-[#0B0E14] text-[#9CA3AF]'
                    }`}
                  >
                    {dealerGammaReport.regime === 'LONG_GAMMA'
                      ? 'LONG GAMMA (Net GEX > 0)'
                      : dealerGammaReport.regime === 'SHORT_GAMMA'
                        ? 'SHORT GAMMA (Net GEX < 0)'
                        : dealerGammaReport.regime === 'NEUTRAL'
                          ? 'GAMMA NEUTRAL'
                          : 'RÉGIMEN GEX —'}
                  </span>
                  <span className="text-[13px] font-bold text-[#FFFFFF]">
                    {dealerGammaReport.behaviorLabel}
                  </span>
                </div>
                <p
                  className={`text-[12px] ${
                    dealerGammaReport.creditStrategySignal === 'GREEN_LIGHT'
                      ? 'text-emerald-300'
                      : dealerGammaReport.creditStrategySignal === 'CAUTION_SHORT_WINGS'
                        ? 'text-rose-300'
                        : 'text-[#9CA3AF]'
                  }`}
                >
                  {dealerGammaReport.strategyGuidance}
                </p>
              </div>
              {Number.isFinite(dealerGammaReport.distanceToZeroGammaPct) && (
                <div className="text-right font-mono-num text-[11.5px] text-[#D1D4DC]">
                  <div>
                    Spot vs Zero Gamma:{' '}
                    <strong className="text-[#FFFFFF]">
                      {dealerGammaReport.spotVsZeroGamma === 'ABOVE_ZERO_GAMMA'
                        ? 'Sobre Flip'
                        : dealerGammaReport.spotVsZeroGamma === 'BELOW_ZERO_GAMMA'
                          ? 'Debajo Flip'
                          : 'En Flip'}
                    </strong>
                  </div>
                  <div className="text-[#9CA3AF]">
                    Distancia: {dealerGammaReport.distanceToZeroGammaPct >= 0 ? '+' : ''}
                    {fmtNum(dealerGammaReport.distanceToZeroGammaPct, 2)}%
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-2 border-t border-[#1E222D]/80 font-mono-num">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#787B86]">NET GEX (1% SPOT)</div>
                <div
                  className={`text-[15px] font-extrabold ${
                    Number.isFinite(dealerGammaReport.netGex)
                      ? dealerGammaReport.netGex >= 0
                        ? 'text-emerald-400'
                        : 'text-rose-400'
                      : 'text-[#787B86]'
                  }`}
                >
                  {Number.isFinite(dealerGammaReport.netGex)
                    ? (() => {
                        const v = dealerGammaReport.netGex;
                        const sign = v > 0 ? '+' : v < 0 ? '-' : '';
                        const ccy = isUsMarket ? 'US$' : '$';
                        const abs = Math.abs(v);
                        if (abs >= 1e9) return `${sign}${ccy} ${fmtNum(abs / 1e9, 2)} B`;
                        if (abs >= 1e6) return `${sign}${ccy} ${fmtNum(abs / 1e6, 2)} M`;
                        if (abs >= 1e3) return `${sign}${ccy} ${fmtNum(abs / 1e3, 1)} K`;
                        return `${sign}${ccy} ${fmtNum(abs, 0)}`;
                      })()
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#787B86]">CALL WALL (CW)</div>
                <div className="text-[15px] font-extrabold text-[#EAB308]">
                  {Number.isFinite(dealerGammaReport.callWallStrike)
                    ? formatStrike(dealerGammaReport.callWallStrike)
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#787B86]">PUT WALL (PW)</div>
                <div className="text-[15px] font-extrabold text-[#C084FC]">
                  {Number.isFinite(dealerGammaReport.putWallStrike)
                    ? formatStrike(dealerGammaReport.putWallStrike)
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#787B86]">ZERO GAMMA (FLIP)</div>
                <div className="text-[15px] font-extrabold text-[#38BDF8]">
                  {Number.isFinite(dealerGammaReport.zeroGammaSpot)
                    ? formatStrike(dealerGammaReport.zeroGammaSpot)
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#787B86]">GEX/CHARM PIN</div>
                <div className="text-[15px] font-extrabold text-[#D1D4DC]">
                  {activeQuantEngines?.gexCharmPin?.gexCharmPinStrike != null &&
                  Number.isFinite(activeQuantEngines.gexCharmPin.gexCharmPinStrike)
                    ? formatStrike(activeQuantEngines.gexCharmPin.gexCharmPinStrike)
                    : '—'}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-2">
              <div className="flex items-center gap-1.5 text-[13px] text-[#D1D4DC] font-medium">
                <span>Balance de actividad Calls vs. Puts</span>
                <HelpCircle className="w-3.5 h-3.5 text-[#6D7282]" />
              </div>
              <div className="text-[22px] font-extrabold text-[#FFFFFF] tracking-tight">
                {flowSummary.dominantDirection}
              </div>
              <div className="text-[13px] text-[#9CA3AF]">
                {Number.isFinite(flowSummary.netDeltaEqShares)
                  ? `Delta neto ponderado por volumen: ${flowSummary.netDeltaEqShares >= 0 ? '+' : ''}${fmtNum(flowSummary.netDeltaEqShares, 0)} acc. equivalentes`
                  : 'Delta equivalente ponderado: —'}
              </div>
            </div>

            <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-2">
              <div className="flex items-center gap-1.5 text-[13px] text-[#D1D4DC] font-medium">
                <span>Relación Put / Call &amp; Gama de Bases</span>
                <HelpCircle className="w-3.5 h-3.5 text-[#6D7282]" />
              </div>
              <div className="text-[22px] font-extrabold text-[#FFFFFF] tracking-tight">
                Ratio P/C: {Number.isFinite(flowSummary.putCallRatio) ? fmtNum(flowSummary.putCallRatio, 2) : '—'}
              </div>
              <div className="text-[13px] text-[#9CA3AF]">
                Calls: {fmtNum(flowSummary.totalCallLots, 0)} lotes · Puts: {fmtNum(flowSummary.totalPutLots, 0)} lotes
              </div>
            </div>
          </div>

          <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-4">
            <div className="flex items-center gap-1.5 text-[13.5px] font-bold text-[#FFFFFF]">
              <span>Rueda completa ({activeExpiry?.label ?? '—'})</span>
              <HelpCircle className="w-3.5 h-3.5 text-[#6D7282]" />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#787B86]">
                  LOTES OPERADOS
                </div>
                <div className="font-mono-num text-[18px] font-extrabold text-[#FFFFFF] mt-0.5">
                  {flowSummary.totalLots > 0 ? fmtNum(flowSummary.totalLots, 0) : '—'}
                </div>
              </div>
              <div>
                <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#787B86]">
                  {isUsMarket ? 'EN USD (PRIMAS)' : 'EN PESOS (PRIMAS)'}
                </div>
                <div className="font-mono-num text-[18px] font-extrabold text-[#FFFFFF] mt-0.5">
                  {Number.isFinite(flowSummary.totalTurnoverM) && flowSummary.totalTurnoverM > 0
                    ? fmtMoneyCompact(flowSummary.totalTurnoverM)
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#787B86]">
                  AGRESIÓN TICKS
                </div>
                {activeTickAggression && activeTickAggression.netBiasPct != null && Number.isFinite(activeTickAggression.netBiasPct) ? (
                  <>
                    <div
                      className={`font-mono-num text-[15px] font-extrabold mt-0.5 ${
                        activeTickAggression.direction === 'COMPRADOR'
                          ? 'text-[#22C55E]'
                          : activeTickAggression.direction === 'VENDEDOR'
                            ? 'text-[#F23645]'
                            : 'text-[#F5B544]'
                      }`}
                    >
                      {activeTickAggression.label}
                    </div>
                    <div className="text-[10.5px] font-mono-num text-[#9CA3AF]">
                      Ask {fmtNum(activeTickAggression.askPct, 0)}% · Bid {fmtNum(activeTickAggression.bidPct, 0)}% ({activeTickAggression.method === 'LEE_READY_BBO' ? 'Lee-Ready' : 'Cierre EOD'})
                    </div>
                  </>
                ) : (
                  <div className="font-mono-num text-[18px] font-extrabold text-[#787B86] mt-0.5">
                    —
                  </div>
                )}
              </div>
              <div>
                <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#787B86]">
                  PARTICIPACIÓN CALLS
                </div>
                <div className="font-mono-num text-[18px] font-extrabold text-[#22C55E] mt-0.5">
                  {Number.isFinite(flowSummary.callSharePct) ? `${fmtNum(flowSummary.callSharePct, 0)}%` : '—'}
                </div>
              </div>
            </div>

            {Number.isFinite(flowSummary.callSharePct) && (
              <div className="w-full h-2.5 rounded-full overflow-hidden flex bg-[#232733]">
                <div style={{ width: `${flowSummary.callSharePct}%` }} className="h-full bg-[#EAB308]" />
                <div style={{ width: `${100 - flowSummary.callSharePct}%` }} className="h-full bg-[#A855F7]" />
              </div>
            )}

            {activeQuantEngines && (
              <div className="pt-3 border-t border-[#1E222D] grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11.5px] font-mono-num">
                <div>
                  <div className="text-[10px] uppercase text-[#787B86]">LA PLATA NETA (CVD)</div>
                  <div
                    className={`font-bold text-[14px] ${
                      (activeQuantEngines.orderFlowArs?.netDirectionalPremiumUsd ?? 0) >= 0
                        ? 'text-[#22C55E]'
                        : 'text-[#F23645]'
                    }`}
                  >
                    {activeQuantEngines.orderFlowArs?.netDirectionalPremiumUsd != null
                      ? `$ ${fmtNum(activeQuantEngines.orderFlowArs.netDirectionalPremiumUsd, 0)}`
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-[#787B86]">
                    {isUsMarket ? 'EN USD (NETO)' : 'EN USD-CCL'}
                  </div>
                  <div className="font-bold text-[14px] text-[#38BDF8]">
                    {activeQuantEngines.netDirectionalPremiumUsdCcl != null
                      ? `US$ ${fmtNum(activeQuantEngines.netDirectionalPremiumUsdCcl, 0)}`
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-[#787B86]">GEX/CHARM PIN &amp; WALLS</div>
                  <div className="font-bold text-[14px] text-[#C084FC]">
                    {activeQuantEngines.gexCharmPin?.gexCharmPinStrike != null
                      ? `Pin $${fmtNum(activeQuantEngines.gexCharmPin.gexCharmPinStrike, 1)}`
                      : '—'}
                  </div>
                  <div className="text-[10px] text-[#9CA3AF]">
                    CW: {activeQuantEngines.flowAdjustedGex?.callWallStrike ?? '—'} · PW:{' '}
                    {activeQuantEngines.flowAdjustedGex?.putWallStrike ?? '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-[#787B86]">ANOMALÍAS MAD VOL/OI</div>
                  <div className="font-bold text-[14px] text-[#EAB308]">
                    {activeQuantEngines.volOiAnomalies?.anomalies?.length ?? 0} bases
                  </div>
                  <div className="text-[10px] text-[#9CA3AF] truncate">
                    {activeQuantEngines.volOiAnomalies?.anomalies?.[0]
                      ? `${activeQuantEngines.volOiAnomalies.anomalies[0].contractType.toUpperCase()} ${activeQuantEngines.volOiAnomalies.anomalies[0].strike ?? ''} (z=${fmtNum(activeQuantEngines.volOiAnomalies.anomalies[0].madLogScore, 1)})`
                      : 'Sin outliers MAD'}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-[12px] bg-[#101218] border border-[#232733] overflow-hidden">
            <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 border-b border-[#232733]">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-[13.5px] font-bold text-[#FFFFFF]">
                  <span>Por base</span>
                  <HelpCircle className="w-3.5 h-3.5 text-[#6D7282]" />
                </div>

                <div className="flex items-center gap-1 border-l border-[#232733] pl-3">
                  <span className="p-1.5 rounded bg-[#1E2330] text-[#FFFFFF]">
                    <AlignLeft className="w-3.5 h-3.5" />
                  </span>
                </div>

                <div className="flex items-center gap-1 border-l border-[#232733] pl-3 text-[12.5px]">
                  <button
                    type="button"
                    onClick={() => setFlowUnit('lotes')}
                    className={`px-3 py-1 rounded-full font-bold cursor-pointer ${
                      flowUnit === 'lotes' ? 'bg-[#EAECEF] text-[#0B0E14]' : 'text-[#9CA3AF] hover:text-white'
                    }`}
                  >
                    lotes
                  </button>
                  <button
                    type="button"
                    onClick={() => setFlowUnit('$')}
                    className={`px-3 py-1 rounded-full font-bold cursor-pointer ${
                      flowUnit === '$' ? 'bg-[#EAECEF] text-[#0B0E14]' : 'text-[#9CA3AF] hover:text-white'
                    }`}
                  >
                    $
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                {(['hoy', 'anterior', 'vencimiento'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setFlowPeriod(p)}
                    className={`px-3.5 py-1.5 rounded-full text-[12.5px] font-bold cursor-pointer transition-colors ${
                      flowPeriod === p ? 'bg-[#EAECEF] text-[#0B0E14]' : 'text-[#9CA3AF] hover:text-white'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-12 border-b border-[#232733] text-[11px] font-bold uppercase tracking-wider text-center">
              <div className="col-span-4 py-2.5 bg-[#2B2819] text-[#EAB308]">CALL</div>
              <div className="col-span-4 py-2.5 bg-[#161922] text-[#9CA3AF]">BASE · WALLS / GEX</div>
              <div className="col-span-4 py-2.5 bg-[#261D30] text-[#C084FC]">PUT</div>
            </div>

            <div className="divide-y divide-[#1A1E29] font-mono-num text-[12px]">
              {flowSummary.rows.length === 0 ? (
                <div className="py-8 text-center text-[#787B86]">
                  Sin flujo operado reportado para {upperUnderlying}.
                </div>
              ) : (
                flowSummary.rows.map((r: BidirectionalFlowRow, rIdx: number) => {
                  const gexRow = exposureByStrikeMap.get(r.strikeNum);
                  const netGexStrike = gexRow?.netGex ?? null;
                  const isCallWall =
                    Number.isFinite(dealerGammaReport.callWallStrike) &&
                    Math.abs(r.strikeNum - dealerGammaReport.callWallStrike) < 1e-6;
                  const isPutWall =
                    Number.isFinite(dealerGammaReport.putWallStrike) &&
                    Math.abs(r.strikeNum - dealerGammaReport.putWallStrike) < 1e-6;
                  const pinK = activeQuantEngines?.gexCharmPin?.gexCharmPinStrike ?? null;
                  const isPinStrike =
                    pinK !== null && Number.isFinite(pinK) && Math.abs(r.strikeNum - pinK) < 1e-6;
                  const zgSpot = dealerGammaReport.zeroGammaSpot;
                  const prevRow = rIdx > 0 ? flowSummary.rows[rIdx - 1] : undefined;
                  const showZeroGammaBefore =
                    Number.isFinite(zgSpot) &&
                    prevRow !== undefined &&
                    Math.min(prevRow.strikeNum, r.strikeNum) < zgSpot &&
                    Math.max(prevRow.strikeNum, r.strikeNum) >= zgSpot;
                  const gexLabel =
                    netGexStrike !== null && Number.isFinite(netGexStrike)
                      ? `${netGexStrike >= 0 ? '+' : '-'}${
                          Math.abs(netGexStrike) >= 1e6
                            ? `${fmtNum(Math.abs(netGexStrike) / 1e6, 1)}M`
                            : Math.abs(netGexStrike) >= 1e3
                              ? `${fmtNum(Math.abs(netGexStrike) / 1e3, 0)}K`
                              : fmtNum(Math.abs(netGexStrike), 0)
                        }`
                      : null;

                  return (
                    <React.Fragment key={r.strikeNum}>
                      {showZeroGammaBefore && (
                        <div className="flex items-center justify-center gap-2 py-1 bg-cyan-950/35 border-y border-cyan-500/45 text-[10.5px] font-bold text-[#38BDF8]">
                          <span>ZERO GAMMA (Gamma Flip)</span>
                          <span className="px-1.5 py-0.2 rounded bg-[#0B0E14] border border-cyan-500/40 text-[#FFFFFF]">
                            {formatStrike(zgSpot)}
                          </span>
                        </div>
                      )}
                      <div
                        className={`grid grid-cols-12 items-center min-h-9 py-1 ${
                          r.isAtm ? 'bg-[#1E222E]' : 'hover:bg-[#151922]'
                        }`}
                      >
                        <div className="col-span-4 flex items-center h-full px-3 gap-2">
                          <span
                            className={`w-14 text-right font-bold shrink-0 ${
                              r.callNetDir === 'pos' ? 'text-[#EAB308]' : 'text-[#6D7282]'
                            }`}
                          >
                            {r.callNetLabel}
                          </span>
                          <div className="flex-1 h-5 flex items-center justify-start relative">
                            {r.callTotalPct > 0 && (
                              <div
                                style={{ width: `${r.callTotalPct}%` }}
                                className="h-5 rounded-[3px] bg-[#5E5438] relative overflow-hidden flex items-center"
                              >
                                {r.callNetHighlightPct > 0 && (
                                  <div
                                    style={{ width: `${Math.min(100, r.callNetHighlightPct)}%` }}
                                    className="h-full bg-[#EAB308]"
                                  />
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        <div
                          className={`col-span-4 h-full px-2 flex flex-wrap items-center justify-center gap-1.5 font-bold text-[#FFFFFF] border-x border-[#232733] ${
                            r.isAtm ? 'bg-[#2B3040]' : 'bg-[#181B24]'
                          }`}
                        >
                          <span>{r.base}</span>
                          {isCallWall && (
                            <span
                              title="Call Wall (Mayor GEX / OI Call)"
                              className="px-1.5 py-0.2 rounded bg-amber-500/20 border border-amber-400/50 text-[9.5px] font-bold text-[#EAB308]"
                            >
                              CW
                            </span>
                          )}
                          {isPutWall && (
                            <span
                              title="Put Wall (Mayor GEX / OI Put)"
                              className="px-1.5 py-0.2 rounded bg-purple-500/20 border border-purple-400/50 text-[9.5px] font-bold text-[#C084FC]"
                            >
                              PW
                            </span>
                          )}
                          {isPinStrike && (
                            <span
                              title="GEX/Charm Pin"
                              className="px-1.5 py-0.2 rounded bg-cyan-500/20 border border-cyan-400/50 text-[9.5px] font-bold text-[#38BDF8]"
                            >
                              PIN
                            </span>
                          )}
                          {gexLabel !== null && (
                            <span
                              title="Net GEX por base (USD por 1% Spot)"
                              className={`text-[9.5px] font-semibold ${
                                (netGexStrike ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                              }`}
                            >
                              GEX {gexLabel}
                            </span>
                          )}
                        </div>

                        <div className="col-span-4 flex items-center justify-end h-full px-3 gap-2">
                          <div className="flex-1 h-5 flex items-center justify-end relative">
                            {r.putTotalPct > 0 && (
                              <div
                                style={{ width: `${r.putTotalPct}%` }}
                                className="h-5 rounded-[3px] bg-[#564D65] relative overflow-hidden flex items-center justify-end"
                              >
                                {r.putNetHighlightPct > 0 && (
                                  <div
                                    style={{ width: `${Math.min(100, r.putNetHighlightPct)}%` }}
                                    className="h-full bg-[#A855F7]"
                                  />
                                )}
                              </div>
                            )}
                          </div>
                          <span
                            className={`w-14 text-left font-bold shrink-0 ${
                              r.putNetDir === 'neg' ? 'text-[#C084FC]' : 'text-[#6D7282]'
                            }`}
                          >
                            {r.putNetLabel}
                          </span>
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          5. MÓDULO 4: CADENA COMPLETA DE OPCIONES ("EL TEÓRICO")
          ===================================================================== */}
      {activeSubView === 'cadena' && (
        <div className="space-y-3">
          <div className="rounded-[12px] bg-[#111116] border border-[#1C1C24] px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 pr-2.5 mr-0.5 border-r border-[#1E222D]">
                <CompanyLogo ticker={upperUnderlying} name={stockName} size="sm" />
                <span className="font-mono-num text-[12px] font-bold text-[#F3F4F6]">
                  {upperUnderlying}
                </span>
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#6B7280] flex items-center gap-1">
                <SlidersHorizontal className="w-3.5 h-3.5" /> Columnas:
              </span>
              {(
                [
                  { id: 'completa', label: 'Completa' },
                  { id: 'griegas', label: 'Griegas (Δ · Γ · Θ · Vega)' },
                  { id: 'valortiempo', label: 'Valor Tiempo y Paridad' },
                  { id: 'liquidez', label: 'Volumen e Interés Abierto' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setColMode(m.id)}
                  className={`px-2.5 py-1 rounded-[8px] text-[12px] font-medium transition-colors cursor-pointer border ${
                    colMode === m.id
                      ? 'bg-[#1A1A23] text-[#F3F4F6] border-[#38BDF8]/60'
                      : 'text-[#9CA3AF] hover:text-[#F3F4F6] bg-[#0A0A0D] border-[#1C1C24]'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-1 text-[11px] text-[#9CA3AF]">
                <span className="text-[#6B7280] mr-1">Click punta:</span>
                <button
                  type="button"
                  onClick={() => setQuoteClickTarget('ticket')}
                  className={`px-2 py-0.5 rounded-[6px] border text-[11px] cursor-pointer transition-colors ${
                    quoteClickTarget === 'ticket'
                      ? 'bg-[#1E1E2B] text-[#E5E7EB] border-[#38BDF8]/50 font-semibold'
                      : 'bg-[#0A0A0D] text-[#6B7280] border-[#1C1C24] hover:text-[#9CA3AF]'
                  }`}
                >
                  Ticket
                </button>
                <button
                  type="button"
                  onClick={() => setQuoteClickTarget('armado')}
                  className={`px-2 py-0.5 rounded-[6px] border text-[11px] cursor-pointer transition-colors ${
                    quoteClickTarget === 'armado'
                      ? 'bg-[#1E1E2B] text-[#E5E7EB] border-[#38BDF8]/50 font-semibold'
                      : 'bg-[#0A0A0D] text-[#6B7280] border-[#1C1C24] hover:text-[#9CA3AF]'
                  }`}
                >
                  Armado
                </button>
              </div>

              <div className="flex items-center gap-1.5 text-[12px] text-[#9CA3AF]">
                <span className="text-[#6B7280]">Banda σ:</span>
                {([1, 1.5, 2] as const).map((sig) => (
                  <button
                    key={sig}
                    type="button"
                    onClick={() => {
                      setSigmaMultiplier(sig);
                      setOnlySigmaRange(true);
                    }}
                    className={`px-2 py-0.5 rounded-[6px] font-mono-num text-[11px] border cursor-pointer transition-colors ${
                      sigmaMultiplier === sig && onlySigmaRange
                        ? 'bg-[#1E1E2B] text-[#F3F4F6] border-[#38BDF8]/60 font-semibold'
                        : 'bg-[#0A0A0D] text-[#9CA3AF] border-[#1C1C24] hover:text-[#F3F4F6]'
                    }`}
                  >
                    ±{sig}σ
                  </button>
                ))}
              </div>
              <label className="inline-flex items-center gap-2 text-[12px] text-[#9CA3AF] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={onlySigmaRange}
                  onChange={(e) => setOnlySigmaRange(e.target.checked)}
                  className="rounded accent-[#38BDF8]"
                />
                <span>Solo bases dentro de ±1σ{sigmaMultiplier !== 1 ? ` (activa: ±${sigmaMultiplier}σ)` : ''}</span>
              </label>
            </div>
          </div>

          {GGAL_OPTION_EXPIRIES.length === 0 ? (
            <div className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] p-6 text-[13px] text-[#9CA3AF]">
              Sin vencimientos de opciones cargados para {upperUnderlying}. Esperando datos de Data912 / Open BYMA...
            </div>
          ) : (
            GGAL_OPTION_EXPIRIES.map((exp) => {
              const isOpen = expandedExpiries[exp.id] ?? true;
              const rawExpiry = liveOptions?.expiries.find((e) => e.expiryCode === exp.id);
              const { summary, rows: enrichedRows } = buildEnrichedChainForExpiry({
                exp,
                rawExpiry,
                liveOptions,
                spot: displaySpot,
                rateDec: effectiveRateDec,
                holdingsBySymbol: optionHoldingsMap,
                marketStateLabel: liveMarket.marketStateLabel,
              });

              const spotValidForBand = Number.isFinite(displaySpot) && displaySpot > 0;
              const bandLow =
                spotValidForBand && Number.isFinite(summary.band1SigmaAbs) && summary.band1SigmaAbs > 0
                  ? displaySpot - sigmaMultiplier * summary.band1SigmaAbs
                  : Number.NaN;
              const bandHigh =
                spotValidForBand && Number.isFinite(summary.band1SigmaAbs) && summary.band1SigmaAbs > 0
                  ? displaySpot + sigmaMultiplier * summary.band1SigmaAbs
                  : Number.NaN;

              const isRowInBand = (r: EnrichedChainRow): boolean =>
                Number.isFinite(bandLow) && Number.isFinite(bandHigh)
                  ? r.row.strike >= bandLow - 1e-9 && r.row.strike <= bandHigh + 1e-9
                  : r.row.inOneSigma;

              const filteredRows = onlySigmaRange ? enrichedRows.filter(isRowInBand) : enrichedRows;

              const { beforeFirst, afterIndex } = computeInlineMarkersForRows({
                rows: filteredRows,
                spot: displaySpot,
                band1SigmaAbs: summary.band1SigmaAbs,
                sigmaMultiplier,
                onlySigmaRange,
              });

              const handleQuoteClick = (
                e: React.MouseEvent,
                item: EnrichedChainRow,
                optType: 'Call' | 'Put',
                side: 'Compra' | 'Venta',
                price: number,
                ticker: string
              ) => {
                if (!Number.isFinite(price) || price <= 0) return;
                if (quoteClickTarget === 'armado' || e.shiftKey) {
                  setLegs((prev) => [
                    ...prev,
                    {
                      ...legFromRow(item.row, optType, side, 10),
                      premium: +price.toFixed(2),
                    },
                  ]);
                  setBuilderSeedKey(`${upperUnderlying}:custom`);
                  onSelectSubView('armado');
                  return;
                }
                onOpenOrderTicket({
                  ticker,
                  side,
                  price,
                  qty: 10,
                  instrumentLabel: `${optType} ${upperUnderlying} Base ${fmtNum(item.row.strike, 0)} (${exp.id})`,
                });
              };

              const callBarPct = Number.isFinite(summary.callSharePct)
                ? Math.min(100, Math.max(0, summary.callSharePct))
                : 0;
              const putBarPct = Number.isFinite(summary.putSharePct)
                ? Math.min(100, Math.max(0, summary.putSharePct))
                : 0;

              return (
                <div key={exp.id} className="rounded-[12px] bg-[#0A0A0D] border border-[#1C1C24] overflow-hidden">
                  {/* Encabezado de Vencimiento — 3 Líneas Compactas */}
                  <div
                    onClick={() => setExpandedExpiries((prev) => ({ ...prev, [exp.id]: !isOpen }))}
                    className="px-4 py-3 bg-[#111116] border-b border-[#1C1C24] cursor-pointer hover:bg-[#15151D] space-y-2"
                  >
                    {/* Línea 1: Fecha + días + estado */}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        {isOpen ? (
                          <ChevronDown className="w-4 h-4 text-[#9CA3AF]" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-[#9CA3AF]" />
                        )}
                        <span className="font-bold text-[14px] text-[#F3F4F6] tracking-tight">
                          {summary.formattedDate} ·{' '}
                          <span className="font-mono-num text-[#9CA3AF]">{formatDteLabel(exp.daysToExpiry)}</span>
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 text-[11.5px] font-medium">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            summary.isOperating ? 'bg-[#22C55E]' : 'bg-[#6B7280]'
                          }`}
                        />
                        <span className={summary.isOperating ? 'text-[#22C55E]' : 'text-[#9CA3AF]'}>
                          {summary.statusText}
                        </span>
                      </div>
                    </div>

                    {/* Línea 2: Dos barras horizontales apiladas CALL / PUT */}
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-3 text-[11.5px] font-mono-num">
                        <span className="w-10 text-[10.5px] font-bold tracking-wider text-[#E5C76B] shrink-0">
                          CALL
                        </span>
                        <div className="flex-1 h-1.5 rounded-full bg-[#181822] overflow-hidden">
                          <div
                            style={{ width: `${callBarPct}%` }}
                            className="h-full rounded-full bg-[#E5C76B]"
                          />
                        </div>
                        <span className="text-[#E5E7EB] min-w-[210px] text-right">
                          {Number.isFinite(summary.callSharePct) ? `${fmtNum(summary.callSharePct, 1)}%` : '—'}
                          <span className="text-[#6B7280]"> · </span>
                          {fmtNum(summary.callLots, 0)} lotes
                          <span className="text-[#6B7280]"> · </span>
                          {Number.isFinite(summary.callTurnoverArsM)
                            ? `$${fmtNum(summary.callTurnoverArsM, 1)}M`
                            : '—'}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-[11.5px] font-mono-num">
                        <span className="w-10 text-[10.5px] font-bold tracking-wider text-[#B794F4] shrink-0">
                          PUT
                        </span>
                        <div className="flex-1 h-1.5 rounded-full bg-[#181822] overflow-hidden">
                          <div
                            style={{ width: `${putBarPct}%` }}
                            className="h-full rounded-full bg-[#B794F4]"
                          />
                        </div>
                        <span className="text-[#E5E7EB] min-w-[210px] text-right">
                          {Number.isFinite(summary.putSharePct) ? `${fmtNum(summary.putSharePct, 1)}%` : '—'}
                          <span className="text-[#6B7280]"> · </span>
                          {fmtNum(summary.putLots, 0)} lotes
                          <span className="text-[#6B7280]"> · </span>
                          {Number.isFinite(summary.putTurnoverArsM)
                            ? `$${fmtNum(summary.putTurnoverArsM, 1)}M`
                            : '—'}
                        </span>
                      </div>
                    </div>

                    {/* Línea 3: Resumen de flujo reciente + línea cuantitativa */}
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] font-mono-num text-[#9CA3AF] pt-0.5">
                      <span className="font-sans text-[#9CA3AF]">{summary.flowLeaderLabel}</span>
                      <span>
                        VI <span className="text-[#E5E7EB]">{fmtNum(summary.atmIvPct, 1)}%</span>
                        {' · '}descuenta{' '}
                        <span className="text-[#E5E7EB]">
                          {Number.isFinite(summary.oneSigmaMoveAbs)
                            ? `±$${fmtNum(summary.oneSigmaMoveAbs, 0)}`
                            : '—'}
                        </span>{' '}
                        ({Number.isFinite(summary.oneSigmaMovePct) ? `${fmtNum(summary.oneSigmaMovePct, 1)}%` : '—'})
                        {' · '}OI{' '}
                        <span className="text-[#E5E7EB]">
                          {Number.isFinite(summary.totalOi) ? fmtNum(summary.totalOi, 0) : '—'}
                        </span>
                        {' · '}max pain{' '}
                        <span className="text-[#E5E7EB]">
                          {Number.isFinite(summary.maxPainStrike) ? fmtNum(summary.maxPainStrike, 0) : '—'}
                        </span>{' '}
                        (
                        {Number.isFinite(summary.maxPainDistPct)
                          ? `${summary.maxPainDistPct >= 0 ? '+' : ''}${fmtNum(summary.maxPainDistPct, 1)}%`
                          : '—'}{' '}
                        vs spot)
                      </span>
                    </div>
                  </div>

                  {isOpen && (
                    <VirtualizedOptionChainTable
                      filteredRows={filteredRows}
                      beforeFirst={beforeFirst}
                      afterIndex={afterIndex}
                      colMode={colMode}
                      density={density}
                      sigmaMultiplier={sigmaMultiplier}
                      displaySpot={displaySpot}
                      daysToExpiry={exp.daysToExpiry}
                      effectiveRateDec={effectiveRateDec}
                      onQuoteClick={handleQuoteClick}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* SUITE AVANZADA: Mapa · Volatilidad */}
      <AnimatePresence mode="wait">
        {(activeSubView === 'mapa' || activeSubView === 'volatilidad') && (
          <motion.div
            key={activeSubView}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.35, ease: FX_EASE }}
          >
            {activeSubView === 'mapa' && (
              <InteractiveOptionPriceMap
                mkt={labMarket}
                onGoToBuilder={loadIntoBuilder}
                onGoToSheet={() => onSelectSubView('cadena')}
              />
            )}
            {activeSubView === 'volatilidad' && (
              <VolatilitySuiteView
                underlying={upperUnderlying}
                stockName={stockName}
                spot={displaySpot}
                activeExpiry={activeExpiry}
                expiries={GGAL_OPTION_EXPIRIES}
                onSelectExpiry={setSelectedExpiryId}
                effectiveTlrPct={effectiveTlrPct}
                liveOptions={liveOptions}
                activeQuantEngines={activeQuantEngines}
                usSnapshot={liveMarket.usSnapshotsBySymbol[upperUnderlying]}
                usVolSurface={liveMarket.usVolSurfaceBySymbol[selectedUnderlyingKey] ?? null}
                onSendToBuilder={(builderLegs) => {
                  loadIntoBuilder(priceLegs(labMarket, builderLegs), 1);
                }}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* =====================================================================
          6. VISTA 6: ARMADO A MANO (SIMULADOR INTERACTIVO DE PATAS)
          ===================================================================== */}
      {activeSubView === 'armado' && (
        <div className="space-y-5">
          <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-bold text-[#FFFFFF] mr-1">Agregar pata:</span>
                <button
                  type="button"
                  onClick={() => addLegFromAtmOffset('Call', 1)}
                  className="px-3 py-1.5 rounded-[8px] text-[12px] font-mono-num font-bold bg-[#2B2819] hover:bg-[#3A3621] text-[#EAB308] border border-[#4D4628] cursor-pointer transition-colors"
                >
                  + CALL
                </button>
                <button
                  type="button"
                  onClick={() => addLegFromAtmOffset('Put', -1)}
                  className="px-3 py-1.5 rounded-[8px] text-[12px] font-mono-num font-bold bg-[#261D30] hover:bg-[#352844] text-[#C084FC] border border-[#48355C] cursor-pointer transition-colors"
                >
                  + PUT
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const spotPx = Number.isFinite(displaySpot) && displaySpot > 0 ? displaySpot : 0;
                    setLegs((prev) => [
                      ...prev,
                      {
                        id: `leg-s-${Date.now()}`,
                        side: 'Compra',
                        type: 'Subyacente',
                        strike: spotPx,
                        qty: 1000,
                        premium: spotPx,
                        iv: 0,
                        delta: 1.0,
                        theta: 0,
                      },
                    ]);
                  }}
                  className="px-3 py-1.5 rounded-[8px] text-[12px] font-mono-num font-bold bg-[#1A2234] hover:bg-[#232E47] text-[#38BDF8] border border-[#2E3D5C] cursor-pointer transition-colors"
                >
                  + ACCIÓN
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="text-[#787B86] mr-1">Presets:</span>
                {[
                  {
                    label: 'Bull spread',
                    build: () => {
                      const r0 = builderRows[atmBuilderIdx] ?? builderRows[0];
                      const r1 = builderRows[atmBuilderIdx + 1] ?? r0;
                      return r0 && r1
                        ? [legFromRow(r0, 'Call', 'Compra'), legFromRow(r1, 'Call', 'Venta')]
                        : [];
                    },
                  },
                  {
                    label: 'Bear spread',
                    build: () => {
                      const r0 = builderRows[atmBuilderIdx] ?? builderRows[0];
                      const r1 = builderRows[Math.max(0, atmBuilderIdx - 1)] ?? r0;
                      return r0 && r1
                        ? [legFromRow(r0, 'Put', 'Compra'), legFromRow(r1, 'Put', 'Venta')]
                        : [];
                    },
                  },
                  {
                    label: 'Mariposa',
                    build: () => {
                      if (builderRows.length < 3) return [];
                      const centerIdx = Math.min(Math.max(1, atmBuilderIdx), builderRows.length - 2);
                      const rLo = builderRows[centerIdx - 1];
                      const rMid = builderRows[centerIdx];
                      const rHi = builderRows[centerIdx + 1];
                      return rLo && rMid && rHi && isValidButterflyStrikes(rLo.strike, rMid.strike, rHi.strike, false)
                        ? [
                            legFromRow(rLo, 'Call', 'Compra', 10),
                            legFromRow(rMid, 'Call', 'Venta', 20),
                            legFromRow(rHi, 'Call', 'Compra', 10),
                          ]
                        : [];
                    },
                  },
                  {
                    label: 'Cóndor',
                    build: () => {
                      const r1 = builderRows[Math.max(0, atmBuilderIdx - 2)];
                      const r2 = builderRows[Math.max(0, atmBuilderIdx - 1)];
                      const r3 = builderRows[Math.min(builderRows.length - 1, atmBuilderIdx + 1)];
                      const r4 = builderRows[Math.min(builderRows.length - 1, atmBuilderIdx + 2)];
                      return r1 && r2 && r3 && r4
                        ? [
                            legFromRow(r1, 'Put', 'Compra'),
                            legFromRow(r2, 'Put', 'Venta'),
                            legFromRow(r3, 'Call', 'Venta'),
                            legFromRow(r4, 'Call', 'Compra'),
                          ]
                        : [];
                    },
                  },
                  {
                    label: 'Cono vendido',
                    build: () => {
                      const r = builderRows[atmBuilderIdx];
                      return r ? [legFromRow(r, 'Call', 'Venta'), legFromRow(r, 'Put', 'Venta')] : [];
                    },
                  },
                  {
                    label: 'Cuña',
                    build: () => {
                      const rLo = builderRows[Math.max(0, atmBuilderIdx - 1)];
                      const rHi = builderRows[Math.min(builderRows.length - 1, atmBuilderIdx + 1)];
                      return rLo && rHi ? [legFromRow(rLo, 'Put', 'Compra'), legFromRow(rHi, 'Call', 'Compra')] : [];
                    },
                  },
                ].map((pr) => (
                  <button
                    key={pr.label}
                    type="button"
                    onClick={() => {
                      const nextLegs = pr.build();
                      if (nextLegs.length > 0) setLegs(nextLegs);
                    }}
                    className="px-2.5 py-1 rounded-full bg-[#181C27] hover:bg-[#23293A] text-[#D1D4DC] border border-[#2A2E3D] cursor-pointer transition-colors"
                  >
                    {pr.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto rounded-[10px] border border-[#232733]">
              <table className="w-full border-collapse text-right font-mono-num text-[12px]">
                <thead>
                  <tr className="bg-[#0B0E14] border-b border-[#232733] text-[10px] font-semibold uppercase tracking-wider text-[#787B86]">
                    <th className="py-2.5 px-3 text-left">Lado</th>
                    <th className="py-2.5 px-2.5 text-left">Tipo</th>
                    <th className="py-2.5 px-2.5">Vto</th>
                    <th className="py-2.5 px-2.5">Cantidad</th>
                    <th className="py-2.5 px-2.5">Base</th>
                    <th className="py-2.5 px-2.5">Prima</th>
                    <th className="py-2.5 px-2.5">VI</th>
                    <th className="py-2.5 px-2.5">Bruto</th>
                    <th className="py-2.5 px-2.5">Neto</th>
                    <th className="py-2.5 px-2.5">Precio Mkt</th>
                    <th className="py-2.5 px-2.5">Teórico BS</th>
                    <th className="py-2.5 px-2.5">Dif. C/V</th>
                    <th className="py-2.5 px-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E222D]">
                  {legs.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="py-6 text-center text-[#787B86]">
                        Agregá patas o elegí un preset para evaluar el payoff en vivo.
                      </td>
                    </tr>
                  ) : (
                    legs.map((leg) => {
                      const isBuy = leg.side === 'Compra';
                      const mult = leg.type === 'Subyacente' ? 1 : LOT;
                      const gross = (isBuy ? -1 : 1) * leg.premium * leg.qty * mult;
                      const fee = Math.abs(gross) * (leg.type === 'Subyacente' ? 0.0008 * 1.21 : COMMISSION_RATE);
                      const net = gross - fee;
                      const rateDec = Number.isFinite(simTlr) && simTlr >= 0 ? Math.log(1 + simTlr / 100) : 0;
                      const bsTheoretical =
                        leg.type === 'Subyacente'
                          ? simSpot
                          : bsPrice(
                              leg.type === 'Call' ? 'C' : 'P',
                              Number.isFinite(simSpot) ? simSpot : displaySpot,
                              leg.strike,
                              simDaysLeft,
                              Math.max(0.02, (leg.iv + simIvShift) / 100),
                              rateDec
                            );
                      const diffBs =
                        Number.isFinite(bsTheoretical) && bsTheoretical > 0 && leg.premium > 0
                          ? ((leg.premium - bsTheoretical) / bsTheoretical) * 100
                          : Number.NaN;

                      return (
                        <tr key={leg.id} className="h-10 hover:bg-[#171B26]">
                          <td className="px-3 text-left">
                            <select
                              value={leg.side}
                              onChange={(e) => {
                                const val = e.target.value as 'Compra' | 'Venta';
                                setLegs((prev) => prev.map((x) => (x.id === leg.id ? { ...x, side: val } : x)));
                              }}
                              className={`px-2 py-0.5 rounded font-sans font-bold text-[11.5px] bg-[#181C27] border border-[#2A2E3D] ${
                                isBuy ? 'text-[#22C55E]' : 'text-[#EF4444]'
                              }`}
                            >
                              <option value="Compra">Comprado</option>
                              <option value="Venta">Lanzado</option>
                            </select>
                          </td>
                          <td className="px-2.5 text-left">
                            <select
                              value={leg.type}
                              onChange={(e) => {
                                const val = e.target.value as 'Call' | 'Put' | 'Subyacente';
                                setLegs((prev) => prev.map((x) => (x.id === leg.id ? { ...x, type: val } : x)));
                              }}
                              className={`px-2 py-0.5 rounded font-bold text-[11px] bg-[#181C27] border border-[#2A2E3D] ${
                                leg.type === 'Call'
                                  ? 'text-[#EAB308]'
                                  : leg.type === 'Put'
                                    ? 'text-[#C084FC]'
                                    : 'text-[#38BDF8]'
                              }`}
                            >
                              <option value="Call">CALL</option>
                              <option value="Put">PUT</option>
                              <option value="Subyacente">ACCIÓN</option>
                            </select>
                          </td>
                          <td className="px-2.5 text-[#9CA3AF]">{activeExpiry?.label ?? '—'}</td>
                          <td className="px-2.5">
                            <input
                              type="number"
                              min={1}
                              value={leg.qty}
                              onChange={(e) => {
                                const q = Math.max(1, Number(e.target.value));
                                setLegs((prev) => prev.map((x) => (x.id === leg.id ? { ...x, qty: q } : x)));
                              }}
                              className="w-16 px-2 py-0.5 rounded bg-[#181C27] border border-[#2A2E3D] text-right font-bold text-[#FFFFFF]"
                            />
                          </td>
                          <td className="px-2.5">
                            <select
                              value={leg.strike}
                              onChange={(e) => {
                                const k = Number(e.target.value);
                                const matchedRow = builderRows.find((r) => r.strike === k);
                                setLegs((prev) =>
                                  prev.map((x) => {
                                    if (x.id !== leg.id) return x;
                                    if (matchedRow && x.type !== 'Subyacente') {
                                      const updated = legFromRow(matchedRow, x.type, x.side, x.qty);
                                      return { ...updated, id: x.id };
                                    }
                                    return { ...x, strike: k };
                                  })
                                );
                              }}
                              className="px-2 py-0.5 rounded bg-[#181C27] border border-[#2A2E3D] font-bold text-[#FFFFFF]"
                            >
                              {(availableStrikes.includes(leg.strike)
                                ? availableStrikes
                                : [...availableStrikes, leg.strike].sort((a, b) => a - b)
                              ).map((k) => (
                                <option key={k} value={k}>
                                  {fmtNum(k, 0)}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2.5 font-bold text-[#FFFFFF]">$ {fmtNum(leg.premium, 2)}</td>
                          <td className="px-2.5 text-[#9CA3AF]">
                            {leg.type === 'Subyacente' ? '—' : `${fmtNum(leg.iv + simIvShift, 1)} %`}
                          </td>
                          <td className={gross >= 0 ? 'px-2.5 text-[#22C55E]' : 'px-2.5 text-[#EF4444]'}>
                            {gross >= 0 ? '+' : '-'}$ {fmtNum(Math.abs(gross), 0)}
                          </td>
                          <td className={net >= 0 ? 'px-2.5 font-bold text-[#22C55E]' : 'px-2.5 font-bold text-[#EF4444]'}>
                            {net >= 0 ? '+' : '-'}$ {fmtNum(Math.abs(net), 0)}
                          </td>
                          <td className="px-2.5 text-[#D1D4DC]">$ {fmtNum(leg.premium, 2)}</td>
                          <td className="px-2.5 text-[#9CA3AF]">
                            {Number.isFinite(bsTheoretical) ? `$ ${fmtNum(bsTheoretical, 2)}` : '—'}
                          </td>
                          <td className={!Number.isFinite(diffBs) ? 'px-2.5 text-[#787B86]' : diffBs <= 0 ? 'px-2.5 text-[#22C55E]' : 'px-2.5 text-[#FACC15]'}>
                            {Number.isFinite(diffBs) ? `${diffBs > 0 ? '+' : ''}${fmtNum(diffBs, 1)}%` : '—'}
                          </td>
                          <td className="px-2 text-center">
                            <button
                              type="button"
                              onClick={() => setLegs((prev) => prev.filter((x) => x.id !== leg.id))}
                              className="text-[#787B86] hover:text-[#EF4444] cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Panel de 6 KPIs calculados en vivo */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-1">
              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                <div className="text-[10px] font-mono-num uppercase text-[#787B86]">CAJA AL ARMAR</div>
                <div
                  className={`font-mono-num text-[16px] font-bold mt-0.5 ${
                    builderAnalytics.netCash >= 0 ? 'text-[#22C55E]' : 'text-[#EF4444]'
                  }`}
                >
                  {builderAnalytics.netCash >= 0 ? '+$' : '-$'} {fmtNum(Math.abs(builderAnalytics.netCash), 0)}
                </div>
                <div className="text-[10.5px] text-[#787B86]">
                  Comis. + IVA: ${fmtNum(builderAnalytics.totalCommission, 0)}
                </div>
              </div>

              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                <div className="text-[10px] font-mono-num uppercase text-[#787B86]">PÉRDIDA MÁXIMA</div>
                <div className="font-mono-num text-[16px] font-bold text-[#EF4444] mt-0.5">
                  {builderAnalytics.unlimitedLoss
                    ? 'ilimitada'
                    : Number.isFinite(builderAnalytics.maxLoss)
                      ? `-$ ${fmtNum(builderAnalytics.maxLoss, 0)}`
                      : '—'}
                </div>
                <div className="text-[10.5px] text-[#787B86]">Al vencimiento (Opex)</div>
              </div>

              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                <div className="text-[10px] font-mono-num uppercase text-[#787B86]">GANANCIA MÁXIMA</div>
                <div className="font-mono-num text-[16px] font-bold text-[#22C55E] mt-0.5">
                  {builderAnalytics.unlimitedGain
                    ? 'ilimitada'
                    : Number.isFinite(builderAnalytics.maxGain)
                      ? `+$ ${fmtNum(Math.max(0, builderAnalytics.maxGain), 0)}`
                      : '—'}
                </div>
                <div className="text-[10.5px] text-[#787B86]">
                  {Number.isFinite(builderAnalytics.maxGain) &&
                  Number.isFinite(builderAnalytics.maxLoss) &&
                  builderAnalytics.maxLoss > 0
                    ? `Sobre riesgo: ${fmtNum((builderAnalytics.maxGain / builderAnalytics.maxLoss) * 100, 0)}%`
                    : '—'}
                </div>
              </div>

              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                <div className="text-[10px] font-mono-num uppercase text-[#787B86]">PROB. DE GANAR (PoP)</div>
                <div className="font-mono-num text-[16px] font-bold text-[#FFFFFF] mt-0.5">
                  {Number.isFinite(builderAnalytics.pop) ? `${fmtNum(builderAnalytics.pop * 100, 1)} %` : '—'}
                </div>
                <div className="text-[10.5px] text-[#787B86]">Distribución log-normal</div>
              </div>

              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                <div className="text-[10px] font-mono-num uppercase text-[#787B86]">PRECIOS DE EMPATE</div>
                <div className="font-mono-num text-[15px] font-bold text-[#FFFFFF] mt-0.5 truncate">
                  {builderAnalytics.breakevens.length > 0
                    ? builderAnalytics.breakevens.slice(0, 2).map((b) => `$${fmtNum(b, 0)}`).join(' · ')
                    : '—'}
                </div>
                <div className="text-[10.5px] font-mono-num text-[#787B86]">
                  {builderAnalytics.breakevens[0] !== undefined &&
                  Number.isFinite(displaySpot) &&
                  displaySpot > 0
                    ? `${fmtPct(((builderAnalytics.breakevens[0] - displaySpot) / displaySpot) * 100)} vs. spot`
                    : '—'}
                </div>
              </div>

              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D]">
                <div className="text-[10px] font-mono-num uppercase text-[#787B86]">MOV. ESPERADO (±1σ)</div>
                <div className="font-mono-num text-[15px] font-bold text-[#EAB308] mt-0.5">
                  {Number.isFinite(builderAnalytics.expectedMoveAbs)
                    ? `±$ ${fmtNum(builderAnalytics.expectedMoveAbs, 0)} (±${fmtNum(builderAnalytics.expectedMovePct, 1)}%)`
                    : '—'}
                </div>
                <div className="text-[10.5px] font-mono-num text-[#787B86]">
                  {Number.isFinite(simTlr) ? `Costo fin.: ${fmtNum(simTlr, 1)}% TNA` : 'TNA: —'}
                </div>
              </div>
            </div>
          </div>

          {/* B) CURVA DE PAYOFF DINÁMICA E INTERACTIVA + HISTOGRAMA OI REAL */}
          <div className="rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[15px] font-bold text-[#FFFFFF]">
                  Curva de Payoff Interactiva (Finish vs. Teórico T+{Math.max(0, (activeExpiry?.daysToExpiry ?? simDaysLeft) - simDaysLeft)}d) &amp; Interés Abierto
                </h3>
                <p className="text-[12px] text-[#9CA3AF]">
                  Mové los sliders inferiores para simular el impacto real Black-Scholes de Precio, Theta, Vega y Rho.
                </p>
              </div>
              <div className="flex items-center gap-4 text-[11.5px] font-mono-num">
                <span className="inline-flex items-center gap-1.5 text-[#22C55E]">
                  <span className="w-3 h-0.5 bg-[#22C55E]" /> Finish (Opex)
                </span>
                <span className="inline-flex items-center gap-1.5 text-[#FFFFFF]">
                  <span className="w-3 h-0.5 border-b border-dashed border-white" /> Teórico ({simDaysLeft}d restantes)
                </span>
                <span className="inline-flex items-center gap-1.5 text-[#EAB308]">
                  <span className="w-2.5 h-2.5 rounded-[2px] bg-[#EAB308]" /> OI Calls
                </span>
                <span className="inline-flex items-center gap-1.5 text-[#A855F7]">
                  <span className="w-2.5 h-2.5 rounded-[2px] bg-[#A855F7]" /> OI Puts
                </span>
              </div>
            </div>

            <div className="h-72 w-full">
              {(() => {
                const grid = builderAnalytics.payoffGrid;
                const firstPt = grid[0];
                const lastPt = grid[grid.length - 1];
                if (!firstPt || !lastPt || grid.length < 2) {
                  return (
                    <div className="h-full flex items-center justify-center text-[#787B86] text-[13px]">
                      Agregá patas para visualizar el payoff.
                    </div>
                  );
                }
                const maxAbs = Math.max(
                  ...grid.flatMap((p) => [Math.abs(p.pnlFinish), Math.abs(p.pnlTheo)]),
                  1000
                );
                const maxOi = Math.max(
                  ...builderAnalytics.oiByGridSpot.flatMap((o) => [o.callOi, o.putOi]),
                  1
                );
                const pts = grid.map((p, idx) => {
                  const x = 65 + (idx / (grid.length - 1)) * 575;
                  const yFin = 100 - (p.pnlFinish / maxAbs) * 62;
                  const yTheo = 100 - (p.pnlTheo / maxAbs) * 62;
                  return { x, yFin, yTheo, spot: p.spot };
                });
                const polyStr = pts.map((p) => `${p.x.toFixed(1)},${p.yFin.toFixed(1)}`).join(' ');
                const areaStr = `65,100 ${polyStr} 640,100`;
                const theoPts = pts.map((p) => `${p.x.toFixed(1)},${p.yTheo.toFixed(1)}`).join(' ');
                const spotSpan = Math.max(1e-6, lastPt.spot - firstPt.spot);
                const simSpotX =
                  65 + Math.min(1, Math.max(0, ((Number.isFinite(simSpot) ? simSpot : firstPt.spot) - firstPt.spot) / spotSpan)) * 575;

                return (
                  <svg viewBox="0 0 680 250" className="w-full h-full overflow-visible">
                    <defs>
                      <clipPath id="builder-pos-clip">
                        <rect x="55" y="15" width="595" height="85" />
                      </clipPath>
                      <clipPath id="builder-neg-clip">
                        <rect x="55" y="100" width="595" height="80" />
                      </clipPath>
                    </defs>

                    <line x1="55" y1="35" x2="650" y2="35" stroke="#1E222D" />
                    <line x1="55" y1="100" x2="650" y2="100" stroke="#363B4C" strokeWidth="1.2" />
                    <line x1="55" y1="165" x2="650" y2="165" stroke="#1E222D" />

                    <text x="48" y="38" textAnchor="end" fill="#22C55E" fontSize="10" className="font-mono-num">
                      +{fmtMoneyCompact(maxAbs / 1_000_000)}
                    </text>
                    <text x="48" y="103" textAnchor="end" fill="#9CA3AF" fontSize="10" className="font-mono-num">
                      $0
                    </text>
                    <text x="48" y="168" textAnchor="end" fill="#EF4444" fontSize="10" className="font-mono-num">
                      -{fmtMoneyCompact(maxAbs / 1_000_000)}
                    </text>

                    <polygon points={areaStr} fill="#0E382B" fillOpacity="0.75" clipPath="url(#builder-pos-clip)" />
                    <polygon points={areaStr} fill="#381419" fillOpacity="0.75" clipPath="url(#builder-neg-clip)" />
                    <polyline fill="none" stroke="#22C55E" strokeWidth="2.4" points={polyStr} clipPath="url(#builder-pos-clip)" />
                    <polyline fill="none" stroke="#EF4444" strokeWidth="2.4" points={polyStr} clipPath="url(#builder-neg-clip)" />
                    <polyline fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeDasharray="5 4" points={theoPts} />

                    <line x1={simSpotX} y1="18" x2={simSpotX} y2="180" stroke="#EAB308" strokeWidth="1.5" strokeDasharray="3 3" />
                    <text x={simSpotX} y="13" textAnchor="middle" fill="#EAB308" fontSize="10" fontWeight="bold" className="font-mono-num">
                      Spot Sim: {Number.isFinite(simSpot) ? `$${fmtNum(simSpot, 0)}` : '—'}
                    </text>

                    <line x1="55" y1="188" x2="650" y2="188" stroke="#232733" />
                    {pts.map((pt, i) => {
                      const oi = builderAnalytics.oiByGridSpot[i] ?? { callOi: 0, putOi: 0 };
                      const callH = oi.callOi > 0 ? Math.max(2, (oi.callOi / maxOi) * 34) : 0;
                      const putH = oi.putOi > 0 ? Math.max(2, (oi.putOi / maxOi) * 34) : 0;
                      return (
                        <g key={i}>
                          {callH > 0 && (
                            <rect x={pt.x - 8} y={228 - callH} width="7" height={callH} fill="#EAB308" opacity="0.85" rx="1.5" />
                          )}
                          {putH > 0 && (
                            <rect x={pt.x + 1} y={228 - putH} width="7" height={putH} fill="#A855F7" opacity="0.85" rx="1.5" />
                          )}
                          {i % 4 === 0 && (
                            <text x={pt.x} y="243" textAnchor="middle" fill="#787B86" fontSize="10" className="font-mono-num">
                              ${fmtNum(pt.spot, 0)}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                );
              })()}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-3 border-t border-[#232733] text-[12px]">
              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-2">
                <div className="flex justify-between">
                  <span className="text-[#9CA3AF]">Precio del Papel</span>
                  <span className="font-mono-num font-bold text-[#FFFFFF]">
                    {Number.isFinite(simSpot) ? `$ ${fmtNum(simSpot, 0)}` : '—'}
                  </span>
                </div>
                <input
                  type="range"
                  min={simSliderMin}
                  max={simSliderMax}
                  step={simSliderStep}
                  value={Number.isFinite(simSpot) ? simSpot : simSliderMin}
                  onChange={(e) => setSimSpot(Number(e.target.value))}
                  className="w-full accent-[#EAB308] cursor-pointer"
                />
              </div>

              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-2">
                <div className="flex justify-between">
                  <span className="text-[#9CA3AF]">Días que Faltan (Theta)</span>
                  <span className="font-mono-num font-bold text-[#FFFFFF]">{simDaysLeft} días</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={Math.max(30, activeExpiry?.daysToExpiry ?? 60)}
                  value={simDaysLeft}
                  onChange={(e) => setSimDaysLeft(Number(e.target.value))}
                  className="w-full accent-[#22C55E] cursor-pointer"
                />
              </div>

              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-2">
                <div className="flex justify-between">
                  <span className="text-[#9CA3AF]">Variación VI (Vega)</span>
                  <span className="font-mono-num font-bold text-[#38BDF8]">
                    {simIvShift >= 0 ? `+${simIvShift}` : simIvShift} pts
                  </span>
                </div>
                <input
                  type="range"
                  min={-20}
                  max={20}
                  value={simIvShift}
                  onChange={(e) => setSimIvShift(Number(e.target.value))}
                  className="w-full accent-[#38BDF8] cursor-pointer"
                />
              </div>

              <div className="p-3 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-2">
                <div className="flex justify-between">
                  <span className="text-[#9CA3AF]">Tasa Libre de Riesgo (TLR)</span>
                  <span className="font-mono-num font-bold text-[#FFFFFF]">
                    {Number.isFinite(simTlr) ? `${fmtNum(simTlr, 1)} %` : '—'}
                  </span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={80}
                  step={0.5}
                  value={Number.isFinite(simTlr) ? simTlr : 30}
                  onChange={(e) => setSimTlr(Number(e.target.value))}
                  className="w-full accent-[#A855F7] cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* C) ESCENARIOS DE ESTRÉS (-20% A +20%) Y MATRIZ DE GRIEGAS REALES */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-6 rounded-[12px] bg-[#12141A] border border-[#232733] p-5 space-y-3">
              <h3 className="text-[14.5px] font-bold text-[#FFFFFF]">
                Escenarios de Estrés del Subyacente (-20% a +20%)
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-right font-mono-num text-[12px]">
                  <thead>
                    <tr className="border-b border-[#232733] text-[10px] uppercase text-[#787B86]">
                      <th className="py-2 text-left">Paso %</th>
                      <th className="py-2">Precio Proy.</th>
                      <th className="py-2">Resultado Finish</th>
                      <th className="py-2">Teórico Hoy</th>
                      <th className="py-2 px-3 text-left">Perfil P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E222D]">
                    {(() => {
                      const maxRowPnl = Math.max(
                        ...builderAnalytics.stressRows.map((r) => Math.abs(r.finishPnl)),
                        1
                      );
                      return builderAnalytics.stressRows.map((sr) => {
                        const isPos = sr.finishPnl >= 0;
                        const barW = Math.min(100, (Math.abs(sr.finishPnl) / maxRowPnl) * 100);
                        return (
                          <tr
                            key={sr.stepPct}
                            className={`h-8 ${sr.stepPct === 0 ? 'bg-[#1D2230] font-bold' : 'hover:bg-[#161A24]'}`}
                          >
                            <td
                              className={`text-left ${
                                sr.stepPct > 0 ? 'text-[#22C55E]' : sr.stepPct < 0 ? 'text-[#EF4444]' : 'text-[#FFFFFF]'
                              }`}
                            >
                              {sr.stepPct > 0 ? `+${sr.stepPct}%` : `${sr.stepPct}%`}
                            </td>
                            <td className="text-[#FFFFFF]">$ {fmtNum(sr.projSpot, 0)}</td>
                            <td className={isPos ? 'text-[#22C55E] font-semibold' : 'text-[#EF4444] font-semibold'}>
                              {isPos ? '+$' : '-$'} {fmtNum(Math.abs(sr.finishPnl), 0)}
                            </td>
                            <td className={sr.theoNow >= 0 ? 'text-[#22C55E]' : 'text-[#EF4444]'}>
                              {sr.theoNow >= 0 ? '+$' : '-$'} {fmtNum(Math.abs(sr.theoNow), 0)}
                            </td>
                            <td className="px-3">
                              <div className="w-24 h-2 rounded bg-[#1E222D] overflow-hidden">
                                <div style={{ width: `${barW}%` }} className={`h-full ${isPos ? 'bg-[#22C55E]' : 'bg-[#EF4444]'}`} />
                              </div>
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="lg:col-span-6 rounded-[12px] bg-[#12141A] border border-[#232733] p-5 flex flex-col justify-between gap-4">
              <div className="space-y-3">
                <h3 className="text-[14.5px] font-bold text-[#FFFFFF]">
                  Matriz de Griegas Totales y por Componente
                </h3>
                <table className="w-full border-collapse text-right font-mono-num text-[12px]">
                  <thead>
                    <tr className="border-b border-[#232733] text-[10px] uppercase text-[#787B86]">
                      <th className="py-2 text-left">Griega</th>
                      <th className="py-2 text-[#FFFFFF]">Global</th>
                      <th className="py-2 text-[#EAB308]">Call</th>
                      <th className="py-2 text-[#C084FC]">Put</th>
                      <th className="py-2 text-[#38BDF8]">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E222D]">
                    <tr className="h-9">
                      <td className="text-left font-bold text-[#D1D4DC]">Delta (Δ acc.)</td>
                      <td className="font-bold text-[#FFFFFF]">{fmtNum(builderAnalytics.delta.global, 0)}</td>
                      <td className="text-[#EAB308]">{fmtNum(builderAnalytics.delta.call, 0)}</td>
                      <td className="text-[#C084FC]">{fmtNum(builderAnalytics.delta.put, 0)}</td>
                      <td className="text-[#38BDF8]">{fmtNum(builderAnalytics.delta.stock, 0)}</td>
                    </tr>
                    <tr className="h-9">
                      <td className="text-left font-bold text-[#D1D4DC]">Gamma (Γ)</td>
                      <td className="font-bold text-[#FFFFFF]">{fmtNum(builderAnalytics.gamma.global, 2)}</td>
                      <td className="text-[#EAB308]">{fmtNum(builderAnalytics.gamma.call, 2)}</td>
                      <td className="text-[#C084FC]">{fmtNum(builderAnalytics.gamma.put, 2)}</td>
                      <td className="text-[#38BDF8]">0,00</td>
                    </tr>
                    <tr className="h-9">
                      <td className="text-left font-bold text-[#D1D4DC]">Vega (ν por 1% VI)</td>
                      <td className={`font-bold ${builderAnalytics.vega.global >= 0 ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}>
                        {builderAnalytics.vega.global >= 0 ? '+$' : '-$'} {fmtNum(Math.abs(builderAnalytics.vega.global), 0)}
                      </td>
                      <td className="text-[#EAB308]">$ {fmtNum(builderAnalytics.vega.call, 0)}</td>
                      <td className="text-[#C084FC]">$ {fmtNum(builderAnalytics.vega.put, 0)}</td>
                      <td className="text-[#38BDF8]">$ 0</td>
                    </tr>
                    <tr className="h-9">
                      <td className="text-left font-bold text-[#D1D4DC]">Theta (Θ por día)</td>
                      <td className={`font-bold ${builderAnalytics.theta.global >= 0 ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}>
                        {builderAnalytics.theta.global >= 0 ? '+$' : '-$'} {fmtNum(Math.abs(builderAnalytics.theta.global), 0)}
                      </td>
                      <td className="text-[#EAB308]">$ {fmtNum(builderAnalytics.theta.call, 0)}</td>
                      <td className="text-[#C084FC]">$ {fmtNum(builderAnalytics.theta.put, 0)}</td>
                      <td className="text-[#38BDF8]">$ 0</td>
                    </tr>
                    <tr className="h-9">
                      <td className="text-left font-bold text-[#D1D4DC]">Rho (ρ por 1% tasa)</td>
                      <td className="font-bold text-[#FFFFFF]">
                        {builderAnalytics.rho.global >= 0 ? '+$' : '-$'} {fmtNum(Math.abs(builderAnalytics.rho.global), 0)}
                      </td>
                      <td className="text-[#EAB308]">$ {fmtNum(builderAnalytics.rho.call, 0)}</td>
                      <td className="text-[#C084FC]">$ {fmtNum(builderAnalytics.rho.put, 0)}</td>
                      <td className="text-[#38BDF8]">$ 0</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="p-4 rounded-[10px] bg-[#0B0E14] border border-[#232733] space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12.5px] font-bold text-[#FFFFFF]">
                    Neutralizar el Delta (Delta-Hedge Automático)
                  </span>
                  <span className="font-mono-num text-[11px] text-[#EAB308]">
                    Desbalance actual: {fmtNum(builderAnalytics.delta.global, 0)} Δ
                  </span>
                </div>
                <p className="text-[11.5px] text-[#9CA3AF]">
                  Elegí un ajuste automático con cotizaciones reales para llevar el Delta hacia cero:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={!Number.isFinite(displaySpot) || displaySpot <= 0}
                    onClick={() => {
                      const hedgeQty = Math.max(1, Math.abs(Math.round(builderAnalytics.delta.global)));
                      setLegs((prev) => [
                        ...prev,
                        {
                          id: `hedge-stock-${Date.now()}`,
                          side: builderAnalytics.delta.global >= 0 ? 'Venta' : 'Compra',
                          type: 'Subyacente',
                          strike: Math.round(displaySpot),
                          qty: hedgeQty,
                          premium: displaySpot,
                          iv: 0,
                          delta: 1,
                          theta: 0,
                        },
                      ]);
                    }}
                    className="p-2.5 rounded-[8px] bg-[#161B26] hover:bg-[#1E2536] border border-[#2A3246] text-left cursor-pointer transition-colors disabled:opacity-50"
                  >
                    <div className="font-mono-num text-[12px] font-bold text-[#38BDF8]">
                      {builderAnalytics.delta.global >= 0 ? 'Vender' : 'Comprar'}{' '}
                      {Math.max(1, Math.abs(Math.round(builderAnalytics.delta.global)))} acc. {upperUnderlying}
                    </div>
                    <div className="text-[10.5px] text-[#787B86]">Cobertura lineal sin alterar Gamma/Vega</div>
                  </button>

                  {(() => {
                    const putRow = builderRows[Math.max(0, atmBuilderIdx - 1)] ?? builderRows[0];
                    const optType = builderAnalytics.delta.global >= 0 ? 'Put' : 'Call';
                    const perLotDelta =
                      putRow && Number.isFinite(optType === 'Put' ? putRow.putDelta : putRow.callDelta)
                        ? Math.abs((optType === 'Put' ? putRow.putDelta : putRow.callDelta) * LOT)
                        : 40;
                    const hedgeLots = Math.max(1, Math.round(Math.abs(builderAnalytics.delta.global) / Math.max(1, perLotDelta)));
                    return (
                      <button
                        type="button"
                        disabled={!putRow}
                        onClick={() => {
                          if (!putRow) return;
                          setLegs((prev) => [...prev, legFromRow(putRow, optType, 'Compra', hedgeLots)]);
                        }}
                        className="p-2.5 rounded-[8px] bg-[#161B26] hover:bg-[#1E2536] border border-[#2A3246] text-left cursor-pointer transition-colors disabled:opacity-50"
                      >
                        <div className="font-mono-num text-[12px] font-bold text-[#C084FC]">
                          Comprar {hedgeLots} lotes {optType.toUpperCase()} {putRow ? `Base ${fk(putRow.strike)}` : '—'}
                        </div>
                        <div className="text-[10.5px] text-[#787B86]">Neutraliza Δ y suma Gamma positivo</div>
                      </button>
                    );
                  })()}
                </div>
              </div>

              <button
                type="button"
                disabled={legs.length === 0}
                onClick={() =>
                  onOpenOrderTicket({
                    ticker: `COMBO-${upperUnderlying}`,
                    side: builderAnalytics.netCash >= 0 ? 'Venta' : 'Compra',
                    price: Math.abs(builderAnalytics.netCash) / LOT,
                    qty: legs[0]?.qty ?? 1,
                    instrumentLabel: `Estrategia Personalizada (${legs.length} patas en ${upperUnderlying})`,
                  })
                }
                className="w-full py-2.5 rounded-[10px] bg-[#EAECEF] hover:bg-white text-[#0B0E14] text-[13px] font-extrabold inline-flex items-center justify-center gap-2 cursor-pointer transition-colors disabled:opacity-50"
              >
                <Send className="w-4 h-4" /> Enviar Estrategia al Ticket de Orden
              </button>
            </div>
          </div>
        </div>
      )}

      <OptionsSymbolSelector
        open={symbolSelectorOpen}
        onClose={() => setSymbolSelectorOpen(false)}
        onSelect={onSelectUnderlying}
        selectedKey={selectedUnderlyingKey}
        underlyings={liveMarket.optionsUnderlyings}
        status={liveMarket.optionsUnderlyingsStatus}
        selectedName={stockName}
        selectedPrice={headerSpot}
        selectedChangePct={Number.isFinite(headerDeltaPct) ? headerDeltaPct : Number.NaN}
        selectedFlash={headerFlash}
      />
    </div>
  );
};
