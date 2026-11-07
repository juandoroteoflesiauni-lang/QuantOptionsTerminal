export interface WelfordState {
  readonly count: number;
  readonly cumWeight: number;
  readonly mean: number;
  readonly m2: number;
}

export interface WelfordOutput {
  readonly vwap: number;
  readonly variance: number;
  readonly stdDev: number;
  readonly cumVolume: number;
}

export interface WelfordStep {
  readonly state: WelfordState;
  readonly output: WelfordOutput;
}

export const INITIAL_WELFORD_STATE: WelfordState = Object.freeze({
  count: 0,
  cumWeight: 0,
  mean: 0,
  m2: 0,
});

export function createInitialWelfordState(): WelfordState {
  return INITIAL_WELFORD_STATE;
}

/**
 * Deriva la salida observable a partir del estado de Welford.
 * Si cumWeight <= 0 o no es finito, indica sin dato (vwap = NaN, variance = NaN, stdDev = NaN, cumVolume = 0).
 */
export function getWelfordOutput(state: WelfordState): WelfordOutput {
  if (state.cumWeight <= 0 || !Number.isFinite(state.cumWeight)) {
    return {
      vwap: Number.NaN,
      variance: Number.NaN,
      stdDev: Number.NaN,
      cumVolume: 0,
    };
  }

  const variance = Math.max(0, state.m2 / state.cumWeight);
  return {
    vwap: state.mean,
    variance,
    stdDev: Math.sqrt(variance),
    cumVolume: state.cumWeight,
  };
}

/**
 * Actualiza el cálculo de Welford ponderado con una nueva barra de precio y volumen.
 *
 * Función pura: no muta el argumento `state` y devuelve un nuevo objeto de estado y la salida.
 *
 * NOTA SOBRE BARRAS EN VIVO:
 * updateWelford es una función pura de acumulación secuencial. Cada llamada representa
 * una nueva barra que se agrega a la serie acumulada (por ejemplo, 100 llamadas consecutivas
 * con la misma barra equivalen a acumular 100 barras iguales, no a actualizar una sola barra en vivo).
 * Las barras en vivo (ticks intra-barra en progreso) se manejan en el motor creando una proyección
 * a partir de un clon/copia del estado de la última barra cerrada, sin actualizar definitivamente
 * el estado acumulado hasta que la barra cierre.
 */
export function updateWelford(
  state: WelfordState,
  price: number,
  volume: number,
): WelfordStep {
  // Regla del SPEC: Si V <= 0 o no es finito, o P no es finito -> no cambia el estado.
  if (!Number.isFinite(price) || !Number.isFinite(volume) || volume <= 0) {
    return {
      state,
      output: getWelfordOutput(state),
    };
  }

  // Regla del SPEC: La primera barra con V > 0 inicializa mean = P, m2 = 0.
  if (state.cumWeight <= 0 || !Number.isFinite(state.cumWeight)) {
    const nextState: WelfordState = {
      count: 1,
      cumWeight: volume,
      mean: price,
      m2: 0,
    };
    return {
      state: nextState,
      output: {
        vwap: price,
        variance: 0,
        stdDev: 0,
        cumVolume: volume,
      },
    };
  }

  // Recurrencia de Welford ponderado (SPEC punto 1):
  // W_n = W_{n-1} + V_n
  // delta = P_n - mu_{n-1}
  // R = delta * V_n / W_n
  // mu_n = mu_{n-1} + R
  // M2_n = M2_{n-1} + W_{n-1} * delta * R
  // sigma = sqrt(max(0, M2_n / W_n))
  const cumWeight = state.cumWeight + volume;
  const delta = price - state.mean;
  const r = (delta * volume) / cumWeight;
  const mean = state.mean + r;
  const m2 = state.m2 + state.cumWeight * delta * r;
  const count = state.count + 1;

  const nextState: WelfordState = {
    count,
    cumWeight,
    mean,
    m2,
  };

  const variance = Math.max(0, m2 / cumWeight);
  const output: WelfordOutput = {
    vwap: mean,
    variance,
    stdDev: Math.sqrt(variance),
    cumVolume: cumWeight,
  };

  return {
    state: nextState,
    output,
  };
}

/**
 * Procesa un array completo de precios y volúmenes devolviendo la serie correspondiente
 * de salidas (VWAP, varianza, desviación estándar y volumen acumulado).
 *
 * Utiliza internamente la misma función `updateWelford`.
 */
export function computeWelfordSeries(
  prices: readonly number[],
  volumes: readonly number[],
  initialState: WelfordState = INITIAL_WELFORD_STATE,
): WelfordOutput[] {
  if (prices.length !== volumes.length) {
    throw new Error(
      `Prices and volumes arrays must have the same length (got ${prices.length.toString()} prices and ${volumes.length.toString()} volumes)`,
    );
  }

  const series: WelfordOutput[] = new Array<WelfordOutput>(prices.length);
  let currentState = initialState;

  for (let i = 0; i < prices.length; i++) {
    const price = prices[i];
    const volume = volumes[i];
    if (price === undefined || volume === undefined) {
      throw new Error(`Element at index ${i.toString()} is undefined`);
    }
    const step = updateWelford(currentState, price, volume);
    currentState = step.state;
    series[i] = step.output;
  }

  return series;
}
