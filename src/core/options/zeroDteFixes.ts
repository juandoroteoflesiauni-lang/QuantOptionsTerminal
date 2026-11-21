/**
 * Pieza 46.1: correcciones de precisión 0DTE / escala ORATS / griegas ITM / densidad BL.
 * Funciones puras, sin red ni interfaz, sin mutar argumentos. Un valor no calculable es NaN o null.
 */
import { greeksBsm, priceBsm } from './blackScholes.js';

export const IV_CAP_DECIMAL = 9.99;
export const EXTRINSIC_EPS = 0.01;
export const ORATS_PERCENT_DETECTION_THRESHOLD = 5;
export const MIN_ANNUALIZATION_DTE = 3;
export const MIN_RATIO_PREMIUM = 0.005;
export const MIN_EXPECTED_MOVE_T_YEARS = 1 / (252 * 6.5);

// ---------------------------------------------------------------------------
// 1. Escala ORATS
// ---------------------------------------------------------------------------

/**
 * Normaliza una volatilidad ORATS a decimal (0.3582 = 35.82 %). Valores >= 5 (500 %) se
 * interpretan como porcentaje y se dividen por 100. Entrada no finita o negativa -> NaN.
 */
export function normalizeOratsVolDecimal(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return Number.NaN;
  return raw >= ORATS_PERCENT_DETECTION_THRESHOLD ? raw / 100 : raw;
}

/** Convierte una volatilidad ORATS (decimal o porcentaje) a puntos porcentuales sin doble * 100. */
export function oratsVolToPct(raw: number | null | undefined): number {
  if (raw === null || raw === undefined) return Number.NaN;
  const dec = normalizeOratsVolDecimal(raw);
  return Number.isFinite(dec) ? dec * 100 : Number.NaN;
}

// ---------------------------------------------------------------------------
// 2. IV capada / extrínseco nulo / griegas fallback
// ---------------------------------------------------------------------------

export type ContractSide = 'call' | 'put';

export function intrinsicValue(side: ContractSide, spot: number, strike: number): number {
  return side === 'call' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}

export function extrinsicValue(side: ContractSide, spot: number, strike: number, mid: number): number {
  if (!Number.isFinite(spot) || !Number.isFinite(strike) || !Number.isFinite(mid)) return Number.NaN;
  return mid - intrinsicValue(side, spot, strike);
}

/** `true` si la IV del contrato no es confiable (techo >= 9.99, no finita o extrínseco <= 0.01). */
export function isIvUnreliable(iv: number, extrinsic: number): boolean {
  if (!Number.isFinite(iv) || iv >= IV_CAP_DECIMAL) return true;
  return Number.isFinite(extrinsic) && extrinsic <= EXTRINSIC_EPS;
}

/** IV saneada: `null` si capada o con extrínseco nulo. */
export function sanitizeContractIv(iv: number, extrinsic: number): number | null {
  return isIvUnreliable(iv, extrinsic) ? null : iv;
}

export interface FallbackGreeksInput {
  readonly side: ContractSide;
  readonly spot: number;
  readonly strike: number;
  readonly timeToExpiry: number;
  readonly rate: number;
  readonly dividendYield: number;
  /** IV del contrato (decimal) o NaN/null si no calculable. */
  readonly contractIv: number | null;
  readonly extrinsic: number;
  /** IV ATM del vencimiento activo (decimal). */
  readonly ivAtm: number;
}

export interface FallbackGreeksResult {
  readonly iv: number | null;
  readonly delta: number;
  readonly gamma: number;
  readonly vega: number;
  readonly theta: number;
  readonly source: 'CONTRACT_IV' | 'ATM_FALLBACK' | 'DEEP_ITM_INTRINSIC' | 'NO_DATA';
}

const NO_DATA_GREEKS: FallbackGreeksResult = Object.freeze({
  iv: null,
  delta: Number.NaN,
  gamma: Number.NaN,
  vega: Number.NaN,
  theta: Number.NaN,
  source: 'NO_DATA',
});

