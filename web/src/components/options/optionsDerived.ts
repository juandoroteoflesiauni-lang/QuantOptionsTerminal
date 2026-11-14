import { OptionChainRow, fmtMoneyCompact, fmtNum } from '../../data/marketData';
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
  totalTurnoverArsM: number;
  callSharePct: number;
  putCallRatio: number;
  netDeltaEqShares: number;
  dominantDirection: string;
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
  const firstLeg = ev.legs[0];
  if (firstLeg?.type === 'P') return { family: 'compradas', bias: 'Bajista' };
  return { family: 'compradas', bias: 'Alcista' };
}

function isFamilyMatch(cardFamily: StrategyFamilyId, selected: StrategyFamilyId): boolean {
  if (selected === 'sugeridas') return true;
  if (cardFamily === selected) return true;
  return false;
}

function buildStrategyPool(
  mkt: Market,
  strategyMode: 'familia' | 'objetivo',
  selectedFamily: StrategyFamilyId,
  marketBias: 'Alcista' | 'Lateral' | 'Bajista' | 'Se mueve',
  targetPrice: number
): Strategy[] {
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
    evalSpot
  );

  const seenIds = new Set<string>();
  const evaluated: Evaluation[] = [];
  for (const st of rawStrategies) {
    if (seenIds.has(st.id)) continue;
    seenIds.add(st.id);
    const ev = evaluate(mkt, st, evalSpot);
    if (!Number.isFinite(ev.cash) || !Number.isFinite(ev.pop)) continue;
    if (opts.strategyMode === 'familia' && opts.selectedFamily !== 'sugeridas') {
      const mapped = mapEngineFamilyToUi(ev);
      if (!isFamilyMatch(mapped.family, opts.selectedFamily)) continue;
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
    const yTop = `$${Math.max(1, scaleK)}k`;
    const yBot = `-$${Math.max(1, scaleK)}k`;

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
        : `$${fmtNum(ev.maxGain / 1000, 1)}k`;
    const maxLossLabel =
      ev.maxLoss === null
        ? 'Ilimitada'
        : `-$${fmtNum(ev.maxLoss / 1000, 1)}k`;
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
      xLabels: [0, 0.33, 0.66, 1].map((f) => `$${fk(loPrice + xRange * f)}`),
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
    };
  });

  return { cards, rows };
}

function callSpreadRatio(baseRow: OptionChainRow, longIdxRow: OptionChainRow | undefined): number {
  if (!longIdxRow) return Number.NaN;
  const width = Math.abs(longIdxRow.strike - baseRow.strike);
  const longPx = Number.isFinite(baseRow.callAsk) && baseRow.callAsk > 0 ? baseRow.callAsk : baseRow.callLast;
  const shortPx = Number.isFinite(longIdxRow.callBid) && longIdxRow.callBid > 0 ? longIdxRow.callBid : longIdxRow.callLast;
  const debit = longPx - shortPx;
  if (!Number.isFinite(width) || !Number.isFinite(debit) || width <= 0 || debit <= 0.05) {
    return Number.NaN;
  }
  const r = width / debit;
  return Number.isFinite(r) && r > 0 && r < 50 ? r : Number.NaN;
}

