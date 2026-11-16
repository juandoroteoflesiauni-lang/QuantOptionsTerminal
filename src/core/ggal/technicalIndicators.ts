/**
 * Librería matemática pura de indicadores técnicos para GGAL Specialist:
 *  - `computeEmaSeries`: EMA(N) con semilla exacta SMA-N (sin valores parciales cuando len < N).
 *  - `computeSessionVwapSeries`: VWAP intradiario con reinicio diario exacto en zona horaria
 *    de mercado (`America/Argentina/Buenos_Aires` para BYMA o `America/New_York` para ADR/US).
 *  - `computeAnchoredVwapSeries`: Anchored VWAP + bandas ±1σ / ±2σ ponderadas por volumen.
 *  - `computeVolumeProfile`: Perfil de volumen por precio, POC, Value Area 70% (VAL/VAH) y Naked POCs.
 *
 * 100 % pura: cero red, cero mutación de entradas, cero valores inventados que oculten NaN.
 */

import type {
  GgalAvwapBandPoint,
  GgalChartBarPoint,
  GgalLinePoint,
  GgalVolumeProfileBin,
  GgalVolumeProfileSummary,
} from './institutionalContracts.js';

export const BYMA_MARKET_TZ = 'America/Argentina/Buenos_Aires';
export const US_MARKET_TZ = 'America/New_York';

const EMPTY_VOLUME_PROFILE: GgalVolumeProfileSummary = Object.freeze({
  poc: Number.NaN,
  vah: Number.NaN,
  val: Number.NaN,
  nakedPocs: [],
  bins: [],
});

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDateFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = dateFormatterCache.get(timeZone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Devuelve la clave de sesión local `YYYY-MM-DD` en la zona horaria del mercado.
 */
export function getSessionDateKey(timeSec: number, marketTz: string = BYMA_MARKET_TZ): string {
  const parts = getDateFormatter(marketTz).formatToParts(new Date(timeSec * 1_000));
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') {
      year = part.value;
    } else if (part.type === 'month') {
      month = part.value;
    } else if (part.type === 'day') {
      day = part.value;
    }
  }
  return `${year}-${month}-${day}`;
}

function isValidBar(bar: GgalChartBarPoint): boolean {
  return (
    Number.isFinite(bar.timeSec) &&
    bar.timeSec > 0 &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    Number.isFinite(bar.volume)
  );
}

function sortBarsAscending(candles: readonly GgalChartBarPoint[]): GgalChartBarPoint[] {
  if (candles.length === 0) {
    return [];
  }
  const copy = [...candles];
  copy.sort((a, b) => a.timeSec - b.timeSec);
  return copy;
}

/**
 * Calcula la Media Móvil Exponencial `EMA(period)` sobre `close`:
 *  - Lanza error si `period` no es un entero >= 1.
 *  - Devuelve `[]` si `candles.length < period` (nunca emite EMAs parciales sin semilla).
 *  - Índice `period - 1`: semilla exacta `SMA(period)` de los primeros `period` cierres.
 *  - Índices `i >= period`: `EMA[i] = close[i] * k + EMA[i - 1] * (1 - k)`, con `k = 2 / (period + 1)`.
 *  - Si algún cierre de la semilla o tramo es no finito, detiene la serie limpia sin arrastrar ni fabricar datos.
 */
export function computeEmaSeries(
  candles: readonly GgalChartBarPoint[],
  period: number,
): GgalLinePoint[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`EMA period must be an integer >= 1 (got ${String(period)})`);
  }
  if (candles.length < period) {
    return [];
  }

  const ordered = sortBarsAscending(candles);
  let seedSum = 0;
  for (let i = 0; i < period; i += 1) {
    const bar = ordered[i];
    if (
      bar === undefined ||
      !Number.isFinite(bar.timeSec) ||
      bar.timeSec <= 0 ||
      !Number.isFinite(bar.close)
    ) {
      return [];
    }
    seedSum += bar.close;
  }

  const seedBar = ordered[period - 1];
  if (seedBar === undefined) {
    return [];
  }

  const k = 2 / (period + 1);
  const oneMinusK = 1 - k;
  let ema = seedSum / period;
  const out: GgalLinePoint[] = [{ timeSec: seedBar.timeSec, value: ema }];

  for (let i = period; i < ordered.length; i += 1) {
    const bar = ordered[i];
    if (
      bar === undefined ||
      !Number.isFinite(bar.timeSec) ||
      bar.timeSec <= 0 ||
      !Number.isFinite(bar.close)
    ) {
      break;
    }
    ema = bar.close * k + ema * oneMinusK;
    out.push({ timeSec: bar.timeSec, value: ema });
  }

  return out;
}

/**
 * Calcula el VWAP de Sesión reiniciando `cumPV = 0` y `cumVol = 0` al cambiar
 * la fecha local de sesión en `marketTz` (`America/Argentina/Buenos_Aires` o `America/New_York`).
 * Utiliza precio típico `TP = (high + low + close) / 3`.
 */
