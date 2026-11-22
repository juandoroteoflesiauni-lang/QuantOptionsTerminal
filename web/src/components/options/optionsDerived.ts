import type {
  ArOptionContractDto,
  ArOptionExpiryDto,
  ArOptionsQuantEnginesDto,
  ArOptionsResponse,
  SerializedTerminalEnginesDto,
  UsSnapshotResponseDto,
} from '../../data/liveTypes';
import {
  type OptionChainRow,
  type OptionExpiryGroup,
  fmtMoneyCompact,
  fmtNum,
} from '../../data/marketData';
import {
  DEFAULT_MIN_SPREAD_DEBIT,
  type LiquiditySemaphore,
} from '../../../../src/core/options/verticalSpreads';
import {
  COMMISSION_RATE,
  Evaluation,
  LOT,
  Market,
  PricedLeg,
  Strategy,
  atmIv,
  bsPrice,
  candidatesForGoal,
  evaluate,
  fk,
  generateCandidates,
  ncdf,
  probAbove,
} from './engine';

export type StrategyFamilyId =
  | 'sugeridas'
  | 'bull_spread'
  | 'bear_spread'
  | 'mariposas'
  | 'condores'
  | 'conos'
  | 'cunas'
  | 'sinteticos'
  | 'ratios'
  | 'calendarios'
  | 'compradas'
  | 'lanzadas'
  | 'lanz_cubierto'
  | 'married_put'
  | 'collar';

export interface BuilderLeg {
  id: string;
  side: 'Compra' | 'Venta';
  type: 'Call' | 'Put' | 'Subyacente';
  strike: number;
  qty: number;
  premium: number;
  iv: number;
  delta: number;
  theta: number;
}

export interface VisualPayoffCardData {
  id: string;
  title: string;
  subtitle: string;
  note?: string;
  family: StrategyFamilyId;
  bias: 'Alcista' | 'Lateral' | 'Bajista' | 'Se mueve';
  mode: 'familia' | 'objetivo' | 'both';
  yLabels: [string, string, string];
  xLabels: string[];
  breakevenLabels?: { xPct: number; label: string }[];
  targetLinePct?: number;
  spotLinePct: number;
  points: { x: number; y: number }[];
  metrics: {
    label1: string;
    val1: string;
    color1: 'green' | 'white';
    label2: string;
    val2: string;
    color2: 'red' | 'white';
    label3: string;
    val3: string;
    color3: 'green' | 'red' | 'white';
    label4: string;
    val4: string;
  };
  netPrice: number;
  pricedLegs: PricedLeg[];
  bidAskPctOfMid?: number;
  liquiditySemaphore?: LiquiditySemaphore;
}

export interface StrategyComparisonRow {
  id: string;
  name: string;
  tag?: string;
  desc: string;
  caja: string;
  cajaNum: number;
  maxGan: string;
  maxPerd: string;
  ganaPierde: string;
  crece: string;
  prob: string;
  delta: string;
  porDia: string;
  relacion: string;
  empates: [string, string?];
  pricedLegs: PricedLeg[];
  bidAskPctOfMid?: number;
  liquiditySemaphore?: LiquiditySemaphore;
}

export interface SpreadLadderRow {
  base: string;
  strikeNum: number;
  c4: number;
  c3: number;
  c2: number;
  c1: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  spotMarkerAfter?: string;
  sigmaMarkerAfter?: string;
}

export interface BidirectionalFlowRow {
  base: string;
  strikeNum: number;
  isAtm: boolean;
  callNetLabel: string;
  callNetDir: 'pos' | 'neg' | 'none';
  callTotalPct: number;
  callNetHighlightPct: number;
  putNetLabel: string;
  putNetDir: 'pos' | 'neg' | 'none';
  putTotalPct: number;
  putNetHighlightPct: number;
}

export interface FlowSummary {
  rows: BidirectionalFlowRow[];
  totalCallLots: number;
  totalPutLots: number;
  totalLots: number;
  totalTurnoverM: number;
  callSharePct: number;
  putCallRatio: number;
  netDeltaEqShares: number;
  dominantDirection: string;
}

export interface FlowCurrencyOptions {
  readonly market: 'AR' | 'US';
  readonly contractMultiplier: number;
}

export interface GreekComponentRow {
  global: number;
  call: number;
  put: number;
  stock: number;
}

export interface BuilderAnalytics {
  payoffGrid: { spot: number; pnlFinish: number; pnlTheo: number }[];
  stressRows: { stepPct: number; projSpot: number; finishPnl: number; theoNow: number }[];
  oiByGridSpot: { callOi: number; putOi: number }[];
  netCash: number;
  totalCommission: number;
  maxGain: number;
  maxLoss: number;
  unlimitedGain: boolean;
  unlimitedLoss: boolean;
  breakevens: number[];
  pop: number;
  expectedMoveAbs: number;
  expectedMovePct: number;
  delta: GreekComponentRow;
  gamma: GreekComponentRow;
  vega: GreekComponentRow;
  theta: GreekComponentRow;
  rho: GreekComponentRow;
}

function mapEngineFamilyToUi(ev: Evaluation): { family: StrategyFamilyId; bias: VisualPayoffCardData['bias'] } {
  const f = ev.strategy.family;
  if (f === 'Bull spread') return { family: 'bull_spread', bias: 'Alcista' };
  if (f === 'Bear spread') return { family: 'bear_spread', bias: 'Bajista' };
  if (f === 'Mariposa') return { family: 'mariposas', bias: 'Lateral' };
  if (f === 'Cóndor') return { family: 'condores', bias: 'Lateral' };
  if (f === 'Cono') return { family: 'conos', bias: 'Se mueve' };
  if (f === 'Cuña') return { family: 'cunas', bias: 'Se mueve' };
  if (f === 'Calendario') return { family: 'calendarios', bias: 'Lateral' };
  const firstLeg = ev.legs[0];
  if (firstLeg?.type === 'P') return { family: 'compradas', bias: 'Bajista' };
  return { family: 'compradas', bias: 'Alcista' };
}

function isFamilyMatch(cardFamily: StrategyFamilyId, selected: StrategyFamilyId): boolean {
  if (selected === 'calendarios') return cardFamily === 'calendarios';
  if (selected === 'sugeridas') return true;
  if (cardFamily === selected) return true;
  return false;
}

export function buildCalendarStrategies(
  mkt: Market,
  expiries: readonly OptionExpiryGroup[] = [],
): Strategy[] {
  if (!Number.isFinite(mkt.spot) || mkt.spot <= 0 || mkt.strikes.length === 0) {
    return [];
  }
  const farExpiries = expiries
    .filter((e) => e.id !== mkt.expiryCode && e.daysToExpiry > mkt.days)
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  const farExp = farExpiries[0];
  if (!farExp) {
    return [];
  }

  const farStrikeSet = new Set(farExp.rows.map((r) => r.strike));
  const sharedNearAtm = [...new Set(mkt.strikes)]
    .filter((k) => Number.isFinite(k) && k > 0 && (farStrikeSet.size === 0 || farStrikeSet.has(k)))
    .sort((a, b) => Math.abs(a - mkt.spot) - Math.abs(b - mkt.spot))
    .slice(0, 6)
    .sort((a, b) => a - b);

  const candidateStrikes =
    sharedNearAtm.length > 0
      ? sharedNearAtm
      : [...new Set(mkt.strikes)]
          .filter((k) => Number.isFinite(k) && k > 0)
          .sort((a, b) => Math.abs(a - mkt.spot) - Math.abs(b - mkt.spot))
          .slice(0, 4)
          .sort((a, b) => a - b);

  const out: Strategy[] = [];
  for (const k of candidateStrikes) {
    for (const type of ['C', 'P'] as const) {
      out.push({
        id: `cal-${type}-${k}-${mkt.expiryCode}-${farExp.id}`,
        family: 'Calendario',
        name: `Calendario ${type === 'C' ? 'calls' : 'puts'} ${fk(k)} (${mkt.days}d/${farExp.daysToExpiry}d)`,
        desc: `Vendés corto (${mkt.expiryLabel}) y comprás largo (${farExp.label}) en la misma base para capturar diferencial de Theta`,
        legs: [
          {
            side: -1,
            type,
            K: k,
            ratio: 1,
            expiryCode: mkt.expiryCode,
            expiryLabel: mkt.expiryLabel,
            days: mkt.days,
          },
          {
            side: 1,
            type,
            K: k,
            ratio: 1,
            expiryCode: farExp.id,
            expiryLabel: farExp.label,
            days: farExp.daysToExpiry,
          },
        ],
      });
    }
  }
  return out;
}

function buildStrategyPool(
  mkt: Market,
  strategyMode: 'familia' | 'objetivo',
  selectedFamily: StrategyFamilyId,
  marketBias: 'Alcista' | 'Lateral' | 'Bajista' | 'Se mueve',
  targetPrice: number,
  expiries: readonly OptionExpiryGroup[] = [],
): Strategy[] {
  if (selectedFamily === 'calendarios' && strategyMode === 'familia') {
    return buildCalendarStrategies(mkt, expiries);
  }
  if (strategyMode === 'objetivo') {
    const goalSpot = Number.isFinite(targetPrice) && targetPrice > 0 ? targetPrice : mkt.spot;
    return [
      ...candidatesForGoal(mkt, { mode: 'precio', price: goalSpot, range: null, move: null }),
      ...candidatesForGoal(mkt, {
        mode: 'rango',
        price: null,
        range: [mkt.spot * 0.93, mkt.spot * 1.07],
        move: null,
      }),
    ];
  }

  if (selectedFamily === 'mariposas' || selectedFamily === 'condores') {
    return candidatesForGoal(mkt, {
      mode: 'rango',
      price: null,
      range: [mkt.spot * 0.92, mkt.spot * 1.08],
      move: null,
    });
  }
  if (selectedFamily === 'conos' || selectedFamily === 'cunas') {
    return candidatesForGoal(mkt, {
      mode: 'mueve',
      price: null,
      range: null,
      move: mkt.spot * 0.12,
    });
  }
  if (selectedFamily === 'bear_spread') {
    return generateCandidates(mkt, mkt.spot * 0.85);
  }
  if (selectedFamily === 'bull_spread' || selectedFamily === 'compradas') {
    return generateCandidates(mkt, marketBias === 'Bajista' ? mkt.spot * 0.85 : mkt.spot * 1.15);
  }

  const biasTarget =
    marketBias === 'Bajista'
      ? mkt.spot * 0.88
      : marketBias === 'Alcista'
      ? mkt.spot * 1.12
      : mkt.spot;
  const pool: Strategy[] = [];
  if (marketBias === 'Lateral') {
    pool.push(
      ...candidatesForGoal(mkt, {
        mode: 'rango',
        price: null,
        range: [mkt.spot * 0.92, mkt.spot * 1.08],
        move: null,
      })
    );
  } else if (marketBias === 'Se mueve') {
    pool.push(
      ...candidatesForGoal(mkt, {
        mode: 'mueve',
        price: null,
        range: null,
        move: mkt.spot * 0.12,
      })
    );
  }
  pool.push(...generateCandidates(mkt, biasTarget));
  return pool;
}

