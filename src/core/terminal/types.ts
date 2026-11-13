/**
 * Tipos puros e inmutables para el motor de Volatilidad Realizada Intradía,
 * Orquestador de Confluencia Multi-Capa (Bloques A + B + C) y Serializador JSON-safe
 * (Pieza 12).
 *
 * Convenciones estrictas (`AGENTS.md` / `SPEC.md`):
 *  - Timestamps siempre en segundos UTC enteros (`time`, `asOfUtcSec`).
 *  - En la capa matemática (`realizedVol.ts`, `confluenceOrchestrator.ts`),
 *    todo valor no calculable se representa con `Number.NaN` y estado explícito.
 *  - En la capa de frontera (`serializer.ts`), todo número no finito se convierte
 *    explícitamente a `null` JSON tipado mediante `JsonSafe<T>`.
 */

import type {
  MacroVolatilityRegimeResult,
  MarketBreadthResult,
} from '../microstructure/breadthMacro.js';
import type { CvdAbsorptionResult } from '../microstructure/cvdAbsorption.js';
import type {
  RsiDivergenceResult,
  SmtDivergenceResult,
} from '../microstructure/divergences.js';
import type { MtfStructureResult } from '../microstructure/mtfStructure.js';
import type { OpeningAuctionResult } from '../microstructure/types.js';
import type { DealerExposureResult } from '../options/exposure.js';
import type { VolSliceMetrics } from '../options/volMetrics.js';

export type TerminalDataStatus = 'OK' | 'NO_DATA';
export type EnvelopeStatus = 'OK' | 'PARTIAL' | 'NO_DATA';

export type PillarId =
  | 'mtf'
  | 'optionsPositioning'
  | 'openingAuction'
  | 'cvdAbsorption'
  | 'divergences'
  | 'breadthMacro';

export type GammaRegime =
  | 'POSITIVE_GAMMA'
  | 'NEGATIVE_GAMMA'
  | 'TRANSITION_ZONE'
  | 'NO_DATA';

export type DirectionalBias =
  | 'STRONG_BULLISH'
  | 'BULLISH'
  | 'NEUTRAL'
  | 'BEARISH'
  | 'STRONG_BEARISH'
  | 'NO_DATA';

export type KeyLevelName =
  | 'CallWall'
  | 'PutWall'
  | 'GammaFlip'
  | 'PMH'
  | 'PML'
  | 'ON_POC'
  | 'ON_VAH'
  | 'ON_VAL'
  | 'IBH'
  | 'IBL'
  | 'PDH'
  | 'PDL'
  | 'PDC'
  | 'SMA200_1D'
  | 'SMA50_4H'
  | 'EMA21_15M'
  | 'HMA55_5M';

export type KeyLevelSource = 'OPTIONS' | 'OPENING_AUCTION' | 'MTF' | 'REFERENCE';

export interface IntradayRealizedVolOptions {
  /** Instante de evaluación sin look-ahead en segundos UTC enteros (`bar.time + 300 <= asOfUtcSec`). */
  readonly asOfUtcSec: number;
  /** Duración fija de barra en segundos; debe ser `300` (5m). */
  readonly barSeconds?: number;
  /** Mínimo de retornos logarítmicos intra-sesión válidos exigidos (por defecto `77`). */
  readonly minReturns?: number;
  /** Ventana rolling opcional de las últimas `K` observaciones intra-sesión (`>= minReturns`). */
  readonly maxReturns?: number;
}

export interface SessionReturnStats {
  readonly sessionDate: string;
  readonly rthBarCount: number;
  readonly returnsCount: number;
}

export interface IntradayRealizedVolResult {
  readonly status: TerminalDataStatus;
  readonly asOfUtcSec: number;
  readonly barSeconds: number;
  readonly annualizationFactor: number;
  readonly closedRthBarCount: number;
  readonly excludedFutureCount: number;
  readonly excludedNonRthCount: number;
  readonly sessionCount: number;
  readonly totalAvailableReturns: number;
  readonly returnsCount: number;
  readonly meanLogReturn: number;
  readonly realizedVolAnnualized: number;
  readonly rvCenteredAnnualized: number;
  readonly sessions: readonly SessionReturnStats[];
}

export interface ReferencePriceLevelsInput {
  readonly pdh?: number;
  readonly pdl?: number;
  readonly pdc?: number;
}

export interface PillarWeights {
  readonly mtf: number;
  readonly optionsPositioning: number;
  readonly openingAuction: number;
  readonly cvdAbsorption: number;
  readonly divergences: number;
  readonly breadthMacro: number;
}