export function computeFallbackGreeks(input: FallbackGreeksInput): FallbackGreeksResult {
  const { side, spot, strike, timeToExpiry, rate, dividendYield, extrinsic, ivAtm } = input;
  const ivRaw = input.contractIv ?? Number.NaN;
  if (
    !Number.isFinite(spot) || spot <= 0 || !Number.isFinite(strike) || strike <= 0 ||
    !Number.isFinite(timeToExpiry) || timeToExpiry <= 0
  ) {
    return NO_DATA_GREEKS;
  }
  const unreliable = isIvUnreliable(ivRaw, extrinsic);
  const itm = intrinsicValue(side, spot, strike) > 0;
  if (Number.isFinite(extrinsic) && extrinsic <= EXTRINSIC_EPS && itm) {
    return {
      iv: null,
      delta: side === 'call' ? 1 : -1,
      gamma: 0,
      vega: 0,
      theta: 0,
      source: 'DEEP_ITM_INTRINSIC',
    };
  }
  const vol = unreliable ? ivAtm : ivRaw;
  if (!Number.isFinite(vol) || vol <= 0 || vol >= IV_CAP_DECIMAL) return NO_DATA_GREEKS;
  const g = greeksBsm({
    spot, strike, timeToExpiry, rate, dividendYield, volatility: vol, contractType: side,
  });
  return {
    iv: unreliable ? null : ivRaw,
    delta: g.delta,
    gamma: g.gamma,
    vega: g.vega,
    theta: g.theta,
    source: unreliable ? 'ATM_FALLBACK' : 'CONTRACT_IV',
  };
}

// ---------------------------------------------------------------------------
// 2b. Pieza 50.1: rescate de IV ITM vía contraparte OTM (paridad Put-Call)
// ---------------------------------------------------------------------------

export const DEFAULT_PARITY_RESCUE_MAX_MONEYNESS = 0.15;

export type ParityItmRescueSource = 'PARITY_OTM' | 'ATM_RESCUE';

export interface ParityItmRescueInput {
  /** IV confiable de la contraparte OTM del mismo (vencimiento, strike) o NaN. */
  readonly counterpartOtmIv: number;
  /** IV ATM del vencimiento como rescate para |moneyness| <= `maxMoneynessAbs` o NaN. */
  readonly atmIv: number;
  /** |strike - spot| / spot. */
  readonly moneynessAbs: number;
  /** Ventana máxima de moneyness para el rescate ATM (default 0.15 = ±15 %). */
  readonly maxMoneynessAbs?: number;
}

export interface ParityItmRescueResult {
  /** IV decimal rescatada, o `null` si no corresponde rescate (deep ITM honesto). */
  readonly iv: number | null;
  readonly source: ParityItmRescueSource | null;
}

/**
 * Pieza 50.1: antes de colapsar un contrato ITM con IV no confiable a
 * `DEEP_ITM_INTRINSIC` (`Delta = ±1`), rescata una IV coherente:
 *  1) `PARITY_OTM` si el mismo (vencimiento, strike) tiene contraparte OTM con IV confiable;
 *  2) `ATM_RESCUE` con la IV ATM del vencimiento si `|moneyness| <= maxMoneynessAbs`.
 * Sin rescate disponible → `{ iv: null, source: null }` (sin inventar valores).
 */
export function resolveParityItmRescueIv(input: ParityItmRescueInput): ParityItmRescueResult {
  const maxMoneynessAbs = input.maxMoneynessAbs ?? DEFAULT_PARITY_RESCUE_MAX_MONEYNESS;
  if (
    Number.isFinite(input.counterpartOtmIv) &&
    input.counterpartOtmIv > 0 &&
    input.counterpartOtmIv < IV_CAP_DECIMAL
  ) {
    return { iv: input.counterpartOtmIv, source: 'PARITY_OTM' };
  }
  if (
    Number.isFinite(input.moneynessAbs) &&
    input.moneynessAbs <= maxMoneynessAbs &&
    Number.isFinite(input.atmIv) &&
    input.atmIv > 0 &&
    input.atmIv < IV_CAP_DECIMAL
  ) {
    return { iv: input.atmIv, source: 'ATM_RESCUE' };
  }
  return { iv: null, source: null };
}

/** Un contrato participa en C-P (pp) solo si ambas IV son confiables. */
export function includeInParityCpPp(
  callIv: number,
  callExtrinsic: number,
  putIv: number,
  putExtrinsic: number,
): boolean {
  return !isIvUnreliable(callIv, callExtrinsic) && !isIvUnreliable(putIv, putExtrinsic);
}

// ---------------------------------------------------------------------------
// 3. Gate Buy-Write DTE < 3
// ---------------------------------------------------------------------------

export type BuyWriteRateStatus = 'OK' | 'BLOCKED_SHORT_DTE' | 'NO_DATA';

export interface AnnualizedRateResult {
  readonly annualizedRate: number | null;
  readonly rateStatus: BuyWriteRateStatus;
}