export function buildLiveStrategyCardsAndRows(
  mkt: Market,
  opts: {
    strategyMode: 'familia' | 'objetivo';
    selectedFamily: StrategyFamilyId;
    marketBias: 'Alcista' | 'Lateral' | 'Bajista' | 'Se mueve';
    targetPrice: number;
    expiries?: readonly OptionExpiryGroup[];
  }
): { cards: VisualPayoffCardData[]; rows: StrategyComparisonRow[] } {
  const sig = atmIv(mkt.days);
  if (!Number.isFinite(mkt.spot) || mkt.spot <= 0 || mkt.strikes.length < 3 || !Number.isFinite(sig) || sig <= 0) {
    return { cards: [], rows: [] };
  }

  const evalSpot =
    opts.strategyMode === 'objetivo' && Number.isFinite(opts.targetPrice) && opts.targetPrice > 0
      ? opts.targetPrice
      : opts.marketBias === 'Bajista'
      ? mkt.spot * 0.9
      : opts.marketBias === 'Alcista'
      ? mkt.spot * 1.1
      : mkt.spot;

  const rawStrategies = buildStrategyPool(
    mkt,
    opts.strategyMode,
    opts.selectedFamily,
    opts.marketBias,
    evalSpot,
    opts.expiries ?? [],
  );

  const seenIds = new Set<string>();
  const evaluated: Evaluation[] = [];
  for (const st of rawStrategies) {
    if (seenIds.has(st.id)) continue;
    seenIds.add(st.id);
    const ev = evaluate(mkt, st, evalSpot);
    if (!Number.isFinite(ev.cash) || !Number.isFinite(ev.pop) || !ev.eligibleForAutoRanking) continue;
    if (opts.strategyMode === 'familia' && opts.selectedFamily !== 'sugeridas') {
      const mapped = mapEngineFamilyToUi(ev);
      if (!isFamilyMatch(mapped.family, opts.selectedFamily)) continue;
      if (opts.selectedFamily === 'calendarios') {
        const expSet = new Set(ev.legs.map((l) => l.expiryCode ?? mkt.expiryCode));
        if (expSet.size < 2 || ev.strategy.family !== 'Calendario') continue;
      }
    }
    evaluated.push(ev);
    if (evaluated.length >= 60) break;
  }

  evaluated.sort((a, b) => {
    const gainA = Number.isFinite(a.gainAtTarget) ? a.gainAtTarget : -Infinity;
    const gainB = Number.isFinite(b.gainAtTarget) ? b.gainAtTarget : -Infinity;
    const popDiff = (b.pop || 0) - (a.pop || 0);
    if (opts.strategyMode === 'objetivo') {
      return gainB - gainA;
    }
    return popDiff * 0.4 + Math.sign(gainB - gainA) * 0.2;
  });

  const loPrice = mkt.spot * 0.78;
  const hiPrice = mkt.spot * 1.24;
  const xRange = Math.max(1e-6, hiPrice - loPrice);
  const spotLinePct = Math.max(5, Math.min(95, ((mkt.spot - loPrice) / xRange) * 100));
  const targetLinePct =
    opts.strategyMode === 'objetivo' && Number.isFinite(opts.targetPrice) && opts.targetPrice > 0
      ? Math.max(5, Math.min(95, ((opts.targetPrice - loPrice) / xRange) * 100))
      : undefined;

  const currencyPrefix = mkt.currencyPrefix ?? (mkt.market === 'US' ? 'US$' : '$');
  const cards: VisualPayoffCardData[] = evaluated.slice(0, 6).map((ev) => {
    const mapped = mapEngineFamilyToUi(ev);
    const sampleSpots: number[] = [];
    const nPts = 24;
    for (let i = 0; i <= nPts; i += 1) {
      sampleSpots.push(loPrice + (xRange * i) / nPts);
    }
    const rawPnls = sampleSpots.map((s) => ev.pnl(s));
    const maxAbsPnl = Math.max(...rawPnls.map((v) => (Number.isFinite(v) ? Math.abs(v) : 0)), 1);
    const points = sampleSpots.map((s, i) => {
      const p = rawPnls[i] ?? 0;
      const xPct = ((s - loPrice) / xRange) * 100;
      const yNorm = Math.max(-0.98, Math.min(0.98, p / maxAbsPnl));
      return { x: xPct, y: yNorm };
    });

    const scaleK = Math.round(maxAbsPnl / 1000);
    const yTop = `${currencyPrefix}${Math.max(1, scaleK)}k`;
    const yBot = `-${currencyPrefix}${Math.max(1, scaleK)}k`;

    const breakevenLabels = ev.breakevens
      .filter((be) => Number.isFinite(be) && be > loPrice && be < hiPrice)
      .slice(0, 2)
      .map((be) => ({
        xPct: ((be - loPrice) / xRange) * 100,
        label: fk(be),
      }));

    const maxGainLabel =
      ev.maxGain === null
        ? 'Ilimitada'
        : `${currencyPrefix}${fmtNum(ev.maxGain / 1000, 1)}k`;
    const maxLossLabel =
      ev.maxLoss === null
        ? 'Ilimitada'
        : `-${currencyPrefix}${fmtNum(ev.maxLoss / 1000, 1)}k`;
    const rewardRisk =
      ev.maxGain !== null && ev.maxLoss !== null && ev.maxLoss > 0
        ? `${fmtNum(ev.maxGain / ev.maxLoss, 2)}x`
        : '—';

    return {
      id: ev.strategy.id,
      title: ev.strategy.name,
      subtitle: ev.strategy.desc,
      family: mapped.family,
      bias: mapped.bias,
      mode: 'both',
      yLabels: [yTop, '0', yBot],
      xLabels: [0, 0.33, 0.66, 1].map((f) => `${currencyPrefix}${fk(loPrice + xRange * f)}`),
      ...(breakevenLabels.length > 0 ? { breakevenLabels } : {}),
      ...(targetLinePct !== undefined ? { targetLinePct } : {}),
      spotLinePct,
      points,
      metrics: {
        label1: 'máx gan',
        val1: maxGainLabel,
        color1: 'green',
        label2: 'máx pérd',
        val2: maxLossLabel,
        color2: 'red',
        label3: 'relación',
        val3: rewardRisk,
        color3: ev.cash >= 0 ? 'green' : 'white',
        label4: 'prob',
        val4: Number.isFinite(ev.pop) ? `${fmtNum(ev.pop * 100, 0)}%` : '—',
      },
      netPrice: Math.abs(ev.cash) / LOT,
      pricedLegs: ev.legs,
      bidAskPctOfMid: ev.bidAskPctOfMid,
      liquiditySemaphore: ev.liquiditySemaphore,
    };
  });

  const rows: StrategyComparisonRow[] = evaluated.slice(0, 8).map((ev) => {
    const netDelta = ev.legs.reduce(
      (acc, l) => acc + (Number.isFinite(l.delta) ? l.side * l.ratio * LOT * l.delta : 0),
      0
    );
    const netTheta = ev.legs.reduce(
      (acc, l) => acc + (Number.isFinite(l.thetaDay) ? l.side * l.ratio * LOT * l.thetaDay : 0),
      0
    );
    const ratio =
      ev.maxGain !== null && ev.maxLoss !== null && ev.maxLoss > 0
        ? `${fmtNum(ev.maxGain / ev.maxLoss, 2)}x`
        : '—';
    const gainVsCash =
      ev.maxGain !== null && Math.abs(ev.cash) > 100
        ? `${fmtNum((ev.maxGain / Math.abs(ev.cash)) * 100, 0)}%`
        : '—';

    const be0 = ev.breakevens[0] !== undefined ? fk(ev.breakevens[0]) : '—';
    const be1 = ev.breakevens[1] !== undefined ? fk(ev.breakevens[1]) : undefined;

    return {
      id: `row-${ev.strategy.id}`,
      name: ev.strategy.name,
      tag: `${ev.legs.length}P`,
      desc: ev.strategy.desc,
      caja: fmtNum(ev.cash, 0),
      cajaNum: ev.cash,
      maxGan: ev.maxGain === null ? 'ilim.' : fmtNum(ev.maxGain, 0),
      maxPerd: ev.maxLoss === null ? 'ilim.' : `-${fmtNum(ev.maxLoss, 0)}`,
      ganaPierde: ratio,
      crece: gainVsCash,
      prob: Number.isFinite(ev.pop) ? `${fmtNum(ev.pop * 100, 0)}%` : '—',
      delta: Number.isFinite(netDelta) ? fmtNum(netDelta, 0) : '—',
      porDia: Number.isFinite(netTheta) ? fmtNum(netTheta, 0) : '—',
      relacion: ratio,
      empates: be1 !== undefined ? [be0, be1] : [be0],
      pricedLegs: ev.legs,
      bidAskPctOfMid: ev.bidAskPctOfMid,
      liquiditySemaphore: ev.liquiditySemaphore,
    };
  });

  return { cards, rows };
}

function callSpreadRatio(baseRow: OptionChainRow, longIdxRow: OptionChainRow | undefined): number {
  if (!longIdxRow) return Number.NaN;
  if (
    !Number.isFinite(baseRow.callBid) ||
    baseRow.callBid <= 0 ||
    !Number.isFinite(baseRow.callAsk) ||
    baseRow.callAsk < baseRow.callBid ||
    !Number.isFinite(longIdxRow.callBid) ||
    longIdxRow.callBid <= 0 ||
    !Number.isFinite(longIdxRow.callAsk) ||
    longIdxRow.callAsk < longIdxRow.callBid
  ) {
    return Number.NaN;
  }
  const width = Math.abs(longIdxRow.strike - baseRow.strike);
  const debit = baseRow.callAsk - longIdxRow.callBid;
  if (!Number.isFinite(width) || !Number.isFinite(debit) || width <= 0 || debit < DEFAULT_MIN_SPREAD_DEBIT - 1e-12) {
    return Number.NaN;
  }
  const r = width / debit;
  return Number.isFinite(r) && r > 0 && r < 50 ? r : Number.NaN;
}

