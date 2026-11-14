/**
 * Suite Vitest 100 % offline para Pieza 17 (Servidor Argentina + Upgrades Opciones EE.UU.).
 *
 * Verifica:
 *  - Matemática soberana (`evaluateSovereignBondMath`: XIRR, Macaulay/Modified Duration, paridad, cupón corrido),
 *    parser BYMA (`parseBymaOptionSymbol`) y costos T+0 con 21 % IVA (`evaluateBymaOptionCostAndFair`)
 *    contra referencia independiente generada por Python en `fixtures/argentina_server_reference.json` (tol 1e-9).
 *  - Endpoints HTTP `/api/ar/overview`, `/api/ar/macro`, `/api/ar/monitoring`, `/api/ar/stock`,
 *    `/api/ar/options` y `/api/ar/relations` 100 % offline sin `NaN`, `Infinity` ni fallbacks silenciosos.
 *  - Degradación honesta de `feedStatus`: `LIVE` (Data912+OpenBYMA) -> `DIFERIDO_20M` (solo Data912)
 *    -> `PARTIAL` (solo OpenBYMA) -> `NO_DATA` (ambos caídos, métricas en `null`).
 *  - Upgrade `MarketRuntime` EE.UU.: rango ±25 %, forward analítico cuando pares paridad < 3,
 *    y cálculo de `putWallStrike` en strikes profundos (-20 %).
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { priceBsm } from '../src/core/options/blackScholes.js';
import type { FetchFn } from '../src/data/types.js';
import {
  type ArMacroResponse,
  type ArMonitoringResponse,
  type ArOptionsResponse,
  type ArOverviewResponse,
  type ArRelationsResponse,
  type ArStockDetailResponse,
  ArgentinaMarketRuntime,
  evaluateSovereignBondMath,
  parseBymaOptionSymbol,
} from '../src/server/argentinaMarketLoader.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import { MarketRuntime, type TerminalSnapshotResponse } from '../src/server/marketRuntime.js';

interface BondReferenceCase {
  readonly name: string;
  readonly spec: {
    readonly baseTicker: string;
    readonly name: string;
    readonly legislation: 'ARG' | 'NY';
    readonly maturity: string;
    readonly flows: readonly {
      readonly dateUtcSec: number;
      readonly coupon: number;
      readonly amortization: number;
    }[];
  };
  readonly marketPriceUsd: number;
  readonly asOfUtcSec: number;
  readonly expected: {
    readonly tirPct: number | null;
    readonly parityPct: number | null;
    readonly duration: number | null;
    readonly accruedInterest: number | null;
  };
}

interface OptionSymbolReferenceCase {
  readonly rawSymbol: string;
  readonly spotHint: number | null;
  readonly asOfUtcSec: number;
  readonly expected: {
    readonly symbol: string;
    readonly underlying: string;
    readonly contractType: 'call' | 'put';
    readonly strike: number;
    readonly expiryCode: string;
    readonly expiryLabel: string;
    readonly expirationDate: string;
    readonly expiryUtcSec: number;
    readonly daysToExpiry: number;
  } | null;
}

interface FeeReferenceCase {
  readonly fairPrice: number;
  readonly lotSize: number;
  readonly optionsFeeRate: number;
  readonly vatRate: number;
  readonly expectedCommissionWithVatArsPerLot: number;
}

interface ArgentinaServerFixture {
  readonly asOfUtcSec: number;
  readonly bondCases: readonly BondReferenceCase[];
  readonly optionSymbolCases: readonly OptionSymbolReferenceCase[];
  readonly feeCases: readonly FeeReferenceCase[];
}

const FIXTURE: ArgentinaServerFixture = JSON.parse(
  readFileSync(new URL('../fixtures/argentina_server_reference.json', import.meta.url), 'utf8'),
) as ArgentinaServerFixture;

function buildDailyBarSeries(params: {
  readonly count: number;
  readonly endUtcSec: number;
  readonly startPrice: number;
  readonly driftPerDay: number;
  readonly waveAmp: number;
  readonly waveFreq: number;
}): readonly Record<string, unknown>[] {
  const { count, endUtcSec, startPrice, driftPerDay, waveAmp, waveFreq } = params;
  const endDayMs = Math.floor(endUtcSec / 86_400) * 86_400_000;
  const rows: Record<string, unknown>[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const idx = count - 1 - i;
    const d = new Date(endDayMs - (i + 1) * 86_400_000);
    const close = Number(
      (startPrice + idx * driftPerDay + Math.sin(idx * waveFreq) * waveAmp).toFixed(4),
    );
    const open = Number((close * 0.996).toFixed(4));
    const high = Number((Math.max(open, close) * 1.012).toFixed(4));
    const low = Number((Math.min(open, close) * 0.988).toFixed(4));
    rows.push({
      date: d.toISOString().slice(0, 10),
      o: open,
      h: high,
      l: low,
      c: close,
      v: 250_000 + idx * 1_200,
    });
  }
  return rows;
}

interface OfflineArMockConfig {
  readonly asOfUtcSec: number;
  readonly failData912?: boolean;
  readonly failOpenByma?: boolean;
  readonly failBcra?: boolean;
  readonly failArgDatos?: boolean;
}

function createOfflineArgentinaHttp(cfg: OfflineArMockConfig): (
  url: string,
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
  readonly headers: Readonly<Record<string, string>>;
}> {
  const {
    asOfUtcSec,
    failData912 = false,
    failOpenByma = false,
    failBcra = false,
    failArgDatos = false,
  } = cfg;

  const ggalSpot = 6_400;
  const badlarTna = 32.0;
  const rateCont = Math.log(1 + badlarTna / 100);
  const ggalDiv = 0.012;

  const makeArOptionRow = (
    symbol: string,
    contractType: 'call' | 'put',
    strike: number,
    daysToExpiry: number,
    vol: number,
    oi: number,
  ): Record<string, unknown> => {
    const { fairPrice } = ArgentinaMarketRuntime.evaluateBymaOptionCostAndFair({
      spot: ggalSpot,
      strike,
      daysToExpiry,
      rateContinuous: rateCont,
      dividendYield: ggalDiv,
      volatility: vol,
      contractType,
    });
    const bid = Number(Math.max(0.5, fairPrice * 0.98).toFixed(2));
    const ask = Number((fairPrice * 1.02 + 0.5).toFixed(2));
    const mid = Number((0.5 * (bid + ask)).toFixed(2));
    return {
      symbol,
      c: mid,
      px_bid: bid,
      px_ask: ask,
      prev_close: Number((mid * 0.96).toFixed(2)),
      pct_change: 4.16,
      v: oi,
      v_ars: mid * 100 * oi,
    };
  };

  // FIXTURE.asOfUtcSec is 2025-03-10 -> AB (Abr 2025 = 2025-04-18, ~39d) and JU (Jun 2025 = 2025-06-20, ~102d)
  const abParsed = parseBymaOptionSymbol('GFGC6400AB', ggalSpot, asOfUtcSec);
  const juParsed = parseBymaOptionSymbol('GFGC6400JU', ggalSpot, asOfUtcSec);
  const abDays = abParsed?.daysToExpiry ?? 39;
  const juDays = juParsed?.daysToExpiry ?? 102;

  const argOptionsRows = [
    makeArOptionRow('GFGC5800AB', 'call', 5800, abDays, 0.58, 14_000),
    makeArOptionRow('GFGV5800AB', 'put', 5800, abDays, 0.58, 22_000),
    makeArOptionRow('GFGC6000AB', 'call', 6000, abDays, 0.56, 18_500),
    makeArOptionRow('GFGV6000AB', 'put', 6000, abDays, 0.56, 26_000),
    makeArOptionRow('GFGC6400AB', 'call', 6400, abDays, 0.54, 42_000),
    makeArOptionRow('GFGV6400AB', 'put', 6400, abDays, 0.54, 31_000),
    makeArOptionRow('GFGC6800AB', 'call', 6800, abDays, 0.55, 36_000),
    makeArOptionRow('GFGV6800AB', 'put', 6800, abDays, 0.55, 11_000),
    makeArOptionRow('GFGC7200AB', 'call', 7200, abDays, 0.57, 25_000),
    makeArOptionRow('GFGV7200AB', 'put', 7200, abDays, 0.57, 4_000),
    makeArOptionRow('GFGC6000JU', 'call', 6000, juDays, 0.52, 8_000),
    makeArOptionRow('GFGV6000JU', 'put', 6000, juDays, 0.52, 9_500),
    makeArOptionRow('GFGC6400JU', 'call', 6400, juDays, 0.50, 12_000),
    makeArOptionRow('GFGV6400JU', 'put', 6400, juDays, 0.50, 10_500),
    makeArOptionRow('GFGC6800JU', 'call', 6800, juDays, 0.51, 9_000),
    makeArOptionRow('GFGV6800JU', 'put', 6800, juDays, 0.51, 6_000),
    makeArOptionRow('GFGC7200JU', 'call', 7200, juDays, 0.53, 7_500),
    makeArOptionRow('GFGV7200JU', 'put', 7200, juDays, 0.53, 2_000),
  ];

  const jsonRes = (payload: unknown, status = 200) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: JSON.stringify(payload),
      headers: {},
    });

  return (url: string) => {
    const parsedUrl = new URL(url);
    const { hostname, pathname } = parsedUrl;

    if (hostname.includes('data912')) {
      if (failData912) {
        return jsonRes({ error: 'Data912 unavailable' }, 503);
      }
      if (pathname === '/live/mep') {
        return jsonRes([{ symbol: 'AL30', mark: 1185.0, ars_bid: 80950, usd_ask: 68.3 }]);
      }
      if (pathname === '/live/ccl') {
        return jsonRes([{ symbol: 'GD30', mark: 1215.0, ars_bid: 83950, usd_ask: 69.1 }]);
      }
      if (pathname === '/live/arg_stocks') {
        return jsonRes([
          { symbol: 'GGAL', c: 6400, px_bid: 6395, px_ask: 6405, prev_close: 6250, l: 6230, h: 6440, v_ars: 8_200_000_000, v: 1_280_000 },
          { symbol: 'YPFD', c: 41200, px_bid: 41100, px_ask: 41250, prev_close: 40500, l: 40300, h: 41400, v_ars: 6_100_000_000, v: 148_000 },
          { symbol: 'PAMP', c: 3920, px_bid: 3910, px_ask: 3930, prev_close: 3860, l: 3850, h: 3950, v_ars: 2_800_000_000, v: 715_000 },
          { symbol: 'BMA', c: 11800, px_bid: 11760, px_ask: 11820, prev_close: 11600, l: 11580, h: 11850, v_ars: 3_100_000_000, v: 263_000 },
        ]);
      }
      if (pathname === '/live/usa_adrs') {
        return jsonRes([
          { symbol: 'GGAL', c: 52.68, prev_close: 51.4, pct_change: 2.49 },
          { symbol: 'YPF', c: 33.91, prev_close: 33.3, pct_change: 1.83 },
          { symbol: 'BMA', c: 97.12, prev_close: 95.8, pct_change: 1.38 },
          { symbol: 'PAM', c: 80.66, prev_close: 79.5, pct_change: 1.46 },
        ]);
      }
      if (pathname === '/live/arg_cedears') {
        return jsonRes([
          { symbol: 'AAPL', c: 14100, px_bid: 14080, px_ask: 14120, prev_close: 13950, v_ars: 1_500_000_000 },
          { symbol: 'VISTA', c: 20400, px_bid: 20350, px_ask: 20450, prev_close: 20100, v_ars: 950_000_000 },
          { symbol: 'SPY', c: 36146, px_bid: 36100, px_ask: 36180, prev_close: 35900, v_ars: 2_300_000_000 },
        ]);
      }
      if (pathname === '/live/usa_stocks') {
        return jsonRes([
          { symbol: 'AAPL', c: 232.0, prev_close: 230.0, pct_change: 0.87 },
          { symbol: 'VIST', c: 50.37, prev_close: 49.8, pct_change: 1.14 },
          { symbol: 'SPY', c: 595.0, prev_close: 592.5, pct_change: 0.42 },
        ]);
      }
      if (pathname === '/live/arg_bonds') {
        return jsonRes([
          { symbol: 'AL29', c: 81172, prev_close: 80500, v_ars: 1_400_000_000 },
          { symbol: 'AL29D', c: 68.5, prev_close: 67.9, v_ars: 900_000_000 },
          { symbol: 'AL30', c: 77025, prev_close: 76300, v_ars: 18_500_000_000 },
          { symbol: 'AL30D', c: 65.0, prev_close: 64.4, v_ars: 14_200_000_000 },
          { symbol: 'AL30C', c: 63.4, prev_close: 62.9, v_ars: 4_100_000_000 },
          { symbol: 'GD30', c: 82240, prev_close: 81600, v_ars: 9_800_000_000 },
          { symbol: 'GD30D', c: 69.4, prev_close: 68.8, v_ars: 7_400_000_000 },
          { symbol: 'GD30C', c: 67.7, prev_close: 67.1, v_ars: 2_600_000_000 },
        ]);
      }
      if (pathname === '/live/arg_notes') {
        return jsonRes([{ symbol: 'S31O5', c: 124.5, px_bid: 124.4, px_ask: 124.6, prev_close: 124.1, v_ars: 4_500_000_000 }]);
      }
      if (pathname === '/live/arg_corp') {
        return jsonRes([{ symbol: 'YMCQO', c: 103.2, px_bid: 102.9, px_ask: 103.5, prev_close: 103.0, v_ars: 820_000_000 }]);
      }
      if (pathname === '/live/arg_options') {
        return jsonRes(argOptionsRows);
      }
      if (pathname.startsWith('/historical/stocks/')) {
        const ticker = pathname.split('/').pop() ?? 'GGAL';
        const basePx = ticker === 'BMA' ? 11_000 : ticker === 'YPFD' ? 39_000 : 6_000;
        return jsonRes(
          buildDailyBarSeries({
            count: 70,
            endUtcSec: asOfUtcSec,
            startPrice: basePx,
            driftPerDay: basePx * 0.001,
            waveAmp: basePx * 0.025,
            waveFreq: ticker === 'BMA' ? 0.31 : 0.23,
          }),
        );
      }
      if (pathname.startsWith('/historical/bonds/')) {
        const ticker = pathname.split('/').pop() ?? 'AL30D';
        const basePx = ticker.startsWith('GD') ? 68.0 : 64.0;
        return jsonRes(
          buildDailyBarSeries({
            count: 70,
            endUtcSec: asOfUtcSec,
            startPrice: basePx,
            driftPerDay: 0.02,
            waveAmp: ticker.startsWith('GD') ? 0.65 : 0.45,
            waveFreq: ticker.startsWith('GD') ? 0.27 : 0.21,
          }),
        );
      }
      if (pathname.startsWith('/historical/cedears/')) {
        return jsonRes(
          buildDailyBarSeries({
            count: 70,
            endUtcSec: asOfUtcSec,
            startPrice: 19_500,
            driftPerDay: 14,
            waveAmp: 380,
            waveFreq: 0.19,
          }),
        );
      }
    }

    if (hostname.includes('open.bymadata')) {
      if (failOpenByma) {
        return jsonRes({ error: 'OpenBYMA timeout' }, 503);
      }
      if (pathname.endsWith('/leading-equity')) {
        return jsonRes({
          data: [
            { symbol: 'GGAL', trade: 6400, bidPrice: 6395, askPrice: 6405, closingPrice: 6250, min: 6230, max: 6440, volumeAmount: 8_200_000_000, nominalVolume: 1_280_000 },
            { symbol: 'YPFD', trade: 41200, bidPrice: 41100, askPrice: 41250, closingPrice: 40500, min: 40300, max: 41400, volumeAmount: 6_100_000_000, nominalVolume: 148_000 },
          ],
        });
      }
      if (pathname.endsWith('/general-equity')) {
        return jsonRes({
          data: [
            { symbol: 'VALO', trade: 425, bidPrice: 423, askPrice: 426, closingPrice: 420, volumeAmount: 190_000_000, nominalVolume: 447_000 },
          ],
        });
      }
    }

    if (hostname.includes('bcra.gob.ar')) {
      if (failBcra) {
        return jsonRes({ error: 'BCRA error' }, 503);
      }
      return jsonRes({
        results: [
          { idVariable: 1, descripcion: 'Reservas Internacionales', valor: 28_450, fecha: '2025-03-10' },
          { idVariable: 5, descripcion: 'Tipo de Cambio Mayorista A3500', valor: 1067.5, fecha: '2025-03-10' },
          { idVariable: 6, descripcion: 'Tasa de Política Monetaria', valor: 29.0, fecha: '2025-03-10' },
          { idVariable: 7, descripcion: 'BADLAR Bancos Privados TNA', valor: badlarTna, fecha: '2025-03-10' },
          { idVariable: 15, descripcion: 'Base Monetaria', valor: 30_200_000, fecha: '2025-03-10' },
          { idVariable: 30, descripcion: 'CER', valor: 548.21, fecha: '2025-03-10' },
          { idVariable: 31, descripcion: 'UVA', valor: 1365.4, fecha: '2025-03-10' },
          { idVariable: 44, descripcion: 'TAMAR TNA', valor: 33.4, fecha: '2025-03-10' },
        ],
      });
    }

    if (hostname.includes('argentinadatos.com')) {
      if (failArgDatos) {
        return jsonRes({ error: 'ArgentinaDatos error' }, 503);
      }
      if (pathname.includes('/cotizaciones/dolares')) {
        return jsonRes([
          { casa: 'oficial', nombre: 'Oficial', compra: 1047, venta: 1087, fechaActualizacion: '2025-03-10T15:00:00Z' },
          { casa: 'blue', nombre: 'Blue', compra: 1205, venta: 1225, fechaActualizacion: '2025-03-10T15:00:00Z' },
          { casa: 'bolsa', nombre: 'MEP', compra: 1182, venta: 1186, fechaActualizacion: '2025-03-10T15:00:00Z' },
          { casa: 'contadoconliqui', nombre: 'CCL', compra: 1210, venta: 1216, fechaActualizacion: '2025-03-10T15:00:00Z' },
        ]);
      }
      if (pathname.includes('/indices/inflacionInteranual')) {
        return jsonRes([{ fecha: '2025-02-28', valor: 66.9 }]);
      }
      if (pathname.includes('/indices/inflacion')) {
        return jsonRes([{ fecha: '2025-02-28', valor: 2.4 }]);
      }
      if (pathname.includes('/indices/riesgo-pais')) {
        return jsonRes([{ fecha: '2025-03-10', valor: 720 }]);
      }
    }

    return jsonRes({ error: `Unhandled mock URL: ${url}` }, 404);
  };
}

function createSparseUsOptionsMassiveFetch(asOfUtcSec: number): FetchFn {
  const spot = 600.0;
  const rate = 0.043;
  const q = 0.0;
  const expiryDate = '2025-04-11';
  const expCompact = '250411';
  const expUtcSec = Math.floor(Date.UTC(2025, 3, 11, 20, 0, 0) / 1_000);
  const tExp = (expUtcSec - asOfUtcSec) / (365 * 86_400);

  const makeOcc = (ct: 'call' | 'put', strike: number): string =>
    `O:SPY${expCompact}${ct === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1_000)).padStart(8, '0')}`;

  // Build 6 strikes spanning -20%..+15%, with only ONE matched pair at ATM (600) -> < 3 parity pairs!
  const sparseContractsSpec: readonly { strike: number; ct: 'call' | 'put'; oi: number; spreadFactor: number }[] = [
    { strike: 480, ct: 'put', oi: 45_000, spreadFactor: 0.04 }, // -20% deep OTM Put Wall within ±25%
    { strike: 540, ct: 'put', oi: 12_000, spreadFactor: 0.04 }, // -10%
    { strike: 570, ct: 'put', oi: 10_000, spreadFactor: 0.04 }, // -5%
    { strike: 600, ct: 'put', oi: 8_000, spreadFactor: 0.02 },  // ATM matched pair (1/1)
    { strike: 600, ct: 'call', oi: 8_500, spreadFactor: 0.02 }, // ATM matched pair (1/1)
    { strike: 630, ct: 'call', oi: 14_000, spreadFactor: 0.03 }, // +5%
    { strike: 690, ct: 'call', oi: 9_000, spreadFactor: 0.65 },  // +15% wide spread 0.65 (accepted under <= 0.85 relaxation for ownIv, filtered at slice maxSpreadRatio=0.35 if >0.35)
    { strike: 660, ct: 'call', oi: 11_000, spreadFactor: 0.03 }, // +10%
  ];

  const makeBars = (symbol: string, multiplier: number, timeframe: string) => {
    const unitSec = timeframe === 'day' ? 86_400 : timeframe === 'hour' ? 3_600 : 60;
    const barSec = Math.max(60, multiplier * unitSec);
    const endOpenSec = Math.floor((asOfUtcSec - barSec) / barSec) * barSec;
    const results: Record<string, unknown>[] = [];
    for (let i = 259; i >= 0; i -= 1) {
      const idx = 259 - i;
      const tSec = endOpenSec - i * barSec;
      const base = symbol === 'I:VIX' ? 17 : symbol === 'QQQ' ? 505 : spot;
      const close = Number((base + Math.sin(idx * 0.2) * 0.8).toFixed(4));
      results.push({
        t: tSec * 1_000,
        o: Number((close - 0.1).toFixed(4)),
        h: Number((close + 0.3).toFixed(4)),
        l: Number((close - 0.3).toFixed(4)),
        c: close,
        v: symbol === 'I:VIX' ? 0 : 100_000,
        vw: close,
      });
    }
    return { status: 'OK', ticker: symbol, resultsCount: results.length, results };
  };

  return (url: string) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/v2/aggs/ticker/')) {
      const segs = path.split('/');
      const ticker = decodeURIComponent(segs[4] ?? 'SPY');
      const mult = Number(segs[6] ?? '5') || 5;
      const span = segs[7] ?? 'minute';
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify(makeBars(ticker, mult, span)),
        headers: {},
      });
    }
    if (path === '/fed/v1/treasury-yields') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: [{
            date: '2025-03-10',
            yield_1_month: 4.3,
            yield_3_month: 4.3,
            yield_6_month: 4.3,
            yield_1_year: 4.3,
            yield_2_year: 4.3,
            yield_3_year: 4.3,
            yield_5_year: 4.3,
            yield_7_year: 4.3,
            yield_10_year: 4.3,
            yield_20_year: 4.3,
            yield_30_year: 4.3,
          }],
        }),
        headers: {},
      });
    }
    if (path === '/fed/v1/funding-conditions') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: [{ date: '2025-03-10', effective_fed_funds_rate: 4.3, sofr: 4.3 }],
        }),
        headers: {},
      });
    }
    if (path === '/v3/snapshot') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: [
            {
              ticker: 'SPY',
              type: 'stocks',
              market_status: 'open',
              session: { price: spot, close: spot, previous_close: 598.0, change: 2.0, change_percent: 0.33, volume: 25_000_000 },
              last_trade: { price: spot, size: 100, sip_timestamp: String(asOfUtcSec * 1_000_000_000) },
              last_quote: { bid: 599.98, ask: 600.02, midpoint: 600.0 },
            },
            { ticker: 'QQQ', type: 'stocks', market_status: 'open', session: { price: 505, close: 505, previous_close: 503 } },
            { ticker: 'I:SPX', type: 'indices', market_status: 'open', value: 6000, session: { price: 6000, previous_close: 5980 } },
            { ticker: 'I:VIX', type: 'indices', market_status: 'open', value: 17.2, session: { price: 17.2, previous_close: 17.5 } },
            { ticker: 'I:SKEW', type: 'indices', market_status: 'open', value: 139.0, session: { price: 139.0, previous_close: 138.0 } },
          ],
        }),
        headers: {},
      });
    }
    if (path === '/v3/reference/options/contracts') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'OK',
          results: sparseContractsSpec.map((item) => ({
            ticker: makeOcc(item.ct, item.strike),
            underlying_ticker: 'SPY',
            contract_type: item.ct,
            strike_price: item.strike,
            expiration_date: expiryDate,
            shares_per_contract: 100,
          })),
        }),
        headers: {},
      });
    }
    if (path.startsWith('/v3/snapshot/options/')) {
      const results = sparseContractsSpec.map((item) => {
        const vol = 0.45;
        const fair = priceBsm({
          spot,
          strike: item.strike,
          timeToExpiry: tExp,
          rate,
          dividendYield: q,
          volatility: vol,
          contractType: item.ct,
        });
        const halfSpread = 0.5 * item.spreadFactor * fair;
        const bid = Number(Math.max(0.01, fair - halfSpread).toFixed(4));
        const ask = Number(Math.max(bid + 0.02, fair + halfSpread).toFixed(4));
        const mid = Number((0.5 * (bid + ask)).toFixed(4));
        return {
          details: {
            ticker: makeOcc(item.ct, item.strike),
            contract_type: item.ct,
            strike_price: item.strike,
            expiration_date: expiryDate,
            shares_per_contract: 100,
          },
          day: { volume: 1_200 },
          open_interest: item.oi,
          implied_volatility: vol,
          last_quote: { bid, ask, midpoint: mid },
          last_trade: { price: mid, sip_timestamp: String(asOfUtcSec * 1_000_000_000) },
          underlying_asset: { ticker: 'SPY', price: spot },
        };
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({ status: 'OK', results }),
        headers: {},
      });
    }
    if (path === '/stocks/v1/dividends' || path === '/options/v1/unusual-trades') {
      return Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ status: 'OK', results: [] }), headers: {} });
    }
    return Promise.resolve({ ok: false, status: 404, text: JSON.stringify({ status: 'NOT_FOUND' }), headers: {} });
  };
}

describe('Argentina server math, BYMA options, /api/ar/* routes & US options upgrades', () => {
  const activeServers: HttpWsServerHandle[] = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      const srv = activeServers.pop();
      if (srv !== undefined) {
        await srv.stop();
      }
    }
  });

  it('matches Python reference within 1e-9 for sovereign bond XIRR, duration, parity & accrued interest', () => {
    for (const testCase of FIXTURE.bondCases) {
      const actual = evaluateSovereignBondMath(
        testCase.spec,
        testCase.marketPriceUsd,
        testCase.asOfUtcSec,
      );
      const keys = ['tirPct', 'parityPct', 'duration', 'accruedInterest'] as const;
      for (const k of keys) {
        const expVal = testCase.expected[k];
        const actVal = actual[k];
        if (expVal === null) {
          expect(actVal, `${testCase.name}.${k}`).toBeNull();
        } else {
          expect(actVal, `${testCase.name}.${k}`).not.toBeNull();
          expect(Math.abs((actVal as number) - expVal), `${testCase.name}.${k}`).toBeLessThan(1e-9);
        }
      }
    }

    const firstSpec = FIXTURE.bondCases[0]?.spec;
    expect(firstSpec).toBeDefined();
    if (firstSpec !== undefined) {
      const nanRes = evaluateSovereignBondMath(firstSpec, Number.NaN, FIXTURE.asOfUtcSec);
      expect(nanRes).toEqual({
        tirPct: null,
        parityPct: null,
        duration: null,
        accruedInterest: null,
      });
    }
  });

  it('matches Python reference for BYMA option symbol parsing & 21% IVA option commission math', () => {
    for (const c of FIXTURE.optionSymbolCases) {
      const actual = parseBymaOptionSymbol(c.rawSymbol, c.spotHint, c.asOfUtcSec);
      expect(actual, c.rawSymbol).toEqual(c.expected);
    }

    const costCheck = ArgentinaMarketRuntime.evaluateBymaOptionCostAndFair({
      spot: 6_400,
      strike: 6_400,
      daysToExpiry: 39,
      rateContinuous: Math.log(1.32),
      dividendYield: 0.012,
      volatility: 0.54,
      contractType: 'call',
    });
    expect(Number.isFinite(costCheck.fairPrice)).toBe(true);
    expect(costCheck.fairPrice).toBeGreaterThan(0);
    const expectedFee = costCheck.fairPrice * 100 * 0.0020 * 1.21;
    expect(Math.abs(costCheck.commissionWithVatArsPerLot - expectedFee)).toBeLessThan(1e-9);

    for (const feeCase of FIXTURE.feeCases) {
      const derived = feeCase.fairPrice * feeCase.lotSize * feeCase.optionsFeeRate * (1 + feeCase.vatRate);
      expect(Math.abs(derived - feeCase.expectedCommissionWithVatArsPerLot)).toBeLessThan(1e-9);
    }
  });

  it('serves all /api/ar/* HTTP endpoints cleanly from offline Data912 + OpenBYMA + BCRA + ArgentinaDatos mocks', async () => {
    const fixedNowMs = FIXTURE.asOfUtcSec * 1_000;
    const arRuntime = new ArgentinaMarketRuntime({
      minData912IntervalMs: 0,
      nowMsFn: () => fixedNowMs,
      fetchFn: createOfflineArgentinaHttp({ asOfUtcSec: FIXTURE.asOfUtcSec }),
    });
    const usRuntime = new MarketRuntime({
      apiKey: 'TEST_US_KEY_NOT_USED',
      secrets: ['TEST_US_KEY_NOT_USED'],
      nowMsFn: () => fixedNowMs,
      enableWs: false,
      fetchFn: createSparseUsOptionsMassiveFetch(FIXTURE.asOfUtcSec),
    });

    const server = createHttpWsServer({
      runtime: usRuntime,
      arRuntime,
      host: '127.0.0.1',
      port: 0,
      startRuntimeWs: false,
    });
    activeServers.push(server);
    const { host, port } = await server.start();
    const base = `http://${host}:${String(port)}`;

    const fetchChecked = async <T>(path: string): Promise<T> => {
      const res = await fetch(`${base}${path}`);
      const text = await res.text();
      expect(res.status, `${path} -> ${text}`).toBe(200);
      expect(text, `${path} NaN/Inf leak`).not.toMatch(/(?<=[:,[])\s*(?:NaN|-?Infinity|undefined)\b/);
      return JSON.parse(text) as T;
    };

    const overview = await fetchChecked<ArOverviewResponse>('/api/ar/overview');
    expect(overview.feedStatus).toBe('LIVE');
    expect(overview.data912Status).toBe('OK');
    expect(overview.openBymaStatus).toBe('OK');
    expect(overview.mervalStocks.length).toBeGreaterThan(0);
    expect(overview.mepCclMatrix.length).toBeGreaterThan(0);
    expect(overview.mepMedian).not.toBeNull();
    expect(overview.cclMedian).not.toBeNull();

    const macro = await fetchChecked<ArMacroResponse>('/api/ar/macro');
    expect(macro.variables.badlarTna).toBeCloseTo(32.0, 6);
    expect(macro.variables.tamarTna).toBeCloseTo(33.4, 6);
    expect(macro.variables.cer).toBeCloseTo(548.21, 6);
    expect(macro.variables.uva).toBeCloseTo(1365.4, 6);
    expect(macro.variables.inflacionMensualPct).toBeCloseTo(2.4, 6);
    expect(macro.variables.riesgoPaisPb).toBe(720);
    expect(macro.dolares.length).toBeGreaterThanOrEqual(4);
    expect(macro.cards.length).toBeGreaterThan(0);
    const al29 = macro.sovereignCurve.find((b) => b.ticker === 'AL29');
    expect(al29).toBeDefined();
    expect(al29?.tirPct).not.toBeNull();
    expect(al29?.parityPct).not.toBeNull();
    expect(al29?.duration).not.toBeNull();

    for (const panel of ['acciones', 'bonos', 'cedears', 'cauciones'] as const) {
      const mon = await fetchChecked<ArMonitoringResponse>(`/api/ar/monitoring?panel=${panel}`);
      expect(mon.panel).toBe(panel);
    }
    const invalidPanelRes = await fetch(`${base}/api/ar/monitoring?panel=invalid`);
    expect(invalidPanelRes.status).toBe(400);

    const stock = await fetchChecked<ArStockDetailResponse>('/api/ar/stock?symbol=GGAL');
    expect(stock.symbol).toBe('GGAL');
    expect(stock.stock?.last).toBe(6400);
    expect(stock.historicalBars.length).toBe(70);
    expect(stock.realizedVol20d).not.toBeNull();
    expect(stock.realizedVol60d).not.toBeNull();
    expect(stock.realizedVolUsd20d).not.toBeNull();
    expect(stock.rsi14).not.toBeNull();
    expect(stock.ema21).not.toBeNull();
    expect(stock.mtfRegime).not.toBe('NO_DATA');

    const options = await fetchChecked<ArOptionsResponse>('/api/ar/options?underlying=GGAL');
    expect(options.underlying).toBe('GGAL');
    expect(options.settlement).toBe('T+0');
    expect(options.exerciseCutoffArt).toBe('15:30 ART');
    expect(options.expiries.length).toBeGreaterThanOrEqual(2);
    expect(options.termStructure.length).toBeGreaterThanOrEqual(2);
    expect(options.realizedVol20d).not.toBeNull();
    expect(options.vrpSpread).not.toBeNull();
    expect(options.costSchedule.optionsFeeRate).toBeCloseTo(0.002, 9);
    expect(options.costSchedule.vatRate).toBeCloseTo(0.21, 9);

    const relations = await fetchChecked<ArRelationsResponse>('/api/ar/relations');
    expect(relations.pairs.length).toBe(3);
    for (const pair of relations.pairs) {
      expect(pair.currentValue).not.toBeNull();
      expect(pair.mean60d).not.toBeNull();
      expect(pair.std60d).not.toBeNull();
      expect(pair.zScore).not.toBeNull();
      expect(pair.history.length).toBeGreaterThan(30);
    }
  });

  it('degrades feedStatus honestly across DIFERIDO_20M, PARTIAL (OpenBYMA fallback) and NO_DATA without silent fallbacks', async () => {
    const fixedNowMs = FIXTURE.asOfUtcSec * 1_000;

    // 1. OpenBYMA fails while Data912 succeeds -> DIFERIDO_20M
    const deferredRt = new ArgentinaMarketRuntime({
      minData912IntervalMs: 0,
      nowMsFn: () => fixedNowMs,
      fetchFn: createOfflineArgentinaHttp({
        asOfUtcSec: FIXTURE.asOfUtcSec,
        failOpenByma: true,
      }),
    });
    const deferredOverview = await deferredRt.getOverview(true);
    expect(deferredOverview.feedStatus).toBe('DIFERIDO_20M');
    expect(deferredOverview.mervalStocks.find((s) => s.ticker === 'GGAL')?.last).toBe(6400);

    // 2. Data912 fails while OpenBYMA succeeds -> PARTIAL with OpenBYMA prices
    const openBymaFallbackRt = new ArgentinaMarketRuntime({
      minData912IntervalMs: 0,
      nowMsFn: () => fixedNowMs,
      fetchFn: createOfflineArgentinaHttp({
        asOfUtcSec: FIXTURE.asOfUtcSec,
        failData912: true,
      }),
    });
    const partialOverview = await openBymaFallbackRt.getOverview(true);
    expect(partialOverview.feedStatus).toBe('PARTIAL');
    expect(partialOverview.data912Status).toBe('ERROR');
    expect(partialOverview.openBymaStatus).toBe('OK');
    const ggalPartial = partialOverview.mervalStocks.find((s) => s.ticker === 'GGAL');
    expect(ggalPartial?.source).toBe('OPEN_BYMA');
    expect(ggalPartial?.last).toBe(6400);

    // 3. All feeds fail -> NO_DATA with nulls (zero fake fallback numbers)
    const noDataRt = new ArgentinaMarketRuntime({
      minData912IntervalMs: 0,
      nowMsFn: () => fixedNowMs,
      fetchFn: createOfflineArgentinaHttp({
        asOfUtcSec: FIXTURE.asOfUtcSec,
        failData912: true,
        failOpenByma: true,
        failBcra: true,
        failArgDatos: true,
      }),
    });
    const noDataOverview = await noDataRt.getOverview(true);
    expect(noDataOverview.feedStatus).toBe('NO_DATA');
    expect(noDataOverview.mepMedian).toBeNull();
    expect(noDataOverview.cclMedian).toBeNull();
    expect(noDataOverview.mervalStocks.every((s) => s.last === null)).toBe(true);
    expect(noDataOverview.providerErrors.length).toBeGreaterThan(0);
  });

  it('computes analytical forward fallback (< 3 parity pairs) and ±25% deep Put Wall in US MarketRuntime', async () => {
    const fixedNowMs = FIXTURE.asOfUtcSec * 1_000;
    const spot = 600.0;
    const rate = 0.043;
    const expUtcSec = Math.floor(Date.UTC(2025, 3, 11, 20, 0, 0) / 1_000);
    const tExp = (expUtcSec - FIXTURE.asOfUtcSec) / (365 * 86_400);
    const expectedAnalyticalForward = spot * Math.exp(rate * tExp);

    const usRuntime = new MarketRuntime({
      apiKey: 'TEST_SPARSE_US_KEY',
      secrets: ['TEST_SPARSE_US_KEY'],
      nowMsFn: () => fixedNowMs,
      enableWs: false,
      fetchFn: createSparseUsOptionsMassiveFetch(FIXTURE.asOfUtcSec),
    });

    const snap: TerminalSnapshotResponse = await usRuntime.getSnapshot('SPY', { forceRefresh: true });
    expect(snap.volSurfaceSummary?.frontSlice).not.toBeNull();
    const frontForward = snap.volSurfaceSummary?.frontSlice?.forward ?? null;
    expect(frontForward).not.toBeNull();
    expect(Math.abs((frontForward as number) - expectedAnalyticalForward)).toBeLessThan(1e-6);

    // Wide-spread (+15% strike = 690, spread 0.65 <= 0.85 relaxation) still receives own IV
    const contract690 = snap.volSurfaceSummary?.contracts.find((c) => c.strike === 690);
    expect(contract690).toBeDefined();
    expect(contract690?.ivSource).toBe('OWN');
    expect(contract690?.ownIv).not.toBeNull();

    // Deep OTM Put Wall (-20% strike = 480, within ±25%) is detected cleanly
    expect(snap.exposureSummary?.putWallStrike).toBe(480);
  });
});