/** Tasa efectiva anualizada compuesta `(1 + r)^(365 / dte) - 1`, bloqueada si `dte < 3`. */
export function annualizeEffectiveRate(periodReturn: number, dte: number): AnnualizedRateResult {
  if (!Number.isFinite(periodReturn) || !Number.isFinite(dte) || dte < 0 || periodReturn <= -1) {
    return { annualizedRate: null, rateStatus: 'NO_DATA' };
  }
  if (dte < MIN_ANNUALIZATION_DTE) {
    return { annualizedRate: null, rateStatus: 'BLOCKED_SHORT_DTE' };
  }
  const rate = Math.pow(1 + periodReturn, 365 / dte) - 1;
  return Number.isFinite(rate)
    ? { annualizedRate: rate, rateStatus: 'OK' }
    : { annualizedRate: null, rateStatus: 'NO_DATA' };
}

export const BLOCKED_SHORT_DTE_TOOLTIP = 'Anualización bloqueada (DTE < 3)';

// ---------------------------------------------------------------------------
// 4. DTE calendario ET, etiqueta 0DTE y circuit breaker
// ---------------------------------------------------------------------------

interface EtParts {
  readonly date: string;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function easternParts(nowMs: number): EtParts | null {
  if (!Number.isFinite(nowMs)) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(nowMs))) parts[p.type] = p.value;
  const y = parts['year'];
  const mo = parts['month'];
  const d = parts['day'];
  if (y === undefined || mo === undefined || d === undefined) return null;
  return {
    date: `${y}-${mo}-${d}`,
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    second: Number(parts['second']),
  };
}

export function todayEtDate(nowMs: number): string | null {
  return easternParts(nowMs)?.date ?? null;
}

function isoToDayNumber(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

/** DTE calendario (ET). `expiryDate === todayET` -> 0. Fecha inválida o pasada -> NaN. */
export function calendarDteEt(expiryDate: string, nowMs: number): number {
  const today = todayEtDate(nowMs);
  if (today === null) return Number.NaN;
  const diff = isoToDayNumber(expiryDate) - isoToDayNumber(today);
  return Number.isFinite(diff) && diff >= 0 ? diff : Number.NaN;
}

export function formatDteLabel(dte: number): string {
  if (!Number.isFinite(dte)) return '—';
  return dte === 0 ? '0DTE' : `${String(dte)}d`;
}

/**
 * Pieza 50.1: instante UTC (segundos) de las 16:00 ET del día de vencimiento
 * `YYYY-MM-DD`, resolviendo EST/EDT con `America/New_York`. Formato o fecha
 * inválidos → `NaN` (sin fallbacks inventados).
 */
export function etExpiryUtcSecFromDate(expiryDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiryDate);
  if (m === null) return Number.NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return Number.NaN;
  }
  // 16:00 ET = 20:00 UTC (EDT) o 21:00 UTC (EST).
  for (const utcHour of [20, 21]) {
    const candidateMs = Date.UTC(year, month - 1, day, utcHour, 0, 0);
    const parts = easternParts(candidateMs);
    if (
      parts !== null &&
      parts.date === expiryDate &&
      parts.hour === 16 &&
      parts.minute === 0
    ) {
      return Math.floor(candidateMs / 1_000);
    }
  }
  return Number.NaN;
}

/** Horas reales restantes hasta las 16:00 ET del día actual (>= 0). */
export function hoursToCloseEt(nowMs: number): number {
  const p = easternParts(nowMs);
  if (p === null) return Number.NaN;
  const elapsed = p.hour + p.minute / 60 + p.second / 3600;
  return Math.max(0, 16 - elapsed);
}

export type ShortPremiumBreakerStatus = 'OK' | 'NO_SHORT_PREMIUM_RISK';

export interface ShortPremiumBreakerInput {
  readonly dte: number;
  readonly spot: number;
  readonly putWall: number | null;
  readonly netGex: number;
}

export interface ShortPremiumBreakerResult {
  readonly blocked: boolean;
  readonly status: ShortPremiumBreakerStatus;
  readonly message: string | null;
  readonly autoSelectCreditMode: boolean;
}

export const SHORT_PREMIUM_RISK_MESSAGE = 'Riesgo 0DTE / Short Gamma — No vender prima';