function putSpreadRatio(baseRow: OptionChainRow, longIdxRow: OptionChainRow | undefined): number {
  if (!longIdxRow) return Number.NaN;
  if (
    !Number.isFinite(longIdxRow.putBid) ||
    longIdxRow.putBid <= 0 ||
    !Number.isFinite(longIdxRow.putAsk) ||
    longIdxRow.putAsk < longIdxRow.putBid ||
    !Number.isFinite(baseRow.putBid) ||
    baseRow.putBid <= 0 ||
    !Number.isFinite(baseRow.putAsk) ||
    baseRow.putAsk < baseRow.putBid
  ) {
    return Number.NaN;
  }
  const width = Math.abs(baseRow.strike - longIdxRow.strike);
  const debit = longIdxRow.putAsk - baseRow.putBid;
  if (!Number.isFinite(width) || !Number.isFinite(debit) || width <= 0 || debit < DEFAULT_MIN_SPREAD_DEBIT - 1e-12) {
    return Number.NaN;
  }
  const r = width / debit;
  return Number.isFinite(r) && r > 0 && r < 50 ? r : Number.NaN;
}

export function buildSpreadLadder(
  rows: readonly OptionChainRow[],
  spot: number,
  oneSigmaHigh: number,
  filterMode: 'donde_estoy' | 'cerca' | 'tenencia' | 'todas'
): SpreadLadderRow[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const filtered = sorted.filter((r) => {
    if (!Number.isFinite(spot) || spot <= 0) return true;
    const dist = Math.abs(r.strike / spot - 1);
    if (filterMode === 'donde_estoy') return dist <= 0.08;
    if (filterMode === 'cerca') return dist <= 0.2;
    return true;
  });

  return filtered.map((row, idx) => {
    const next = filtered[idx + 1];
    const spotMarkerAfter =
      Number.isFinite(spot) && spot > 0 && row.strike <= spot && (!next || next.strike > spot)
        ? fmtNum(spot, 2)
        : undefined;
    const sigmaMarkerAfter =
      Number.isFinite(oneSigmaHigh) &&
      oneSigmaHigh > 0 &&
      row.strike <= oneSigmaHigh &&
      next !== undefined &&
      next.strike > oneSigmaHigh
        ? '+1σ'
        : undefined;

    const fullIdx = sorted.findIndex((s) => s.strike === row.strike);
    const out: SpreadLadderRow = {
      base: fk(row.strike),
      strikeNum: row.strike,
      c1: callSpreadRatio(row, sorted[fullIdx + 1]),
      c2: callSpreadRatio(row, sorted[fullIdx + 2]),
      c3: callSpreadRatio(row, sorted[fullIdx + 3]),
      c4: callSpreadRatio(row, sorted[fullIdx + 4]),
      p1: putSpreadRatio(row, sorted[fullIdx - 1]),
      p2: putSpreadRatio(row, sorted[fullIdx - 2]),
      p3: putSpreadRatio(row, sorted[fullIdx - 3]),
      p4: putSpreadRatio(row, sorted[fullIdx - 4]),
      ...(spotMarkerAfter !== undefined ? { spotMarkerAfter } : {}),
      ...(sigmaMarkerAfter !== undefined ? { sigmaMarkerAfter } : {}),
    };
    return out;
  });
}

export function buildBidirectionalFlow(
  rows: readonly OptionChainRow[],
  spot: number,
  unit: 'lotes' | '$',
  currencyOptions: FlowCurrencyOptions
): FlowSummary {
  const multiplier =
    Number.isFinite(currencyOptions.contractMultiplier) && currencyOptions.contractMultiplier > 0
      ? currencyOptions.contractMultiplier
      : Number.NaN;
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return {
      rows: [],
      totalCallLots: 0,
      totalPutLots: 0,
      totalLots: 0,
      totalTurnoverM: Number.NaN,
      callSharePct: Number.NaN,
      putCallRatio: Number.NaN,
      netDeltaEqShares: Number.NaN,
      dominantDirection: '—',
    };
  }
  if (rows.length === 0) {
    return {
      rows: [],
      totalCallLots: 0,
      totalPutLots: 0,
      totalLots: 0,
      totalTurnoverM: 0,
      callSharePct: Number.NaN,
      putCallRatio: Number.NaN,
      netDeltaEqShares: Number.NaN,
      dominantDirection: '—',
    };
  }

  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  let totalCallLots = 0;
  let totalPutLots = 0;
  let totalTurnover = 0;
  let netDeltaEqShares = 0;
  let hasDelta = false;

  const pickRefPx = (last: number, bid: number, ask: number): number => {
    if (Number.isFinite(last) && last > 0) return last;
    if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) return (bid + ask) / 2;
    if (Number.isFinite(ask) && ask > 0) return ask;
    if (Number.isFinite(bid) && bid > 0) return bid;
    return 0;
  };

  const perStrike = sorted.map((r) => {
    const cLots = Number.isFinite(r.callVolumeLots) ? Math.max(0, r.callVolumeLots) : 0;
    const pLots = Number.isFinite(r.putVolumeLots) ? Math.max(0, r.putVolumeLots) : 0;
    const cPx = pickRefPx(r.callLast, r.callBid, r.callAsk);
    const pPx = pickRefPx(r.putLast, r.putBid, r.putAsk);
    const cVal = cLots * multiplier * cPx;
    const pVal = pLots * multiplier * pPx;

    totalCallLots += cLots;
    totalPutLots += pLots;
    totalTurnover += cVal + pVal;

    if (Number.isFinite(r.callDelta)) {
      netDeltaEqShares += cLots * multiplier * r.callDelta;
      hasDelta = true;
    }
    if (Number.isFinite(r.putDelta)) {
      netDeltaEqShares += pLots * multiplier * r.putDelta;
      hasDelta = true;
    }

    return {
      strike: r.strike,
      cMetric: unit === 'lotes' ? cLots : cVal / 1_000_000,
      pMetric: unit === 'lotes' ? pLots : pVal / 1_000_000,
      cOi: Number.isFinite(r.callOpenInterest) ? r.callOpenInterest : 0,
      pOi: Number.isFinite(r.putOpenInterest) ? r.putOpenInterest : 0,
    };
  });

  const maxMetric = Math.max(...perStrike.flatMap((x) => [x.cMetric, x.pMetric]), 1);
  let atmStrike = Number.NaN;
  if (Number.isFinite(spot) && spot > 0) {
    let minD = Infinity;
    for (const r of sorted) {
      const d = Math.abs(r.strike - spot);
      if (d < minD) {
        minD = d;
        atmStrike = r.strike;
      }
    }
  }

  const flowRows: BidirectionalFlowRow[] = perStrike.map((item) => {
    const cPct = item.cMetric > 0 ? Math.min(100, Math.max(2, (item.cMetric / maxMetric) * 100)) : 0;
    const pPct = item.pMetric > 0 ? Math.min(100, Math.max(2, (item.pMetric / maxMetric) * 100)) : 0;
    return {
      base: fk(item.strike),
      strikeNum: item.strike,
      isAtm: Number.isFinite(atmStrike) && item.strike === atmStrike,
      callNetLabel:
        item.cMetric <= 0
          ? '—'
          : unit === 'lotes'
            ? fmtNum(item.cMetric, 0)
            : fmtMoneyCompact(item.cMetric),
      callNetDir: item.cMetric > 0 ? 'pos' : 'none',
      callTotalPct: cPct,
      callNetHighlightPct: item.cMetric > 0 ? Math.round(cPct * 0.45) : 0,
      putNetLabel:
        item.pMetric <= 0
          ? '—'
          : unit === 'lotes'
            ? fmtNum(item.pMetric, 0)
            : fmtMoneyCompact(item.pMetric),
      putNetDir: item.pMetric > 0 ? 'neg' : 'none',
      putTotalPct: pPct,
      putNetHighlightPct: item.pMetric > 0 ? Math.round(pPct * 0.45) : 0,
    };
  });

  const totalLots = totalCallLots + totalPutLots;
  const callSharePct = totalLots > 0 ? (totalCallLots / totalLots) * 100 : Number.NaN;
  const putCallRatio = totalCallLots > 0 ? totalPutLots / totalCallLots : Number.NaN;
  const dominantDirection =
    totalLots === 0
      ? 'Sin volumen reportado'
      : totalCallLots > totalPutLots * 1.15
        ? 'Mayor volumen en Calls'
        : totalPutLots > totalCallLots * 1.15
          ? 'Mayor volumen en Puts'
          : 'Volumen equilibrado Calls / Puts';

  return {
    rows: flowRows,
    totalCallLots,
    totalPutLots,
    totalLots,
    totalTurnoverM: totalTurnover / 1_000_000,
    callSharePct,
    putCallRatio,
    netDeltaEqShares: hasDelta ? netDeltaEqShares : Number.NaN,
    dominantDirection,
  };
}

function legBsValue(
  leg: BuilderLeg,
  spot: number,
  daysLeft: number,
  ivShiftPts: number,
  rateDec: number,
  floorDays = 0
): number {
  if (leg.type === 'Subyacente') return spot;
  const optType = leg.type === 'Call' ? 'C' : 'P';
  const sigma = Math.max(0.02, (leg.iv + ivShiftPts) / 100);
  // Pieza 50.3: en 0DTE (simDaysLeft === 0) la valuación BS usa el piso intradiario real
  // (horas hasta el cierre 16:00 ET, mínima 1/(252·6.5) años) en lugar del intrínseco.
  const effectiveDays = daysLeft > 0 ? daysLeft : floorDays;
  if (effectiveDays <= 0) {
    return optType === 'C' ? Math.max(0, spot - leg.strike) : Math.max(0, leg.strike - spot);
  }
  return bsPrice(optType, spot, leg.strike, effectiveDays, sigma, rateDec);
}

