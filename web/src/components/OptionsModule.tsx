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
  Map as MapIcon,
} from 'lucide-react';
import {
  AR_STOCKS,
  GGAL_OPTION_EXPIRIES,
  fmtMoneyCompact,
  fmtNum,
  fmtPct,
  OptionChainRow,
} from '../data/marketData';
import { requestOptionsChain, useLiveMarketState } from '../data/liveRuntimeBridge';
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
} from './options/engine';
import { InteractiveOptionPriceMap } from './options/map/InteractiveOptionPriceMap';
import { VolatilitySurface } from './options/VolatilitySurface';
import {
  type BidirectionalFlowRow,
  type BuilderLeg,
  type EnrichedChainRow,
  type InlineAxisMarker,
  type StrategyFamilyId,
  type VisualPayoffCardData,
  buildBidirectionalFlow,
  buildEnrichedChainForExpiry,
  buildLiveStrategyCardsAndRows,
  computeBuilderAnalytics,
  computeInlineMarkersForRows,
  readOptionHoldingsFromStorage,
} from './options/optionsDerived';

export type OptionsSubView =
  | 'mapa'
  | 'estrategias'
  | 'spreads'
  | 'flujo'
  | 'cadena'
  | 'volatilidad'
  | 'armado';

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

/* ============================================================================
   COMPONENTE DE TARJETA DE PAYOFF
   ============================================================================ */