export function computeSessionVwapSeries(
  candles: readonly GgalChartBarPoint[],
  marketTz: string = BYMA_MARKET_TZ,
): GgalLinePoint[] {
  if (candles.length === 0) {
    return [];
  }

  const ordered = sortBarsAscending(candles);
  const out: GgalLinePoint[] = [];
  let currentDateKey: string | null = null;
  let cumPV = 0;
  let cumVol = 0;

  for (const bar of ordered) {
    if (!Number.isFinite(bar.timeSec) || bar.timeSec <= 0) {
      continue;
    }
    const dateKey = getSessionDateKey(bar.timeSec, marketTz);
    if (dateKey !== currentDateKey) {
      currentDateKey = dateKey;
      cumPV = 0;
      cumVol = 0;
    }

    const tp = (bar.high + bar.low + bar.close) / 3;
    const validPrice = Number.isFinite(tp) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close);
    const vol = Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : 0;

    if (validPrice && vol > 0) {
      cumPV += tp * vol;
      cumVol += vol;
    }

    if (cumVol > 0) {
      out.push({
        timeSec: bar.timeSec,
        value: cumPV / cumVol,
      });
    }
  }

  return out;
}

/**
 * Calcula Anchored VWAP (AVWAP) + bandas ±1σ y ±2σ acumuladas desde `anchorTimeSec`:
 *  - Acumula exactamente desde el primer candle con `timeSec >= anchorTimeSec`.
 *  - `TP = (high + low + close) / 3`, `avwap = sum(TP * V) / sum(V)`.
 *  - Desviación estándar ponderada por volumen `sigma = sqrt(max(0, var_vwap))` usando
 *    recurrencia ponderada estable algebraicamente idéntica a `sum(V * TP^2)/sum(V) - avwap^2`.
 *  - Nunca sustituye volumen 0 por volumen 1 (sin fallbacks silenciosos).
 */
export function computeAnchoredVwapSeries(
  candles: readonly GgalChartBarPoint[],
  anchorTimeSec: number,
): GgalAvwapBandPoint[] {
  if (!Number.isFinite(anchorTimeSec) || candles.length === 0) {
    return [];
  }

  const ordered = sortBarsAscending(candles);
  const out: GgalAvwapBandPoint[] = [];

  let cumPV = 0;
  let cumVol = 0;
  let mean = 0;
  let m2 = 0;

  for (const bar of ordered) {
    if (!Number.isFinite(bar.timeSec) || bar.timeSec < anchorTimeSec || bar.timeSec <= 0) {
      continue;
    }

    const tp = (bar.high + bar.low + bar.close) / 3;
    const validPrice = Number.isFinite(tp) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close);
    const vol = Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : 0;

    if (validPrice && vol > 0) {
      if (cumVol <= 0) {
        cumVol = vol;
        cumPV = tp * vol;
        mean = tp;
        m2 = 0;
      } else {
        const nextCumVol = cumVol + vol;
        const delta = tp - mean;
        const nextMean = mean + (vol / nextCumVol) * delta;
        const delta2 = tp - nextMean;
        m2 = m2 + vol * delta * delta2;
        mean = nextMean;
        cumVol = nextCumVol;
        cumPV += tp * vol;
      }
    }

    if (cumVol > 0) {
      const avwap = cumPV / cumVol;
      const variance = Math.max(0, m2 / cumVol);
      const sigma = Math.sqrt(variance);
      if (Number.isFinite(avwap) && Number.isFinite(sigma)) {
        out.push({
          timeSec: bar.timeSec,
          avwap,
          plus1Sigma: avwap + sigma,
          minus1Sigma: avwap - sigma,
          plus2Sigma: avwap + 2 * sigma,
          minus2Sigma: avwap - 2 * sigma,
        });
      }
    }
  }

  return out;
}

/**
 * Calcula Volume Profile (bins, POC, Value Area 70% VAH/VAL) y Naked POCs
 * (POCs de sesiones anteriores no tocados posteriormente).
 */