export function computeBuilderAnalytics(
  legs: readonly BuilderLeg[],
  simSpot: number,
  simDaysLeft: number,
  simIvShiftPts: number,
  simTlrPct: number,
  baseSpot: number,
  baseDays: number,
  rows: readonly OptionChainRow[],
  /** Pieza 50.3: piso de días para la valuación BS teórica cuando `simDaysLeft === 0` (0DTE). */
  bsFloorDays = 0
): BuilderAnalytics {
  const safeSpot = Number.isFinite(simSpot) && simSpot > 0 ? simSpot : Number.isFinite(baseSpot) && baseSpot > 0 ? baseSpot : 100;
  const rateDec = Number.isFinite(simTlrPct) && simTlrPct >= 0 ? Math.log(1 + simTlrPct / 100) : 0;

  let netCash = 0;
  let totalCommission = 0;
  const delta: GreekComponentRow = { global: 0, call: 0, put: 0, stock: 0 };
  const gamma: GreekComponentRow = { global: 0, call: 0, put: 0, stock: 0 };
  const vega: GreekComponentRow = { global: 0, call: 0, put: 0, stock: 0 };
  const theta: GreekComponentRow = { global: 0, call: 0, put: 0, stock: 0 };
  const rho: GreekComponentRow = { global: 0, call: 0, put: 0, stock: 0 };

  for (const leg of legs) {
    const dir = leg.side === 'Compra' ? 1 : -1;
    const shares = leg.type === 'Subyacente' ? leg.qty : leg.qty * LOT;
    const gross = -dir * leg.premium * shares;
    netCash += gross;
    totalCommission += Math.abs(gross) * (leg.type === 'Subyacente' ? 0.0008 * 1.21 : COMMISSION_RATE);

    if (leg.type === 'Subyacente') {
      const legDelta = dir * shares;
      delta.stock += legDelta;
      delta.global += legDelta;
      continue;
    }

    const bucket = leg.type === 'Call' ? 'call' : 'put';
    const dS = Math.max(0.01, safeSpot * 0.005);
    const v0 = legBsValue(leg, safeSpot, simDaysLeft, simIvShiftPts, rateDec, bsFloorDays);
    const vUp = legBsValue(leg, safeSpot + dS, simDaysLeft, simIvShiftPts, rateDec, bsFloorDays);
    const vDn = legBsValue(leg, Math.max(0.01, safeSpot - dS), simDaysLeft, simIvShiftPts, rateDec, bsFloorDays);
    const vIvUp = legBsValue(leg, safeSpot, simDaysLeft, simIvShiftPts + 1, rateDec, bsFloorDays);
    const vNextDay = legBsValue(leg, safeSpot, Math.max(0, simDaysLeft - 1), simIvShiftPts, rateDec, bsFloorDays);
    const vRateUp = legBsValue(leg, safeSpot, simDaysLeft, simIvShiftPts, rateDec + 0.01, bsFloorDays);

    const dPerShare = Number.isFinite(vUp) && Number.isFinite(vDn) ? (vUp - vDn) / (2 * dS) : leg.delta;
    const gPerShare = Number.isFinite(vUp) && Number.isFinite(vDn) && Number.isFinite(v0) ? (vUp - 2 * v0 + vDn) / (dS * dS) : 0;
    const vegPerShare = Number.isFinite(vIvUp) && Number.isFinite(v0) ? vIvUp - v0 : 0;
    const thPerShare = Number.isFinite(vNextDay) && Number.isFinite(v0) ? vNextDay - v0 : leg.theta;
    const rhoPerShare = Number.isFinite(vRateUp) && Number.isFinite(v0) ? vRateUp - v0 : 0;

    const lDelta = dir * shares * dPerShare;
    const lGamma = dir * shares * gPerShare;
    const lVega = dir * shares * vegPerShare;
    const lTheta = dir * shares * thPerShare;
    const lRho = dir * shares * rhoPerShare;

    delta[bucket] += lDelta;
    delta.global += lDelta;
    gamma[bucket] += lGamma;
    gamma.global += lGamma;
    vega[bucket] += lVega;
    vega.global += lVega;
    theta[bucket] += lTheta;
    theta.global += lTheta;
    rho[bucket] += lRho;
    rho.global += lRho;
  }

  const pnlFinishAt = (spotVal: number): number => {
    let total = -totalCommission;
    for (const leg of legs) {
      const dir = leg.side === 'Compra' ? 1 : -1;
      const shares = leg.type === 'Subyacente' ? leg.qty : leg.qty * LOT;
      const valAtExp = legBsValue(leg, spotVal, 0, simIvShiftPts, rateDec);
      total += dir * (valAtExp - leg.premium) * shares;
    }
    return total;
  };

  const pnlTheoAt = (spotVal: number): number => {
    let total = -totalCommission;
    for (const leg of legs) {
      const dir = leg.side === 'Compra' ? 1 : -1;
      const shares = leg.type === 'Subyacente' ? leg.qty : leg.qty * LOT;
      const valTheo = legBsValue(leg, spotVal, simDaysLeft, simIvShiftPts, rateDec, bsFloorDays);
      total += dir * (valTheo - leg.premium) * shares;
    }
    return total;
  };

  const loSpot = safeSpot * 0.78;
  const hiSpot = safeSpot * 1.24;
  const gridSteps = 24;
  const payoffGrid: { spot: number; pnlFinish: number; pnlTheo: number }[] = [];
  for (let i = 0; i <= gridSteps; i += 1) {
    const sp = loSpot + ((hiSpot - loSpot) * i) / gridSteps;
    payoffGrid.push({
      spot: sp,
      pnlFinish: pnlFinishAt(sp),
      pnlTheo: pnlTheoAt(sp),
    });
  }

  const oiByGridSpot = payoffGrid.map((pt) => {
    const step = (hiSpot - loSpot) / gridSteps;
    let callOi = 0;
    let putOi = 0;
    for (const r of rows) {
      if (Math.abs(r.strike - pt.spot) <= step * 0.65) {
        callOi += Number.isFinite(r.callOpenInterest) ? r.callOpenInterest : 0;
        putOi += Number.isFinite(r.putOpenInterest) ? r.putOpenInterest : 0;
      }
    }
    return { callOi, putOi };
  });

  const stressSteps = [-20, -16, -12, -8, -4, 0, 4, 8, 12, 16, 20];
  const stressRows = stressSteps.map((stepPct) => {
    const projSpot = Math.round(safeSpot * (1 + stepPct / 100));
    return {
      stepPct,
      projSpot,
      finishPnl: pnlFinishAt(projSpot),
      theoNow: pnlTheoAt(projSpot),
    };
  });

  // Al vencimiento la pendiente solo cambia en los strikes.
  const expirySpots = new Set([0]);
  let tailSlope = 0;
  for (const leg of legs) {
    if (leg.type !== 'Subyacente') expirySpots.add(leg.strike);
    if (leg.type !== 'Put') {
      const shares = leg.type === 'Call' ? leg.qty * LOT : leg.qty;
      tailSlope += leg.side === 'Compra' ? shares : -shares;
    }
  }
  let maxGain = -Infinity;
  let maxLoss = Infinity;
  for (const spot of expirySpots) {
    const pnl = pnlFinishAt(spot);
    maxGain = Math.max(maxGain, pnl);
    maxLoss = Math.min(maxLoss, pnl);
  }
  const hasExpiryPayoff = legs.length > 0 &&
    Number.isFinite(maxGain) && Number.isFinite(maxLoss) && Number.isFinite(tailSlope);
  const unlimitedGain = hasExpiryPayoff && tailSlope > 0;
  const unlimitedLoss = hasExpiryPayoff && tailSlope < 0;

  // Escaneo para breakevens y PoP.
  const scanLo = safeSpot * 0.35;
  const scanHi = safeSpot * 1.85;
  const scanN = 300;
  const breakevens: number[] = [];
  let prevS = scanLo;
  let prevP = pnlFinishAt(scanLo);
  for (let i = 1; i <= scanN; i += 1) {
    const s = scanLo + ((scanHi - scanLo) * i) / scanN;
    const p = pnlFinishAt(s);
    if ((prevP <= 0 && p > 0) || (prevP >= 0 && p < 0)) {
      const frac = Math.abs(prevP) / Math.max(1e-9, Math.abs(p - prevP));
      breakevens.push(prevS + frac * (s - prevS));
    }
    prevS = s;
    prevP = p;
  }

  const avgIvPct =
    legs.filter((l) => l.type !== 'Subyacente' && l.iv > 0).length > 0
      ? legs
          .filter((l) => l.type !== 'Subyacente' && l.iv > 0)
          .reduce((a, l) => a + l.iv + simIvShiftPts, 0) /
        legs.filter((l) => l.type !== 'Subyacente' && l.iv > 0).length
      : Number.isFinite(atmIv(baseDays))
        ? atmIv(baseDays) * 100 + simIvShiftPts
        : Number.NaN;
  const effIv = Number.isFinite(avgIvPct) ? Math.max(0.02, avgIvPct / 100) : Number.NaN;
  const popDays = Math.max(1, baseDays);
  const expectedMovePct =
    Number.isFinite(effIv) && effIv > 0 ? effIv * Math.sqrt(popDays / 365) * 100 : Number.NaN;
  const expectedMoveAbs =
    Number.isFinite(expectedMovePct) && safeSpot > 0 ? (safeSpot * expectedMovePct) / 100 : Number.NaN;

  let pop = Number.NaN;
  if (legs.length > 0 && Number.isFinite(effIv) && effIv > 0) {
    const tmpMkt: Market = {
      ticker: '',
      spot: safeSpot,
      days: popDays,
      rate: rateDec,
      expiryLabel: '',
      expiryCode: '',
      codePrefix: '',
      step: 1,
      strikes: [],
      expiryDate: new Date(),
    };
    const b1 = breakevens[0];
    const b2 = breakevens[1];
    if (breakevens.length === 1 && b1 !== undefined) {
      const winsAbove = pnlFinishAt(b1 * 1.05) > 0;
      const pAbove = probAbove(tmpMkt, b1, popDays, effIv, rateDec);
      pop = Number.isFinite(pAbove) ? (winsAbove ? pAbove : 1 - pAbove) : Number.NaN;
    } else if (breakevens.length === 2 && b1 !== undefined && b2 !== undefined) {
      const winsInside = pnlFinishAt((b1 + b2) / 2) > 0;
      const p1 = probAbove(tmpMkt, b1, popDays, effIv, rateDec);
      const p2 = probAbove(tmpMkt, b2, popDays, effIv, rateDec);
      if (Number.isFinite(p1) && Number.isFinite(p2)) {
        const inside = Math.max(0, p1 - p2);
        pop = winsInside ? inside : 1 - inside;
      }
    } else if (legs.every((l) => l.type !== 'Subyacente')) {
      const allPos = pnlFinishAt(safeSpot) > 0;
      pop = allPos ? 1 : 0;
    } else {
      const be = legs[0]?.strike ?? safeSpot;
      const driftTerm = ((rateDec - (effIv * effIv) / 2) * (popDays / 365)) / (effIv * Math.sqrt(popDays / 365));
      pop = ncdf(Math.log(safeSpot / be) / (effIv * Math.sqrt(popDays / 365)) + driftTerm);
    }
  }

  return {
    payoffGrid,
    stressRows,
    oiByGridSpot,
    netCash,
    totalCommission,
    maxGain: hasExpiryPayoff && !unlimitedGain ? maxGain : Number.NaN,
    maxLoss: hasExpiryPayoff && !unlimitedLoss ? Math.max(0, -maxLoss) : Number.NaN,
    unlimitedGain,
    unlimitedLoss,
    breakevens,
    pop,
    expectedMoveAbs,
    expectedMovePct,
    delta,
    gamma,
    vega,
    theta,
    rho,
  };
}