const PayoffStrategyCard: React.FC<{
  card: VisualPayoffCardData;
  onExecute: (card: VisualPayoffCardData) => void;
}> = ({ card, onExecute }) => {
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
    <div className="rounded-[12px] bg-[#12141A] border border-[#232733] hover:border-[#343A4D] p-5 flex flex-col justify-between gap-4 transition-all">
      {/* Header de la Card */}
      <div className="space-y-1.5">
        <h3 className="text-[16px] font-bold text-[#FFFFFF] tracking-tight">{card.title}</h3>
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

      <div className="pt-2 text-center">
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

function resolveOptionSpreadPrice(
  row: OptionChainRow,
  side: 'CALL' | 'PUT',
  legRole: 'BUY' | 'SELL',
): { readonly price: number; readonly eodFallback: boolean } {
  const bid = side === 'CALL' ? row.callBid : row.putBid;
  const ask = side === 'CALL' ? row.callAsk : row.putAsk;
  const last = side === 'CALL' ? row.callLast : row.putLast;
  if (legRole === 'BUY') {
    if (Number.isFinite(ask) && ask > 0) return { price: ask, eodFallback: false };
    if (Number.isFinite(last) && last > 0) return { price: last, eodFallback: true };
    if (Number.isFinite(bid) && bid > 0) return { price: bid, eodFallback: true };
    return { price: Number.NaN, eodFallback: false };
  }
  if (Number.isFinite(bid) && bid > 0) return { price: bid, eodFallback: false };
  if (Number.isFinite(last) && last > 0) return { price: last, eodFallback: true };
  if (Number.isFinite(ask) && ask > 0) return { price: ask, eodFallback: true };
  return { price: Number.NaN, eodFallback: false };
}

function buildDetailedSpreadMatrix(
  rows: readonly OptionChainRow[],
  spot: number,
  oneSigmaHigh: number,
  daysToExpiry: number,
  rateDec: number,
  atmIvDec: number,
  filter: 'donde_estoy' | 'cerca' | 'tenencia' | 'todas',
): readonly DetailedSpreadRow[] {
  if (rows.length < 2) return [];
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const visible = sorted.filter((r) => {
    if (!Number.isFinite(spot) || spot <= 0 || filter === 'todas') return true;
    const dist = Math.abs(r.strike - spot) / spot;
    if (filter === 'donde_estoy') return dist <= 0.08;
    if (filter === 'cerca') return dist <= 0.22;
    return dist <= 0.14;
  });
  const target = visible.length > 0 ? visible : sorted;
  const tExp = Math.max(1 / 365, (Number.isFinite(daysToExpiry) && daysToExpiry > 0 ? daysToExpiry : 30) / 365);
  const rCont = Number.isFinite(rateDec) ? rateDec : 0;

  const makeMetric = (
    longRow: OptionChainRow | undefined,
    shortRow: OptionChainRow | undefined,
    side: 'CALL' | 'PUT',
    widthBases: 1 | 2 | 3 | 4,
  ): SpreadCellMetric | null => {
    if (!longRow || !shortRow) return null;
    const widthArs = Math.abs(shortRow.strike - longRow.strike);
    if (!(widthArs > 0)) return null;
    const buyLeg = resolveOptionSpreadPrice(longRow, side, 'BUY');
    const sellLeg = resolveOptionSpreadPrice(shortRow, side, 'SELL');
    if (!Number.isFinite(buyLeg.price) || !Number.isFinite(sellLeg.price)) return null;
    const debit = buyLeg.price - sellLeg.price;
    if (!(debit > 0.05) || debit >= widthArs - 0.01) return null;
    const maxProfit = widthArs - debit;
    const ratio = maxProfit / debit;
    const breakeven = side === 'CALL' ? longRow.strike + debit : longRow.strike - debit;
    const beDistPct =
      Number.isFinite(spot) && spot > 0 ? ((breakeven - spot) / spot) * 100 : Number.NaN;

    const longIv = (side === 'CALL' ? longRow.callIV : longRow.putIV) / 100;
    const shortIv = (side === 'CALL' ? shortRow.callIV : shortRow.putIV) / 100;
    const ivSamples = [longIv, shortIv, atmIvDec].filter((v) => Number.isFinite(v) && v > 0.01);
    const ivMean =
      ivSamples.length > 0 ? ivSamples.reduce((a, b) => a + b, 0) / ivSamples.length : Number.NaN;

    let probBePct = Number.NaN;
    let edgePct = Number.NaN;
    if (
      Number.isFinite(spot) &&
      spot > 0 &&
      breakeven > 0 &&
      Number.isFinite(ivMean) &&
      ivMean > 0.01
    ) {
      const denom = ivMean * Math.sqrt(tExp);
      const d2 = (Math.log(spot / breakeven) + (rCont - 0.5 * ivMean * ivMean) * tExp) / denom;
      const probBe = side === 'CALL' ? ncdf(d2) : ncdf(-d2);
      if (Number.isFinite(probBe)) {
        probBePct = probBe * 100;
        edgePct = (probBe - debit / widthArs) * 100;
      }
    }

    return {
      side,
      longStrike: longRow.strike,
      shortStrike: shortRow.strike,
      widthBases,
      widthArs,
      debit,
      maxProfit,
      ratio,
      breakeven,
      beDistPct,
      probBePct,
      edgePct,
      usesEodRef: buyLeg.eodFallback || sellLeg.eodFallback,
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
      spotMarkerAfter = `SPOT $${fmtNum(spot, 1)}`;
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
      sigmaMarkerAfter = `+1σ ($${fmtNum(oneSigmaHigh, 0)})`;
    }

    return {
      base: fk(row.strike),
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

function safeAnalyticalBsmGamma(
  spot: number,
  strike: number,
  ivPct: number,
  daysToExpiry: number,
  rateDec: number,
): number {
  if (
    !Number.isFinite(spot) ||
    spot <= 0 ||
    !Number.isFinite(strike) ||
    strike <= 0 ||
    !Number.isFinite(ivPct) ||
    ivPct <= 0
  ) {
    return Number.NaN;
  }
  const t = Math.max((Number.isFinite(daysToExpiry) && daysToExpiry > 0 ? daysToExpiry : 1) / 365, 1e-4);
  const sigma = Math.max(ivPct / 100, 1e-4);
  const r = Number.isFinite(rateDec) ? rateDec : 0;
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (r + 0.5 * sigma * sigma) * t) / (sigma * sqrtT);
  const nd1Prime = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const g = nd1Prime / (spot * sigma * sqrtT);
  return Number.isFinite(g) ? g : Number.NaN;
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
  const upperUnderlying = selectedUnderlying.toUpperCase();

  useEffect(() => {
    void requestOptionsChain(upperUnderlying);
  }, [upperUnderlying]);

  // Estado del Header de Opciones
  const [selectedExpiryId, setSelectedExpiryId] = useState<string>('');
  const [tlrShiftPp, setTlrShiftPp] = useState<number>(0);
  const [showOnboardingBanner, setShowOnboardingBanner] = useState(true);

  // Estado del Módulo 1: Estrategias
  const [strategyMode, setStrategyMode] = useState<'familia' | 'objetivo'>('familia');
  const [selectedFamily, setSelectedFamily] = useState<StrategyFamilyId>('sugeridas');
  const [marketBias, setMarketBias] = useState<'Alcista' | 'Lateral' | 'Bajista' | 'Se mueve'>('Lateral');
  const [objectiveBias, setObjectiveBias] = useState<
    'Muy bajista' | 'Bajista' | 'Lateral' | 'Se mueve' | 'Alcista' | 'Muy alcista'
  >('Alcista');
  const [targetPrice, setTargetPrice] = useState<number>(Number.NaN);
  const [maxRiskInput, setMaxRiskInput] = useState<string>('sin tope');
  const [probabilityWeight, setProbabilityWeight] = useState<number>(55);
  const [optimizerDir, setOptimizerDir] = useState<'BULLISH' | 'BEARISH'>('BULLISH');

  // Estado del Módulo 2: Spreads
  const [spreadFilter, setSpreadFilter] = useState<'donde_estoy' | 'cerca' | 'tenencia' | 'todas'>('cerca');
  const [spreadViewMode, setSpreadViewMode] = useState<'pares' | 'escalera'>('escalera');
  const [selectedSpreadCell, setSelectedSpreadCell] = useState<SpreadCellMetric | null>(null);

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

  const liveOptions = liveMarket.optionsByUnderlying[upperUnderlying];
  const liveOptionsExt = liveOptions as
    | (typeof liveOptions & {
        readonly primaryLiquidExpiryCode?: string | null;
        readonly quantEnginesByExpiry?: Readonly<
          Record<string, NonNullable<typeof liveOptions>['quantEngines']>
        >;
      })
    | undefined;
  const primaryLiquidCode = liveOptionsExt?.primaryLiquidExpiryCode ?? null;

  useEffect(() => {
    setSelectedExpiryId('');
  }, [upperUnderlying]);

  const catalogStock = AR_STOCKS.find((s) => s.ticker === upperUnderlying) ?? AR_STOCKS[0];
  const overviewStock =
    liveMarket.overview?.mervalStocks.find((s) => s.ticker === upperUnderlying) ??
    liveMarket.overview?.generalPanelStocks.find((s) => s.ticker === upperUnderlying) ??
    liveMarket.overview?.cedears.find((s) => s.ticker === upperUnderlying);

  const stockName = overviewStock?.name ?? catalogStock?.name ?? upperUnderlying;
  const displaySpot = liveOptions?.spot ?? overviewStock?.last ?? catalogStock?.last ?? Number.NaN;
  const displayDeltaPct = overviewStock?.deltaPct ?? catalogStock?.deltaPct ?? Number.NaN;

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
      strikes
    );
  }, [upperUnderlying, displaySpot, activeExpiry, effectiveRateDec]);

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

  // Header 1-sigma real sincronizado al vencimiento seleccionado
  const activeDays = activeExpiry?.daysToExpiry ?? 0;
  const activeAtmIvDec =
    activeExpiry && Number.isFinite(activeExpiry.atmIV) && activeExpiry.atmIV > 0
      ? activeExpiry.atmIV / 100
      : activeDays > 0
        ? atmIv(activeDays)
        : Number.NaN;
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
      ),
    [activeExpiry, displaySpot, activeDays, effectiveRateDec, activeAtmIvDec, spreadFilter, liveMarket.version],
  );

  const spreadSummaryStats = useMemo(() => {
    const allCells: SpreadCellMetric[] = [];
    for (const r of detailedSpreadRows) {
      for (const c of [r.c1, r.c2, r.c3, r.c4, r.p1, r.p2, r.p3, r.p4]) {
        if (c !== null) allCells.push(c);
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
    () => buildBidirectionalFlow(activeExpiry?.rows ?? [], displaySpot, flowUnit),
    [activeExpiry, displaySpot, flowUnit, liveMarket.version]
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

  const underlyingChoices = useMemo(() => {
    const base = ['GGAL', 'YPFD', 'PAMP', 'BMA', 'COME', 'ALUA', 'TXAR', 'SUPV', 'SPY', 'QQQ'];
    return base.includes(upperUnderlying) ? base : [upperUnderlying, ...base];
  }, [upperUnderlying]);

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

  const rowHeightClass =
    density === 'densa' ? 'h-8 text-[12px]' : density === 'comoda' ? 'h-11 text-[13px]' : 'h-9 text-[12px]';

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
                <div className="flex items-center gap-1.5">
                  <select
                    value={upperUnderlying}
                    onChange={(e) => onSelectUnderlying(e.target.value)}
                    className="bg-transparent text-[20px] font-extrabold text-[#FFFFFF] tracking-tight outline-none cursor-pointer"
                  >
                    {underlyingChoices.map((t) => (
                      <option key={t} value={t} className="bg-[#131722] text-white">
                        {t}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-[#9CA3AF] -ml-1 pointer-events-none" />
                </div>
                <div className="text-[12px] text-[#787B86] leading-none">{stockName}</div>
              </div>
            </div>

            <div className="flex flex-col">
              <span className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                ÚLTIMO
              </span>
              <div className="flex flex-wrap items-baseline gap-2.5">
                <span
                  className={`font-mono-num text-[22px] font-extrabold tracking-tight ${
                    !Number.isFinite(displayDeltaPct)
                      ? 'text-[#FFFFFF]'
                      : displayDeltaPct < 0
                        ? 'text-[#F23645]'
                        : 'text-[#22C55E]'
                  }`}
                >
                  {fmtNum(displaySpot, 2)}
                </span>
                <span className="text-[12px] font-mono-num text-[#787B86]">
                  {upperUnderlying === 'SPY' ||
                  upperUnderlying === 'QQQ' ||
                  upperUnderlying === 'NVDA' ||
                  upperUnderlying === 'AAPL' ||
                  upperUnderlying === 'MSFT' ||
                  upperUnderlying === 'I:SPX'
                    ? 'USD'
                    : 'ARS'}
                </span>
                <span
                  className={`font-mono-num text-[13px] font-semibold ${
                    !Number.isFinite(displayDeltaPct)
                      ? 'text-[#787B86]'
                      : displayDeltaPct < 0
                        ? 'text-[#F23645]'
                        : 'text-[#22C55E]'
                  }`}
                >
                  {Number.isFinite(displayDeltaPct)
                    ? `${displayDeltaPct > 0 ? '+' : ''}${fmtNum(displayDeltaPct, 2)} %`
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
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-6 ml-auto">
            <div>
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                VTO.
              </div>
              <button
                type="button"
                onClick={() => {
                  if (GGAL_OPTION_EXPIRIES.length <= 1) return;
                  const idx = GGAL_OPTION_EXPIRIES.findIndex((e) => e.id === activeExpiry?.id);
                  const next = GGAL_OPTION_EXPIRIES[(idx + 1) % GGAL_OPTION_EXPIRIES.length];
                  if (next) setSelectedExpiryId(next.id);
                }}
                className="inline-flex items-center gap-1 font-mono-num text-[14px] font-bold text-[#FFFFFF] hover:text-[#EAB308] cursor-pointer"
              >
                <span>
                  {activeExpiry ? `${activeExpiry.label} · ${activeExpiry.daysToExpiry}d` : 'Sin vtos · —'}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-[#787B86]" />
              </button>
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
                {liveOptions ? `${fmtNum(liveOptions.dividendYield * 100, 1)}%` : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Selector rápido con logo por subyacente */}
        <div className="pt-2 border-t border-[#1E222D]/60 flex items-center gap-1.5 overflow-x-auto">
          <span className="text-[10px] font-mono-num uppercase tracking-wider text-[#6D7282] mr-1 shrink-0">
            Subyacente:
          </span>
          {underlyingChoices.map((t) => {
            const active = t === upperUnderlying;
            return (
              <button
                key={`opt-under-${t}`}
                type="button"
                onClick={() => onSelectUnderlying(t)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono-num font-semibold transition-colors cursor-pointer shrink-0 ${
                  active
                    ? 'bg-[#211B3A] border-[#8B7CF6]/70 text-[#FFFFFF]'
                    : 'bg-[#090B10] border-[#1E222D] text-[#9CA3AF] hover:text-[#FFFFFF] hover:border-[#2E3446]'
                }`}
              >
                <CompanyLogo ticker={t} size="xs" />
                <span>{t}</span>
              </button>
            );
          })}
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
              ? `1σ hoy = $${fmtNum(headerOneSigmaAbs, 0)} (±${fmtNum(headerOneSigmaPct, 1)}% al ${activeExpiry.label})`
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
                      ? `Vencimiento elegido: ${activeExpiry.label} (${activeExpiry.daysToExpiry} días). Desvío esperado 1σ = $${fmtNum(headerOneSigmaAbs, 0)}.`
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
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {visiblePayoffCards.map((card) => (
                <PayoffStrategyCard
                  key={card.id}
                  card={card}
                  onExecute={(c) => {
                    loadIntoBuilder(c.pricedLegs, 1);
                  }}
                />
              ))}
            </div>
          )}

          {/* OPTIMITZADOR CUANTITATIVO — LAS 3 MANERAS DE JUGARLA (PIEZA 18) */}
          {(() => {
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
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[24px] font-extrabold text-[#FFFFFF] tracking-tight">Spreads</h2>
              <HelpTooltip
                title="Matriz de Spreads en Escalera"
                text="Muestra la relación retorno/costo real de armar spreads verticales de 1, 2, 3 o 4 bases de ancho usando puntas Bid/Ask en vivo."
              />
            </div>
            <p className="text-[13px] text-[#9CA3AF]">
              Cada par de bases de {upperUnderlying} ({activeExpiry?.label ?? '—'}), con Débito Neto, Ratio Max Profit / Débito, Breakeven y Edge implícito.
            </p>
          </div>

          {/* Panel Resumen de Decisión Spreads (Calls Bull & Puts Bear) */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-[10px] bg-[#101218] border border-[#232733] p-3.5 space-y-1">
              <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#EAB308]">
                MEJOR BULL CALL SPREAD ({spreadSummaryStats.bestCall ? `${spreadSummaryStats.bestCall.longStrike}/${spreadSummaryStats.bestCall.shortStrike}` : '—'})
              </div>
              {spreadSummaryStats.bestCall ? (
                <>
                  <div className="font-mono-num text-[17px] font-extrabold text-[#FFFFFF]">
                    {fmtNum(spreadSummaryStats.bestCall.ratio, 2)}x R/B · Deb $ {fmtNum(spreadSummaryStats.bestCall.debit, 1)}
                  </div>
                  <div className="text-[11px] font-mono-num text-[#9CA3AF]">
                    BE $ {fmtNum(spreadSummaryStats.bestCall.breakeven, 0)} ({fmtPct(spreadSummaryStats.bestCall.beDistPct, 1)}) · Prob {fmtNum(spreadSummaryStats.bestCall.probBePct, 1)}% · Edge {fmtPct(spreadSummaryStats.bestCall.edgePct, 1)}
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-[#787B86] font-mono-num">Sin Call Spread válido en rango</div>
              )}
            </div>

            <div className="rounded-[10px] bg-[#101218] border border-[#232733] p-3.5 space-y-1">
              <div className="text-[10.5px] font-mono-num uppercase tracking-wider text-[#C084FC]">
                MEJOR BEAR PUT SPREAD ({spreadSummaryStats.bestPut ? `${spreadSummaryStats.bestPut.longStrike}/${spreadSummaryStats.bestPut.shortStrike}` : '—'})
              </div>
              {spreadSummaryStats.bestPut ? (
                <>
                  <div className="font-mono-num text-[17px] font-extrabold text-[#FFFFFF]">
                    {fmtNum(spreadSummaryStats.bestPut.ratio, 2)}x R/B · Deb $ {fmtNum(spreadSummaryStats.bestPut.debit, 1)}
                  </div>
                  <div className="text-[11px] font-mono-num text-[#9CA3AF]">
                    BE $ {fmtNum(spreadSummaryStats.bestPut.breakeven, 0)} ({fmtPct(spreadSummaryStats.bestPut.beDistPct, 1)}) · Prob {fmtNum(spreadSummaryStats.bestPut.probBePct, 1)}% · Edge {fmtPct(spreadSummaryStats.bestPut.edgePct, 1)}
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-[#787B86] font-mono-num">Sin Put Spread válido en rango</div>
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
                              <span
                                className={`px-2 py-0.5 rounded-full font-bold text-[11.5px] ${getSpreadPillColor(
                                  cell.ratio
                                )}`}
                              >
                                {fmtNum(cell.ratio, 2)}x
                              </span>
                              <span className="text-[9.5px] font-mono-num text-[#9CA3AF] leading-tight whitespace-nowrap">
                                Deb ${fmtNum(cell.debit, 0)} · BE {fmtPct(cell.beDistPct, 1)}
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
                title="Volumen y Delta por Base"
                text="Analiza el volumen operado en Calls y Puts por base y su exposición neta en acciones equivalentes provista por el feed BYMA."
              />
            </div>
            <p className="text-[13px] text-[#9CA3AF]">
              Volumen operado e interés en cada base de {upperUnderlying} ({activeExpiry?.label ?? '—'}).
            </p>
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
                  EN PESOS (PRIMAS)
                </div>
                <div className="font-mono-num text-[18px] font-extrabold text-[#FFFFFF] mt-0.5">
                  {flowSummary.totalTurnoverArsM > 0 ? fmtMoneyCompact(flowSummary.totalTurnoverArsM) : '—'}
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
                  <div className="text-[10px] uppercase text-[#787B86]">EN USD-CCL</div>
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

            <div className="grid grid-cols-11 border-b border-[#232733] text-[11px] font-bold uppercase tracking-wider text-center">
              <div className="col-span-5 py-2.5 bg-[#2B2819] text-[#EAB308]">CALL</div>
              <div className="col-span-1 py-2.5 bg-[#161922] text-[#9CA3AF]">BASE</div>
              <div className="col-span-5 py-2.5 bg-[#261D30] text-[#C084FC]">PUT</div>
            </div>

            <div className="divide-y divide-[#1A1E29] font-mono-num text-[12px]">
              {flowSummary.rows.length === 0 ? (
                <div className="py-8 text-center text-[#787B86]">
                  Sin flujo operado reportado para {upperUnderlying}.
                </div>
              ) : (
                flowSummary.rows.map((r: BidirectionalFlowRow) => (
                  <div
                    key={r.strikeNum}
                    className={`grid grid-cols-11 items-center h-9 ${
                      r.isAtm ? 'bg-[#1E222E]' : 'hover:bg-[#151922]'
                    }`}
                  >
                    <div className="col-span-5 flex items-center h-full px-3 gap-3">
                      <span
                        className={`w-16 text-right font-bold shrink-0 ${
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
                              <div style={{ width: `${Math.min(100, r.callNetHighlightPct)}%` }} className="h-full bg-[#EAB308]" />
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div
                      className={`col-span-1 h-full flex items-center justify-center font-bold text-[#FFFFFF] border-x border-[#232733] ${
                        r.isAtm ? 'bg-[#2B3040]' : 'bg-[#181B24]'
                      }`}
                    >
                      {r.base}
                    </div>

                    <div className="col-span-5 flex items-center justify-end h-full px-3 gap-3">
                      <div className="flex-1 h-5 flex items-center justify-end relative">
                        {r.putTotalPct > 0 && (
                          <div
                            style={{ width: `${r.putTotalPct}%` }}
                            className="h-5 rounded-[3px] bg-[#564D65] relative overflow-hidden flex items-center justify-end"
                          >
                            {r.putNetHighlightPct > 0 && (
                              <div style={{ width: `${Math.min(100, r.putNetHighlightPct)}%` }} className="h-full bg-[#A855F7]" />
                            )}
                          </div>
                        )}
                      </div>
                      <span
                        className={`w-16 text-left font-bold shrink-0 ${
                          r.putNetDir === 'neg' ? 'text-[#C084FC]' : 'text-[#6D7282]'
                        }`}
                      >
                        {r.putNetLabel}
                      </span>
                    </div>
                  </div>
                ))
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

              const sideColCount = colMode === 'completa' ? 8 : 5;

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

              const renderHoldingsCell = (holdings: number, ticker: string, isLeftBorder = false) => (
                <td
                  title={holdings !== 0 ? `${ticker}: tenencia neta ${holdings > 0 ? '+' : ''}${holdings} lotes` : `${ticker}: sin tenencia`}
                  className={`px-2 py-1.5 text-center font-mono-num text-[11.5px] bg-[#0A0A0D] ${
                    isLeftBorder ? '' : ''
                  } ${
                    holdings > 0
                      ? 'text-[#22C55E] font-semibold'
                      : holdings < 0
                        ? 'text-[#EF4444] font-semibold'
                        : 'text-[#374151]'
                  }`}
                >
                  {holdings > 0 ? `+${fmtNum(holdings, 0)}` : holdings < 0 ? fmtNum(holdings, 0) : ''}
                </td>
              );

              const renderVarCell = (valPct: number) => {
                if (!Number.isFinite(valPct)) {
                  return <td className="px-2 py-1.5 font-mono-num text-[11.5px] text-[#6B7280] bg-[#0A0A0D]">—</td>;
                }
                const cls =
                  valPct > 0 ? 'text-[#22C55E]' : valPct < 0 ? 'text-[#EF4444]' : 'text-[#6B7280]';
                return (
                  <td className={`px-2 py-1.5 font-mono-num text-[11.5px] bg-[#0A0A0D] ${cls}`}>
                    {valPct > 0 ? '+' : ''}
                    {fmtNum(valPct, 1)}%
                  </td>
                );
              };

              const renderTheoCell = (theo: number, ask: number) => {
                const isCheap =
                  Number.isFinite(ask) &&
                  ask > 0 &&
                  Number.isFinite(theo) &&
                  theo > 0 &&
                  ask < theo * 0.98;
                return (
                  <td
                    className={`px-2 py-1.5 font-mono-num text-[12px] bg-[#0A0A0D] ${
                      !Number.isFinite(theo) || theo < 0
                        ? 'text-[#6B7280]'
                        : isCheap
                          ? 'text-[#4ADE80]'
                          : 'text-[#9CA3AF]'
                    }`}
                  >
                    {Number.isFinite(theo) && theo >= 0 ? fmtNum(theo, 2) : '—'}
                  </td>
                );
              };

              const renderBidAskCell = (
                e: React.MouseEvent | null,
                _type: 'Call' | 'Put',
                _orderSide: 'Compra' | 'Venta',
                px: number,
                size: number,
                isBid: boolean,
                item: EnrichedChainRow,
                optType: 'Call' | 'Put',
                ticker: string
              ) => {
                const hasPx = Number.isFinite(px) && px > 0;
                const hasSize = Number.isFinite(size) && size > 0;
                const actionSide: 'Compra' | 'Venta' = isBid ? 'Venta' : 'Compra';
                void e;
                return (
                  <td
                    onClick={(ev) => handleQuoteClick(ev, item, optType, actionSide, px, ticker)}
                    title={
                      hasPx
                        ? `${ticker} · Click para ${actionSide.toLowerCase()} a ${fmtNum(px, 2)} (Shift+Click envía a Armado a mano)`
                        : `${ticker} · Sin punta`
                    }
                    className={`px-2 py-1.5 font-mono-num text-[12px] bg-[#0A0A0D] transition-colors ${
                      hasPx ? 'hover:bg-[#16161F] cursor-pointer' : ''
                    }`}
                  >
                    {hasPx ? (
                      <span className="inline-flex items-baseline justify-end gap-1">
                        <span className={isBid ? 'text-[#22C55E] font-medium' : 'text-[#EF4444] font-medium'}>
                          {fmtNum(px, 2)}
                        </span>
                        {hasSize && <span className="text-[10.5px] text-[#6B7280]">×{fmtNum(size, 0)}</span>}
                      </span>
                    ) : (
                      <span className="text-[#6B7280]">—</span>
                    )}
                  </td>
                );
              };

              const renderAxisMarkerRow = (marker: InlineAxisMarker) => (
                <tr key={marker.id} className="bg-[#0A0A0D]">
                  <td colSpan={sideColCount} className="p-0 bg-[#0A0A0D]">
                    <div
                      className={
                        marker.kind === 'spot' ? 'h-[1px] w-full bg-[#38BDF8]/35' : 'h-[1px] w-full bg-[#1C1C24]'
                      }
                    />
                  </td>
                  <td className="py-1 px-2 text-center bg-[#111116] border-x border-[#1C1C24]">
                    <span
                      title={marker.tooltip}
                      className={
                        marker.kind === 'spot'
                          ? 'inline-block rounded-full bg-[#38BDF8] text-[#08080D] font-bold font-mono-num text-[10.5px] px-2.5 py-0.5 leading-tight'
                          : 'inline-block rounded-full bg-[#1E1E2B] text-[#9CA3AF] font-mono-num text-[10px] font-semibold px-2 py-0.5 leading-tight'
                      }
                    >
                      {marker.label}
                    </span>
                  </td>
                  <td colSpan={sideColCount} className="p-0 bg-[#0A0A0D]">
                    <div
                      className={
                        marker.kind === 'spot' ? 'h-[1px] w-full bg-[#38BDF8]/35' : 'h-[1px] w-full bg-[#1C1C24]'
                      }
                    />
                  </td>
                </tr>
              );

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
                    className="px-4 py-3 bg-[#111116] border-b border-[#1C1C24] cursor-pointer hover:bg-[#15151D] transition-colors space-y-2"
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
                          <span className="font-mono-num text-[#9CA3AF]">{exp.daysToExpiry}d</span>
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
                    <div className="overflow-x-auto bg-[#0A0A0D]">
                      <table className="w-full border-collapse text-right">
                        <thead>
                          <tr className="border-b border-[#1C1C24] text-[10.5px] font-bold uppercase tracking-[0.08em]">
                            <th
                              colSpan={sideColCount}
                              style={{ backgroundColor: 'rgba(229, 199, 107, 0.08)', color: '#E5C76B' }}
                              className="py-1.5 px-3 text-center"
                            >
                              CALL
                            </th>
                            <th className="py-1.5 px-3 text-center bg-[#111116] text-[#9CA3AF] border-x border-[#1C1C24]">
                              BASE
                            </th>
                            <th
                              colSpan={sideColCount}
                              style={{ backgroundColor: 'rgba(183, 148, 244, 0.08)', color: '#B794F4' }}
                              className="py-1.5 px-3 text-center"
                            >
                              PUT
                            </th>
                          </tr>
                          <tr className="border-b border-[#1C1C24] bg-[#0D0D12] text-[10.5px] font-medium text-[#6B7280]">
                            {colMode === 'completa' && (
                              <>
                                <th className="py-2 px-2">Delta Δ</th>
                                <th className="py-2 px-2">VI %</th>
                                <th className="py-2 px-2">teórico</th>
                                <th className="py-2 px-2">últ.</th>
                                <th className="py-2 px-2">var%</th>
                                <th className="py-2 px-2">compra</th>
                                <th className="py-2 px-2">venta</th>
                                <th className="py-2 px-2 text-center">tenencia</th>
                              </>
                            )}
                            {colMode === 'griegas' && (
                              <>
                                <th className="py-2 px-2">Gamma Γ</th>
                                <th className="py-2 px-2">Theta Θ (d)</th>
                                <th className="py-2 px-2">Vega ν</th>
                                <th className="py-2 px-2">VI %</th>
                                <th className="py-2 px-2">Delta Δ</th>
                              </>
                            )}
                            {colMode === 'valortiempo' && (
                              <>
                                <th className="py-2 px-2">teórico</th>
                                <th className="py-2 px-2">Val. Intrínseco</th>
                                <th className="py-2 px-2">Val. Tiempo $</th>
                                <th className="py-2 px-2">Tasa % s/Spot</th>
                                <th className="py-2 px-2">últ.</th>
                              </>
                            )}
                            {colMode === 'liquidez' && (
                              <>
                                <th className="py-2 px-2">Rotación OI</th>
                                <th className="py-2 px-2">Int. Abierto</th>
                                <th className="py-2 px-2">Lotes Hoy</th>
                                <th className="py-2 px-2">compra</th>
                                <th className="py-2 px-2">venta</th>
                              </>
                            )}

                            <th className="py-2 px-3 text-center bg-[#111116] text-[#9CA3AF] border-x border-[#1C1C24]">
                              BASE
                            </th>

                            {colMode === 'completa' && (
                              <>
                                <th className="py-2 px-2 text-center">tenencia</th>
                                <th className="py-2 px-2">compra</th>
                                <th className="py-2 px-2">venta</th>
                                <th className="py-2 px-2">var%</th>
                                <th className="py-2 px-2">últ.</th>
                                <th className="py-2 px-2">teórico</th>
                                <th className="py-2 px-2">VI %</th>
                                <th className="py-2 px-2">Delta Δ</th>
                              </>
                            )}
                            {colMode === 'griegas' && (
                              <>
                                <th className="py-2 px-2">Delta Δ</th>
                                <th className="py-2 px-2">VI %</th>
                                <th className="py-2 px-2">Vega ν</th>
                                <th className="py-2 px-2">Theta Θ (d)</th>
                                <th className="py-2 px-2">Gamma Γ</th>
                              </>
                            )}
                            {colMode === 'valortiempo' && (
                              <>
                                <th className="py-2 px-2">últ.</th>
                                <th className="py-2 px-2">Tasa % s/Spot</th>
                                <th className="py-2 px-2">Val. Tiempo $</th>
                                <th className="py-2 px-2">Val. Intrínseco</th>
                                <th className="py-2 px-2">teórico</th>
                              </>
                            )}
                            {colMode === 'liquidez' && (
                              <>
                                <th className="py-2 px-2">compra</th>
                                <th className="py-2 px-2">venta</th>
                                <th className="py-2 px-2">Lotes Hoy</th>
                                <th className="py-2 px-2">Int. Abierto</th>
                                <th className="py-2 px-2">Rotación OI</th>
                              </>
                            )}
                          </tr>
                        </thead>

                        <tbody className="divide-y divide-[#1C1C24] font-mono-num">
                          {filteredRows.length === 0 ? (
                            <tr>
                              <td colSpan={sideColCount * 2 + 1} className="py-6 text-center text-[12px] text-[#6B7280]">
                                Ninguna base dentro de la banda ±{sigmaMultiplier}σ seleccionada. Desactivá el filtro o ampliá a ±2σ.
                              </td>
                            </tr>
                          ) : (
                            <>
                              {beforeFirst.map(renderAxisMarkerRow)}
                              {filteredRows.map((item: EnrichedChainRow, idx: number) => {
                                const { row } = item;
                                const spotValid = Number.isFinite(displaySpot) && displaySpot > 0;
                                const callGammaSafe = Number.isFinite(row.callGamma)
                                  ? row.callGamma
                                  : safeAnalyticalBsmGamma(
                                      displaySpot,
                                      row.strike,
                                      row.callIV,
                                      exp.daysToExpiry,
                                      effectiveRateDec
                                    );
                                const putGammaSafe = Number.isFinite(row.putGamma)
                                  ? row.putGamma
                                  : safeAnalyticalBsmGamma(
                                      displaySpot,
                                      row.strike,
                                      row.putIV,
                                      exp.daysToExpiry,
                                      effectiveRateDec
                                    );
                                const callOiRatio =
                                  Number.isFinite(row.callOpenInterest) && row.callOpenInterest > 0
                                    ? (row.callVolumeLots / row.callOpenInterest) * 100
                                    : Number.NaN;
                                const putOiRatio =
                                  Number.isFinite(row.putOpenInterest) && row.putOpenInterest > 0
                                    ? (row.putVolumeLots / row.putOpenInterest) * 100
                                    : Number.NaN;
                                const trailingMarkers = afterIndex.get(idx) ?? [];

                                return (
                                  <React.Fragment key={row.strike}>
                                    <tr className={`${rowHeightClass} bg-[#0A0A0D] hover:bg-[#13131A] transition-colors`}>
                                      {/* CALL SIDE */}
                                      {colMode === 'completa' && (
                                        <>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {fmtNum(row.callDelta, 2)}
                                          </td>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {Number.isFinite(row.callIV) ? `${fmtNum(row.callIV, 1)}%` : '—'}
                                          </td>
                                          {renderTheoCell(item.callTheoreticalPrice, row.callAsk)}
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#E5E7EB]">
                                            {Number.isFinite(row.callLast) ? fmtNum(row.callLast, 2) : '—'}
                                          </td>
                                          {renderVarCell(item.callChangePct)}
                                          {renderBidAskCell(
                                            null,
                                            'Call',
                                            'Venta',
                                            row.callBid,
                                            item.callBidSize,
                                            true,
                                            item,
                                            'Call',
                                            row.callTicker
                                          )}
                                          {renderBidAskCell(
                                            null,
                                            'Call',
                                            'Compra',
                                            row.callAsk,
                                            item.callAskSize,
                                            false,
                                            item,
                                            'Call',
                                            row.callTicker
                                          )}
                                          {renderHoldingsCell(item.callHoldings, row.callTicker)}
                                        </>
                                      )}

                                      {colMode === 'griegas' && (
                                        <>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {fmtNum(callGammaSafe, 5)}
                                          </td>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#EF4444]">
                                            {Number.isFinite(row.callTheta) ? `-${fmtNum(Math.abs(row.callTheta), 2)}` : '—'}
                                          </td>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {Number.isFinite(row.callVega) ? fmtNum(row.callVega, 2) : '—'}
                                          </td>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {Number.isFinite(row.callIV) ? `${fmtNum(row.callIV, 1)}%` : '—'}
                                          </td>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#E5E7EB]">
                                            {fmtNum(row.callDelta, 2)}
                                          </td>
                                        </>
                                      )}

                                      {colMode === 'valortiempo' && (
                                        <>
                                          {renderTheoCell(item.callTheoreticalPrice, row.callAsk)}
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {spotValid ? fmtNum(Math.max(0, displaySpot - row.strike), 2) : '—'}
                                          </td>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#E5E7EB]">
                                            {Number.isFinite(row.callTimeValue) ? fmtNum(row.callTimeValue, 2) : '—'}
                                          </td>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {Number.isFinite(row.callTimeValuePct)
                                              ? `${fmtNum(row.callTimeValuePct, 2)}%`
                                              : '—'}
                                          </td>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#E5E7EB]">
                                            {Number.isFinite(row.callLast) ? fmtNum(row.callLast, 2) : '—'}
                                          </td>
                                        </>
                                      )}

                                      {colMode === 'liquidez' && (
                                        <>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {Number.isFinite(callOiRatio) ? `${fmtNum(callOiRatio, 1)}%` : '—'}
                                          </td>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {fmtNum(row.callOpenInterest, 0)}
                                          </td>
                                          <td title={row.callTicker} className="px-2 py-1.5 text-[#E5E7EB]">
                                            {fmtNum(row.callVolumeLots, 0)}
                                          </td>
                                          {renderBidAskCell(
                                            null,
                                            'Call',
                                            'Venta',
                                            row.callBid,
                                            item.callBidSize,
                                            true,
                                            item,
                                            'Call',
                                            row.callTicker
                                          )}
                                          {renderBidAskCell(
                                            null,
                                            'Call',
                                            'Compra',
                                            row.callAsk,
                                            item.callAskSize,
                                            false,
                                            item,
                                            'Call',
                                            row.callTicker
                                          )}
                                        </>
                                      )}

                                      {/* BASE CENTRAL */}
                                      <td
                                        title={`Call: ${row.callTicker} · Put: ${row.putTicker}`}
                                        className="px-3 py-1 text-center bg-[#111116] border-x border-[#1C1C24]"
                                      >
                                        <div className="flex flex-col items-center leading-tight">
                                          <span className="font-bold text-[#F3F4F6]">
                                            {fmtNum(row.strike, row.strike % 1 === 0 ? 0 : 2)}
                                          </span>
                                          <span className="text-[10px] font-normal text-[#6B7280]">
                                            {Number.isFinite(row.distancePct)
                                              ? `${row.distancePct > 0 ? '+' : ''}${fmtNum(row.distancePct, 1)}%`
                                              : '—'}
                                          </span>
                                        </div>
                                      </td>

                                      {/* PUT SIDE (simétrica centro -> derecha) */}
                                      {colMode === 'completa' && (
                                        <>
                                          {renderHoldingsCell(item.putHoldings, row.putTicker)}
                                          {renderBidAskCell(
                                            null,
                                            'Put',
                                            'Venta',
                                            row.putBid,
                                            item.putBidSize,
                                            true,
                                            item,
                                            'Put',
                                            row.putTicker
                                          )}
                                          {renderBidAskCell(
                                            null,
                                            'Put',
                                            'Compra',
                                            row.putAsk,
                                            item.putAskSize,
                                            false,
                                            item,
                                            'Put',
                                            row.putTicker
                                          )}
                                          {renderVarCell(item.putChangePct)}
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#E5E7EB]">
                                            {Number.isFinite(row.putLast) ? fmtNum(row.putLast, 2) : '—'}
                                          </td>
                                          {renderTheoCell(item.putTheoreticalPrice, row.putAsk)}
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {Number.isFinite(row.putIV) ? `${fmtNum(row.putIV, 1)}%` : '—'}
                                          </td>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {fmtNum(row.putDelta, 2)}
                                          </td>
                                        </>
                                      )}

                                      {colMode === 'griegas' && (
                                        <>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#E5E7EB]">
                                            {fmtNum(row.putDelta, 2)}
                                          </td>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {Number.isFinite(row.putIV) ? `${fmtNum(row.putIV, 1)}%` : '—'}
                                          </td>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {Number.isFinite(row.putVega) ? fmtNum(row.putVega, 2) : '—'}
                                          </td>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#EF4444]">
                                            {Number.isFinite(row.putTheta) ? `-${fmtNum(Math.abs(row.putTheta), 2)}` : '—'}
                                          </td>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {fmtNum(putGammaSafe, 5)}
                                          </td>
                                        </>
                                      )}

                                      {colMode === 'valortiempo' && (
                                        <>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#E5E7EB]">
                                            {Number.isFinite(row.putLast) ? fmtNum(row.putLast, 2) : '—'}
                                          </td>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {Number.isFinite(row.putTimeValuePct)
                                              ? `${fmtNum(row.putTimeValuePct, 2)}%`
                                              : '—'}
                                          </td>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#E5E7EB]">
                                            {Number.isFinite(row.putTimeValue) ? fmtNum(row.putTimeValue, 2) : '—'}
                                          </td>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {spotValid ? fmtNum(Math.max(0, row.strike - displaySpot), 2) : '—'}
                                          </td>
                                          {renderTheoCell(item.putTheoreticalPrice, row.putAsk)}
                                        </>
                                      )}

                                      {colMode === 'liquidez' && (
                                        <>
                                          {renderBidAskCell(
                                            null,
                                            'Put',
                                            'Venta',
                                            row.putBid,
                                            item.putBidSize,
                                            true,
                                            item,
                                            'Put',
                                            row.putTicker
                                          )}
                                          {renderBidAskCell(
                                            null,
                                            'Put',
                                            'Compra',
                                            row.putAsk,
                                            item.putAskSize,
                                            false,
                                            item,
                                            'Put',
                                            row.putTicker
                                          )}
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#E5E7EB]">
                                            {fmtNum(row.putVolumeLots, 0)}
                                          </td>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {fmtNum(row.putOpenInterest, 0)}
                                          </td>
                                          <td title={row.putTicker} className="px-2 py-1.5 text-[#9CA3AF]">
                                            {Number.isFinite(putOiRatio) ? `${fmtNum(putOiRatio, 1)}%` : '—'}
                                          </td>
                                        </>
                                      )}
                                    </tr>
                                    {trailingMarkers.map(renderAxisMarkerRow)}
                                  </React.Fragment>
                                );
                              })}
                            </>
                          )}
                        </tbody>
                      </table>
                    </div>
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
              <div className="space-y-4">
                <VolatilitySurface mkt={labMarket} expiries={GGAL_OPTION_EXPIRIES} />
                {(() => {
                  const qe = activeQuantEngines;
                  const vc = qe?.volCone;
                  const pq = qe?.pqDivergence;
                  const sr = qe?.syntheticRates;
                  const cr = qe?.conversionReversal;
                  const bw = qe?.buyWrite;
                  const cal = qe?.calendarRoll;
                  const conf = qe?.confluenceClusters;
                  return (
                    <div className="rounded-[14px] bg-[#101218] border border-[#232733] p-5 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-[15px] font-extrabold text-[#FFFFFF]">
                          Cono de Volatilidad, Divergencia ℙ vs. ℚ &amp; Arbitraje Sintético / Calendars ({upperUnderlying})
                        </h3>
                        <span className="font-mono-num text-[11px] text-[#9CA3AF]">
                          IV Rank: <strong className="text-[#FFFFFF]">{vc?.ivRank != null ? `${fmtNum(vc.ivRank, 1)}%` : '—'}</strong> ·
                          IV Pct: <strong className="text-[#38BDF8]">{vc?.ivPercentile != null ? `${fmtNum(vc.ivPercentile, 1)}%` : '—'}</strong>
                        </span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px] font-mono-num">
                        <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1.5">
                          <div className="text-[10.5px] font-bold uppercase text-[#38BDF8]">
                            DIVERGENCIA ℙ vs. ℚ (BREEDEN-LITZENBERGER)
                          </div>
                          <div className="flex justify-between text-[#9CA3AF]">
                            <span>Media ℚ / Desv. ℚ</span>
                            <span className="text-[#FFFFFF]">
                              {qe?.qDistribution?.meanQ != null ? `$${fmtNum(qe.qDistribution.meanQ, 1)}` : '—'} ·{' '}
                              {qe?.qDistribution?.stdDevQ != null ? `±$${fmtNum(qe.qDistribution.stdDevQ, 1)}` : '—'}
                            </span>
                          </div>
                          <div className="flex justify-between text-[#9CA3AF]">
                            <span>Colas &gt; 3σ (ℙ Empírica)</span>
                            <span className="text-[#EAB308]">
                              {qe?.pDistribution?.tailEventsCount ?? '—'} eventos (
                              {qe?.pDistribution?.tailFrequencyPct != null ? `${fmtNum(qe.pDistribution.tailFrequencyPct, 1)}%` : '—'})
                            </span>
                          </div>
                          {(pq?.levels ?? []).slice(0, 2).map((lv) => (
                            <div key={lv.label} className="flex justify-between text-[11px] pt-1 border-t border-[#1E222D]">
                              <span className="text-[#D1D4DC]">{lv.label}</span>
                              <span className="text-[#22C55E]">
                                P {lv.probP != null ? `${fmtNum(lv.probP * 100, 1)}%` : '—'} vs Q{' '}
                                {lv.probQ != null ? `${fmtNum(lv.probQ * 100, 1)}%` : '—'}
                              </span>
                            </div>
                          ))}
                        </div>

                        <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1.5">
                          <div className="text-[10.5px] font-bold uppercase text-[#C084FC]">
                            TASA SINTÉTICA, BORROW &amp; CONV/REV
                          </div>
                          <div className="flex justify-between text-[#9CA3AF]">
                            <span>Tasa Implícita TNA</span>
                            <span className="text-[#FFFFFF]">
                              {sr?.medianImpliedTna != null ? `${fmtNum(sr.medianImpliedTna * 100, 2)}%` : '—'}
                            </span>
                          </div>
                          <div className="flex justify-between text-[#9CA3AF]">
                            <span>Régimen Borrow</span>
                            <span className="text-[#EAB308]">{sr?.borrowRegime ?? '—'}</span>
                          </div>
                          <div className="flex justify-between text-[#9CA3AF]">
                            <span>Conv/Rev Edge (bps)</span>
                            <span className="text-[#FFFFFF]">
                              {cr?.netEdgeVsRiskFreeBps != null ? `${fmtNum(cr.netEdgeVsRiskFreeBps, 0)} pb (${cr.arbitrageSignal})` : '—'}
                            </span>
                          </div>
                          <div className="flex justify-between text-[#9CA3AF] pt-1 border-t border-[#1E222D]">
                            <span>Clusters &lt; 0,15 ATR</span>
                            <span className="text-[#38BDF8]">
                              {conf?.strongestClusterCentroid != null ? `$${fmtNum(conf.strongestClusterCentroid, 1)}` : '—'}
                            </span>
                          </div>
                        </div>

                        <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1.5">
                          <div className="text-[10.5px] font-bold uppercase text-[#22C55E]">
                            BUY-WRITE (LANZAMIENTO) &amp; CALENDAR ROLL
                          </div>
                          <div className="flex justify-between text-[#9CA3AF]">
                            <span>Buy-Write BE / Estática</span>
                            <span className="text-[#FFFFFF]">
                              {bw?.breakevenPrice != null ? `$${fmtNum(bw.breakevenPrice, 1)}` : '—'} ·{' '}
                              {bw?.staticAnnualizedTna != null ? `${fmtNum(bw.staticAnnualizedTna * 100, 1)}%` : '—'}
                            </span>
                          </div>
                          <div className="flex justify-between text-[#9CA3AF]">
                            <span>TNA Ejercida</span>
                            <span className="text-[#22C55E]">
                              {bw?.assignedAnnualizedTna != null ? `${fmtNum(bw.assignedAnnualizedTna * 100, 1)}%` : '—'}
                            </span>
                          </div>
                          <div className="flex justify-between text-[#9CA3AF] pt-1 border-t border-[#1E222D]">
                            <span>Calendar Roll Créd.</span>
                            <span className="text-[#FFFFFF]">
                              {cal?.netRollCredit != null ? `$${fmtNum(cal.netRollCredit, 2)}` : '—'}
                            </span>
                          </div>
                          <div className="flex justify-between text-[#9CA3AF]">
                            <span>Roll Yield Anual</span>
                            <span className="text-[#38BDF8]">
                              {cal?.annualizedRollYieldOnSpot != null ? `${fmtNum(cal.annualizedRollYieldOnSpot * 100, 1)}%` : '—'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
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
                      const rLo = builderRows[Math.max(0, atmBuilderIdx - 1)];
                      const rMid = builderRows[atmBuilderIdx];
                      const rHi = builderRows[Math.min(builderRows.length - 1, atmBuilderIdx + 1)];
                      return rLo && rMid && rHi
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
    </div>
  );
};
