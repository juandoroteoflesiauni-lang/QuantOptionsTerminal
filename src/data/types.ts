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
  | 'invalidOhlc'
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

/**
 * Hueco detectado entre dos barras consecutivas. No se rellena nunca.
 *
 * Se calcula sobre las barras cerradas del resultado normalizado ANTES del
 * filtro RTH (si `rthOnly`) y ANTES de que el cargador recorte el buffer,
 * así que `previousTime` y `nextTime` pueden referenciar barras fuera del
 * buffer devuelto.
 */
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
  /** Filas crudas recibidas del proveedor, sin validar. */
  readonly received: number;
  /**
   * Filas aceptadas tras la validación, INCLUIDA la barra en formación:
   * el normalizador la reporta pero no la elimina; excluirla decide la
   * capa de carga. Por eso `accepted` puede no coincidir con
   * `normalizedBars` del cargador aunque no haya descartes.
   */
  readonly accepted: number;
  /** received - accepted. */
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
  /**
   * Máxima desviación de `vw` fuera de [low, high], en % del propio `vw`:
   * max(low - vw, vw - high, 0) / vw * 100. Solo barras aceptadas con `vw`
   * finito y > 0; sin barras que se desvíen vale 0. En Massive es normal que
   * `vw` quede fuera de rango (p99 <= 0,56 % en 1m): se mide, no se descarta.
   */
  readonly vwMaxDeviationPct: number;
  /** Barras aceptadas con desviación de `vw` estrictamente superior al 2 %. */
  readonly vwBarsOver2Pct: number;
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
  /**
   * Cabeceras de la respuesta con nombre en minúsculas, cuando el
   * transporte las expone. Opcional: los `fetchFn` de tests no las
   * construyen. El cargador solo lee `retry-after` para reintentos 429.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Segundos de espera de `Retry-After`, ya interpretados por el
   * transporte; null/ausente si la cabecera falta o no es interpretable.
   */
  readonly retryAfterSeconds?: number | null;
}

/** Inyección de red: permite tests deterministas sin tocar la red real. */
export type FetchFn = (url: string) => Promise<FetchResponse>;

/** Espera inyectable para pausas y reintentos: tests sin temporizadores reales. */
export type SleepFn = (ms: number) => Promise<void>;

export type StopReason =
  | 'targetReached'
  | 'noMorePages'
  | 'maxPages'
  | 'providerError'
  | 'malformedResponse';

/**
 * Campos que añade el cargador al reporte del normalizador.
 *
 * Los campos de recorte describen el buffer devuelto; `gaps` y
 * `gapDetection` (heredados del normalizador) se calcularon sobre las
 * barras cerradas ANTES del filtro RTH (si `rthOnly`) y ANTES del recorte,
 * así que pueden referenciar barras fuera de `bars`, y
 * `firstTime`/`lastTime` no acotan su rango.
 */
export interface LoaderFields {
  /** visibleBars + warmupBars. */
  readonly requestedBars: number;
  readonly visibleBars: number;
  readonly warmupBars: number;
  /**
   * Barras cerradas tras excluir la barra en formación (y filtrar RTH si
   * `rthOnly`), antes de recortar. Difiere de `accepted` del normalizador
   * justo en esa barra: con 6 filas aceptadas y 1 en formación,
   * `normalizedBars` es 5.
   */
  readonly normalizedBars: number;
  /** Barras cerradas eliminadas por quedar fuera del buffer solicitado. */
  readonly trimmedBars: number;
  /** La barra en formación se excluyó del resultado. */
  readonly formingExcluded: boolean;
  /**
   * true si el buffer alcanzó `requestedBars` barras (cerradas, tras
   * excluir la formación y filtrar RTH si `rthOnly`). false significa
   * historia insuficiente para el calentamiento del SPEC punto 2: p. ej.
   * BingX 1D está limitado a ~380 días por carga (code 100204) y no puede
   * alcanzar el warmup por defecto de 1000.
   */
  readonly warmupSatisfied: boolean;
  /**
   * true si el buffer contiene la primera barra de la sesión que contiene
   * la primera barra visible: en Massive, la barra del mismo día ET que
   * abre a las 09:30 ET (la primera que acumula el VWAP de sesión); en
   * BingX, la barra que abre a las 00:00 UTC del día UTC. false si el
   * buffer está vacío o sin tramo visible, si esa barra no está en el
   * buffer (el buffer empieza a mitad de sesión o hay un hueco) o si la
   * temporalidad no tiene barra en el inicio de sesión (4h/1D en
   * acciones, 1D en cripto; con rthOnly + 1h la ventana de 09:30 agregada
   * existe): en esos casos el VWAP de sesión es parcial (límite del SPEC
   * punto 8).
   */
  readonly sessionStartCovered: boolean;
  /** Número de peticiones HTTP realizadas. */
  readonly pages: number;
  /** Apertura de la primera barra del buffer ya recortado; null si está vacío. */
  readonly firstTime: number | null;
  /** Apertura de la última barra del buffer ya recortado; null si está vacío. */
  readonly lastTime: number | null;
  /**
   * `targetReached`: buffer completo; `noMorePages`: el proveedor no dio
   * más datos; `maxPages`: se agotó el límite de peticiones;
   * `providerError`: error del proveedor; `malformedResponse`: respuesta
   * no interpretable (incluye un `next_url` rechazado).
   */
  readonly stoppedReason: StopReason;
}

