/**
 * Pieza 50.5 (Bloque 1) — Inicio de la ventana histórica REST FMP/Tradier.
 *
 * Función pura, sin red ni mutación: traduce un objetivo de barras
 * (`targetBars`, el `visibleBars` de `/api/bars`) al inicio `fromUtcSec` de
 * una solicitud `from/to` en segundos UTC. Antes el runtime usaba
 * `visibleBars * barSeconds + 14 días`, que en `1D` entregaba del orden de
 * 870 ruedas por cada 1.250 pedidas.
 *
 * Densidad de barras útiles por sesión, derivada del horario y de los buckets
 * reales de cada adaptador más el filtro RTH posterior del runtime:
 *  - Sesión extendida 04:00–20:00 ET (960 minutos): 960/192/64/16/4 barras por
 *    sesión para 1m/5m/15m/1h/4h. FMP las entrega nativas en su rejilla ET;
 *    Tradier pide 15m y agrega por muro ET (`aggregateTradierBars`), con el
 *    mismo número de buckets finales.
 *  - RTH 09:30–16:00 ET (390 minutos): 390/78/26 para 1m/5m/15m. `1h` RTH son
 *    7 ventanas (FMP nativa anclada a 09:30; Tradier agrupa 15m en 09:00…15:00
 *    ET). `4h` RTH son 2 (Tradier agrupa por floor a 240 min: 08:00 y 12:00) y
 *    hoy es inalcanzable porque `getBars` desactiva `rthOnly` para `4h`
 *    (siempre sesión extendida); se mantiene como valor defensivo.
 *  - `1D`: una barra por rueda (apertura 00:00 ET en ambos adaptadores).
 *
 * Conversión a calendario con el mismo criterio de `massiveLookbackDays`
 * (loader.ts): margen del 3% sobre el objetivo, factor sesiones→días
 * `365.25/250` y 10 días finales de margen.
 *
 * Un objetivo o instante no calculable devuelve `NaN` (nada de valores de
 * respaldo).
 */

import { isTimeframe } from './timeframes.js';
import type { Timeframe } from './types.js';

export type RestHistoricalProvider = 'FMP_ENTERPRISE_REST' | 'TRADIER_REST';

export interface RestHistoricalWindowInput {
  /** Fin de la ventana (normalmente `nowSec` del runtime). */
  readonly toUtcSec: number;
  readonly provider: RestHistoricalProvider;
  readonly timeframe: Timeframe;
  /** Sesión efectiva: `true` cubre 04:00–20:00 ET; `false` solo RTH. */
  readonly includeExtended: boolean;
  /** Barras visibles pedidas (sin warm-up en este bloque). */
  readonly targetBars: number;
}

interface RestProviderDensity {
  readonly extended: Readonly<Record<Timeframe, number>>;
  readonly rth: Readonly<Record<Timeframe, number>>;
}

const SECONDS_PER_DAY = 86_400;
const TARGET_MARGIN = 1.03;
const SESSIONS_PER_CALENDAR_YEAR = 365.25 / 250;

const FMP_BARS_PER_SESSION: RestProviderDensity = Object.freeze({
  extended: Object.freeze({
    '1m': 960,
    '5m': 192,
    '15m': 64,
    '1h': 16,
    '4h': 4,
    '1D': 1,
  }),
  rth: Object.freeze({
    '1m': 390,
    '5m': 78,
    '15m': 26,
    '1h': 7,
    '4h': 2,
    '1D': 1,
  }),
});

const TRADIER_BARS_PER_SESSION: RestProviderDensity = Object.freeze({
  extended: Object.freeze({
    '1m': 960,
    '5m': 192,
    '15m': 64,
    '1h': 16,
    '4h': 4,
    '1D': 1,
  }),
  rth: Object.freeze({
    '1m': 390,
    '5m': 78,
    '15m': 26,
    '1h': 7,
    '4h': 2,
    '1D': 1,
  }),
});

function isRestHistoricalProvider(value: string): value is RestHistoricalProvider {
  return value === 'FMP_ENTERPRISE_REST' || value === 'TRADIER_REST';
}

/** Barras por sesión completa del adaptador; `NaN` si la entrada no es válida. */
export function barsPerSessionForRestProvider(
  provider: RestHistoricalProvider,
  timeframe: Timeframe,
  includeExtended: boolean,
): number {
  if (!isRestHistoricalProvider(provider) || !isTimeframe(timeframe)) {
    return Number.NaN;
  }
  if (typeof includeExtended !== 'boolean') {
    return Number.NaN;
  }
  const density = provider === 'TRADIER_REST' ? TRADIER_BARS_PER_SESSION : FMP_BARS_PER_SESSION;
  const value = (includeExtended ? density.extended : density.rth)[timeframe];
  return Number.isFinite(value) && value > 0 ? value : Number.NaN;
}

/**
 * Días calendario de lookback para cubrir `targetBars` con `barsPerSession`.
 *
 * Reproduce el criterio diario de `massiveLookbackDays` para cualquier
 * densidad: `ceil(objetivo × 1.03 / barrasPorSesión × 365.25/250) + 10`.
 */
export function restHistoricalLookbackDays(
  targetBars: number,
  barsPerSession: number,
): number {
  if (!Number.isInteger(targetBars) || targetBars <= 0) {
    return Number.NaN;
  }
  if (!Number.isFinite(barsPerSession) || barsPerSession <= 0) {
    return Number.NaN;
  }
  const sessionsNeeded = (targetBars * TARGET_MARGIN) / barsPerSession;
  return Math.ceil(sessionsNeeded * SESSIONS_PER_CALENDAR_YEAR) + 10;
}

/** Inicio UTC de la ventana histórica; `NaN` si la entrada no es válida. */
export function restHistoricalFromUtcSec(input: RestHistoricalWindowInput): number {
  if (!Number.isInteger(input.toUtcSec) || input.toUtcSec <= 0) {
    return Number.NaN;
  }
  const barsPerSession = barsPerSessionForRestProvider(
    input.provider,
    input.timeframe,
    input.includeExtended,
  );
  const lookbackDays = restHistoricalLookbackDays(input.targetBars, barsPerSession);
  if (!Number.isFinite(lookbackDays)) {
    return Number.NaN;
  }
  return input.toUtcSec - lookbackDays * SECONDS_PER_DAY;
}
