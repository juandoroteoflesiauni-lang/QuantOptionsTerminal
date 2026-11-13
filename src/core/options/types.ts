/**
 * Tipos puros para valoración europea (BSM y Black-76), griegas de 1er/2do
 * orden e inversión de volatilidad implícita (Pieza 2).
 *
 * Unidades estándar del motor:
 *  - `timeToExpiry`: años (ACT/365 por defecto: `segundos / 31_536_000`).
 *  - `volatility`: decimal anualizada (p. ej. `0.20` = 20 %).
 *  - `rate`, `dividendYield`: tasas continuas anualizadas decimales (`0.05` = 5 %).
 *  - `theta`: anual (`∂V/∂t`); `thetaDaily`: diaria (`theta / 365`).
 *  - `vega`: por `+1.00` (+100 pp de volatilidad); `vegaPer1Pct`: por `+0.01` (+1 %).
 *  - `vanna`: `∂Δ/∂σ`; `charm`: `-∂Δ/∂t = ∂Δ/∂T` (anual, años^-1).
 */

export type OptionContractType = 'call' | 'put';

export interface BsmInput {
  readonly spot: number;
  readonly strike: number;
  readonly timeToExpiry: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly volatility: number;
  readonly contractType: OptionContractType;
}

export interface Black76Input {
  readonly forward: number;
  readonly strike: number;
  readonly timeToExpiry: number;
  readonly rate: number;
  readonly volatility: number;
  readonly contractType: OptionContractType;
}

export interface OptionGreeksResult {
  readonly price: number;
  readonly delta: number;
  readonly gamma: number;
  readonly theta: number;
  readonly thetaDaily: number;
  readonly vega: number;
  readonly vegaPer1Pct: number;
  readonly rho: number;
  readonly vanna: number;
  readonly charm: number;
}

export interface ImpliedVolSolverOptions {
  /** Límite inferior del bracketing de volatilidad. Por defecto `1e-6` (puede bajar hasta `1e-9`). */
  readonly minVolatility?: number;
  /** Límite superior de volatilidad admitida. Por defecto `20.0` (2000 %). */
  readonly maxVolatility?: number;
  /** Tolerancia relativa en `sigma`. Por defecto `1e-12`. */
  readonly tolerance?: number;
  /** Máximo de iteraciones híbridas Newton + bisección. Por defecto `100`. */
  readonly maxIterations?: number;
  /** Vega mínima exigible en la raíz para descartar mesetas planas de subdesbordamiento. Por defecto `1e-15`. */
  readonly minVega?: number;
}

export interface SolveImpliedVolBsmInput {
  readonly spot: number;
  readonly strike: number;
  readonly timeToExpiry: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly contractType: OptionContractType;
  readonly price: number;
  readonly options?: ImpliedVolSolverOptions;
}

export interface SolveImpliedVolBlack76Input {
  readonly forward: number;
  readonly strike: number;
  readonly timeToExpiry: number;
  readonly rate: number;
  readonly contractType: OptionContractType;
  readonly price: number;
  readonly options?: ImpliedVolSolverOptions;
}

export interface ArbitrageBounds {
  readonly lower: number;
  readonly upper: number;
}
