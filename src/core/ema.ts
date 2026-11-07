/**
 * EMA (9, 21, 50, 200) sobre el cierre (SPEC punto 2).
 *
 * Todas las funciones de este módulo son puras: no mutan los argumentos,
 * no leen estado externo y no aplican valores de respaldo que oculten NaN.
 */

export const EMA_PERIODS = [9, 21, 50, 200] as const;

export type EmaPeriod = (typeof EMA_PERIODS)[number];

export type EmaSuite = Record<EmaPeriod, number[]>;

/**
 * Valida que el periodo sea un entero >= 1.
 *
 * Cualquier otro valor (0, negativos, fraccionarios, NaN, Infinity) lanza error:
 * no existe una EMA válida para esos periodos y devolver NaN ocultaría un error
 * de uso en lugar de señalarlo.
 */
function assertValidPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`EMA period must be an integer >= 1 (got ${String(period)})`);
  }
}

function emaAlpha(period: number): number {
  return 2 / (period + 1);
}

/**
 * Calcula la EMA de una serie de cierres con semilla SMA.
 *
 * - Índices 0..period-2: NaN (aún no hay suficientes cierres para la semilla).
 * - Índice period-1: SMA de los primeros `period` cierres.
 * - Índices siguientes: ema = alpha * close + (1 - alpha) * emaPrevio,
 *   con alpha = 2 / (period + 1).
 *
 * Decisión sobre cierres no finitos: si un cierre es NaN, +Infinity o -Infinity,
 * ese índice y TODOS los siguientes devuelven NaN. No se arrastra el último valor
 * válido ni se reinicia la EMA, porque cualquiera de esas alternativas produciría
 * una serie numéricamente falsa. Si el cierre no finito cae dentro de la semilla,
 * la semilla tampoco es construible y toda la serie queda en NaN.
 *
 * No muta `closes`.
 */
export function calculateEma(closes: readonly number[], period: number): number[] {
  assertValidPeriod(period);

  const result = new Array<number>(closes.length);
  result.fill(Number.NaN);

  if (closes.length < period) {
    return result;
  }

  // Semilla: SMA explícita de los primeros `period` cierres.
  let seedSum = 0;
  for (let i = 0; i < period; i++) {
    const close = closes[i];
    if (close === undefined || !Number.isFinite(close)) {
      // Semilla no construible: todos los índices quedan en NaN.
      return result;
    }
    seedSum += close;
  }

  const alpha = emaAlpha(period);
  const oneMinusAlpha = 1 - alpha;
  let ema = seedSum / period;
  result[period - 1] = ema;

  for (let i = period; i < closes.length; i++) {
    const close = closes[i];
    if (close === undefined || !Number.isFinite(close)) {
      // Este índice y todos los siguientes quedan en NaN (ya inicializados).
      break;
    }
    ema = alpha * close + oneMinusAlpha * ema;
    result[i] = ema;
  }

  return result;
}

/**
 * Calcula las cuatro series EMA requeridas por el SPEC: 9, 21, 50 y 200.
 * Cada serie se calcula con `calculateEma`, incluida la regla de NaN.
 */
export function computeEmaSuite(closes: readonly number[]): EmaSuite {
  return {
    9: calculateEma(closes, 9),
    21: calculateEma(closes, 21),
    50: calculateEma(closes, 50),
    200: calculateEma(closes, 200),
  };
}

/**
 * Proyecta la EMA en vivo de la barra actual a partir de la EMA de la última
 * barra CERRADA:
 *
 *   emaVivo = alpha * precioVivo + (1 - alpha) * emaUltimaBarraCerrada
 *
 * IMPORTANTE: `lastClosedEma` debe ser SIEMPRE la EMA de la última barra cerrada,
 * nunca la EMA proyectada del tick anterior. Encadenar la proyección tick a tick
 * aplicaría alpha repetidamente al mismo precio y haría que la EMA dependiera de
 * cuántos ticks recibió la barra, no del precio. La función es pura y no guarda
 * estado, de modo que el motor puede llamarla con cada tick partiendo siempre del
 * mismo valor cerrado.
 *
 * Si `lastClosedEma` o `livePrice` no son finitos, devuelve NaN (no hay proyección
 * calculable). Un periodo inválido lanza error.
 */
export function projectLiveEma(
  lastClosedEma: number,
  livePrice: number,
  period: number,
): number {
  assertValidPeriod(period);
  if (!Number.isFinite(lastClosedEma) || !Number.isFinite(livePrice)) {
    return Number.NaN;
  }
  const alpha = emaAlpha(period);
  return alpha * livePrice + (1 - alpha) * lastClosedEma;
}

/**
 * Peso residual de la semilla SMA después de `barsAfterSeed` barras:
 *
 *   (1 - alpha)^barsAfterSeed, con alpha = 2 / (period + 1)
 *
 * Sirve para cuantificar cuánto influye todavía la semilla en la EMA.
 * `barsAfterSeed` debe ser un entero >= 0; en caso contrario lanza error.
 */
export function emaWarmupWeight(period: number, barsAfterSeed: number): number {
  assertValidPeriod(period);
  if (!Number.isInteger(barsAfterSeed) || barsAfterSeed < 0) {
    throw new Error(
      `barsAfterSeed must be an integer >= 0 (got ${String(barsAfterSeed)})`,
    );
  }
  const alpha = emaAlpha(period);
  return Math.pow(1 - alpha, barsAfterSeed);
}
