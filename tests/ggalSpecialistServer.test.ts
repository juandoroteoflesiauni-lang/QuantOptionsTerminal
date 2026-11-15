/**
 * Suite Vitest 100 % offline para Pieza 21 — GGAL Specialist Server Integration.
 *
 * Verifica:
 *  - Los 7 endpoints HTTP (/api/ar/ggal-specialist/overview, /parity-gap, /vol-triangle,
 *    /dual-density, /structure-pinning, POST /strategy-selector, POST /anexo-b/ingest)
 *  - Funcionamiento 24/7 en modo explícito `EOD_CIERRE` (sábado/feriado sin rueda)
 *  - Ingesta y validación de Anexo B IAMC (texto pegado y filas estructuradas + rechazo 400)
 *  - GgalChainRecorder (snapshots cada 20s + flujo discreto BYMA)
 *  - Bloqueo `STALE_DATA_LOCK`, validación estricta 405, cero NaN/Infinity y cero fuga de secretos
 */

import { afterEach, describe, expect, it } from 'vitest';
import { priceBsm } from '../src/core/options/blackScholes.js';
import type { FetchFn } from '../src/data/types.js';
import { ArgentinaMarketRuntime, type ArHttpFn } from '../src/server/argentinaMarketLoader.js';
import {
  GgalSpecialistRuntime,
  type AnexoBStoredRecord,
  type GgalDualDensityResponse,
  type GgalParityGapResponse,
  type GgalSpecialistOverviewResponse,
  type GgalStrategySelectorResponse,
  type GgalStructurePinningResponse,
  type GgalVolTriangleResponse,
} from '../src/server/ggalSpecialistRuntime.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';

