/**
 * Pieza 50.2: binding estricto de TIR y régimen al vencimiento activo. Funciones puras
 * (sin red, DOM ni mutación de argumentos) que impiden heredar la tasa bloqueada o el
 * banner `Riesgo 0DTE / Short Gamma` del front cuando el usuario selecciona 30 DTE,
 * 60 DTE o LEAPS. Lo no calculable permanece `NaN` y la UI muestra `—`.
 */

import { evaluateShortPremiumBreaker } from '../../../../src/core/options/zeroDteFixes.js';
import {
  computeActiveExpiryVrpAndRegime,
  type OperativeRegimeCode,
} from '../../../../src/core/options/volAnalyticsSuite.js';

export interface ActiveExpiryHeaderTirInput {
  readonly activeDte: number;
  readonly activeExpiryId: string | null;
  readonly activeParity: {
    readonly expiryCode?: string | null;
    readonly medianMidTeaPct?: number | null;
    readonly impliedRateStatus?: string | null;
  } | null;
  /** `syntheticRates` EXCLUSIVAMENTE del vencimiento activo (o del front si el activo ES el front). */
  readonly activeExpirySyntheticRates: {
    readonly medianImpliedTna?: number | null;
    readonly impliedRateStatus?: string | null;
  } | null;
}

export interface ActiveExpiryHeaderTirResult {
  readonly blockedShortDte: boolean;
  readonly tirPct: number;
}

/**
 * TIR del encabezado evaluada EXCLUSIVAMENTE sobre el DTE del vencimiento activo.
 * `blockedShortDte = activeDte < 3` (nunca heredado del front); la paridad solo se usa
 * si corresponde exactamente al `activeExpiryId`; el fallback sintético usa la tasa del
 * propio vencimiento y, si no es calculable, devuelve `NaN` (UI `—`).
 */
export function evaluateActiveExpiryHeaderTir(
  input: ActiveExpiryHeaderTirInput,
): ActiveExpiryHeaderTirResult {
  const blockedShortDte = Number.isFinite(input.activeDte) && input.activeDte < 3;
  if (blockedShortDte) {
    return { blockedShortDte: true, tirPct: Number.NaN };
  }
  const parity = input.activeParity;
  const parityMatchesActive =
    parity !== null &&
    input.activeExpiryId !== null &&
    parity.expiryCode === input.activeExpiryId &&
    typeof parity.medianMidTeaPct === 'number' &&
    Number.isFinite(parity.medianMidTeaPct);
  if (parityMatchesActive && parity !== null && typeof parity.medianMidTeaPct === 'number') {
    return { blockedShortDte: false, tirPct: parity.medianMidTeaPct };
  }
  const syntheticTna = input.activeExpirySyntheticRates?.medianImpliedTna;
  if (typeof syntheticTna === 'number' && Number.isFinite(syntheticTna)) {
    return { blockedShortDte: false, tirPct: syntheticTna * 100 };
  }
  return { blockedShortDte: false, tirPct: Number.NaN };
}

export interface ActiveExpiryRegimeBreakerInput {
  readonly activeDte: number;
  readonly activeExpiryId: string | null;
  readonly spot: number;
  readonly activeExposureSummary: {
    readonly putWallStrike: number | null;
    readonly netGex: number | null;
  } | null;
  /** Régimen precomputado SOLO si pertenece al vencimiento activo (`expiryCode` + `daysToExpiry`). */
  readonly precomputedRegimeForActiveExpiry: OperativeRegimeCode | null;
  readonly fallbackRegimeInput: {
    readonly ivAtmActiveExpiryPct: number | null;
    readonly rvReferencePct: number | null;
    readonly rvReferenceLabel: string;
  };
}

export interface ActiveExpiryRegimeBreakerResult {
  readonly blocked: boolean;
  readonly autoSelectCreditMode: boolean;
  readonly baseRegimeCode: OperativeRegimeCode;
  readonly activeRegimeCode: OperativeRegimeCode;
}

/**
 * Circuit breaker de venta de prima y régimen operativo del vencimiento activo. Usa la
 * exposición del propio vencimiento (`exposureSummaryByExpiry`) y recalcula el régimen
 * con su `daysToExpiry` cuando el precomputado no pertenece a esa fecha o es incoherente
 * con el breaker (p. ej. `NO_SHORT_PREMIUM_RISK` heredado del front 0DTE).
 */
export function evaluateActiveExpiryRegimeAndBreaker(
  input: ActiveExpiryRegimeBreakerInput,
): ActiveExpiryRegimeBreakerResult {
  const breaker = evaluateShortPremiumBreaker({
    dte: input.activeDte,
    spot: input.spot,
    putWall: input.activeExposureSummary?.putWallStrike ?? null,
    netGex: input.activeExposureSummary?.netGex ?? Number.NaN,
  });
  const precomputed = input.precomputedRegimeForActiveExpiry;
  const precomputedCoherent =
    precomputed !== null && !(precomputed === 'NO_SHORT_PREMIUM_RISK' && !breaker.blocked);
  const baseRegimeCode: OperativeRegimeCode = precomputedCoherent
    ? (precomputed as OperativeRegimeCode)
    : computeActiveExpiryVrpAndRegime({
        expiryCode: input.activeExpiryId,
        daysToExpiry: input.activeDte,
        ivAtmActiveExpiryPct: input.fallbackRegimeInput.ivAtmActiveExpiryPct,
        sameExpiryFallbackIvAtmPct: input.fallbackRegimeInput.ivAtmActiveExpiryPct,
        rvReferencePct: input.fallbackRegimeInput.rvReferencePct,
        rvReferenceLabel: input.fallbackRegimeInput.rvReferenceLabel,
        historicalRvSeriesPct: [],
        spot: input.spot,
        putWallStrike: input.activeExposureSummary?.putWallStrike ?? null,
        netGex: input.activeExposureSummary?.netGex ?? null,
      }).operativeRegime.code;
  const activeRegimeCode: OperativeRegimeCode =
    breaker.blocked && baseRegimeCode === 'VENTA_PRIMA_CUBIERTA'
      ? 'NO_SHORT_PREMIUM_RISK'
      : baseRegimeCode;
  return {
    blocked: breaker.blocked,
    autoSelectCreditMode: breaker.autoSelectCreditMode,
    baseRegimeCode,
    activeRegimeCode,
  };
}