export interface MassiveLoadBarsReport
  extends MassiveNormalizeReport,
    LoaderFields {
  /**
   * Solo rthOnly + 1h (ventanas agregadas desde 30m): ventanas cerradas
   * construidas con menos mitades de 30m que las esperadas, porque Massive
   * omite las barras sin operaciones. La ventana 15:30-16:00 espera una sola
   * mitad, así que su forma normal no cuenta como parcial. Ausente en el
   * resto de modos.
   */
  readonly aggregatedPartialBars?: number;
  /**
   * Solo rthOnly + 1h (ventanas agregadas desde 30m): mitades sin vw
   * utilizable (ausente, 0 o no finito) cuya contribución al promedio
   * ponderado usó el precio típico (high + low + close) / 3 de esa mitad.
   * Ausente en el resto de modos.
   */
  readonly aggregatedVwFallbackHalves?: number;
}

export interface BingxLoadBarsReport
  extends BingxNormalizeReport,
    LoaderFields {}

export type LoadBarsReport = MassiveLoadBarsReport | BingxLoadBarsReport;

export interface LoadBarsResult {
  readonly bars: readonly Bar[];
  readonly visibleStart: number;
  readonly report: LoadBarsReport;
}

/**
 * Opciones del cargador (Paso D).
 *
 * `fetchFn` se inyecta para que los tests no toquen la red. `apiKey` solo se
 * usa con Massive y nunca se escribe en el reporte.
 */
export interface LoadBarsOptions {
  readonly provider: DataProvider;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly visibleBars: number;
  /** Por defecto 1000, como exige el calentamiento del SPEC punto 2. */
  readonly warmupBars?: number;
  readonly fetchFn: FetchFn;
  /** Segundos UTC enteros. Si falta, se usa el reloj del sistema. */
  readonly now?: number;
  /** Máximo de peticiones HTTP. Por defecto 10. */
  readonly maxPages?: number;
  /**
   * Pausa fija aplicada antes de cada petición a partir de la segunda
   * (páginas y reintentos), en ms. Por defecto 0: sin pausa. Los espaciados
   * de 12 s del capturador y 13,001 s del smoke existían SOLO para el tope
   * de 5 peticiones/minuto del plan gratuito de Massive; con un plan de
   * pago no hacen falta.
   */
  readonly minRequestIntervalMs?: number;
  /**
   * Reintento opt-in ante HTTP 429 de la misma petición: máximo de reintentos
   * DESPUÉS del primer intento. Por defecto 0 (sin reintento). La espera
   * respeta `Retry-After` (`retryAfterSeconds` del transporte o su cabecera)
   * y, sin él, un backoff exponencial `retry429BaseDelayMs × 2^reintento`;
   * toda espera se recorta a `retry429MaxDelayMs`. Agotados los reintentos, la
   * última respuesta 429 se clasifica como hoy: `providerError` con code 429.
   */
  readonly retry429MaxAttempts?: number;
  /** Base del backoff exponencial ante 429, en ms. Por defecto 1000. */
  readonly retry429BaseDelayMs?: number;
  /** Tope de la espera de cada reintento ante 429, en ms. Por defecto 30000. */
  readonly retry429MaxDelayMs?: number;
  /** Espera usada para pausas y reintentos. Por defecto `setTimeout`. */
  readonly sleepFn?: SleepFn;
  /** Obligatoria para Massive. BingX spot es público. */
  readonly apiKey?: string;
  /** Origen alternativo (proxy o host distinto). */
  readonly baseUrl?: string;
  /**
   * Solo Massive. Si es true, el buffer devuelto solo contiene barras
   * cerradas cuya APERTURA está dentro de RTH (09:30 <= t < 16:00 ET,
   * lunes a viernes; SPEC puntos 3 y 9). El objetivo `requestedBars` y el
   * recorte se aplican sobre las barras RTH, y el lookback se escala a
   * barras RTH por día. `gaps` se sigue calculando sobre el buffer
   * cerrado completo, antes del filtro. Con BingX lanza error (en cripto
   * no hay RTH) y con 1D también (ninguna barra diaria abre dentro de
   * RTH).
   */
  readonly rthOnly?: boolean;
}
