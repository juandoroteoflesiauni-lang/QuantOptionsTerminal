/**
 * Inferencia pura de Forward implícito `F(T)` y tasa de dividendo continuo
 * implícita `q(T)` mediante Paridad Put-Call (Pieza 3).
 *
 * Convenciones (AGENTS.md / SPEC.md):
 *  - Funciones 100 % puras: cero red, cero E/S, cero mutación de argumentos.
 *  - Prohibido inventar respaldos al precio spot (`?? spot` o `|| spot`): cuando no
 *    existen pares válidos o los spreads están cruzados/rotos, devuelve `NaN`.
 *  - Paridad europea: `C - P = exp(-rT) * (F(T) - K)` => `F(T) = K + (C - P) / D`,
 *    con `D = exp(-rT) > 0` y `q(T) = r - ln(F(T) / S) / T`.
 */

export type ForwardParityMethod = 'median' | 'weightedMean';

export interface ParityOptionPair {
  readonly strike: number;
  readonly callMid: number;
  readonly putMid: number;
  /** Bid/Ask opcionales para validar spreads y ponderar por liquidez. */
  readonly callBid?: number;
  readonly callAsk?: number;
  readonly putBid?: number;
  readonly putAsk?: number;
  /** Peso de liquidez positivo opcional (p. ej. min(OI) entre call y put). */
  readonly liquidityWeight?: number;
}

export interface InferForwardOptions {
  /** Método sobre los pares cercanos al dinero: `'median'` (defecto) o `'weightedMean'`. */
  readonly method?: ForwardParityMethod;
  /** Número máximo de pares más cercanos al dinero (`|ln(K / F_ref)|`) a combinar (`5` por defecto). */
  readonly nearAtmCount?: number;
  /** Spread relativo máximo `(ask - bid) / mid` admitido por pata (`0.35` por defecto). */
  readonly maxRelativeSpread?: number;
  /** Exigir `bid > 0` cuando el par incluye `callBid`/`putBid` (`true` por defecto). */
  readonly requirePositiveBid?: boolean;
  /** Mínimo de pares válidos requeridos para emitir resultado (`1` por defecto). */
  readonly minValidPairs?: number;
}

export interface InferForwardDetailedResult {
  readonly forward: number;
  readonly validPairsCount: number;
  readonly usedPairsCount: number;
  readonly discardedPairsCount: number;
}

export interface ImpliedDividendYieldInput {
  readonly spot: number;
  readonly forward: number;
  readonly timeToExpiry: number;
  readonly rate: number;
}

const DEFAULT_NEAR_ATM_COUNT = 5;
const DEFAULT_MAX_RELATIVE_SPREAD = 0.35;
const QUOTE_MID_BOUND_TOL = 1e-12;
const SPREAD_WEIGHT_EPS = 1e-4;
const ALLOWED_METHODS = new Set<string>(['median', 'weightedMean']);

interface ValidParityEntry {
  readonly strike: number;
  readonly pairForward: number;
  readonly weight: number;
  readonly totalRelSpread: number;
}

const NAN_DETAILED_RESULT: InferForwardDetailedResult = Object.freeze({
  forward: Number.NaN,
  validPairsCount: 0,
  usedPairsCount: 0,
  discardedPairsCount: 0,
});

function validateOptionLegQuote(
  mid: number,
  bid: number | undefined,
  ask: number | undefined,
  maxRelativeSpread: number,
  requirePositiveBid: boolean,
): number | null {
  if (!Number.isFinite(mid) || mid <= 0) {
    return null;
  }

  const tol = QUOTE_MID_BOUND_TOL * Math.max(1, mid);

  if (bid !== undefined) {
    if (!Number.isFinite(bid) || bid < 0) {
      return null;
    }
    if (requirePositiveBid && bid <= 0) {
      return null;
    }
    if (mid < bid - tol) {
      return null;
    }
  }

  if (ask !== undefined) {
    if (!Number.isFinite(ask) || ask <= 0) {
      return null;
    }
    if (mid > ask + tol) {
      return null;
    }
  }

  if (bid !== undefined && ask !== undefined) {
    if (ask < bid) {
      return null;
    }
    const relSpread = (ask - bid) / mid;
    if (!Number.isFinite(relSpread) || relSpread > maxRelativeSpread) {
      return null;
    }
    return relSpread;
  }

  return 0;
}