export function computeVolumeProfile(
  candles: readonly GgalChartBarPoint[],
  numBins = 32,
  marketTz: string = BYMA_MARKET_TZ,
): GgalVolumeProfileSummary {
  const safeBins = Math.max(4, Math.min(128, Math.floor(numBins)));
  const valid = sortBarsAscending(candles).filter(
    (b) => isValidBar(b) && b.high >= b.low && b.low > 0,
  );
  if (valid.length === 0) {
    return EMPTY_VOLUME_PROFILE;
  }

  let minLow = Number.POSITIVE_INFINITY;
  let maxHigh = Number.NEGATIVE_INFINITY;
  let totalVol = 0;
  for (const b of valid) {
    if (b.low < minLow) minLow = b.low;
    if (b.high > maxHigh) maxHigh = b.high;
    if (b.volume > 0) totalVol += b.volume;
  }

  if (!Number.isFinite(minLow) || !Number.isFinite(maxHigh) || totalVol <= 0) {
    return EMPTY_VOLUME_PROFILE;
  }

  const range = maxHigh - minLow;
  if (range <= 0) {
    const mid = minLow;
    return {
      poc: mid,
      vah: mid,
      val: mid,
      nakedPocs: [],
      bins: [
        {
          priceMid: mid,
          volume: totalVol,
          isValToVah: true,
          isPoc: true,
        },
      ],
    };
  }

  const binStep = range / safeBins;
  const binVolumes = new Array<number>(safeBins).fill(0);

  for (const b of valid) {
    if (b.volume <= 0) {
      continue;
    }
    const barRange = b.high - b.low;
    if (barRange <= 0) {
      const idx = Math.min(safeBins - 1, Math.max(0, Math.floor((b.close - minLow) / binStep)));
      binVolumes[idx] = (binVolumes[idx] ?? 0) + b.volume;
      continue;
    }
    const startIdx = Math.min(safeBins - 1, Math.max(0, Math.floor((b.low - minLow) / binStep)));
    const endIdx = Math.min(safeBins - 1, Math.max(0, Math.floor((b.high - minLow) / binStep)));
    for (let idx = startIdx; idx <= endIdx; idx += 1) {
      const binLo = minLow + idx * binStep;
      const binHi = idx === safeBins - 1 ? maxHigh : binLo + binStep;
      const overlap = Math.max(0, Math.min(b.high, binHi) - Math.max(b.low, binLo));
      const weight = overlap / barRange;
      if (weight > 0) {
        binVolumes[idx] = (binVolumes[idx] ?? 0) + b.volume * weight;
      }
    }
  }

  let pocIdx = 0;
  let maxBinVol = -1;
  for (let i = 0; i < safeBins; i += 1) {
    const v = binVolumes[i] ?? 0;
    if (v > maxBinVol) {
      maxBinVol = v;
      pocIdx = i;
    }
  }

  if (maxBinVol <= 0) {
    return EMPTY_VOLUME_PROFILE;
  }

  // Value Area 70% alrededor del POC
  const targetVol = totalVol * 0.7;
  let accVol = binVolumes[pocIdx] ?? 0;
  let loIdx = pocIdx;
  let hiIdx = pocIdx;
  while (accVol < targetVol && (loIdx > 0 || hiIdx < safeBins - 1)) {
    const leftVol = loIdx > 0 ? (binVolumes[loIdx - 1] ?? 0) : -1;
    const rightVol = hiIdx < safeBins - 1 ? (binVolumes[hiIdx + 1] ?? 0) : -1;
    if (rightVol > leftVol) {
      hiIdx += 1;
      accVol += Math.max(0, rightVol);
    } else if (loIdx > 0) {
      loIdx -= 1;
      accVol += Math.max(0, leftVol);
    } else if (hiIdx < safeBins - 1) {
      hiIdx += 1;
      accVol += Math.max(0, rightVol);
    } else {
      break;
    }
  }

  const bins: GgalVolumeProfileBin[] = [];
  for (let i = 0; i < safeBins; i += 1) {
    bins.push({
      priceMid: minLow + (i + 0.5) * binStep,
      volume: binVolumes[i] ?? 0,
      isValToVah: i >= loIdx && i <= hiIdx,
      isPoc: i === pocIdx,
    });
  }

  const poc = minLow + (pocIdx + 0.5) * binStep;
  const val = minLow + loIdx * binStep;
  const vah = hiIdx === safeBins - 1 ? maxHigh : minLow + (hiIdx + 1) * binStep;

  // Naked POCs de sesiones cerradas anteriores no mitigados por barras posteriores
  const sessionGroups = new Map<string, GgalChartBarPoint[]>();
  const sessionOrder: string[] = [];
  for (const b of valid) {
    const key = getSessionDateKey(b.timeSec, marketTz);
    let grp = sessionGroups.get(key);
    if (grp === undefined) {
      grp = [];
      sessionGroups.set(key, grp);
      sessionOrder.push(key);
    }
    grp.push(b);
  }

  const nakedPocs: number[] = [];
  if (sessionOrder.length >= 2) {
    for (let sIdx = 0; sIdx < sessionOrder.length - 1; sIdx += 1) {
      const key = sessionOrder[sIdx];
      if (key === undefined) continue;
      const grp = sessionGroups.get(key);
      if (grp === undefined || grp.length === 0) continue;

      let bestTp: number | null = null;
      let bestVol = -1;
      for (const bar of grp) {
        if (bar.volume > bestVol) {
          bestVol = bar.volume;
          bestTp = (bar.high + bar.low + bar.close) / 3;
        }
      }
      if (bestTp === null || !Number.isFinite(bestTp)) continue;

      const lastSessionBar = grp[grp.length - 1];
      if (lastSessionBar === undefined) continue;
      let touchedAfter = false;
      for (const later of valid) {
        if (later.timeSec > lastSessionBar.timeSec && later.low <= bestTp && bestTp <= later.high) {
          touchedAfter = true;
          break;
        }
      }
      if (!touchedAfter) {
        nakedPocs.push(bestTp);
      }
    }
  }

  return {
    poc,
    vah,
    val,
    nakedPocs: nakedPocs.slice(-8),
    bins,
  };
}