function putSpreadRatio(baseRow: OptionChainRow, longIdxRow: OptionChainRow | undefined): number {
  if (!longIdxRow) return Number.NaN;
  const width = Math.abs(baseRow.strike - longIdxRow.strike);
  const longPx = Number.isFinite(longIdxRow.putAsk) && longIdxRow.putAsk > 0 ? longIdxRow.putAsk : longIdxRow.putLast;
  const shortPx = Number.isFinite(baseRow.putBid) && baseRow.putBid > 0 ? baseRow.putBid : baseRow.putLast;
  const debit = longPx - shortPx;
  if (!Number.isFinite(width) || !Number.isFinite(debit) || width <= 0 || debit <= 0.05) {
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
  unit: 'lotes' | '$'
): FlowSummary {
  if (rows.length === 0) {
    return {
      rows: [],
      totalCallLots: 0,
      totalPutLots: 0,
      totalLots: 0,
      totalTurnoverArsM: 0,
      callSharePct: Number.NaN,
      putCallRatio: Number.NaN,
      netDeltaEqShares: Number.NaN,
      dominantDirection: '—',
    };
  }

  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  let totalCallLots = 0;
  let totalPutLots = 0;
  let totalTurnoverArs = 0;
  let netDeltaEqShares = 0;
  let hasDelta = false;

  const perStrike = sorted.map((r) => {
    const cLots = Number.isFinite(r.callVolumeLots) ? Math.max(0, r.callVolumeLots) : 0;
    const pLots = Number.isFinite(r.putVolumeLots) ? Math.max(0, r.putVolumeLots) : 0;
    const cPx = Number.isFinite(r.callLast) ? Math.max(0, r.callLast) : 0;
    const pPx = Number.isFinite(r.putLast) ? Math.max(0, r.putLast) : 0;
    const cVal = cLots * LOT * cPx;
    const pVal = pLots * LOT * pPx;

    totalCallLots += cLots;
    totalPutLots += pLots;
    totalTurnoverArs += cVal + pVal;

    if (Number.isFinite(r.callDelta)) {
      netDeltaEqShares += cLots * LOT * r.callDelta;
      hasDelta = true;
    }
    if (Number.isFinite(r.putDelta)) {
      netDeltaEqShares += pLots * LOT * r.putDelta;
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
    totalTurnoverArsM: totalTurnoverArs / 1_000_000,
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
  rateDec: number
): number {
  if (leg.type === 'Subyacente') return spot;
  const optType = leg.type === 'Call' ? 'C' : 'P';
  const sigma = Math.max(0.02, (leg.iv + ivShiftPts) / 100);
  if (daysLeft <= 0) {
    return optType === 'C' ? Math.max(0, spot - leg.strike) : Math.max(0, leg.strike - spot);
  }
  return bsPrice(optType, spot, leg.strike, daysLeft, sigma, rateDec);
}

export function computeBuilderAnalytics(
  legs: readonly BuilderLeg[],
  simSpot: number,
  simDaysLeft: number,
  simIvShiftPts: number,
  simTlrPct: number,
  baseSpot: number,
  baseDays: number,
  rows: readonly OptionChainRow[]
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
    const v0 = legBsValue(leg, safeSpot, simDaysLeft, simIvShiftPts, rateDec);
    const vUp = legBsValue(leg, safeSpot + dS, simDaysLeft, simIvShiftPts, rateDec);
    const vDn = legBsValue(leg, Math.max(0.01, safeSpot - dS), simDaysLeft, simIvShiftPts, rateDec);
    const vIvUp = legBsValue(leg, safeSpot, simDaysLeft, simIvShiftPts + 1, rateDec);
    const vNextDay = legBsValue(leg, safeSpot, Math.max(0, simDaysLeft - 1), simIvShiftPts, rateDec);
    const vRateUp = legBsValue(leg, safeSpot, simDaysLeft, simIvShiftPts, rateDec + 0.01);

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
      const valTheo = legBsValue(leg, spotVal, simDaysLeft, simIvShiftPts, rateDec);
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

  // Escaneo fino para maxGain, maxLoss, breakevens y PoP
  const scanLo = safeSpot * 0.35;
  const scanHi = safeSpot * 1.85;
  const scanN = 300;
  let maxGain = -Infinity;
  let maxLoss = Infinity;
  const breakevens: number[] = [];
  let prevS = scanLo;
  let prevP = pnlFinishAt(scanLo);
  for (let i = 1; i <= scanN; i += 1) {
    const s = scanLo + ((scanHi - scanLo) * i) / scanN;
    const p = pnlFinishAt(s);
    if (p > maxGain) maxGain = p;
    if (p < maxLoss) maxLoss = p;
    if ((prevP <= 0 && p > 0) || (prevP >= 0 && p < 0)) {
      const frac = Math.abs(prevP) / Math.max(1e-9, Math.abs(p - prevP));
      breakevens.push(prevS + frac * (s - prevS));
    }
    prevS = s;
    prevP = p;
  }

  const farUpSlope = pnlFinishAt(safeSpot * 3) - pnlFinishAt(safeSpot * 2.5);
  const unlimitedGain = farUpSlope > 1;
  const unlimitedLoss = farUpSlope < -1;

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
    maxGain: legs.length > 0 && Number.isFinite(maxGain) ? maxGain : Number.NaN,
    maxLoss: legs.length > 0 && Number.isFinite(maxLoss) ? Math.abs(Math.min(0, maxLoss)) : Number.NaN,
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