function medianSorted(sortedValues: readonly number[]): number {
  const n = sortedValues.length;
  if (n === 0) {
    return Number.NaN;
  }
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    return sortedValues[mid] ?? Number.NaN;
  }
  const left = sortedValues[mid - 1];
  const right = sortedValues[mid];
  if (left === undefined || right === undefined) {
    return Number.NaN;
  }
  return 0.5 * (left + right);
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * Variante detallada de `inferForwardFromParity` que expone además cuántos pares
 * fueron válidos, usados tras filtrar al entorno ATM y descartados.
 */
export function inferForwardFromParityDetailed(
  pairs: readonly ParityOptionPair[],
  discountFactor: number,
  options?: InferForwardOptions,
): InferForwardDetailedResult {
  if (!isRuntimeArray(pairs) || !Number.isFinite(discountFactor) || discountFactor <= 0) {
    return NAN_DETAILED_RESULT;
  }

  const method = options?.method ?? 'median';
  const nearAtmCount = options?.nearAtmCount ?? DEFAULT_NEAR_ATM_COUNT;
  const maxRelativeSpread = options?.maxRelativeSpread ?? DEFAULT_MAX_RELATIVE_SPREAD;
  const requirePositiveBid = options?.requirePositiveBid ?? true;
  const minValidPairs = options?.minValidPairs ?? 1;

  if (
    !ALLOWED_METHODS.has(method) ||
    !(
      nearAtmCount === Number.POSITIVE_INFINITY ||
      (Number.isInteger(nearAtmCount) && nearAtmCount >= 1)
    ) ||
    !Number.isFinite(maxRelativeSpread) ||
    maxRelativeSpread < 0 ||
    !Number.isInteger(minValidPairs) ||
    minValidPairs < 1
  ) {
    return NAN_DETAILED_RESULT;
  }

  const validEntries: ValidParityEntry[] = [];
  let discardedPairsCount = 0;

  for (const pair of pairs) {
    if (!Number.isFinite(pair.strike) || pair.strike <= 0) {
      discardedPairsCount += 1;
      continue;
    }

    const baseWeight = pair.liquidityWeight ?? 1;
    if (!Number.isFinite(baseWeight) || baseWeight <= 0) {
      discardedPairsCount += 1;
      continue;
    }

    const callRelSpread = validateOptionLegQuote(
      pair.callMid,
      pair.callBid,
      pair.callAsk,
      maxRelativeSpread,
      requirePositiveBid,
    );
    const putRelSpread = validateOptionLegQuote(
      pair.putMid,
      pair.putBid,
      pair.putAsk,
      maxRelativeSpread,
      requirePositiveBid,
    );
    if (callRelSpread === null || putRelSpread === null) {
      discardedPairsCount += 1;
      continue;
    }

    const pairForward = pair.strike + (pair.callMid - pair.putMid) / discountFactor;
    if (!Number.isFinite(pairForward) || pairForward <= 0) {
      discardedPairsCount += 1;
      continue;
    }

    const totalRelSpread = callRelSpread + putRelSpread;
    const weight = baseWeight / (SPREAD_WEIGHT_EPS + totalRelSpread);
    if (!Number.isFinite(weight) || weight <= 0) {
      discardedPairsCount += 1;
      continue;
    }

    validEntries.push({
      strike: pair.strike,
      pairForward,
      weight,
      totalRelSpread,
    });
  }

  if (validEntries.length < minValidPairs) {
    return {
      forward: Number.NaN,
      validPairsCount: validEntries.length,
      usedPairsCount: 0,
      discardedPairsCount,
    };
  }

  let selected: readonly ValidParityEntry[] = validEntries;
  if (validEntries.length > nearAtmCount) {
    const allSortedForwards = validEntries
      .map((entry) => entry.pairForward)
      .sort((a, b) => a - b);
    const refForward = medianSorted(allSortedForwards);
    if (!Number.isFinite(refForward) || refForward <= 0) {
      return {
        forward: Number.NaN,
        validPairsCount: validEntries.length,
        usedPairsCount: 0,
        discardedPairsCount,
      };
    }

    selected = [...validEntries]
      .sort((a, b) => {
        const distA = Math.abs(Math.log(a.strike / refForward));
        const distB = Math.abs(Math.log(b.strike / refForward));
        if (distA !== distB) {
          return distA - distB;
        }
        if (a.totalRelSpread !== b.totalRelSpread) {
          return a.totalRelSpread - b.totalRelSpread;
        }
        return a.strike - b.strike;
      })
      .slice(0, nearAtmCount);
  }

  let forward: number;
  if (method === 'median') {
    const sorted = selected.map((entry) => entry.pairForward).sort((a, b) => a - b);
    forward = medianSorted(sorted);
  } else {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const entry of selected) {
      weightedSum += entry.weight * entry.pairForward;
      weightTotal += entry.weight;
    }
    forward = weightTotal > 0 ? weightedSum / weightTotal : Number.NaN;
  }

  if (!Number.isFinite(forward) || forward <= 0) {
    return {
      forward: Number.NaN,
      validPairsCount: validEntries.length,
      usedPairsCount: 0,
      discardedPairsCount,
    };
  }

  return {
    forward,
    validPairsCount: validEntries.length,
    usedPairsCount: selected.length,
    discardedPairsCount,
  };
}

