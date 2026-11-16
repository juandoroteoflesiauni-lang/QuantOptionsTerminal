import { describe, expect, it } from 'vitest';

import {
  BYMA_MARKET_TZ,
  US_MARKET_TZ,
  computeAnchoredVwapSeries,
  computeEmaSeries,
  computeSessionVwapSeries,
  computeVolumeProfile,
} from '../src/core/ggal/technicalIndicators.js';
import type { GgalChartBarPoint } from '../src/core/ggal/institutionalContracts.js';

function makeBar(
  timeSec: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): GgalChartBarPoint {
  return Object.freeze({ timeSec, open, high, low, close, volume });
}

describe('ggal/technicalIndicators (pure math audit)', () => {
  it('computeEmaSeries: retorna [] si len < period y usa semilla exacta SMA-N sin datos parciales', () => {
    const shortCandles = Array.from({ length: 8 }, (_, idx) =>
      makeBar(1_760_000_000 + idx * 86_400, 100 + idx, 102 + idx, 99 + idx, 100 + idx, 1_000),
    );
    expect(computeEmaSeries(shortCandles, 9)).toEqual([]);
    expect(computeEmaSeries(shortCandles, 200)).toEqual([]);

    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 28, 30];
    const candles = closes.map((c, idx) =>
      makeBar(1_760_000_000 + idx * 86_400, c, c + 1, c - 1, c, 5_000),
    );
    const snapshotBefore = JSON.stringify(candles);

    const ema9 = computeEmaSeries(candles, 9);
    // Exact length: closes.length (11) - period (9) + 1 = 3 points (indices 8, 9, 10)
    expect(ema9.length).toBe(3);

    const expectedSeed = (10 + 11 + 12 + 13 + 14 + 15 + 16 + 17 + 18) / 9; // 14
    const k = 2 / (9 + 1); // 0.2
    const expected1 = 28 * k + expectedSeed * (1 - k); // 16.8
    const expected2 = 30 * k + expected1 * (1 - k); // 19.44

    expect(ema9[0]?.timeSec).toBe(candles[8]?.timeSec);
    expect(ema9[0]?.value).toBeCloseTo(expectedSeed, 12);
    expect(ema9[1]?.value).toBeCloseTo(expected1, 12);
    expect(ema9[2]?.value).toBeCloseTo(expected2, 12);
    expect(JSON.stringify(candles)).toBe(snapshotBefore);
  });

  it('computeEmaSeries: EMA 200 emite exactamente len - 199 puntos tras calentamiento completo', () => {
    const candles = Array.from({ length: 250 }, (_, idx) => {
      const price = 500 + idx * 2;
      return makeBar(1_740_000_000 + idx * 86_400, price - 1, price + 2, price - 2, price, 10_000);
    });
    const ema200 = computeEmaSeries(candles, 200);
    expect(ema200.length).toBe(51);
    const first200Mean =
      Array.from({ length: 200 }, (_, idx) => 500 + idx * 2).reduce((a, b) => a + b, 0) / 200;
    expect(ema200[0]?.timeSec).toBe(candles[199]?.timeSec);
    expect(ema200[0]?.value).toBeCloseTo(first200Mean, 11);
    expect(() => computeEmaSeries(candles, 0)).toThrow();
  });

  it('computeSessionVwapSeries: reinicia cumPV y cumVol exactamente en cambio de día en ART y NY', () => {
    // Día 1 ART (2026-06-15 11:00 ART = 14:00Z, 16:00 ART = 19:00Z)
    // Día 2 ART (2026-06-16 11:00 ART = 14:00Z, 12:00 ART = 15:00Z)
    const tD1Bar1 = Math.floor(Date.parse('2026-06-15T14:00:00Z') / 1_000);
    const tD1Bar2 = Math.floor(Date.parse('2026-06-15T19:00:00Z') / 1_000);
    const tD2Bar1 = Math.floor(Date.parse('2026-06-16T14:00:00Z') / 1_000);
    const tD2Bar2 = Math.floor(Date.parse('2026-06-16T15:00:00Z') / 1_000);

    const bars = [
      makeBar(tD1Bar1, 100, 105, 95, 100, 100), // TP = 100, V = 100
      makeBar(tD1Bar2, 110, 115, 105, 110, 300), // TP = 110, V = 300 => VWAP = (10000+33000)/400 = 107.5
      makeBar(tD2Bar1, 200, 210, 190, 200, 50), // Reset! TP = 200, V = 50 => VWAP = 200
      makeBar(tD2Bar2, 220, 230, 210, 220, 150), // TP = 220, V = 150 => VWAP = (10000+33000)/200 = 215
    ];

    const vwapAr = computeSessionVwapSeries(bars, BYMA_MARKET_TZ);
    expect(vwapAr.length).toBe(4);
    expect(vwapAr[0]?.value).toBeCloseTo(100, 12);
    expect(vwapAr[1]?.value).toBeCloseTo(107.5, 12);
    expect(vwapAr[2]?.value).toBeCloseTo(200, 12);
    expect(vwapAr[3]?.value).toBeCloseTo(215, 12);

    // Late evening UTC boundary test: 2026-06-15T22:30:00-03:00 is 2026-06-16T01:30:00Z!
    // In ART it belongs to 2026-06-15 (same session); in UTC it would wrongly reset.
    const tD1LateArt = Math.floor(Date.parse('2026-06-16T01:30:00Z') / 1_000);
    const boundaryBars = [
      makeBar(tD1Bar1, 100, 100, 100, 100, 100),
      makeBar(tD1LateArt, 140, 140, 140, 140, 100),
    ];
    const vwapBoundaryAr = computeSessionVwapSeries(boundaryBars, BYMA_MARKET_TZ);
    expect(vwapBoundaryAr[1]?.value).toBeCloseTo(120, 12);

    const vwapBoundaryNy = computeSessionVwapSeries(boundaryBars, US_MARKET_TZ);
    expect(vwapBoundaryNy[1]?.value).toBeCloseTo(120, 12);
  });

  it('computeAnchoredVwapSeries: acumula exactamente desde anchorTimeSec con bandas σ ponderadas', () => {
    const t0 = 1_760_000_000;
    const bars = [
      makeBar(t0 - 86_400, 999, 999, 999, 999, 50_000), // antes del ancla -> ignorado
      makeBar(t0, 100, 106, 94, 100, 200), // TP = 100, V = 200
      makeBar(t0 + 86_400, 110, 116, 104, 110, 600), // TP = 110, V = 600
      makeBar(t0 + 2 * 86_400, 125, 130, 120, 125, 0), // volumen 0 -> no cambia AVWAP ni inventa vol=1
      makeBar(t0 + 3 * 86_400, 130, 136, 124, 130, 200), // TP = 130, V = 200
    ];

    const bands = computeAnchoredVwapSeries(bars, t0);
    expect(bands.length).toBe(4);

    // Step 0: TP=100, V=200 => avwap=100, sigma=0
    expect(bands[0]?.timeSec).toBe(t0);
    expect(bands[0]?.avwap).toBeCloseTo(100, 12);
    expect(bands[0]?.plus1Sigma).toBeCloseTo(100, 12);

    // Step 1: TP=[100,110], V=[200,600] => mean = (20000 + 66000)/800 = 107.5
    // var = (200*(100-107.5)^2 + 600*(110-107.5)^2)/800 = (11250 + 3750)/800 = 18.75
    const mean1 = 107.5;
    const sig1 = Math.sqrt(18.75);
    expect(bands[1]?.avwap).toBeCloseTo(mean1, 12);
    expect(bands[1]?.plus1Sigma).toBeCloseTo(mean1 + sig1, 12);
    expect(bands[1]?.minus1Sigma).toBeCloseTo(mean1 - sig1, 12);
    expect(bands[1]?.plus2Sigma).toBeCloseTo(mean1 + 2 * sig1, 12);
    expect(bands[1]?.minus2Sigma).toBeCloseTo(mean1 - 2 * sig1, 12);

    // Step 2 (vol=0): sin fallback vol=1 -> repite exactamente avwap y sigma del Step 1
    expect(bands[2]?.avwap).toBeCloseTo(mean1, 12);
    expect(bands[2]?.plus1Sigma).toBeCloseTo(mean1 + sig1, 12);

    // Step 3: totalV=1000, sum(PV)=20000+66000+26000=112000 => mean=112
    const mean3 = 112;
    const var3 =
      (200 * (100 - mean3) ** 2 + 600 * (110 - mean3) ** 2 + 200 * (130 - mean3) ** 2) / 1_000;
    const sig3 = Math.sqrt(var3);
    expect(bands[3]?.avwap).toBeCloseTo(mean3, 12);
    expect(bands[3]?.plus1Sigma).toBeCloseTo(mean3 + sig3, 12);
    expect(bands[3]?.minus2Sigma).toBeCloseTo(mean3 - 2 * sig3, 12);
  });

  it('computeVolumeProfile: calcula POC, VAL/VAH (70% VA) y Naked POCs sin mutar entradas', () => {
    const tD1 = Math.floor(Date.parse('2026-06-15T15:00:00Z') / 1_000);
    const tD2 = Math.floor(Date.parse('2026-06-16T15:00:00Z') / 1_000);
    const bars = [
      makeBar(tD1, 100, 102, 98, 100, 9_000), // sesión 1 POC ~100 (nunca mitigado luego!)
      makeBar(tD2, 110, 114, 108, 112, 3_000),
      makeBar(tD2 + 3_600, 112, 113, 111, 112, 12_000),
    ];

    const vp = computeVolumeProfile(bars, 16, BYMA_MARKET_TZ);
    expect(Number.isFinite(vp.poc)).toBe(true);
    expect(Number.isFinite(vp.vah)).toBe(true);
    expect(Number.isFinite(vp.val)).toBe(true);
    expect(vp.val <= vp.poc && vp.poc <= vp.vah).toBe(true);
    expect(vp.bins.length).toBe(16);
    expect(vp.bins.filter((b) => b.isPoc).length).toBe(1);
    expect(vp.nakedPocs.length).toBe(1);
    expect(vp.nakedPocs[0]).toBeCloseTo(100, 8);
  });
});