/* ============================================================================
   CADENA COMPLETA ("EL TEÓRICO"): HELPERS PUROS DE EXPIRACIÓN, PUNTAS, TEÓRICO Y TENENCIA
   ============================================================================ */

type ArContractWithExtras = ArOptionContractDto & {
  readonly bidSize?: number | null;
  readonly askSize?: number | null;
  readonly changePct?: number | null;
  readonly theoreticalPrice?: number | null;
  readonly volumeArs?: number | null;
};

type ArExpiryWithExtras = ArOptionExpiryDto & {
  readonly maxPainStrike?: number | null;
  readonly maxPainDistPct?: number | null;
};

export interface ChainExpirySummary {
  readonly formattedDate: string;
  readonly isOperating: boolean;
  readonly statusText: 'Operando' | 'Cierre EOD';
  readonly callLots: number;
  readonly putLots: number;
  readonly totalLots: number;
  readonly callTurnoverArsM: number;
  readonly putTurnoverArsM: number;
  readonly callSharePct: number;
  readonly putSharePct: number;
  readonly flowLeaderLabel: string;
  readonly atmIvPct: number;
  readonly oneSigmaMoveAbs: number;
  readonly oneSigmaMovePct: number;
  readonly totalOi: number;
  readonly maxPainStrike: number;
  readonly maxPainDistPct: number;
  readonly band1SigmaAbs: number;
}

export interface EnrichedChainRow {
  readonly row: OptionChainRow;
  readonly callBidSize: number;
  readonly callAskSize: number;
  readonly callChangePct: number;
  readonly callTheoreticalPrice: number;
  readonly callHoldings: number;
  readonly putBidSize: number;
  readonly putAskSize: number;
  readonly putChangePct: number;
  readonly putTheoreticalPrice: number;
  readonly putHoldings: number;
}

export interface InlineAxisMarker {
  readonly id: string;
  readonly kind: 'spot' | 'sigma';
  readonly label: string;
  readonly thresholdValue: number;
  readonly tooltip: string;
}

const POSITIONS_STORAGE_KEY = 'quant_core_positions_v1';

const toFiniteOrNaN = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;

export function readOptionHoldingsFromStorage(): ReadonlyMap<string, number> {
  const holdings = new Map<string, number>();
  if (typeof window === 'undefined' || !window.localStorage) {
    return holdings;
  }
  try {
    const raw = window.localStorage.getItem(POSITIONS_STORAGE_KEY);
    if (!raw) return holdings;
    const parsed: unknown = JSON.parse(raw);
    const items: unknown[] = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' &&
          parsed !== null &&
          Array.isArray((parsed as { positions?: unknown }).positions)
        ? ((parsed as { positions: unknown[] }).positions)
        : [];

    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const symRaw = rec['ticker'] ?? rec['symbol'];
      if (typeof symRaw !== 'string' || symRaw.trim() === '') continue;
      const sym = symRaw.trim().toUpperCase();
      const qtyRaw = rec['qty'] ?? rec['quantity'] ?? rec['lots'] ?? rec['contracts'] ?? rec['netSize'];
      const qtyNum = typeof qtyRaw === 'number' ? qtyRaw : Number(qtyRaw);
      if (!Number.isFinite(qtyNum) || qtyNum === 0) continue;
      const sideRaw = typeof rec['side'] === 'string' ? rec['side'].trim().toUpperCase() : '';
      const signedQty =
        sideRaw === 'VENTA' || sideRaw === 'SHORT' || sideRaw === 'SELL'
          ? -Math.abs(qtyNum)
          : qtyNum;
      holdings.set(sym, (holdings.get(sym) ?? 0) + signedQty);
    }
  } catch {
    return holdings;
  }
  return holdings;
}

export function formatSpanishExpiryDate(
  expirationDate: string | undefined,
  fallbackLabel: string
): string {
  if (typeof expirationDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(expirationDate.trim())) {
    const parts = expirationDate.trim().slice(0, 10).split('-').map(Number);
    const y = parts[0] ?? 0;
    const m = parts[1] ?? 0;
    const d = parts[2] ?? 0;
    if (y > 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
      try {
        return new Intl.DateTimeFormat('es-AR', {
          day: 'numeric',
          month: 'long',
          timeZone: 'UTC',
        }).format(utcNoon);
      } catch {
        // fallback below
      }
    }
  }
  return fallbackLabel;
}

export function computeMaxPainFromRows(
  rows: readonly OptionChainRow[],
  spot: number
): { readonly maxPainStrike: number; readonly maxPainDistPct: number } {
  let totalOi = 0;
  for (const r of rows) {
    if (Number.isFinite(r.callOpenInterest) && r.callOpenInterest > 0) totalOi += r.callOpenInterest;
    if (Number.isFinite(r.putOpenInterest) && r.putOpenInterest > 0) totalOi += r.putOpenInterest;
  }
  if (totalOi <= 0 || rows.length === 0) {
    return { maxPainStrike: Number.NaN, maxPainDistPct: Number.NaN };
  }

  let bestStrike = Number.NaN;
  let bestPayout = Number.POSITIVE_INFINITY;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const cand of rows) {
    let payout = 0;
    for (const r of rows) {
      if (Number.isFinite(r.callOpenInterest) && r.callOpenInterest > 0 && cand.strike > r.strike) {
        payout += r.callOpenInterest * (cand.strike - r.strike);
      }
      if (Number.isFinite(r.putOpenInterest) && r.putOpenInterest > 0 && r.strike > cand.strike) {
        payout += r.putOpenInterest * (r.strike - cand.strike);
      }
    }
    const distSpot = Number.isFinite(spot) && spot > 0 ? Math.abs(cand.strike - spot) : 0;
    if (payout < bestPayout - 1e-6 || (Math.abs(payout - bestPayout) <= 1e-6 && distSpot < bestDist)) {
      bestPayout = payout;
      bestDist = distSpot;
      bestStrike = cand.strike;
    }
  }

  const maxPainDistPct =
    Number.isFinite(bestStrike) && Number.isFinite(spot) && spot > 0
      ? ((bestStrike - spot) / spot) * 100
      : Number.NaN;
  return { maxPainStrike: bestStrike, maxPainDistPct };
}