const JSON_FORBIDDEN_TOKEN = /(?<=[:,[])\s*(?:NaN|-?Infinity|undefined)\b/;
const FAKE_SECRET = 'TEST_GGAL_SECRET_991';

function buildAlignedDailyArBars(params: {
  readonly count: number;
  readonly endUtcSec: number;
  readonly startClose: number;
  readonly drift: number;
  readonly amp: number;
  readonly freq: number;
}): readonly Record<string, unknown>[] {
  const endDayMs = Math.floor(params.endUtcSec / 86_400) * 86_400_000;
  const rows: Record<string, unknown>[] = [];
  for (let i = params.count - 1; i >= 0; i -= 1) {
    const idx = params.count - 1 - i;
    const d = new Date(endDayMs - (i + 1) * 86_400_000);
    const close = Number(
      (params.startClose + idx * params.drift + Math.sin(idx * params.freq) * params.amp).toFixed(4),
    );
    rows.push({
      date: d.toISOString().slice(0, 10),
      o: Number((close * 0.996).toFixed(4)),
      h: Number((close * 1.008).toFixed(4)),
      l: Number((close * 0.992).toFixed(4)),
      c: close,
      v: 950_000 + idx * 1_500,
    });
  }
  return rows;
}

function buildCerHistory(endUtcSec: number, count: number): readonly Record<string, unknown>[] {
  const endDayMs = Math.floor(endUtcSec / 86_400) * 86_400_000;
  const rows: Record<string, unknown>[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const idx = count - 1 - i;
    const d = new Date(endDayMs - (i + 1) * 86_400_000);
    const val = Number((540 * Math.exp(0.00085 * idx + Math.sin(idx * 0.17) * 0.002)).toFixed(4));
    rows.push({
      fecha: d.toISOString().slice(0, 10),
      valor: val,
    });
  }
  return rows;
}

function createOfflineMocks(params: {
  readonly asOfUtcSec: number;
  readonly eodWeekendMode?: boolean;
  readonly failWithSecret?: boolean;
}): { readonly arFetch: ArHttpFn; readonly usFetch: FetchFn } {
  const { asOfUtcSec, eodWeekendMode = false, failWithSecret = false } = params;
  const jsonRes = (payload: unknown, status = 200) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: JSON.stringify(payload),
      headers: {},
    });

  // Referencia de precios reales consistentes: BYMA GGAL = 6400 ARS, ADR = 53.00 USD (~1207.55 CCL)
  const ggalSpotArs = 6400;
  const ggalAdrUsd = 53.0;
  const arsContRate = 0.295; // ~34% TNA
  const usdContRate = 0.043; // SOFR 4.30%

  const frontExpiryDate = '2026-11-20';
  const backExpiryDate = '2026-12-18';
  const weeklyOpraExpiryDate = '2026-11-06';
  const frontExpSec = Math.floor(Date.UTC(2026, 10, 20, 18, 30, 0) / 1_000);
  const backExpSec = Math.floor(Date.UTC(2026, 11, 18, 18, 30, 0) / 1_000);
  const weeklyOpraExpSec = Math.floor(Date.UTC(2026, 10, 6, 18, 30, 0) / 1_000);
  const tFront = Math.max(0.05, (frontExpSec - asOfUtcSec) / (365 * 86_400));
  const tBack = Math.max(0.1, (backExpSec - asOfUtcSec) / (365 * 86_400));
  const tWeekly = Math.max(0.03, (weeklyOpraExpSec - asOfUtcSec) / (365 * 86_400));

  const bymaStrikes = [5400, 5800, 6000, 6200, 6400, 6600, 6800, 7200];
  const bymaIvAtStrike = (k: number): number => {
    const moneyness = (k - ggalSpotArs) / ggalSpotArs;
    return 0.56 - 0.14 * moneyness + 0.12 * moneyness * moneyness;
  };

  const argOptionsRows: Record<string, unknown>[] = [];
  for (const [expCode, tExp] of [
    ['NO', tFront],
    ['DI', tBack],
  ] as const) {
    for (const strike of bymaStrikes) {
      const iv = bymaIvAtStrike(strike);
      for (const ct of ['call', 'put'] as const) {
        const ticker = `GFG${ct === 'call' ? 'C' : 'V'}${String(strike)}${expCode}`;
        const fair = priceBsm({
          spot: ggalSpotArs,
          strike,
          timeToExpiry: tExp,
          rate: arsContRate,
          dividendYield: 0,
          volatility: iv,
          contractType: ct,
        });
        const px = Number(Math.max(12, fair).toFixed(2));
        argOptionsRows.push({
          symbol: ticker,
          c: px,
          px_bid: eodWeekendMode ? 0 : Number((px * 0.985).toFixed(2)),
          px_ask: eodWeekendMode ? 0 : Number((px * 1.015).toFixed(2)),
          v: 180_000,
          v_ars: 180_000 * px,
          open_interest: 180_000,
        });
      }
    }
  }

  const arByDate = buildAlignedDailyArBars({
    count: 85,
    endUtcSec: asOfUtcSec,
    startClose: 5_950,
    drift: 5.3,
    amp: 110,
    freq: 0.24,
  });
  const adrByDate = buildAlignedDailyArBars({
    count: 85,
    endUtcSec: asOfUtcSec,
    startClose: 49.4,
    drift: 0.042,
    amp: 0.85,
    freq: 0.21,
  });
  const al30ByDate = buildAlignedDailyArBars({
    count: 85,
    endUtcSec: asOfUtcSec,
    startClose: 75_500,
    drift: 48,
    amp: 420,
    freq: 0.19,
  });
  const al30cByDate = buildAlignedDailyArBars({
    count: 85,
    endUtcSec: asOfUtcSec,
    startClose: 63.0,
    drift: 0.032,
    amp: 0.35,
    freq: 0.2,
  });
  const gd30ByDate = buildAlignedDailyArBars({
    count: 85,
    endUtcSec: asOfUtcSec,
    startClose: 80_200,
    drift: 51,
    amp: 450,
    freq: 0.18,
  });
  const gd30cByDate = buildAlignedDailyArBars({
    count: 85,
    endUtcSec: asOfUtcSec,
    startClose: 66.8,
    drift: 0.035,
    amp: 0.38,
    freq: 0.17,
  });
  const cerSeries = buildCerHistory(asOfUtcSec, 85);

  const arFetch: ArHttpFn = (url: string) => {
    if (failWithSecret) {
      return Promise.reject(new Error(`Provider refused token=${FAKE_SECRET}`));
    }
    const parsedUrl = new URL(url);
    const { hostname, pathname } = parsedUrl;

    if (hostname.includes('data912')) {
      if (pathname === '/live/mep') {
        return jsonRes(eodWeekendMode ? [] : [{ symbol: 'AL30', mark: 1185, ars_bid: 77025, usd_ask: 65 }]);
      }
      if (pathname === '/live/ccl') {
        return jsonRes(eodWeekendMode ? [] : [{ symbol: 'AL30', mark: 1205, ars_bid: 77025, usd_ask: 63.9 }]);
      }
      if (pathname === '/live/arg_stocks') {
        if (eodWeekendMode) {
          return jsonRes([]);
        }
        return jsonRes([
          {
            symbol: 'GGAL',
            c: ggalSpotArs,
            px_bid: 6396,
            px_ask: 6404,
            prev_close: 6320,
            v: 1_450_000,
            v_ars: 9_280_000_000,
          },
          { symbol: 'YPFD', c: 41200, px_bid: 41100, px_ask: 41300, prev_close: 40800, v: 180_000 },
        ]);
      }
      if (pathname === '/live/usa_adrs') {
        return jsonRes([
          { symbol: 'GGAL', c: ggalAdrUsd, prev_close: 52.35, pct_change: 1.24 },
          { symbol: 'YPF', c: 34.1, prev_close: 33.8, pct_change: 0.88 },
        ]);
      }
      if (pathname === '/live/arg_cedears') {
        return jsonRes(eodWeekendMode ? [] : [{ symbol: 'SPY', c: 36_100, px_bid: 36_050, px_ask: 36_150, prev_close: 35_900 }]);
      }
      if (pathname === '/live/usa_stocks') {
        return jsonRes([{ symbol: 'SPY', c: 595, prev_close: 592, pct_change: 0.51 }]);
      }
      if (pathname === '/live/arg_bonds') {
        if (eodWeekendMode) {
          return jsonRes([]);
        }
        return jsonRes([
          { symbol: 'AL30', c: 77_000, px_bid: 76_950, px_ask: 77_050, prev_close: 76_500, v: 18_000_000, v_ars: 14_000_000_000 },
          { symbol: 'AL30D', c: 65.0, px_bid: 64.9, px_ask: 65.1, prev_close: 64.6, v: 12_000_000 },
          { symbol: 'AL30C', c: 63.9, px_bid: 63.8, px_ask: 64.0, prev_close: 63.5, v: 5_000_000 },
          { symbol: 'GD30', c: 82_200, px_bid: 82_120, px_ask: 82_280, prev_close: 81_700, v: 10_000_000, v_ars: 8_200_000_000 },
          { symbol: 'GD30D', c: 69.3, px_bid: 69.2, px_ask: 69.4, prev_close: 68.9, v: 6_000_000 },
          { symbol: 'GD30C', c: 68.2, px_bid: 68.1, px_ask: 68.3, prev_close: 67.8, v: 3_000_000 },
        ]);
      }
      if (pathname === '/live/arg_notes') {
        return jsonRes([{ symbol: 'S31O6', c: 125.5, px_bid: 125.4, px_ask: 125.6, prev_close: 125.1, tna: 34.2, v_ars: 4_000_000_000 }]);
      }
      if (pathname === '/live/arg_corp') {
        return jsonRes([]);
      }
      if (pathname === '/live/cauciones') {
        return jsonRes([{ symbol: 'PESOS 1D', days: 1, tna: 32.8, c: 32.8, v_ars: 90_000_000_000 }]);
      }
      if (pathname === '/live/arg_options') {
        return jsonRes(argOptionsRows);
      }
      if (pathname === '/historical/stocks/GGAL' || pathname.startsWith('/historical/stocks/')) {
        return jsonRes(arByDate);
      }
      if (pathname === '/historical/bonds/AL30') return jsonRes(al30ByDate);
      if (pathname === '/historical/bonds/AL30C') return jsonRes(al30cByDate);
      if (pathname === '/historical/bonds/AL30D') return jsonRes(al30cByDate);
      if (pathname === '/historical/bonds/GD30') return jsonRes(gd30ByDate);
      if (pathname === '/historical/bonds/GD30C') return jsonRes(gd30cByDate);
      if (pathname === '/historical/bonds/GD30D') return jsonRes(gd30cByDate);
      if (pathname.startsWith('/historical/cedears/')) return jsonRes(arByDate);
    }

    if (hostname.includes('open.bymadata')) {
      return jsonRes({ data: [] });
    }

    if (hostname.includes('bcra.gob.ar')) {
      if (pathname === '/estadisticas/v4.0/Monetarias/30') {
        return jsonRes({ results: cerSeries });
      }
      return jsonRes({
        results: [
          { idVariable: 1, descripcion: 'Reservas Internacionales', valor: 29_500, fecha: '2026-10-15' },
          { idVariable: 5, descripcion: 'Tipo de Cambio Mayorista A3500', valor: 1095.0, fecha: '2026-10-15' },
          { idVariable: 6, descripcion: 'Tasa de Política Monetaria', valor: 30.0, fecha: '2026-10-15' },
          { idVariable: 7, descripcion: 'BADLAR Bancos Privados TNA', valor: 34.5, fecha: '2026-10-15' },
          { idVariable: 15, descripcion: 'Base Monetaria', valor: 31_000_000, fecha: '2026-10-15' },
          { idVariable: 30, descripcion: 'CER', valor: 582.4, fecha: '2026-10-15' },
          { idVariable: 31, descripcion: 'UVA', valor: 1410.2, fecha: '2026-10-15' },
          { idVariable: 44, descripcion: 'TAMAR TNA', valor: 35.2, fecha: '2026-10-15' },
        ],
      });
    }

    if (hostname.includes('argentinadatos.com')) {
      if (pathname.includes('/cotizaciones/dolares')) {
        return jsonRes([
          { casa: 'oficial', nombre: 'Oficial', compra: 1080, venta: 1120, fechaActualizacion: '2026-10-15T15:00:00Z' },
          { casa: 'blue', nombre: 'Blue', compra: 1210, venta: 1230, fechaActualizacion: '2026-10-15T15:00:00Z' },
          { casa: 'bolsa', nombre: 'MEP', compra: 1183, venta: 1187, fechaActualizacion: '2026-10-15T15:00:00Z' },
          { casa: 'contadoconliqui', nombre: 'CCL', compra: 1204, venta: 1210, fechaActualizacion: '2026-10-15T15:00:00Z' },
        ]);
      }
      if (pathname.includes('/indices/inflacionInteranual')) return jsonRes([{ fecha: '2026-09-30', valor: 42.5 }]);
      if (pathname.includes('/indices/inflacion')) return jsonRes([{ fecha: '2026-09-30', valor: 2.3 }]);
      if (pathname.includes('/indices/riesgo-pais')) return jsonRes([{ fecha: '2026-10-15', valor: 680 }]);
      if (pathname.includes('/tasas/plazoFijo')) return jsonRes([{ fecha: '2026-10-15', tnaClientes: 33.5 }]);
    }

    if (hostname.includes('newyorkfed.org')) {
      return jsonRes({ refRates: [{ percentRate: 4.3, effectiveDate: '2026-10-15' }] });
    }

    return jsonRes({ error: `Unhandled mock URL: ${url}` }, 404);
  };

  const opraStrikes = [46, 48, 50, 52, 54, 56, 58, 60];
  const makeOcc = (expCompact: string, ct: 'call' | 'put', k: number): string =>
    `O:GGAL${expCompact}${ct === 'call' ? 'C' : 'P'}${String(Math.round(k * 1_000)).padStart(8, '0')}`;

  interface OpraMockSpec {
    readonly expDate: string;
    readonly expCompact: string;
    readonly tExp: number;
    readonly strike: number;
    readonly ct: 'call' | 'put';
    readonly iv: number;
  }
  const mutableSpecs: OpraMockSpec[] = [];
  for (const exp of [
    { expDate: weeklyOpraExpiryDate, expCompact: '261106', tExp: tWeekly },
    { expDate: frontExpiryDate, expCompact: '261120', tExp: tFront },
    { expDate: backExpiryDate, expCompact: '261218', tExp: tBack },
  ]) {
    for (const k of opraStrikes) {
      const iv = 0.44 - 0.12 * ((k - ggalAdrUsd) / ggalAdrUsd) + 0.08 * Math.pow((k - ggalAdrUsd) / ggalAdrUsd, 2);
      for (const ct of ['call', 'put'] as const) {
        mutableSpecs.push({ expDate: exp.expDate, expCompact: exp.expCompact, tExp: exp.tExp, strike: k, ct, iv });
      }
    }
  }

  const usFetch: FetchFn = (url: string) => {
    if (failWithSecret) {
      return Promise.reject(new Error(`Massive denied token=${FAKE_SECRET}`));
    }
    const path = new URL(url).pathname;
    if (path.startsWith('/v2/aggs/ticker/')) {
      const segs = path.split('/');
      const ticker = decodeURIComponent(segs[4] ?? 'GGAL');
      const mult = Number(segs[6] ?? '1') || 1;
      const span = segs[7] ?? 'day';
      const barSec = span === 'day' ? 86_400 : span === 'hour' ? 3_600 : mult * 60;
      if (span === 'day' && ticker === 'GGAL') {
        const results = adrByDate.map((row) => ({
          t: Date.parse(`${String(row['date'])}T04:00:00Z`),
          o: row['o'],
          h: row['h'],
          l: row['l'],
          c: row['c'],
          v: row['v'],
          vw: row['c'],
        }));
        return jsonRes({ status: 'OK', ticker, resultsCount: results.length, results });
      }
      const endOpenSec = Math.floor((asOfUtcSec - barSec) / barSec) * barSec;
      const results: Record<string, unknown>[] = [];
      const base = ticker === 'I:VIX' ? 16.5 : ticker === 'QQQ' ? 510 : ticker === 'SPY' ? 595 : ggalAdrUsd;
      for (let i = 219; i >= 0; i -= 1) {
        const idx = 219 - i;
        const close =
          i === 0
            ? base
            : Number((base + Math.sin(idx * 0.19) * (base * 0.01)).toFixed(4));
        results.push({
          t: (endOpenSec - i * barSec) * 1_000,
          o: close,
          h: Number((close * 1.004).toFixed(4)),
          l: Number((close * 0.996).toFixed(4)),
          c: close,
          v: 50_000,
          vw: close,
        });
      }
      return jsonRes({ status: 'OK', ticker, resultsCount: results.length, results });
    }
    if (path === '/fed/v1/treasury-yields') {
      return jsonRes({
        status: 'OK',
        results: [
          {
            date: '2026-10-15',
            yield_1_month: usdContRate * 100,
            yield_3_month: usdContRate * 100,
            yield_6_month: usdContRate * 100,
            yield_1_year: usdContRate * 100,
            yield_2_year: usdContRate * 100,
            yield_3_year: usdContRate * 100,
            yield_5_year: usdContRate * 100,
            yield_7_year: usdContRate * 100,
            yield_10_year: usdContRate * 100,
            yield_20_year: usdContRate * 100,
            yield_30_year: usdContRate * 100,
          },
        ],
      });
    }
    if (path === '/fed/v1/funding-conditions') {
      return jsonRes({
        status: 'OK',
        results: [{ date: '2026-10-15', effective_fed_funds_rate: 4.3, sofr: 4.3 }],
      });
    }
    if (path === '/v3/snapshot') {
      return jsonRes({
        status: 'OK',
        results: [
          {
            ticker: 'GGAL',
            type: 'stocks',
            market_status: eodWeekendMode ? 'closed' : 'open',
            session: { price: ggalAdrUsd, close: ggalAdrUsd, previous_close: 52.35, change: 0.65, change_percent: 1.24, volume: 1_900_000 },
            last_trade: { price: ggalAdrUsd, size: 100, sip_timestamp: String(asOfUtcSec * 1_000_000_000) },
            last_quote: { bid: 52.96, ask: 53.04, midpoint: ggalAdrUsd },
          },
          { ticker: 'SPY', type: 'stocks', market_status: eodWeekendMode ? 'closed' : 'open', session: { price: 595, previous_close: 592, change_percent: 0.51 } },
          { ticker: 'QQQ', type: 'stocks', market_status: eodWeekendMode ? 'closed' : 'open', session: { price: 510, previous_close: 508, change_percent: 0.39 } },
          { ticker: 'I:VIX', type: 'indices', market_status: 'open', value: 16.5, session: { price: 16.5, previous_close: 16.9, change_percent: -2.3 } },
          { ticker: 'I:SKEW', type: 'indices', market_status: 'open', value: 136, session: { price: 136, previous_close: 135 } },
        ],
      });
    }
    if (path === '/v3/reference/options/contracts') {
      return jsonRes({
        status: 'OK',
        results: mutableSpecs.map((item) => ({
          ticker: makeOcc(item.expCompact, item.ct, item.strike),
          underlying_ticker: 'GGAL',
          contract_type: item.ct,
          strike_price: item.strike,
          expiration_date: item.expDate,
          shares_per_contract: 100,
        })),
      });
    }
    if (path.startsWith('/v3/snapshot/options/')) {
      const results = mutableSpecs.map((item) => {
        const fair = priceBsm({
          spot: ggalAdrUsd,
          strike: item.strike,
          timeToExpiry: item.tExp,
          rate: usdContRate,
          dividendYield: 0,
          volatility: item.iv,
          contractType: item.ct,
        });
        const halfSpread = Math.max(0.02, fair * 0.02);
        const bid = Number(Math.max(0.05, fair - halfSpread).toFixed(2));
        const ask = Number(Math.max(bid + 0.02, fair + halfSpread).toFixed(2));
        const mid = Number((0.5 * (bid + ask)).toFixed(2));
        return {
          details: {
            ticker: makeOcc(item.expCompact, item.ct, item.strike),
            contract_type: item.ct,
            strike_price: item.strike,
            expiration_date: item.expDate,
            shares_per_contract: 100,
          },
          day: { volume: 650 },
          open_interest: 1_200,
          implied_volatility: item.iv,
          last_quote: { bid, ask, midpoint: mid },
          last_trade: { price: mid, sip_timestamp: String(asOfUtcSec * 1_000_000_000) },
          underlying_asset: { ticker: 'GGAL', price: ggalAdrUsd },
        };
      });
      return jsonRes({ status: 'OK', results });
    }
    if (path.startsWith('/v3/trades/')) {
      return jsonRes({ status: 'OK', results: [] });
    }
    return jsonRes({ error: `Unhandled Massive URL: ${url}` }, 404);
  };

  return { arFetch, usFetch };
}

