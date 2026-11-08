/** Temporalidades soportadas por la capa de datos. */

import type { Timeframe } from './types.js';

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D'] as const;

export const TIMEFRAME_SECONDS: Readonly<Record<Timeframe, number>> =
  Object.freeze({
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '1h': 3_600,
    '4h': 14_400,
    '1D': 86_400,
  });

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

export function timeframeSeconds(timeframe: Timeframe): number {
  return TIMEFRAME_SECONDS[timeframe];
}