export function buildEnrichedChainForExpiry(params: {
  readonly exp: OptionExpiryGroup;
  readonly rawExpiry: ArOptionExpiryDto | undefined;
  readonly liveOptions: ArOptionsResponse | undefined;
  readonly spot: number;
  readonly rateDec: number;
  readonly holdingsBySymbol: ReadonlyMap<string, number>;
  readonly marketStateLabel: string;
}): {
  readonly summary: ChainExpirySummary;
  readonly rows: readonly EnrichedChainRow[];
} {
  const { exp, rawExpiry, liveOptions, spot, rateDec, holdingsBySymbol, marketStateLabel } = params;
  const rawCallsBySymbol = new Map<string, ArContractWithExtras>();
  const rawCallsByStrike = new Map<number, ArContractWithExtras>();
  const rawPutsBySymbol = new Map<string, ArContractWithExtras>();
  const rawPutsByStrike = new Map<number, ArContractWithExtras>();

  if (rawExpiry) {
    for (const c of rawExpiry.calls) {
      const ext = c as ArContractWithExtras;
      rawCallsBySymbol.set(c.symbol.toUpperCase(), ext);
      rawCallsByStrike.set(c.strike, ext);
    }
    for (const p of rawExpiry.puts) {
      const ext = p as ArContractWithExtras;
      rawPutsBySymbol.set(p.symbol.toUpperCase(), ext);
      rawPutsByStrike.set(p.strike, ext);
    }
  }

  const effSpot = Number.isFinite(spot) && spot > 0 ? spot : Number.NaN;
  const atmIvPct =
    Number.isFinite(exp.atmIV) && exp.atmIV > 0
      ? exp.atmIV
      : Number.isFinite(atmIv(exp.daysToExpiry))
        ? atmIv(exp.daysToExpiry) * 100
        : Number.NaN;
  const atmIvDec = Number.isFinite(atmIvPct) && atmIvPct > 0 ? atmIvPct / 100 : Number.NaN;
  const effRate = Number.isFinite(rateDec) ? rateDec : 0;

  let callLots = 0;
  let putLots = 0;
  let callTurnoverArs = 0;
  let putTurnoverArs = 0;
  let totalOi = 0;
  let bestStrike = Number.NaN;
  let bestStrikeTotalLots = 0;
  let bestStrikeCallLots = 0;
  let bestStrikePutLots = 0;

  const pickRefPrice = (last: number, bid: number, ask: number): number => {
    if (Number.isFinite(last) && last > 0) return last;
    if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid) return 0.5 * (bid + ask);
    if (Number.isFinite(ask) && ask > 0) return ask;
    if (Number.isFinite(bid) && bid > 0) return bid;
    return Number.NaN;
  };

  const rows: EnrichedChainRow[] = exp.rows.map((row) => {
    const rawCall =
      rawCallsBySymbol.get(row.callTicker.toUpperCase()) ?? rawCallsByStrike.get(row.strike);
    const rawPut =
      rawPutsBySymbol.get(row.putTicker.toUpperCase()) ?? rawPutsByStrike.get(row.strike);

    const cLots = Number.isFinite(row.callVolumeLots) && row.callVolumeLots > 0 ? row.callVolumeLots : 0;
    const pLots = Number.isFinite(row.putVolumeLots) && row.putVolumeLots > 0 ? row.putVolumeLots : 0;
    callLots += cLots;
    putLots += pLots;

    const cTurnoverDirect = toFiniteOrNaN(rawCall?.volumeArs);
    if (Number.isFinite(cTurnoverDirect) && cTurnoverDirect > 0) {
      callTurnoverArs += cTurnoverDirect;
    } else if (cLots > 0) {
      const refPx = pickRefPrice(row.callLast, row.callBid, row.callAsk);
      if (Number.isFinite(refPx) && refPx > 0) callTurnoverArs += cLots * LOT * refPx;
    }

    const pTurnoverDirect = toFiniteOrNaN(rawPut?.volumeArs);
    if (Number.isFinite(pTurnoverDirect) && pTurnoverDirect > 0) {
      putTurnoverArs += pTurnoverDirect;
    } else if (pLots > 0) {
      const refPx = pickRefPrice(row.putLast, row.putBid, row.putAsk);
      if (Number.isFinite(refPx) && refPx > 0) putTurnoverArs += pLots * LOT * refPx;
    }

    if (Number.isFinite(row.callOpenInterest) && row.callOpenInterest > 0) totalOi += row.callOpenInterest;
    if (Number.isFinite(row.putOpenInterest) && row.putOpenInterest > 0) totalOi += row.putOpenInterest;

    const rowTotalLots = cLots + pLots;
    if (rowTotalLots > bestStrikeTotalLots) {
      bestStrikeTotalLots = rowTotalLots;
      bestStrike = row.strike;
      bestStrikeCallLots = cLots;
      bestStrikePutLots = pLots;
    }

    const callBackendTheo = toFiniteOrNaN(rawCall?.theoreticalPrice);
    const putBackendTheo = toFiniteOrNaN(rawPut?.theoreticalPrice);
    const modelSigC = Number.isFinite(atmIvDec)
      ? atmIvDec
      : Number.isFinite(row.callIV) && row.callIV > 0
        ? row.callIV / 100
        : Number.NaN;
    const modelSigP = Number.isFinite(atmIvDec)
      ? atmIvDec
      : Number.isFinite(row.putIV) && row.putIV > 0
        ? row.putIV / 100
        : Number.NaN;

    const callTheoreticalPrice = Number.isFinite(callBackendTheo)
      ? callBackendTheo
      : Number.isFinite(effSpot) && Number.isFinite(modelSigC) && exp.daysToExpiry > 0
        ? bsPrice('C', effSpot, row.strike, exp.daysToExpiry, modelSigC, effRate)
        : Number.NaN;
    const putTheoreticalPrice = Number.isFinite(putBackendTheo)
      ? putBackendTheo
      : Number.isFinite(effSpot) && Number.isFinite(modelSigP) && exp.daysToExpiry > 0
        ? bsPrice('P', effSpot, row.strike, exp.daysToExpiry, modelSigP, effRate)
        : Number.NaN;

    const callChangeRaw = toFiniteOrNaN(rawCall?.changePct);
    const callChangePct = Number.isFinite(callChangeRaw) ? callChangeRaw : row.callDeltaPct;
    const putChangeRaw = toFiniteOrNaN(rawPut?.changePct);
    const putChangePct = Number.isFinite(putChangeRaw) ? putChangeRaw : row.putDeltaPct;

    return {
      row,
      callBidSize: toFiniteOrNaN(rawCall?.bidSize),
      callAskSize: toFiniteOrNaN(rawCall?.askSize),
      callChangePct,
      callTheoreticalPrice,
      callHoldings: holdingsBySymbol.get(row.callTicker.toUpperCase()) ?? 0,
      putBidSize: toFiniteOrNaN(rawPut?.bidSize),
      putAskSize: toFiniteOrNaN(rawPut?.askSize),
      putChangePct,
      putTheoreticalPrice,
      putHoldings: holdingsBySymbol.get(row.putTicker.toUpperCase()) ?? 0,
    };
  });

  const totalLots = callLots + putLots;
  const totalTurnoverArs = callTurnoverArs + putTurnoverArs;
  const callSharePct =
    totalLots > 0
      ? (callLots / totalLots) * 100
      : totalTurnoverArs > 0
        ? (callTurnoverArs / totalTurnoverArs) * 100
        : Number.NaN;
  const putSharePct = Number.isFinite(callSharePct) ? Math.max(0, 100 - callSharePct) : Number.NaN;

  const band1SigmaAbs =
    Number.isFinite(effSpot) && Number.isFinite(atmIvDec) && exp.daysToExpiry > 0
      ? effSpot * atmIvDec * Math.sqrt(exp.daysToExpiry / 365)
      : Number.isFinite(exp.oneSigmaLow) && Number.isFinite(exp.oneSigmaHigh)
        ? 0.5 * (exp.oneSigmaHigh - exp.oneSigmaLow)
        : Number.NaN;
  const oneSigmaMovePct =
    Number.isFinite(band1SigmaAbs) && Number.isFinite(effSpot) && effSpot > 0
      ? (band1SigmaAbs / effSpot) * 100
      : Number.NaN;

  const rawExpExt = rawExpiry as ArExpiryWithExtras | undefined;
  const backendMaxPain = toFiniteOrNaN(rawExpExt?.maxPainStrike);
  const backendMaxPainDist = toFiniteOrNaN(rawExpExt?.maxPainDistPct);
  const computedMaxPain = computeMaxPainFromRows(exp.rows, effSpot);
  const maxPainStrike = Number.isFinite(backendMaxPain) ? backendMaxPain : computedMaxPain.maxPainStrike;
  const maxPainDistPct = Number.isFinite(backendMaxPainDist)
    ? backendMaxPainDist
    : computedMaxPain.maxPainDistPct;

  const upperState = marketStateLabel.toUpperCase();
  const isOperating =
    liveOptions?.feedStatus === 'LIVE' &&
    !upperState.includes('EOD') &&
    !upperState.includes('FIN DE SEMANA') &&
    !upperState.includes('CERRAD') &&
    !upperState.includes('POST-CIERRE');

  let flowLeaderLabel = 'Sin actividad operada en la ventana';
  if (bestStrikeTotalLots > 0 && Number.isFinite(bestStrike)) {
    const callShareLeader = (bestStrikeCallLots / bestStrikeTotalLots) * 100;
    const putShareLeader = 100 - callShareLeader;
    flowLeaderLabel = `Base más operada: ${fmtNum(bestStrike, 0)} (${fmtNum(bestStrikeTotalLots, 0)} lotes · ${fmtNum(callShareLeader, 0)}% C / ${fmtNum(putShareLeader, 0)}% P)`;
  }

  return {
    summary: {
      formattedDate: formatSpanishExpiryDate(exp.expiryDate, exp.label),
      isOperating,
      statusText: isOperating ? 'Operando' : 'Cierre EOD',
      callLots,
      putLots,
      totalLots,
      callTurnoverArsM: callTurnoverArs > 0 ? callTurnoverArs / 1_000_000 : Number.NaN,
      putTurnoverArsM: putTurnoverArs > 0 ? putTurnoverArs / 1_000_000 : Number.NaN,
      callSharePct,
      putSharePct,
      flowLeaderLabel,
      atmIvPct,
      oneSigmaMoveAbs: band1SigmaAbs,
      oneSigmaMovePct,
      totalOi: totalOi > 0 ? totalOi : Number.NaN,
      maxPainStrike,
      maxPainDistPct,
      band1SigmaAbs,
    },
    rows,
  };
}

export function computeInlineMarkersForRows(params: {
  readonly rows: readonly EnrichedChainRow[];
  readonly spot: number;
  readonly band1SigmaAbs: number;
  readonly sigmaMultiplier: 1 | 1.5 | 2;
  readonly onlySigmaRange: boolean;
}): {
  readonly beforeFirst: readonly InlineAxisMarker[];
  readonly afterIndex: ReadonlyMap<number, readonly InlineAxisMarker[]>;
} {
  const { rows, spot, band1SigmaAbs, sigmaMultiplier, onlySigmaRange } = params;
  const beforeFirst: InlineAxisMarker[] = [];
  const afterIndex = new Map<number, InlineAxisMarker[]>();
  if (rows.length === 0) {
    return { beforeFirst, afterIndex };
  }

  const candidates: {
    readonly id: string;
    readonly kind: 'spot' | 'sigma';
    readonly label: string;
    readonly value: number;
    readonly tooltip: string;
    readonly sigmaOrder: number;
  }[] = [];

  if (Number.isFinite(spot) && spot > 0) {
    candidates.push({
      id: 'spot',
      kind: 'spot',
      label: fmtNum(spot, 2),
      value: spot,
      tooltip: `Spot Subyacente: $ ${fmtNum(spot, 2)}`,
      sigmaOrder: 0,
    });
    if (Number.isFinite(band1SigmaAbs) && band1SigmaAbs > 0) {
      candidates.push(
        {
          id: 'sigma-m2',
          kind: 'sigma',
          label: '-2σ',
          value: spot - 2 * band1SigmaAbs,
          tooltip: `Límite -2σ (95,4%): $ ${fmtNum(spot - 2 * band1SigmaAbs, 2)}`,
          sigmaOrder: 2,
        },
        {
          id: 'sigma-m1',
          kind: 'sigma',
          label: '-1σ',
          value: spot - band1SigmaAbs,
          tooltip: `Límite -1σ (68,2%): $ ${fmtNum(spot - band1SigmaAbs, 2)}`,
          sigmaOrder: 1,
        },
        {
          id: 'sigma-p1',
          kind: 'sigma',
          label: '+1σ',
          value: spot + band1SigmaAbs,
          tooltip: `Límite +1σ (68,2%): $ ${fmtNum(spot + band1SigmaAbs, 2)}`,
          sigmaOrder: 1,
        },
        {
          id: 'sigma-p2',
          kind: 'sigma',
          label: '+2σ',
          value: spot + 2 * band1SigmaAbs,
          tooltip: `Límite +2σ (95,4%): $ ${fmtNum(spot + 2 * band1SigmaAbs, 2)}`,
          sigmaOrder: 2,
        }
      );
    }
  }

  const visibleCandidates = candidates
    .filter((m) => m.kind === 'spot' || !onlySigmaRange || m.sigmaOrder <= sigmaMultiplier)
    .sort((a, b) => a.value - b.value);

  const firstStrike = rows[0]?.row.strike ?? 0;
  for (const m of visibleCandidates) {
    const marker: InlineAxisMarker = {
      id: m.id,
      kind: m.kind,
      label: m.label,
      thresholdValue: m.value,
      tooltip: m.tooltip,
    };
    if (m.value < firstStrike) {
      beforeFirst.push(marker);
      continue;
    }
    let placedIdx = rows.length - 1;
    for (let i = 0; i < rows.length - 1; i += 1) {
      const cur = rows[i]?.row.strike ?? 0;
      const nxt = rows[i + 1]?.row.strike ?? 0;
      if (m.value >= cur && m.value < nxt) {
        placedIdx = i;
        break;
      }
    }
    const existing = afterIndex.get(placedIdx) ?? [];
    afterIndex.set(placedIdx, [...existing, marker]);
  }

  return { beforeFirst, afterIndex };
}