export function evaluateShortPremiumBreaker(input: ShortPremiumBreakerInput): ShortPremiumBreakerResult {
  const shortDte = Number.isFinite(input.dte) && input.dte <= 1;
  const shortGammaBreak =
    input.putWall !== null &&
    Number.isFinite(input.putWall) &&
    Number.isFinite(input.spot) &&
    Number.isFinite(input.netGex) &&
    input.spot < input.putWall &&
    input.netGex < 0;
  const blocked = shortDte || shortGammaBreak;
  return {
    blocked,
    status: blocked ? 'NO_SHORT_PREMIUM_RISK' : 'OK',
    message: blocked ? SHORT_PREMIUM_RISK_MESSAGE : null,
    autoSelectCreditMode: !blocked,
  };
}

// ---------------------------------------------------------------------------
// 5. Strikes ±1σ / ±2σ y filtro cero en Ratios 1x2
// ---------------------------------------------------------------------------

export function expectedMoveSigma(spot: number, ivAtm: number, timeToExpiry: number): number {
  if (!Number.isFinite(spot) || !Number.isFinite(ivAtm) || !Number.isFinite(timeToExpiry)) return Number.NaN;
  if (spot <= 0 || ivAtm <= 0) return Number.NaN;
  return spot * ivAtm * Math.sqrt(Math.max(timeToExpiry, MIN_EXPECTED_MOVE_T_YEARS));
}

export interface SigmaStrikes {
  readonly expectedMove: number;
  readonly minus2: number;
  readonly minus1: number;
  readonly plus1: number;
  readonly plus2: number;
}

function nearestStrike(strikes: readonly number[], target: number): number {
  let best = Number.NaN;
  let bestDist = Infinity;
  for (const k of strikes) {
    if (!Number.isFinite(k)) continue;
    const dist = Math.abs(k - target);
    if (dist < bestDist - 1e-12 || (Math.abs(dist - bestDist) <= 1e-12 && k < best)) {
      best = k;
      bestDist = dist;
    }
  }
  return best;
}

export function pickSigmaStrikes(
  spot: number,
  ivAtm: number,
  timeToExpiry: number,
  strikes: readonly number[],
): SigmaStrikes {
  const em = expectedMoveSigma(spot, ivAtm, timeToExpiry);
  if (!Number.isFinite(em)) {
    return { expectedMove: NaN, minus2: NaN, minus1: NaN, plus1: NaN, plus2: NaN };
  }
  return {
    expectedMove: em,
    minus2: nearestStrike(strikes, spot - 2 * em),
    minus1: nearestStrike(strikes, spot - em),
    plus1: nearestStrike(strikes, spot + em),
    plus2: nearestStrike(strikes, spot + 2 * em),
  };
}

export const NO_VALID_PREMIUMS_MESSAGE = 'Sin primas válidas en este vencimiento';

/** Una tarjeta de ratio es válida si al menos una pata tiene prima > 0.005. */
export function isRatioCardValid(legAPremium: number, legBPremium: number): boolean {
  const a = Number.isFinite(legAPremium) && legAPremium > MIN_RATIO_PREMIUM;
  const b = Number.isFinite(legBPremium) && legBPremium > MIN_RATIO_PREMIUM;
  return a || b;
}

// ---------------------------------------------------------------------------
// 6. Densidad Breeden-Litzenberger endurecida
// ---------------------------------------------------------------------------

export interface BlHardenedNode {
  readonly strike: number;
  readonly iv: number | null;
  readonly bid: number;
  readonly ask?: number;
}

export interface BlHardenedInput {
  readonly spot: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly timeToExpiry: number;
  readonly dte: number;
  readonly expectedMove: number;
  readonly nodes: readonly BlHardenedNode[];
  /** Spread relativo máximo (ask-bid)/mid. Por defecto 0.5. */
  readonly maxRelativeSpread?: number;
  /** Paso de grilla como fracción de expectedMove. Por defecto 0.05. */
  readonly gridStepFraction?: number;
}

export interface BlHardenedResult {
  readonly status: 'OK' | 'NO_DATA';
  readonly usedNodes: number;
  readonly rawArea: number;
  readonly step: number;
  readonly nodes: readonly { readonly strike: number; readonly densityQ: number }[];
}

const NO_DATA_BL: BlHardenedResult = Object.freeze({
  status: 'NO_DATA',
  usedNodes: 0,
  rawArea: Number.NaN,
  step: Number.NaN,
  nodes: [],
});

export const DEFAULT_BL_MAX_RELATIVE_SPREAD = 0.5;
export const DEFAULT_BL_GRID_STEP_FRACTION = 0.05;
const MAX_BL_GRID = 2000;
const MIN_BL_NODES = 4;
const MIN_TOTAL_VARIANCE = 1e-12;

