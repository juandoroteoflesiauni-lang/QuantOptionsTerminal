/**
 * Pieza 50.3 — Guarda de integridad de cadenas de opciones.
 *
 * Función pura determinista (sin red, sin UI, sin mutar argumentos) que valida que la
 * mediana de los strikes finitos de una cadena sea coherente con la escala del spot del
 * subyacente activo. Evita el cruce AR:GGAL ↔ US:SPY (strikes 6.000–9.000 ARS vs. spot
 * ~600 USD) bloqueando el render de la cadena corrupta.
 */

export const DEFAULT_MIN_STRIKE_SPOT_RATIO = 0.25;
export const DEFAULT_MAX_STRIKE_SPOT_RATIO = 3.0;

export interface ChainIntegrityRowLike {
  readonly strike: number;
}

export type ChainIntegrityReason =
  | 'OK'
  | 'EMPTY_CHAIN'
  | 'INVALID_SPOT'
  | 'INVALID_STRIKES'
  | 'SCALE_MISMATCH';

export interface ChainIntegrityResult {
  readonly valid: boolean;
  readonly reason: ChainIntegrityReason;
  readonly medianStrike: number;
  readonly ratio: number;
  readonly validStrikeCount: number;
}

/**
 * Valida la coherencia de escala de `rows` contra `activeSpot`:
 *  - mediana exacta de strikes finitos y estrictamente positivos (par: promedio de los dos centrales);
 *  - `ratio = medianStrike / activeSpot` debe caer en `[minRatio, maxRatio]` (default `[0.25, 3.0]`).
 */
export function validateChainIntegrity(
  rows: readonly ChainIntegrityRowLike[],
  activeSpot: number,
  options?: { readonly minRatio?: number; readonly maxRatio?: number },
): ChainIntegrityResult {
  if (rows.length === 0) {
    return {
      valid: false,
      reason: 'EMPTY_CHAIN',
      medianStrike: Number.NaN,
      ratio: Number.NaN,
      validStrikeCount: 0,
    };
  }

  const sorted = rows
    .map((r) => r.strike)
    .filter((k) => Number.isFinite(k) && k > 0)
    .sort((a, b) => a - b);

  if (sorted.length === 0) {
    return {
      valid: false,
      reason: 'INVALID_STRIKES',
      medianStrike: Number.NaN,
      ratio: Number.NaN,
      validStrikeCount: 0,
    };
  }

  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const medianStrike =
    n % 2 === 1
      ? (sorted[mid] as number)
      : 0.5 * ((sorted[mid - 1] as number) + (sorted[mid] as number));

  if (!Number.isFinite(activeSpot) || activeSpot <= 0) {
    return {
      valid: false,
      reason: 'INVALID_SPOT',
      medianStrike,
      ratio: Number.NaN,
      validStrikeCount: n,
    };
  }

  const minRatio = options?.minRatio ?? DEFAULT_MIN_STRIKE_SPOT_RATIO;
  const maxRatio = options?.maxRatio ?? DEFAULT_MAX_STRIKE_SPOT_RATIO;
  if (
    !Number.isFinite(minRatio) ||
    !Number.isFinite(maxRatio) ||
    minRatio >= maxRatio
  ) {
    return {
      valid: false,
      reason: 'INVALID_SPOT',
      medianStrike,
      ratio: Number.NaN,
      validStrikeCount: n,
    };
  }

  const ratio = medianStrike / activeSpot;
  if (ratio > maxRatio || ratio < minRatio) {
    return {
      valid: false,
      reason: 'SCALE_MISMATCH',
      medianStrike,
      ratio,
      validStrikeCount: n,
    };
  }

  return {
    valid: true,
    reason: 'OK',
    medianStrike,
    ratio,
    validStrikeCount: n,
  };
}
