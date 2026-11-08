/**
 * Tipos de la capa de datos (SPEC punto 6).
 *
 * Los normalizadores convierten las respuestas CRUDAS de los proveedores al
 * formato único de barra del proyecto. `time` siempre son segundos UTC enteros:
 * la conversión desde milisegundos ocurre SOLO en los normalizadores.
 */

import type { Bar } from '../core/types.js';

export type DataProvider = 'massive' | 'bingx';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1D';

/** Causas de descarte de una fila cruda. */
export type DiscardCause =
  | 'malformedRow'
  | 'invalidTime'
  | 'nonFinite'
  | 'invalidPrice'
  | 'highBelowLow'
  | 'invalidVolume'
  | 'duplicate';

/**
 * Descarte individual.
 *
 * `time` son segundos UTC cuando la fila tenía un tiempo en milisegundos
 * válido; es null cuando el tiempo no era convertible (o la fila no tenía
 * forma de objeto/array).
 */
export interface DiscardRecord {
  readonly cause: DiscardCause;
  readonly time: number | null;
}

export type DiscardCounts = Readonly<Record<DiscardCause, number>>;

/** Hueco detectado entre dos barras consecutivas. No se rellena nunca. */
export interface BarGap {
  readonly previousTime: number;
  readonly nextTime: number;
  readonly diffSeconds: number;
  readonly missingBars: number;
  readonly sessionKey: string;
}

/**
 * `performed`: se buscaron huecos dentro de la sesión.
 * `skippedDaily`: las barras diarias no tienen una rejilla calendario fija
 * (fines de semana y feriados), así que no se reportan huecos.
 */
export type GapDetection = 'performed' | 'skippedDaily';

export interface FormingBarInfo {
  readonly time: number;
  readonly reason: 'intervalContainsNow' | 'closeTimeContainsServerTime';
}

export interface ProviderError {
  readonly code: number;
  readonly message: string;
}

export interface NormalizeOptions {
  /** Segundos de la temporalidad; necesario para detectar huecos y formación. */
  readonly barSeconds: number;
  /** Instante actual en segundos UTC. Solo se usa para reportar la barra en formación. */
  readonly now?: number;
}

export interface BaseNormalizeReport<P extends DataProvider> {
  readonly provider: P;
  readonly received: number;
  readonly accepted: number;
  readonly discarded: number;
  readonly discardCounts: DiscardCounts;
  readonly discards: readonly DiscardRecord[];
  readonly reordered: boolean;
  readonly gaps: readonly BarGap[];
  readonly gapDetection: GapDetection;
  readonly formingBar: FormingBarInfo | null;
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
}

export interface MassiveNormalizeReport extends BaseNormalizeReport<'massive'> {
  /** Barras aceptadas sin campo `vw` (ausente o null). */
  readonly vwMissing: number;
  /** Barras aceptadas con `vw === 0`. */
  readonly vwZero: number;
  /** Barras aceptadas con `vw` presente pero no finito; se omite el campo. */
  readonly vwNonFinite: number;
  /** Barras aceptadas cuyo `vw` queda fuera de [low, high]. */
  readonly vwOutsideRange: number;
}

export interface BingxNormalizeReport extends BaseNormalizeReport<'bingx'> {
  /** Barras con volumen > 0 y quoteVolume finito: candidato calculable. */
  readonly vwCandidateBars: number;
  /** Barras con volumen > 0 y quoteVolume ausente o no finito. */
  readonly vwCandidateMissing: number;
  /** Barras con volumen === 0: no hay candidato posible. */
  readonly vwCandidateZeroVolume: number;
  /** Candidatos quoteVolume / volume fuera de [low, high]. */
  readonly vwCandidateOutsideRange: number;
  /**
   * La muestra real de BingX falló la verificación del SPEC punto 6: en 1m,
   * 185 de 3.445 barras quedaron fuera de [low, high]. Por eso NUNCA se expone
   * `vw` en las barras normalizadas de BingX.
   */
  readonly vwExposed: false;
}

export interface MassiveNormalizeResult {
  readonly bars: readonly Bar[];
  readonly report: MassiveNormalizeReport;
}

export interface BingxNormalizeResult {
  readonly bars: readonly Bar[];
  readonly report: BingxNormalizeReport;
}

/** Respuesta HTTP mínima que consume el cargador. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

/** Inyección de red: permite tests deterministas sin tocar la red real. */
export type FetchFn = (url: string) => Promise<FetchResponse>;

export type StopReason =
  | 'targetReached'
  | 'noMorePages'
  | 'maxPages'
  | 'providerError'
  | 'malformedResponse';

export interface LoaderFields {
  /** visibleBars + warmupBars. */
  readonly requestedBars: number;
  readonly visibleBars: number;
  readonly warmupBars: number;
  /** Barras válidas tras excluir la barra en formación, antes de recortar. */
  readonly normalizedBars: number;
  /** Barras válidas eliminadas por quedar fuera del buffer solicitado. */
  readonly trimmedBars: number;
  /** La barra en formación se excluyó del resultado. */
  readonly formingExcluded: boolean;
  /** Número de peticiones HTTP realizadas. */
  readonly pages: number;
  readonly firstTime: number | null;
  readonly lastTime: number | null;
  readonly stoppedReason: StopReason;
}

export interface MassiveLoadBarsReport
  extends MassiveNormalizeReport,
    LoaderFields {}

export interface BingxLoadBarsReport
  extends BingxNormalizeReport,
    LoaderFields {}

export type LoadBarsReport = MassiveLoadBarsReport | BingxLoadBarsReport;

export interface LoadBarsResult {
  readonly bars: readonly Bar[];
  readonly visibleStart: number;
  readonly report: LoadBarsReport;
}