export function filterBlNodes(
  nodes: readonly BlHardenedNode[],
  maxRelativeSpread: number,
): { readonly strike: number; readonly iv: number }[] {
  const byStrike = new Map<number, { strike: number; iv: number }>();
  for (const n of nodes) {
    if (n.iv === null || !Number.isFinite(n.iv) || n.iv <= 0 || n.iv >= IV_CAP_DECIMAL) continue;
    if (!Number.isFinite(n.strike) || n.strike <= 0) continue;
    if (!Number.isFinite(n.bid) || n.bid <= 0) continue;
    if (n.ask !== undefined) {
      if (!Number.isFinite(n.ask) || n.ask < n.bid) continue;
      const mid = 0.5 * (n.bid + n.ask);
      if ((n.ask - n.bid) / mid > maxRelativeSpread) continue;
    }
    if (!byStrike.has(n.strike)) byStrike.set(n.strike, { strike: n.strike, iv: n.iv });
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

function numAt(arr: readonly number[], idx: number): number {
  const v = arr[idx];
  return v !== undefined ? v : Number.NaN;
}

/** Pendientes PCHIP (Fritsch-Carlson, extremos con fórmula de 3 puntos limitada). */
export function pchipSlopes(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length;
  if (n < 2) return [];
  const h: number[] = [];
  const del: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const step = numAt(xs, i + 1) - numAt(xs, i);
    h.push(step);
    del.push((numAt(ys, i + 1) - numAt(ys, i)) / step);
  }
  const d = new Array<number>(n).fill(0);
  if (n === 2) {
    const slope = numAt(del, 0);
    d[0] = slope;
    d[1] = slope;
    return d;
  }
  for (let i = 1; i < n - 1; i += 1) {
    const d0 = numAt(del, i - 1);
    const d1 = numAt(del, i);
    if (d0 * d1 > 0) {
      const hi = numAt(h, i);
      const hiPrev = numAt(h, i - 1);
      const w1 = 2 * hi + hiPrev;
      const w2 = hi + 2 * hiPrev;
      d[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
    } else {
      d[i] = 0;
    }
  }
  const endpoint = (h0: number, h1: number, del0: number, del1: number): number => {
    let v = ((2 * h0 + h1) * del0 - h0 * del1) / (h0 + h1);
    if (Math.sign(v) !== Math.sign(del0)) {
      v = 0;
    } else if (Math.sign(del0) !== Math.sign(del1) && Math.abs(v) > 3 * Math.abs(del0)) {
      v = 3 * del0;
    }
    return v;
  };
  d[0] = endpoint(numAt(h, 0), numAt(h, 1), numAt(del, 0), numAt(del, 1));
  d[n - 1] = endpoint(numAt(h, n - 2), numAt(h, n - 3), numAt(del, n - 2), numAt(del, n - 3));
  return d;
}

export function pchipEval(xs: readonly number[], ys: readonly number[], d: readonly number[], x: number): number {
  const n = xs.length;
  let i = 0;
  while (i < n - 2 && x > numAt(xs, i + 1)) i += 1;
  const x0 = numAt(xs, i);
  const h = numAt(xs, i + 1) - x0;
  const t = (x - x0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * numAt(ys, i) +
    (t3 - 2 * t2 + t) * h * numAt(d, i) +
    (-2 * t3 + 3 * t2) * numAt(ys, i + 1) +
    (t3 - t2) * h * numAt(d, i + 1)
  );
}

export function buildHardenedBlDensity(input: BlHardenedInput): BlHardenedResult {
  const { spot, rate, dividendYield, timeToExpiry, dte, expectedMove } = input;
  if (
    !Number.isFinite(spot) || spot <= 0 || !Number.isFinite(rate) || !Number.isFinite(dividendYield) ||
    !Number.isFinite(timeToExpiry) || timeToExpiry <= 0 || !Number.isFinite(expectedMove) || expectedMove <= 0
  ) {
    return NO_DATA_BL;
  }
  const maxSpread = input.maxRelativeSpread ?? DEFAULT_BL_MAX_RELATIVE_SPREAD;
  const stepFraction = input.gridStepFraction ?? DEFAULT_BL_GRID_STEP_FRACTION;
  const clean = filterBlNodes(input.nodes, maxSpread);
  const firstNode = clean[0];
  const lastNode = clean[clean.length - 1];
  if (clean.length < MIN_BL_NODES || firstNode === undefined || lastNode === undefined) return NO_DATA_BL;

  const forward = spot * Math.exp((rate - dividendYield) * timeToExpiry);
  const ks = clean.map((n) => Math.log(n.strike / forward));
  const ws = clean.map((n) => n.iv * n.iv * timeToExpiry);
  const slopes = pchipSlopes(ks, ws);

  const kMin = firstNode.strike;
  const kMax = lastNode.strike;
  const step = Math.max(expectedMove * stepFraction, (kMax - kMin) / (MAX_BL_GRID - 1));
  const count = Math.floor((kMax - kMin) / step + 1e-9) + 1;
  if (count < 5) return NO_DATA_BL;

  const grid: number[] = [];
  const calls: number[] = [];
  for (let j = 0; j < count; j += 1) {
    const strike = kMin + j * step;
    const w = Math.max(MIN_TOTAL_VARIANCE, pchipEval(ks, ws, slopes, Math.log(strike / forward)));
    const price = priceBsm({
      spot, strike, timeToExpiry, rate, dividendYield,
      volatility: Math.sqrt(w / timeToExpiry), contractType: 'call',
    });
    if (!Number.isFinite(price)) return NO_DATA_BL;
    grid.push(strike);
    calls.push(price);
  }

  const growth = Math.exp(rate * timeToExpiry);
  let dens = new Array<number>(count).fill(0);
  for (let j = 1; j < count - 1; j += 1) {
    const d2 = (numAt(calls, j - 1) - 2 * numAt(calls, j) + numAt(calls, j + 1)) / (step * step);
    dens[j] = Math.max(0, growth * d2);
  }
  dens[0] = numAt(dens, 1);
  dens[count - 1] = numAt(dens, count - 2);

  if (Number.isFinite(dte) && dte <= 1) {
    const sm = dens.slice();
    for (let j = 1; j < count - 1; j += 1) {
      sm[j] = 0.25 * numAt(dens, j - 1) + 0.5 * numAt(dens, j) + 0.25 * numAt(dens, j + 1);
    }
    dens = sm;
  }

  let area = 0;
  for (let j = 0; j < count - 1; j += 1) area += 0.5 * (numAt(dens, j) + numAt(dens, j + 1)) * step;
  if (!Number.isFinite(area) || area <= 0) return NO_DATA_BL;

  return {
    status: 'OK',
    usedNodes: clean.length,
    rawArea: area,
    step,
    nodes: grid.map((strike, j) => ({ strike, densityQ: numAt(dens, j) / area })),
  };
}

// ---------------------------------------------------------------------------
// 7. What-If en horas y breakevens
// ---------------------------------------------------------------------------

export const HOURS_PER_YEAR = 365 * 24;

export function timeYearsFromHours(hoursRemaining: number): number {
  return Number.isFinite(hoursRemaining) && hoursRemaining >= 0 ? hoursRemaining / HOURS_PER_YEAR : Number.NaN;
}

/** Valores del slider de horas restantes: de `startHours` a 0 con paso `step` (incluye 0). */
export function hoursRemainingGrid(startHours: number, step = 0.25): number[] {
  if (!Number.isFinite(startHours) || startHours < 0 || !Number.isFinite(step) || step <= 0) return [];
  const top = Math.floor(startHours / step + 1e-9) * step;
  const out: number[] = [];
  if (startHours - top > 1e-9) out.push(startHours);
  const n = Math.round(top / step);
  for (let i = n; i >= 0; i -= 1) out.push(i * step);
  return out;
}

/** Cruces por cero de la curva P&L al vencimiento (interpolación lineal exacta). */
export function findBreakevens(spots: readonly number[], pnl: readonly number[]): number[] {
  const out: number[] = [];
  const m = Math.min(spots.length, pnl.length);
  for (let i = 0; i < m; i += 1) {
    const s = spots[i];
    const y = pnl[i];
    if (s === undefined || y === undefined || !Number.isFinite(s) || !Number.isFinite(y)) continue;
    if (y === 0) {
      out.push(s);
      continue;
    }
    if (i + 1 < m) {
      const s1 = spots[i + 1];
      const y1 = pnl[i + 1];
      if (s1 === undefined || y1 === undefined || !Number.isFinite(s1) || !Number.isFinite(y1)) continue;
      if (y1 !== 0 && y * y1 < 0) {
        out.push(s + (-y * (s1 - s)) / (y1 - y));
      }
    }
  }
  return out;
}

export function formatBreakevenLabel(price: number): string {
  return Number.isFinite(price) ? `BE $${price.toFixed(2)}` : 'BE —';
}