// ============================================================================
// Pieza 27: DTOs y helpers puros para VolatilitySuiteView (6 sub-pestañas)
// ============================================================================

export interface VolSuiteSmilePointDto {
  readonly strike: number;
  readonly moneynessPct: number;
  readonly delta: number | null;
  readonly ivPct: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly mid: number | null;
  readonly volume: number | null;
  readonly openInterest: number | null;
  readonly isOtm: boolean;
  readonly isShortDteItm: boolean;
}

export interface VolSuiteCompositeSmilePointDto {
  readonly strike: number;
  readonly moneynessPct: number;
  readonly ivPct: number | null;
  readonly sourceSide: 'PUT' | 'CALL' | 'ATM_AVG';
}

export interface VolSuiteSeparatedSmileDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly onlyOtm: boolean;
  readonly isShortDteSlice: boolean;
  readonly excludedItmCount: number;
  readonly callPoints: readonly VolSuiteSmilePointDto[];
  readonly putPoints: readonly VolSuiteSmilePointDto[];
  readonly compositeOtmPoints: readonly VolSuiteCompositeSmilePointDto[];
  readonly atmIvPct: number | null;
  readonly callWingAvgIvPct: number | null;
  readonly putWingAvgIvPct: number | null;
  readonly callVsPutSkewPp: number | null;
  readonly iv25DeltaCallPct: number | null;
  readonly iv25DeltaPutPct: number | null;
  readonly riskReversal25DeltaPp: number | null;
}

export interface VolSuiteMatrixCellDto {
  readonly offsetPct: number;
  readonly ivPct: number | null;
}

export interface VolSuiteMatrixRowDto {
  readonly expiryCode: string;
  readonly expiryLabel: string;
  readonly daysToExpiry: number;
  readonly atmIvPct: number | null;
  readonly cells: readonly VolSuiteMatrixCellDto[];
}

export interface VolSuiteMoneynessMatrixDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly offsetsPct: readonly number[];
  readonly rows: readonly VolSuiteMatrixRowDto[];
  readonly termRegime: 'CONTANGO' | 'BACKWARDATION' | 'FLAT' | 'NO_DATA';
  readonly termSpreadPp: number | null;
}

export interface VolSuiteHistoryPointDto {
  readonly time: number;
  readonly date: string;
  readonly close: number | null;
  readonly rvPct: number | null;
}

export interface VolSuiteQuintileBucketDto {
  readonly id: 'VERY_LOW' | 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';
  readonly label: string;
  readonly rangeLabel: string;
  readonly minBoundPct: number | null;
  readonly maxBoundPct: number | null;
  readonly occurrences: number;
  readonly avgVolChange30dPts: number | null;
  readonly avgUnderlyingReturn30dPct: number | null;
  readonly pctVolDecreased: number | null;
  readonly isCurrent: boolean;
}

export type VolSuiteOperativeRegimeCode =
  | 'VENTA_PRIMA_CUBIERTA'
  | 'COMPRA_CONVEXIDAD_CALENDAR'
  | 'NEUTRAL_SELECTIVO'
  | 'NO_SHORT_PREMIUM_RISK'
  | 'NO_DATA';

export interface VolSuiteSeasonalityRowDto {
  readonly monthIndex: number;
  readonly monthLabel: string;
  readonly tradingDays: number;
  readonly monthsSampled: number;
  readonly meanDailyReturnPct: number | null;
  readonly avgMonthlyReturnPct: number | null;
  readonly annualizedVolPct: number | null;
  readonly positiveMonthRatePct: number | null;
}

export interface VolSuiteExtremeSessionDto {
  readonly time: number;
  readonly date: string;
  readonly logReturnPct: number | null;
  readonly simpleReturnPct: number | null;
  readonly zScore: number | null;
  readonly direction: 'UP' | 'DOWN';
}

export interface VolSuiteHistoricalCondDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly barsUsed: number;
  readonly historyObservations: number;
  readonly pairedObservations: number;
  readonly currentEvalVolPct: number | null;
  readonly latestRv20Pct: number | null;
  readonly latestRv23Pct: number | null;
  readonly latestRv60Pct: number | null;
  readonly vrpVsRv23Pts: number | null;
  readonly ivRank: number | null;
  readonly ivPercentile: number | null;
  readonly quantiles: {
    readonly minPct: number | null;
    readonly p20Pct: number | null;
    readonly p40Pct: number | null;
    readonly p60Pct: number | null;
    readonly p80Pct: number | null;
    readonly maxPct: number | null;
    readonly medianPct: number | null;
  };
  readonly operativeRegime: {
    readonly code: VolSuiteOperativeRegimeCode;
    readonly label: string;
    readonly rationale: string;
  };
  readonly buckets: readonly VolSuiteQuintileBucketDto[];
  readonly historySeries: readonly VolSuiteHistoryPointDto[];
  readonly seasonalityMonths: readonly VolSuiteSeasonalityRowDto[];
  readonly extremeSessions: readonly VolSuiteExtremeSessionDto[];
}

export interface VolSuiteRvWindowDto {
  readonly minPct: number | null;
  readonly p25Pct: number | null;
  readonly medianPct: number | null;
  readonly p75Pct: number | null;
  readonly maxPct: number | null;
  readonly currentPct: number | null;
  readonly observations: number;
}

export interface VolSuiteExpectedConeDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly dailyMoveAbs: number | null;
  readonly dailyMovePct: number | null;
  readonly horizonMove1SigmaPct: number | null;
  readonly upper1Sigma: number | null;
  readonly lower1Sigma: number | null;
  readonly upper2Sigma: number | null;
  readonly lower2Sigma: number | null;
  readonly probQAboveSpotPct: number | null;
  readonly probQBelowMinus10Pct: number | null;
  readonly comparisonNodes: readonly {
    readonly strike: number;
    readonly densityQ: number | null;
    readonly lognormalDensity: number | null;
    readonly probAboveQ: number | null;
  }[];
}

export interface VolSuiteParityStrikeDto {
  readonly strike: number;
  readonly callIvPct: number | null;
  readonly putIvPct: number | null;
  readonly ivSpreadPp: number | null;
  readonly callBid: number | null;
  readonly callAsk: number | null;
  readonly callMid: number | null;
  readonly putBid: number | null;
  readonly putAsk: number | null;
  readonly putMid: number | null;
  readonly syntheticForwardMid: number | null;
  readonly midImpliedTeaPct: number | null;
  readonly teaTomadoraPct: number | null;
  readonly teaColocadoraPct: number | null;
  readonly canLendAboveBenchmark: boolean;
  readonly canBorrowBelowBenchmark: boolean;
  readonly edgeColocadoraBps: number | null;
  readonly edgeTomadoraBps: number | null;
}

export interface VolSuiteParityDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly impliedRateStatus?: 'OK' | 'BLOCKED_SHORT_DTE' | 'NO_DATA';
  readonly daysToExpiry: number;
  readonly benchmarkTeaPct: number | null;
  readonly benchmarkLabel: string;
  readonly medianMidTeaPct: number | null;
  readonly medianTeaTomadoraPct: number | null;
  readonly medianTeaColocadoraPct: number | null;
  readonly bestColocadoraStrike: number | null;
  readonly bestColocadoraTeaPct: number | null;
  readonly bestTomadoraStrike: number | null;
  readonly bestTomadoraTeaPct: number | null;
  readonly strikes: readonly VolSuiteParityStrikeDto[];
}

export interface VolSuiteRatioRowDto {
  readonly side: 'CALL' | 'PUT';
  readonly targetOffsetPct: number;
  readonly longStrike: number;
  readonly longPrice: number | null;
  readonly shortStrike: number;
  readonly shortMoneynessPct: number | null;
  readonly shortPrice: number | null;
  readonly priceSource: 'BBO' | 'MID';
  readonly otmLotsPerBought: number | null;
  readonly netCash1x2: number | null;
  readonly outerBreakeven1x2: number | null;
}

export interface VolSuiteStructureCostDto {
  readonly id: 'BULL_CALL_5' | 'BEAR_PUT_5' | 'BUTTERFLY_SYM';
  readonly name: string;
  readonly legsLabel: string;
  readonly strikes: readonly number[];
  readonly priceSource: 'BBO' | 'MID';
  readonly width: number | null;
  readonly netDebit: number | null;
  readonly maxProfit: number | null;
  readonly maxRisk: number | null;
  readonly costPctOfMaxProfit: number | null;
  readonly costPctOfWidth: number | null;
  readonly rewardRiskRatio: number | null;
  readonly breakevenLow: number | null;
  readonly breakevenHigh: number | null;
  readonly bs2002HistoricalPercentile: number | null;
  readonly bs2002HistoricalMinPct: number | null;
  readonly bs2002HistoricalMedianPct: number | null;
  readonly bs2002HistoricalMaxPct: number | null;
  readonly bs2002HistoricalObs: number;
}

export interface VolSuiteRatiosStructuresDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly callRatios: readonly VolSuiteRatioRowDto[];
  readonly putRatios: readonly VolSuiteRatioRowDto[];
  readonly structures: readonly VolSuiteStructureCostDto[];
}

export interface VolSuiteDualSurfaceNodeDto {
  readonly offsetPct: number;
  readonly bymaIvPct: number | null;
  readonly opraAdrIvPct: number | null;
  readonly theoreticalBymaIvPct: number | null;
  readonly spreadBymaMinusOpraPp: number | null;
  readonly spreadBymaMinusTheoreticalPp: number | null;
}

export interface VolSuiteDualSurfaceDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly arUnderlying: string;
  readonly adrTicker: string;
  readonly adrRatio: number | null;
  readonly bymaSpotArs: number | null;
  readonly adrSpotUsd: number | null;
  readonly cclImplicit: number | null;
  readonly bymaExpiryCode: string;
  readonly bymaDays: number;
  readonly opraExpiryDate: string;
  readonly opraDays: number;
  readonly cclAnnualVolPct: number | null;
  readonly corrAdrCcl: number | null;
  readonly bymaAtmIvPct: number | null;
  readonly opraAtmIvPct: number | null;
  readonly theoreticalAtmIvPct: number | null;
  readonly atmSpreadBymaVsOpraPp: number | null;
  readonly atmSpreadBymaVsTheoreticalPp: number | null;
  readonly nodes: readonly VolSuiteDualSurfaceNodeDto[];
}

export interface VolSuiteActiveExpiryVrpDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly expiryCode: string | null;
  readonly daysToExpiry: number | null;
  readonly ivAtmActiveExpiryPct: number | null;
  readonly ivSource: 'INTERPOLATED_ATM' | 'SAME_EXPIRY_FALLBACK' | 'NO_DATA';
  readonly rvReferencePct: number | null;
  readonly rvReferenceLabel: string;
  readonly vrpActiveExpiryPts: number | null;
  readonly ivRankActiveExpiry: number | null;
  readonly ivPercentileActiveExpiry: number | null;
  readonly operativeRegime: {
    readonly code: VolSuiteOperativeRegimeCode;
    readonly label: string;
    readonly rationale: string;
  };
}

export interface VolAnalyticsExpirySuiteDto {
  readonly expiryCode: string;
  readonly expirationDate: string;
  readonly daysToExpiry: number;
  readonly smileOtmOnly: VolSuiteSeparatedSmileDto;
  readonly smileAll: VolSuiteSeparatedSmileDto;
  readonly priorSmile: {
    readonly dateKey: string;
    readonly tradingDaysAgo: number;
    readonly atmIvPct: number | null;
    readonly compositeOtmPoints: readonly VolSuiteCompositeSmilePointDto[];
  } | null;
  readonly expectedCone: VolSuiteExpectedConeDto;
  readonly parity: VolSuiteParityDto;
  readonly ratiosAndStructures: VolSuiteRatiosStructuresDto;
  readonly activeExpiryVrp?: VolSuiteActiveExpiryVrpDto;
}

export interface VolAnalyticsSuiteDto {
  readonly status: 'OK' | 'NO_DATA';
  readonly market: 'BYMA' | 'US';
  readonly underlying: string;
  readonly spot: number | null;
  readonly rateContinuous: number | null;
  readonly rateTeaPct: number | null;
  readonly benchmarkLabel: string;
  readonly dividendYield: number | null;
  readonly activeExpiryCode: string | null;
  readonly hasDualAdr: boolean;
  readonly nonDualMessage: string | null;
  readonly moneynessMatrixOtm: VolSuiteMoneynessMatrixDto;
  readonly moneynessMatrixAll: VolSuiteMoneynessMatrixDto;
  readonly historicalConditional: VolSuiteHistoricalCondDto;
  readonly rvWindows: {
    readonly rv20: VolSuiteRvWindowDto;
    readonly rv60: VolSuiteRvWindowDto;
    readonly rv120: VolSuiteRvWindowDto;
  };
  readonly dualSurface: VolSuiteDualSurfaceDto | null;
  readonly expiriesByCode: Readonly<Record<string, VolAnalyticsExpirySuiteDto>>;
}

export type UnifiedQuantEnginesDto = Pick<
  ArOptionsQuantEnginesDto,
  | 'qDistribution'
  | 'pDistribution'
  | 'pqDivergence'
  | 'volCone'
  | 'syntheticRates'
  | 'conversionReversal'
  | 'buyWrite'
  | 'calendarRoll'
  | 'confluenceClusters'
>;

export type VolHistoryHorizon = '1M' | '3M' | '6M' | '1A' | 'TODO';

const HORIZON_BAR_LIMITS: Readonly<Record<VolHistoryHorizon, number>> = {
  '1M': 23,
  '3M': 63,
  '6M': 126,
  '1A': 252,
  TODO: 750,
};

/** Resuelve el payload de Pieza 27 tanto desde motores BYMA como desde el snapshot US. */
export function resolveActiveVolAnalyticsSuite(params: {
  readonly liveOptions: ArOptionsResponse | undefined;
  readonly liveQuantEngines: ArOptionsQuantEnginesDto | null;
  readonly usSnapshot: UsSnapshotResponseDto | undefined;
}): VolAnalyticsSuiteDto | null {
  const fromActive = (
    params.liveQuantEngines as (ArOptionsQuantEnginesDto & {
      readonly volAnalyticsSuite?: VolAnalyticsSuiteDto | null;
    }) | null
  )?.volAnalyticsSuite;
  if (fromActive) return fromActive;

  const fromOptions = (
    params.liveOptions?.quantEngines as
      | (ArOptionsQuantEnginesDto & {
          readonly volAnalyticsSuite?: VolAnalyticsSuiteDto | null;
        })
      | null
      | undefined
  )?.volAnalyticsSuite;
  if (fromOptions) return fromOptions;

  const fromUs = (
    params.usSnapshot?.terminalEngines as
      | (SerializedTerminalEnginesDto & {
          readonly volAnalyticsSuite?: VolAnalyticsSuiteDto | null;
        })
      | null
      | undefined
  )?.volAnalyticsSuite;
  return fromUs ?? null;
}

/**
 * Resuelve el slice de vencimiento activo dentro de `expiriesByCode` sin silenciosos
 * falsos. Con `options.strict === true` y un `selectedExpiryCode` no vacío jamás cae al
 * front (`activeExpiryCode` / primera clave): devuelve `null` si el vencimiento pedido no
 * está en la suite. Sin `strict` conserva el comportamiento previo (retrocompatible).
 */
export function resolveExpiryVolSuite(
  suite: VolAnalyticsSuiteDto | null,
  selectedExpiryCode: string | null,
  options?: { readonly strict?: boolean },
): VolAnalyticsExpirySuiteDto | null {
  if (!suite) return null;
  if (options?.strict === true) {
    if (selectedExpiryCode === null || selectedExpiryCode === '') return null;
    return suite.expiriesByCode[selectedExpiryCode] ?? null;
  }
  if (selectedExpiryCode && suite.expiriesByCode[selectedExpiryCode]) {
    return suite.expiriesByCode[selectedExpiryCode] ?? null;
  }
  if (suite.activeExpiryCode && suite.expiriesByCode[suite.activeExpiryCode]) {
    return suite.expiriesByCode[suite.activeExpiryCode] ?? null;
  }
  const firstKey = Object.keys(suite.expiriesByCode)[0];
  return firstKey ? (suite.expiriesByCode[firstKey] ?? null) : null;
}

/**
 * Pieza 50.2: binding estricto de TIR/régimen sobre el vencimiento activo (funciones
 * puras en `activeExpiryBinding`).
 */
export {
  evaluateActiveExpiryHeaderTir,
  evaluateActiveExpiryRegimeAndBreaker,
  type ActiveExpiryHeaderTirInput,
  type ActiveExpiryHeaderTirResult,
  type ActiveExpiryRegimeBreakerInput,
  type ActiveExpiryRegimeBreakerResult,
} from './activeExpiryBinding';


/** Unifica motores cuantitativos AR (`activeQuantEngines`) y US (`terminalEngines`) para Tab 1 y Tab 4. */
export function resolveUnifiedQuantEngines(
  liveQuantEngines: ArOptionsQuantEnginesDto | null,
  usSnapshot: UsSnapshotResponseDto | undefined,
): UnifiedQuantEnginesDto | null {
  return liveQuantEngines ?? usSnapshot?.terminalEngines ?? null;
}

/** Recorta la serie histórica de RV/close según el horizonte seleccionado. */
export function sliceHistorySeriesByHorizon(
  series: readonly VolSuiteHistoryPointDto[],
  horizon: VolHistoryHorizon,
): readonly VolSuiteHistoryPointDto[] {
  if (series.length === 0) return [];
  const limit = HORIZON_BAR_LIMITS[horizon];
  return series.length > limit ? series.slice(-limit) : series;
}

/** Formateo estricto nulo-seguro (`'—'` ante `null`/`undefined`/`NaN`). */
export function fmtNullableNumber(
  value: number | null | undefined,
  decimals = 2,
  suffix = '',
  prefix = '',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${prefix}${fmtNum(value, decimals)}${suffix}`;
}

/** Formateo con signo explícito (`+` / `-`) o `'—'` ante falta de datos. */
export function fmtSignedNullable(
  value: number | null | undefined,
  decimals = 2,
  suffix = '',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${fmtNum(value, decimals)}${suffix}`;
}

/** Calcula dominio [min, max] con padding para gráficos SVG neutros sin colapsar en rango cero. */
export function computeNumericExtent(
  values: readonly (number | null | undefined)[],
  padRatio = 0.08,
  fallbackSpan = 1,
): { readonly min: number; readonly max: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { min: 0, max: fallbackSpan };
  }
  const rawSpan = hi - lo;
  const span = rawSpan > 1e-9 ? rawSpan : Math.max(Math.abs(lo) * 0.1, fallbackSpan);
  const pad = span * padRatio;
  return { min: lo - pad, max: hi + pad };
}

/** Mapea puntos `(x, y)` finitos a path SVG `M ... L ...` con cortes si faltan valores. */
export function buildSvgLinePath(
  points: readonly { readonly x: number; readonly y: number | null | undefined }[],
  mapX: (x: number) => number,
  mapY: (y: number) => number,
): string {
  const parts: string[] = [];
  let penDown = false;
  for (const pt of points) {
    if (pt.y === null || pt.y === undefined || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      penDown = false;
      continue;
    }
    const sx = mapX(pt.x);
    const sy = mapY(pt.y);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
      penDown = false;
      continue;
    }
    parts.push(`${penDown ? 'L' : 'M'}${sx.toFixed(1)},${sy.toFixed(1)}`);
    penDown = true;
  }
  return parts.join(' ');
}

export function safeAnalyticalBsmGamma(
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