export interface TerminalConfluenceOptions {
  /** Instante de evaluación sin look-ahead en segundos UTC enteros (opcional si se infiere de entradas). */
  readonly asOfUtcSec?: number;
  /** Pesos opcionales por pilar (por defecto `1.0` en cada uno de los 6 pilares). */
  readonly weights?: Partial<PillarWeights>;
  /** Ventana OLS de pendiente de `adLine` en barras cerradas (entero `>= 2`, por defecto `5`). */
  readonly adSlopeWindow?: number;
  /** IV 30d explícita en decimal; si no se especifica se toma `volMetrics.ivAtm` cuando existe. */
  readonly iv30dOverride?: number;
}

export interface TerminalConfluenceInputs {
  readonly mtf?: MtfStructureResult | null;
  readonly exposure?: DealerExposureResult | null;
  readonly volMetrics?: VolSliceMetrics | null;
  readonly openingAuction?: OpeningAuctionResult | null;
  readonly cvdAbsorption?: CvdAbsorptionResult | null;
  readonly rsiDivergences?: RsiDivergenceResult | null;
  readonly smtDivergences?: SmtDivergenceResult | null;
  readonly breadth?: MarketBreadthResult | null;
  readonly macroVol?: MacroVolatilityRegimeResult | null;
  readonly realizedVol?: IntradayRealizedVolResult | null;
  readonly referenceLevels?: ReferencePriceLevelsInput | null;
  readonly options?: TerminalConfluenceOptions;
}

export interface PillarAssessment {
  readonly id: PillarId;
  readonly label: string;
  readonly status: TerminalDataStatus;
  readonly score: number;
  readonly weight: number;
  readonly weightedContribution: number;
  readonly summaryCode: string;
}

export interface TerminalKeyLevel {
  readonly name: KeyLevelName;
  readonly source: KeyLevelSource;
  readonly price: number;
}

export interface TerminalAuxiliaryMetrics {
  readonly spot: number;
  readonly netDollarGex: number;
  readonly netDex: number;
  readonly gammaFlipSpot: number;
  readonly callWallStrike: number;
  readonly putWallStrike: number;
  readonly expectedMove: number;
  readonly expectedMovePct: number;
  readonly iv30d: number;
  readonly riskReversal25: number;
  readonly butterfly25: number;
  readonly realizedVolAnnualized: number;
  readonly rvCenteredAnnualized: number;
  readonly vrpSpread: number;
  readonly vixLevel: number;
  readonly vixSlope: number;
  readonly cboeSkewLevel: number;
  readonly vixRegime: MacroVolatilityRegimeResult['vixRegime'] | 'NO_DATA';
  readonly tailRiskAlert: boolean | null;
  readonly positionSizeMultiplier: number;
  readonly adLineSlope: number;
  readonly latestAdLine: number;
  readonly currentSessionCvd: number;
  readonly latestRsi: number;
}

export interface TerminalConfluenceSnapshot {
  readonly status: TerminalDataStatus;
  readonly asOfUtcSec: number | null;
  readonly activePillarsCount: number;
  readonly totalPillarsCount: number;
  readonly totalActiveWeight: number;
  readonly confluenceScore: number;
  readonly directionalBias: DirectionalBias;
  readonly gammaRegime: GammaRegime;
  readonly pillars: readonly PillarAssessment[];
  readonly pillarMap: Readonly<Record<PillarId, PillarAssessment>>;
  readonly keyLevels: readonly TerminalKeyLevel[];
  readonly metrics: TerminalAuxiliaryMetrics;
}

export type JsonSafe<T> = T extends number
  ? number | null
  : T extends string | boolean | null
    ? T
    : T extends undefined
      ? null
      : T extends readonly (infer U)[]
        ? readonly JsonSafe<U>[]
        : T extends object
          ? { readonly [K in keyof T]: JsonSafe<T[K]> }
          : never;

export interface SerializedMetadata {
  readonly symbol: string;
  readonly generatedAtUtcSec: number;
  readonly timeframe?: string;
  readonly sessionDate?: string;
  readonly asOfUtcSec?: number;
}

export interface TerminalSerializedEnvelope {
  readonly schemaVersion: '1.0.0';
  readonly envelopeStatus: EnvelopeStatus;
  readonly nonFiniteFieldCount: number;
  readonly nonFinitePaths: readonly string[];
  readonly metadata: JsonSafe<SerializedMetadata>;
  readonly snapshot: JsonSafe<TerminalConfluenceSnapshot>;
}