/**
 * Estima el precio Forward implícito `F(T) = K + (C - P) / exp(-rT)` mediante
 * paridad Put-Call sobre los pares válidos más cercanos al dinero.
 *
 * Devuelve `Number.NaN` explícitamente si `discountFactor <= 0` o no finita,
 * si no hay suficientes pares válidos o si los spreads son inválidos (jamás
 * recurre a `spot` como respaldo).
 */
export function inferForwardFromParity(
  pairs: readonly ParityOptionPair[],
  discountFactor: number,
  options?: InferForwardOptions,
): number {
  return inferForwardFromParityDetailed(pairs, discountFactor, options).forward;
}

/**
 * Calcula la tasa de dividendo continuo implícita `q(T)` consistente con un
 * forward `F(T) = S * exp((r - q) * T)`:
 * `q = r - ln(F(T) / S) / T`.
 *
 * Nota: `q` puede resultar negativa legítimamente (p. ej. acciones hard-to-borrow).
 * Devuelve `Number.NaN` ante entradas no finitas o `spot, forward, timeToExpiry <= 0`.
 */
export function impliedDividendYieldFromForward(input: ImpliedDividendYieldInput): number;
export function impliedDividendYieldFromForward(
  spot: number,
  forward: number,
  timeToExpiry: number,
  rate: number,
): number;
export function impliedDividendYieldFromForward(
  spotOrInput: number | ImpliedDividendYieldInput,
  forwardArg?: number,
  timeToExpiryArg?: number,
  rateArg?: number,
): number {
  const spot = typeof spotOrInput === 'number' ? spotOrInput : spotOrInput.spot;
  const forward = typeof spotOrInput === 'number' ? (forwardArg ?? Number.NaN) : spotOrInput.forward;
  const timeToExpiry =
    typeof spotOrInput === 'number' ? (timeToExpiryArg ?? Number.NaN) : spotOrInput.timeToExpiry;
  const rate = typeof spotOrInput === 'number' ? (rateArg ?? Number.NaN) : spotOrInput.rate;

  if (
    !Number.isFinite(spot) ||
    spot <= 0 ||
    !Number.isFinite(forward) ||
    forward <= 0 ||
    !Number.isFinite(timeToExpiry) ||
    timeToExpiry <= 0 ||
    !Number.isFinite(rate)
  ) {
    return Number.NaN;
  }

  const ratioDiff = (forward - spot) / spot;
  const logForwardSpot =
    Math.abs(ratioDiff) <= 0.25 ? Math.log1p(ratioDiff) : Math.log(forward / spot);
  const q = rate - logForwardSpot / timeToExpiry;
  return Number.isFinite(q) ? q : Number.NaN;
}