describe('GGAL Specialist Backend Integration (Pieza 21)', () => {
  const handles: HttpWsServerHandle[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const h = handles.pop();
      if (h !== undefined) {
        await h.stop();
      }
    }
  });

  async function spinUp(opts: {
    readonly asOfUtcSec: number;
    readonly eodWeekendMode?: boolean;
    readonly failWithSecret?: boolean;
    readonly maxData912StalenessSec?: number;
    readonly runtimeNowOffsetSec?: number;
  }) {
    const mocks = createOfflineMocks({
      asOfUtcSec: opts.asOfUtcSec,
      ...(opts.eodWeekendMode !== undefined ? { eodWeekendMode: opts.eodWeekendMode } : {}),
      ...(opts.failWithSecret !== undefined ? { failWithSecret: opts.failWithSecret } : {}),
    });

    const dataNowMs = opts.asOfUtcSec * 1_000;
    const runtime = new MarketRuntime({
      apiKey: FAKE_SECRET,
      secrets: [FAKE_SECRET],
      fetchFn: mocks.usFetch,
      nowMsFn: () => dataNowMs,
    });
    const arRuntime = new ArgentinaMarketRuntime({
      fetchFn: mocks.arFetch,
      secrets: [FAKE_SECRET],
      nowMsFn: () => dataNowMs,
      minData912IntervalMs: 0,
    });

    const specialistNowMs = (opts.asOfUtcSec + (opts.runtimeNowOffsetSec ?? 0)) * 1_000;
    const ggalRuntime = new GgalSpecialistRuntime({
      runtime,
      arRuntime,
      fetchFn: mocks.arFetch,
      secrets: [FAKE_SECRET],
      nowMsFn: () => specialistNowMs,
      ...(opts.maxData912StalenessSec !== undefined
        ? { maxData912StalenessSec: opts.maxData912StalenessSec }
        : {}),
    });

    const server = createHttpWsServer({
      runtime,
      arRuntime,
      ggalRuntime,
      secrets: [FAKE_SECRET],
      port: 0,
    });
    handles.push(server);
    const addr = await server.start();
    return { baseUrl: `http://${addr.host}:${String(addr.port)}`, ggalRuntime };
  }

  it('sirve los 7 endpoints HTTP LIVE con cálculos puros reales, ingesta Anexo B IAMC y grabador 20s sin NaN ni fugas', async () => {
    // Jueves 15 oct 2026 15:30:00Z = 12:30 ART / 11:30 EDT (OVERLAP BYMA + NASDAQ)
    const asOfUtcSec = Math.floor(Date.UTC(2026, 9, 15, 15, 30, 0) / 1_000);
    const { baseUrl, ggalRuntime } = await spinUp({ asOfUtcSec });

    // Grabador manual de 2 snapshots consecutivos (>= 20s) para habilitar flujo discreto BYMA
    await ggalRuntime.recordSnapshotNow();

    // 1. Parity & Gap
    const parityRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/parity-gap`);
    expect(parityRes.status).toBe(200);
    const parityRaw = await parityRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(parityRaw)).toBe(false);
    const parityJson = JSON.parse(parityRaw) as GgalParityGapResponse;
    expect(parityJson.telemetry.marketMode).toBe('LIVE');
    expect(parityJson.telemetry.dstMode).toBe('EDT');
    expect(parityJson.telemetry.sessionRegime).toBe('OVERLAP');
    expect(parityJson.result.spot.byma24hArs).toBeCloseTo(6400, 1);
    expect(parityJson.result.spot.adrMidUsd).toBeCloseTo(53.0, 2);
    expect(parityJson.result.ccl.cclGgal24h).toBeGreaterThan(1100);
    expect(parityJson.result.ouCalibration.status).toBe('OK');
    expect(parityJson.historicalSpreads.length).toBeGreaterThan(30);

    // 2. Vol Triangle
    const volRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/vol-triangle`);
    expect(volRes.status).toBe(200);
    const volRaw = await volRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(volRaw)).toBe(false);
    const volJson = JSON.parse(volRaw) as GgalVolTriangleResponse;
    expect(volJson.result).not.toBeNull();
    expect(volJson.result?.bymaAtmIvPct).toBeGreaterThan(30);
    expect(volJson.result?.opraAdrAtmIvPct).toBeGreaterThan(20);
    expect(volJson.smileComparison.length).toBeGreaterThanOrEqual(6);

    // 3. Dual Density (BCRA CER + Cóplula t-Student + SVI BL)
    const dualRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/dual-density`);
    expect(dualRes.status).toBe(200);
    const dualRaw = await dualRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(dualRaw)).toBe(false);
    const dualJson = JSON.parse(dualRaw) as GgalDualDensityResponse;
    expect(dualJson.cerSeriesCount).toBeGreaterThanOrEqual(30);
    expect(dualJson.result?.physicalMetricsUsd.status).toBe('OK');
    expect(dualJson.result?.simulatedNodes.length).toBeGreaterThan(100);

    // 4a. Structure Pinning BEFORE Anexo B -> NO_DATA explícito + fallback informativo Data912
    const structBeforeRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/structure-pinning`);
    expect(structBeforeRes.status).toBe(200);
    const structBefore = JSON.parse(await structBeforeRes.text()) as GgalStructurePinningResponse;
    expect(structBefore.telemetry.anexoBStatus).toBe('NO_DATA');
    expect(structBefore.result).toBeNull();
    expect(structBefore.data912TotalOiFallback.length).toBeGreaterThan(0);

    // 4b. POST /anexo-b/ingest rechaza payload vacío con 400
    const badIngest = await fetch(`${baseUrl}/api/ar/ggal-specialist/anexo-b/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText: 'sin filas numericas validas' }),
    });
    expect(badIngest.status).toBe(400);

    // 4c. POST /anexo-b/ingest con formato real IAMC (miles españoles y nominales)
    const rawAnexoB = [
      'Fecha 2026-10-14',
      'GFGC6000NO  85.000  140.000  32.000  8.000',
      'GFGV6000NO  12.000  95.000   22.000  4.000',
      'GFGC6400NO  110.000 180.000  45.000  12.000',
      'GFGV6400NO  18.000  130.000  28.000  6.000',
      'GFGC6800NO  160.000 210.000  38.000  10.000',
      'GFGV6800NO  5.000   70.000   15.000  2.000',
    ].join('\n');
    const goodIngest = await fetch(`${baseUrl}/api/ar/ggal-specialist/anexo-b/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText: rawAnexoB }),
    });
    expect(goodIngest.status).toBe(200);
    const goodIngestJson = (await goodIngest.json()) as { readonly ok: boolean; readonly record: AnexoBStoredRecord };
    expect(goodIngestJson.ok).toBe(true);
    expect(goodIngestJson.record.asOfDate).toBe('2026-10-14');
    expect(goodIngestJson.record.totals.strikesCount).toBe(3);
    expect(goodIngestJson.record.totals.callUncoveredNom).toBe(530_000);

    // 4d. Structure Pinning AFTER Anexo B -> cálculos reales + T-1 ANEXO B badge
    const structAfterRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/structure-pinning`);
    expect(structAfterRes.status).toBe(200);
    const structAfterRaw = await structAfterRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(structAfterRaw)).toBe(false);
    const structAfter = JSON.parse(structAfterRaw) as GgalStructurePinningResponse;
    expect(structAfter.telemetry.anexoBStatus).toBe('T-1 ANEXO B');
    expect(structAfter.result).not.toBeNull();
    expect(structAfter.result?.strikeProfile.length).toBe(3);
    expect(structAfter.result?.callWallArs).toBeGreaterThanOrEqual(6000);

    // 5. Strategy Selector POST (todas las familias + filtro BULL_CALL_SPREAD)
    const stratRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/strategy-selector`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enforceThresholds: false, maxCandidates: 15 }),
    });
    expect(stratRes.status).toBe(200);
    const stratRaw = await stratRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(stratRaw)).toBe(false);
    const stratJson = JSON.parse(stratRaw) as GgalStrategySelectorResponse;
    expect(stratJson.result?.status).toBe('OK');
    expect(stratJson.result?.rankedStrategies.length).toBeGreaterThan(0);

    const filteredRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/strategy-selector`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        familyFilter: 'BULL_CALL_SPREAD',
        enforceThresholds: false,
      }),
    });
    expect(filteredRes.status).toBe(200);
    const filteredJson = (await filteredRes.json()) as GgalStrategySelectorResponse;
    for (const c of filteredJson.result?.rankedStrategies ?? []) {
      expect(c.family).toBe('BULL_CALL_SPREAD');
    }

    // 6. Overview consolidado + CORS Preflight (incluye POST)
    const ovRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/overview`);
    expect(ovRes.status).toBe(200);
    const ovRaw = await ovRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(ovRaw)).toBe(false);
    expect(ovRaw).not.toContain(FAKE_SECRET);
    const ovJson = JSON.parse(ovRaw) as GgalSpecialistOverviewResponse;
    expect(ovJson.spot.byma24hArs).toBeCloseTo(6400, 1);

    const optRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/strategy-selector`, {
      method: 'OPTIONS',
    });
    expect(optRes.status).toBe(204);
    expect(optRes.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('opera 24/7 en modo explícito EOD_CIERRE los fines de semana sin STALE_DATA_LOCK ni mocks', async () => {
    // Sábado 17 oct 2026 18:00:00Z (mercado cerrado)
    const saturdaySec = Math.floor(Date.UTC(2026, 9, 17, 18, 0, 0) / 1_000);
    const { baseUrl } = await spinUp({
      asOfUtcSec: saturdaySec,
      eodWeekendMode: true,
    });

    const parityRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/parity-gap`);
    expect(parityRes.status).toBe(200);
    const parityRaw = await parityRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(parityRaw)).toBe(false);
    const parityJson = JSON.parse(parityRaw) as GgalParityGapResponse;

    expect(parityJson.telemetry.marketMode).toBe('EOD_CIERRE');
    expect(parityJson.telemetry.feedStatus).toBe('EOD_CIERRE');
    expect(parityJson.telemetry.sessionRegime).toBe('CLOSED');
    expect(parityJson.result.signal).not.toBe('STALE_DATA_LOCK');
    expect(parityJson.result.ouCalibration.status).toBe('OK');
  });

  it('dispara STALE_DATA_LOCK cuando los feeds en vivo superan la tolerancia, rechaza métodos 405 y oculta secretos', async () => {
    const asOfUtcSec = Math.floor(Date.UTC(2026, 9, 15, 15, 30, 0) / 1_000);
    const staleSetup = await spinUp({
      asOfUtcSec,
      maxData912StalenessSec: 10,
      runtimeNowOffsetSec: 45,
    });

    const staleParity = await fetch(`${staleSetup.baseUrl}/api/ar/ggal-specialist/parity-gap`);
    expect(staleParity.status).toBe(200);
    const staleJson = (await staleParity.json()) as GgalParityGapResponse;
    expect(staleJson.result.signal).toBe('STALE_DATA_LOCK');
    expect(staleJson.telemetry.feedStatus).toBe('STALE_DATA_LOCK');

    const methodErrGetOnPost = await fetch(
      `${staleSetup.baseUrl}/api/ar/ggal-specialist/strategy-selector`,
      { method: 'GET' },
    );
    expect(methodErrGetOnPost.status).toBe(405);

    const methodErrPostOnGet = await fetch(
      `${staleSetup.baseUrl}/api/ar/ggal-specialist/overview`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(methodErrPostOnGet.status).toBe(405);

    // Ciclo startRecorder / stop del grabador 20s sin colgar el event loop
    staleSetup.ggalRuntime.startRecorder();
    expect(staleSetup.ggalRuntime.getRecorderStatus().running).toBe(true);
    staleSetup.ggalRuntime.stop();
    expect(staleSetup.ggalRuntime.getRecorderStatus().running).toBe(false);

    // Zero fuga de secretos si los proveedores fallan con token embebido
    const errSetup = await spinUp({ asOfUtcSec, failWithSecret: true });
    const errRes = await fetch(`${errSetup.baseUrl}/api/ar/ggal-specialist/overview`);
    const errBody = await errRes.text();
    expect(errBody).not.toContain(FAKE_SECRET);
  });
});
