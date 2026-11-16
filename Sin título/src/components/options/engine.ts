import { fmtNum } from '../../data/marketData';

/* ============================================================================
   Motor cuantitativo compartido por la suite de Opciones.
   Black-Scholes con sonrisa "sticky strike", payoff por pata, zonas de ganancia,
   empates y probabilidad log-normal (primas vs. historia).
   ============================================================================ */

export const LOT = 100;
export const COMMISSION_RATE = 0.006;
export const HIST_VOL = 0.46;
/** Para "servir", lo que ganás en tu precio tiene que ser al menos este múltiplo de lo que arriesgás. */
export const MIN_REWARD_RISK = 0.3;
export const FX_EASE = [0.16, 1, 0.3, 1] as const;

export interface Market {
  ticker: string;
  spot: number;
  days: number;
  rate: number;
  expiryLabel: string;
  expiryCode: string;
  codePrefix: string;
  step: number;
  strikes: number[];
  expiryDate: Date;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function parseExpiry(label: string): Date {
  const [dd, mon] = label.split(' ');
  const now = new Date();
  const m = Math.max(0, MONTHS.indexOf(mon));
  let d = new Date(now.getFullYear(), m, Number(dd) || 1);
  if (d.getTime() < now.getTime() - 86400000) d = new Date(now.getFullYear() + 1, m, Number(dd) || 1);
  return d;
}

/** Fecha corta ("18 dic") a `elapsed` días desde hoy. */
export function dateAt(mkt: Market, elapsed: number): string {
  const d = new Date(mkt.expiryDate.getTime() - (mkt.days - elapsed) * 86400000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function makeMarket(
  ticker: string,
  spot: number,
  days = 39,
  rate = 0.221,
  expiryLabel = '18 dic',
  expiryCode = 'DI'
): Market {
  const raw = spot * 0.04;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.75) ?? 10 * mag;
  const lo = Math.round((spot * 0.82) / step) * step;
  const hi = Math.round((spot * 1.22) / step) * step;
  const strikes: number[] = [];
  for (let k = lo; k <= hi + 1e-9; k += step) strikes.push(Math.round(k * 100) / 100);
  return {
    ticker,
    spot,
    days,
    rate,
    expiryLabel,
    expiryCode,
    codePrefix: ticker === 'GGAL' ? 'GFG' : ticker.slice(0, 3),
    step,
    strikes,
    expiryDate: parseExpiry(expiryLabel),
  };
}

export const fk = (k: number) => fmtNum(k, 0);
export const money = (v: number, decimals = 0) => `${v < 0 ? '-' : ''}$${fmtNum(Math.abs(v), decimals)}`;
export const signedMoney = (v: number) =>
  `${v > 0.5 ? '+' : v < -0.5 ? '-' : ''}$${fmtNum(Math.abs(v), 0)}`;
export const pct = (p: number, decimals = 0) => `${fmtNum(p * 100, decimals)}%`;

export function ncdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/* Estructura temporal de la VI ATM (Dic 38d · Feb 101d · Abr 164d) */
export const TERM_STRUCTURE: { days: number; label: string; atm: number }[] = [
  { days: 38, label: 'Dic', atm: 0.512 },
  { days: 101, label: 'Feb', atm: 0.536 },
  { days: 164, label: 'Abr', atm: 0.551 },
];

export function atmIv(days: number): number {
  const t = TERM_STRUCTURE;
  if (days <= t[0].days) return t[0].atm;
  for (let i = 1; i < t.length; i++) {
    if (days <= t[i].days) {
      const a = t[i - 1];
      const b = t[i];
      return a.atm + ((b.atm - a.atm) * (days - a.days)) / (b.days - a.days);
    }
  }
  return t[t.length - 1].atm;
}

/** Sonrisa: curvatura que se aplana con el plazo y skew positivo hacia los calls. */
export function smileIv(spot: number, K: number, days: number): number {
  const m = Math.log(K / spot);
  const curv = 0.8 * Math.sqrt(38 / Math.max(days, 10));
  return atmIv(days) + curv * m * m + 0.05 * m;
}

export const HIST_MEDIAN_IV = 0.58;
export function ivPercentile(iv: number): number {
  return Math.max(3, Math.min(97, Math.round(50 + (iv - 0.54) * 1200)));
}
export type IvDiagnosis = 'Barata' | 'En rango' | 'Cara';
export const diagnose = (p: number): IvDiagnosis => (p < 25 ? 'Barata' : p > 75 ? 'Cara' : 'En rango');

export type OptType = 'C' | 'P';

export function bsPrice(type: OptType, S: number, K: number, days: number, sigma: number, r: number): number {
  const T = days / 365;
  if (T <= 1e-6 || sigma <= 0) return type === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-r * T);
  return type === 'C' ? S * ncdf(d1) - K * df * ncdf(d2) : K * df * ncdf(-d2) - S * ncdf(-d1);
}

export interface StratLeg {
  side: 1 | -1;
  type: OptType;
  K: number;
  ratio: number;
}

export type Family = 'Bear spread' | 'Bull spread' | 'Mariposa' | 'Comprada' | 'Cuña' | 'Cono' | 'Cóndor';

export interface Strategy {
  id: string;
  family: Family;
  name: string;
  desc: string;
  legs: StratLeg[];
}

export interface PricedLeg extends StratLeg {
  premium: number;
  iv: number;
  code: string;
  delta: number;
  thetaDay: number;
}

export function priceLegs(mkt: Market, legs: StratLeg[]): PricedLeg[] {
  return legs.map((l) => {
    const iv = smileIv(mkt.spot, l.K, mkt.days);
    const p = bsPrice(l.type, mkt.spot, l.K, mkt.days, iv, mkt.rate);
    const pUp = bsPrice(l.type, mkt.spot * 1.001, l.K, mkt.days, iv, mkt.rate);
    const pTomorrow = bsPrice(l.type, mkt.spot, l.K, Math.max(0, mkt.days - 1), iv, mkt.rate);
    return {
      ...l,
      premium: Math.max(0.5, Math.round(p * 100) / 100),
      iv,
      code: `${mkt.codePrefix}${l.type === 'C' ? 'C' : 'V'}${Math.round(l.K)}${mkt.expiryCode}`,
      delta: (pUp - p) / (mkt.spot * 0.001),
      thetaDay: pTomorrow - p,
    };
  });
}

function legValue(mkt: Market, l: PricedLeg, S: number, daysLeft: number): number {
  if (daysLeft <= 0) return l.type === 'C' ? Math.max(0, S - l.K) : Math.max(0, l.K - S);
  return bsPrice(l.type, S, l.K, daysLeft, smileIv(mkt.spot, l.K, daysLeft), mkt.rate);
}

export interface Zone {
  lo: number;
  hi: number;
  openLo: boolean;
  openHi: boolean;
}

export interface Evaluation {
  strategy: Strategy;
  legs: PricedLeg[];
  /** Caja por unidad (positivo = cobrás, negativo = pagás), sin comisiones. */
  cash: number;
  commission: number;
  maxGain: number | null;
  maxLoss: number | null;
  zones: Zone[];
  breakevens: number[];
  pop: number;
  popHist: number;
  gainAtTarget: number;
  daysLeft: number;
  pnl: (S: number) => number;
  /** P&L de una unidad a un precio y a `elapsed` días desde hoy. */
  pnlAt: (S: number, elapsed: number) => number;
}

export function makePnlAt(mkt: Market, legs: PricedLeg[], commission: number) {
  return (S: number, elapsed: number) => {
    const dl = Math.max(0, mkt.days - elapsed);
    let v = -commission;
    for (const l of legs) v += l.side * l.ratio * LOT * (legValue(mkt, l, S, dl) - l.premium);
    return v;
  };
}

/** Probabilidad de terminar arriba de `p` dentro de `elapsed` días. */
export function probAbove(mkt: Market, p: number, elapsed: number, sigma: number, drift: number): number {
  if (elapsed <= 0) return mkt.spot > p ? 1 : 0;
  const t = elapsed / 365;
  const d2 = (Math.log(mkt.spot / p) + (drift - (sigma * sigma) / 2) * t) / (sigma * Math.sqrt(t));
  return ncdf(d2);
}

/** Evalúa una estrategia (1 unidad) en el horizonte `elapsed` días desde hoy. */
export function evaluate(mkt: Market, strategy: Strategy, target: number, elapsed = mkt.days): Evaluation {
  const legs = priceLegs(mkt, strategy.legs);
  const commission = legs.reduce((a, l) => a + Math.abs(l.premium * l.ratio * LOT) * COMMISSION_RATE, 0);
  const cash = legs.reduce((a, l) => a - l.side * l.premium * l.ratio * LOT, 0);
  const horizon = Math.max(0, Math.min(mkt.days, elapsed));
  const daysLeft = mkt.days - horizon;

  const pnlAt = makePnlAt(mkt, legs, commission);
  const pnl = (S: number) => pnlAt(S, horizon);

  let maxG = -Infinity;
  let minL = Infinity;
  for (let i = 0; i <= 600; i++) {
    const v = pnl(mkt.spot * (0.2 + i * 0.004));
    if (v > maxG) maxG = v;
    if (v < minL) minL = v;
  }
  const far1 = pnl(mkt.spot * 3);
  const far2 = pnl(mkt.spot * 4);
  const slope = far2 - far1;
  const maxGain = slope > 1 ? null : Math.max(maxG, far2);
  const maxLoss = slope < -1 ? null : Math.max(0, -Math.min(minL, far2));

  const lo0 = mkt.spot * 0.4;
  const hi0 = mkt.spot * 1.8;
  const N = 700;
  const zones: Zone[] = [];
  const breakevens: number[] = [];
  let prevS = lo0;
  let prevV = pnl(lo0);
  let cur: { lo: number; openLo: boolean } | null = prevV > 0 ? { lo: lo0, openLo: true } : null;
  for (let i = 1; i <= N; i++) {
    const S = lo0 + ((hi0 - lo0) * i) / N;
    const v = pnl(S);
    if (prevV > 0 !== v > 0) {
      const x = prevS + ((S - prevS) * (0 - prevV)) / (v - prevV);
      breakevens.push(x);
      if (v > 0) cur = { lo: x, openLo: false };
      else if (cur) {
        zones.push({ lo: cur.lo, hi: x, openLo: cur.openLo, openHi: false });
        cur = null;
      }
    }
    prevS = S;
    prevV = v;
  }
  if (cur) zones.push({ lo: cur.lo, hi: hi0, openLo: cur.openLo, openHi: true });

  const prob = (sigma: number, drift: number) => {
    if (horizon <= 0) return pnl(mkt.spot) > 0 ? 1 : 0;
    const t = horizon / 365;
    const sd = sigma * Math.sqrt(t);
    const mu = (drift - (sigma * sigma) / 2) * t;
    let w = 0;
    let tot = 0;
    for (let z = -4.5; z <= 4.5; z += 0.03) {
      const f = Math.exp((-z * z) / 2);
      tot += f;
      if (pnl(mkt.spot * Math.exp(mu + sd * z)) > 0) w += f;
    }
    return w / tot;
  };

  return {
    strategy,
    legs,
    cash,
    commission,
    maxGain,
    maxLoss,
    zones,
    breakevens,
    pop: prob(atmIv(mkt.days), mkt.rate),
    popHist: prob(HIST_VOL, 0),
    gainAtTarget: pnl(target),
    daysLeft,
    pnl,
    pnlAt,
  };
}

/* ============================================================================
   Generador de candidatas (las que "sirven" según el objetivo del mapa)
   ============================================================================ */
function verticals(mkt: Market, down: boolean): Strategy[] {
  const ks = mkt.strikes;
  const out: Strategy[] = [];
  for (let i = 0; i < ks.length; i++) {
    for (let j = i + 1; j < ks.length; j++) {
      const lo = ks[i];
      const hi = ks[j];
      if (hi - lo > mkt.step * 6) continue;
      out.push(
        down
          ? {
              id: `bps-${lo}-${hi}`,
              family: 'Bear spread',
              name: `Bear spread puts ${fk(lo)}/${fk(hi)}`,
              desc: 'Bajista con riesgo acotado: comprás el put alto y lo financiás vendiendo el bajo',
              legs: [
                { side: 1, type: 'P', K: hi, ratio: 1 },
                { side: -1, type: 'P', K: lo, ratio: 1 },
              ],
            }
          : {
              id: `bcs-${lo}-${hi}`,
              family: 'Bull spread',
              name: `Bull spread calls ${fk(lo)}/${fk(hi)}`,
              desc: 'Alcista con riesgo acotado: comprás el call bajo y vendés el alto',
              legs: [
                { side: 1, type: 'C', K: lo, ratio: 1 },
                { side: -1, type: 'C', K: hi, ratio: 1 },
              ],
            }
      );
    }
  }
  return out;
}

function butterflies(mkt: Market): Strategy[] {
  const ks = mkt.strikes;
  const out: Strategy[] = [];
  for (const c of ks) {
    for (const w of [1, 2, 3].map((m) => m * mkt.step)) {
      const lo = c - w;
      const hi = c + w;
      if (lo < ks[0] || hi > ks[ks.length - 1]) continue;
      for (const type of ['C', 'P'] as const) {
        out.push({
          id: `bfly-${type}-${lo}-${c}-${hi}`,
          family: 'Mariposa',
          name: `Mariposa ${type === 'C' ? 'calls' : 'puts'} ${fk(lo)}/${fk(c)}/${fk(hi)}`,
          desc: 'Zona de precios: la ganancia máxima está en la base del medio',
          legs: [
            { side: 1, type, K: lo, ratio: 1 },
            { side: -1, type, K: c, ratio: 2 },
            { side: 1, type, K: hi, ratio: 1 },
          ],
        });
      }
    }
  }
  return out;
}

function condors(mkt: Market): Strategy[] {
  const ks = mkt.strikes;
  const out: Strategy[] = [];
  const w = mkt.step;
  for (let i = 0; i < ks.length; i++) {
    for (let j = i + 1; j < ks.length; j++) {
      const k2 = ks[i];
      const k3 = ks[j];
      if (k3 - k2 > mkt.step * 6) continue;
      const k1 = k2 - w;
      const k4 = k3 + w;
      if (k1 < ks[0] || k4 > ks[ks.length - 1]) continue;
      out.push({
        id: `condor-${k1}-${k2}-${k3}-${k4}`,
        family: 'Cóndor',
        name: `Cóndor calls ${fk(k1)}/${fk(k2)}/${fk(k3)}/${fk(k4)}`,
        desc: 'Zona de ganancia amplia entre las dos bases vendidas',
        legs: [
          { side: 1, type: 'C', K: k1, ratio: 1 },
          { side: -1, type: 'C', K: k2, ratio: 1 },
          { side: -1, type: 'C', K: k3, ratio: 1 },
          { side: 1, type: 'C', K: k4, ratio: 1 },
        ],
      });
    }
  }
  return out;
}

function singles(mkt: Market, down: boolean): Strategy[] {
  return mkt.strikes.map((k) =>
    down
      ? {
          id: `lp-${k}`,
          family: 'Comprada' as const,
          name: `Put comprado ${fk(k)}`,
          desc: 'Bajista simple: ganás más cuanto más baja; lo más que perdés es la prima',
          legs: [{ side: 1 as const, type: 'P' as const, K: k, ratio: 1 }],
        }
      : {
          id: `lc-${k}`,
          family: 'Comprada' as const,
          name: `Call comprado ${fk(k)}`,
          desc: 'Alcista simple: ganás más cuanto más sube; lo más que perdés es la prima',
          legs: [{ side: 1 as const, type: 'C' as const, K: k, ratio: 1 }],
        }
  );
}

function longVol(mkt: Market): Strategy[] {
  const ks = mkt.strikes;
  const out: Strategy[] = [];
  for (const k of ks.filter((x) => Math.abs(x - mkt.spot) <= mkt.step * 2)) {
    out.push({
      id: `straddle-${k}`,
      family: 'Cono',
      name: `Cono comprado ${fk(k)}`,
      desc: 'Ganás si se mueve fuerte para cualquier lado; lo peor es que termine en la base',
      legs: [
        { side: 1, type: 'P', K: k, ratio: 1 },
        { side: 1, type: 'C', K: k, ratio: 1 },
      ],
    });
  }
  for (const kp of ks.filter((x) => x < mkt.spot && mkt.spot - x <= mkt.step * 5)) {
    for (const kc of ks.filter((x) => x > mkt.spot && x - mkt.spot <= mkt.step * 5)) {
      out.push({
        id: `strangle-${kp}-${kc}`,
        family: 'Cuña',
        name: `Cuña comprada ${fk(kp)}/${fk(kc)}`,
        desc: 'Más barata que el cono: necesita un movimiento más grande para ganar',
        legs: [
          { side: 1, type: 'P', K: kp, ratio: 1 },
          { side: 1, type: 'C', K: kc, ratio: 1 },
        ],
      });
    }
  }
  return out;
}

export function generateCandidates(mkt: Market, target: number): Strategy[] {
  const down = target < mkt.spot;
  return [...verticals(mkt, down), ...butterflies(mkt), ...singles(mkt, down)];
}

/* ============================================================================
   Objetivo del mapa (un precio · un rango · se mueve)
   ============================================================================ */
export type MapMode = 'precio' | 'rango' | 'mueve';

export interface MapGoal {
  mode: MapMode;
  price: number | null;
  range: [number, number] | null;
  move: number | null;
}

export const goalReady = (g: MapGoal) =>
  g.mode === 'precio'
    ? g.price != null
    : g.mode === 'rango'
    ? g.range != null && g.range[1] - g.range[0] > 0
    : g.move != null && g.move > 0;

export function goalCenter(mkt: Market, g: MapGoal): number {
  if (g.mode === 'precio') return g.price ?? mkt.spot;
  if (g.mode === 'rango' && g.range) return (g.range[0] + g.range[1]) / 2;
  return mkt.spot;
}

/** "Ganás ahí" según el modo: en el precio, promedio en el rango, o el peor de los dos lados. */
export function goalGain(mkt: Market, g: MapGoal, pnl: (S: number) => number): number {
  if (g.mode === 'rango' && g.range) {
    const [lo, hi] = g.range;
    let acc = 0;
    for (let i = 0; i <= 12; i++) acc += pnl(lo + ((hi - lo) * i) / 12);
    return acc / 13;
  }
  if (g.mode === 'mueve' && g.move != null) return Math.min(pnl(mkt.spot + g.move), pnl(mkt.spot - g.move));
  return pnl(g.price ?? mkt.spot);
}

export function candidatesForGoal(mkt: Market, g: MapGoal): Strategy[] {
  if (g.mode === 'rango') return [...butterflies(mkt), ...condors(mkt)];
  if (g.mode === 'mueve') return longVol(mkt);
  return generateCandidates(mkt, g.price ?? mkt.spot);
}

export interface Sized {
  ev: Evaluation;
  units: number;
  gain: number;
  risk: number;
}

export function sizeForBudget(
  evs: Evaluation[],
  budget: number,
  gainOf: (ev: Evaluation) => number = (ev) => ev.gainAtTarget
): Sized[] {
  const out: Sized[] = [];
  for (const ev of evs) {
    const g = gainOf(ev);
    if (ev.maxLoss == null || ev.maxLoss <= 0 || g < ev.maxLoss * MIN_REWARD_RISK) continue;
    const units = Math.floor(budget / ev.maxLoss);
    if (units < 1) continue;
    out.push({ ev, units, gain: g * units, risk: ev.maxLoss * units });
  }
  return out;
}

export function pickThree(list: Sized[]): { seguido?: Sized; medio?: Sized; grande?: Sized } {
  if (!list.length) return {};
  const seguido = [...list].sort((a, b) => b.ev.pop - a.ev.pop || b.gain - a.gain)[0];
  const grande = [...list].sort((a, b) => b.gain - a.gain || b.ev.pop - a.ev.pop)[0];
  const between = list.filter(
    (s) => s !== seguido && s !== grande && s.ev.pop < seguido.ev.pop && s.ev.pop > grande.ev.pop
  );
  const rest = list.filter((s) => s !== seguido && s !== grande);
  const pool = between.length ? between : rest.length ? rest : list;
  const mid = (seguido.ev.pop + grande.ev.pop) / 2;
  const medio = [...pool].sort(
    (a, b) => Math.abs(a.ev.pop - mid) - Math.abs(b.ev.pop - mid) || b.gain - a.gain
  )[0];
  return { seguido, medio, grande };
}

/** Interpolación monótona cúbica (Fritsch–Carlson) en coordenadas de pantalla. */
export function monotonePath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n < 2) return '';
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    m[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  const t: number[] = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * m[i];
      t[i + 1] = tau * b * m[i];
    }
  }
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C ${(pts[i].x + h).toFixed(1)} ${(pts[i].y + t[i] * h).toFixed(1)}, ${(pts[i + 1].x - h).toFixed(1)} ${(
      pts[i + 1].y -
      t[i + 1] * h
    ).toFixed(1)}, ${pts[i + 1].x.toFixed(1)} ${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}
