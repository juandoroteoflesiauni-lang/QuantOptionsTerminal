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
import type { Bar } from '../src/core/types.js';
import type { FetchFn } from '../src/data/types.js';
import {
  type ArMacroResponse,
  type ArMonitoringResponse,
  type ArOptionsResponse,
  type ArOverviewResponse,
  type ArRelationsResponse,
  type ArStockDetailResponse,
  ArgentinaMarketRuntime,
  computeBasketRelativeSeries,
  computeRelationPairStats,
  computeSyntheticUsdFuturesCurve,
  evaluateSovereignBondMath,
  parseBymaOptionSymbol,
} from '../src/server/argentinaMarketLoader.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import {
  DEFAULT_RELATIONS_US_TICKERS,
  MarketRuntime,
  type TerminalSnapshotResponse,
} from '../src/server/marketRuntime.js';

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

  it('activates 24/7 EOD_CIERRE fallback on empty live feeds, expands 20/14/13 universe & wires Piezas 15-18 engines (Pieza 19)', async () => {
    const fixedNowMs = FIXTURE.asOfUtcSec * 1_000;
    const baseFetch = createOfflineArgentinaHttp({ asOfUtcSec: FIXTURE.asOfUtcSec });

    const weekendEodFetch: FetchFn = (url) => {
      const { hostname, pathname } = new URL(url);
      const okJson = (payload: unknown) =>
        Promise.resolve({ ok: true, status: 200, text: JSON.stringify(payload), headers: {} });
      if (hostname.includes('argentinadatos') && pathname === '/v1/finanzas/tasas/plazoFijo') {
        return okJson([{ entidad: 'BNA', tnaClientes: 33.5 }]);
      }
      if (
        hostname.includes('data912') &&
        (pathname === '/live/arg_stocks' ||
          pathname === '/live/arg_cedears' ||
          pathname === '/live/arg_bonds')
      ) {
        return okJson([]);
      }
      if (
        hostname.includes('open.bymadata') &&
        (pathname.endsWith('/leading-equity') || pathname.endsWith('/general-equity'))
      ) {
        return okJson({ data: [] });
      }
      return baseFetch(url);
    };

    const eodRt = new ArgentinaMarketRuntime({
      minData912IntervalMs: 0,
      nowMsFn: () => fixedNowMs,
      fetchFn: weekendEodFetch,
    });
    await eodRt.warmup(true);

    const eodOverview = await eodRt.getOverview();
    expect(eodOverview.feedStatus).toBe('EOD_CIERRE');
    expect(eodOverview.mervalStocks.length).toBeGreaterThanOrEqual(20);
    for (const reqTicker of [
      'GGAL', 'YPFD', 'PAMP', 'BMA', 'TXAR', 'ALUA', 'CEPU', 'TGSU2', 'TRAN', 'EDN',
      'COME', 'CRES', 'LOMA', 'MIRG', 'SUPV', 'BBAR', 'VALO', 'BYMA', 'METR', 'TGNO4',
    ]) {
      expect(eodOverview.mervalStocks.some((s) => s.ticker === reqTicker)).toBe(true);
    }
    expect(eodOverview.cedears.length).toBeGreaterThanOrEqual(14);
    for (const reqCedear of [
      'SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'KO', 'MELI', 'BABA', 'XLE', 'EWZ',
    ]) {
      expect(eodOverview.cedears.some((c) => c.ticker === reqCedear)).toBe(true);
    }
    expect(eodOverview.mervalStocks.find((s) => s.ticker === 'GGAL')?.last).not.toBeNull();
    expect(eodOverview.mervalStocks.find((s) => s.ticker === 'GGAL')?.source).toBe('DATA912');

    const eodMonitoringBonos = await eodRt.getMonitoring('bonos', true);
    expect(eodMonitoringBonos.bonds.length).toBeGreaterThanOrEqual(9);
    for (const reqBond of ['AL29', 'AL30', 'GD30', 'AL35', 'GD35', 'AE38', 'TX26', 'TX28', 'TZX26']) {
      expect(eodMonitoringBonos.bonds.some((b) => b.ticker === reqBond)).toBe(true);
    }

    const eodMacro = await eodRt.getMacro(true);
    expect(eodMacro.variables.plazoFijoTna).toBeCloseTo(33.5, 6);

    const liveFetch = createOfflineArgentinaHttp({ asOfUtcSec: FIXTURE.asOfUtcSec });
    const fullRt = new ArgentinaMarketRuntime({
      minData912IntervalMs: 0,
      nowMsFn: () => fixedNowMs,
      fetchFn: fullWrapFetch(liveFetch),
    });

    function fullWrapFetch(inner: FetchFn): FetchFn {
      return (url) => {
        const { hostname, pathname } = new URL(url);
        if (hostname.includes('argentinadatos') && pathname === '/v1/finanzas/tasas/plazoFijo') {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: JSON.stringify([{ entidad: 'BNA', tnaClientes: 33.5 }]),
            headers: {},
          });
        }
        return inner(url);
      };
    }

    const relations = await fullRt.getRelations(true);
    expect(relations.pairs.length).toBe(3);
    expect(relations.extendedPairs?.length).toBe(5);
    expect(relations.extendedPairs?.some((p) => p.id === 'ypfd-pamp')).toBe(true);
    expect(relations.extendedPairs?.some((p) => p.id === 'spy-qqq')).toBe(true);

    const ggalDetail = await fullRt.getStockDetail('GGAL', true);
    expect(ggalDetail.institutionalEngines).toBeDefined();
    expect(ggalDetail.institutionalEngines).not.toBeNull();
    expect(ggalDetail.institutionalEngines?.volumeProfile?.status).toBe('OK');
    expect(ggalDetail.institutionalEngines?.atr14).toBeGreaterThan(0);
    expect(ggalDetail.institutionalEngines?.relativeStrength?.status).toBe('OK');
    expect(ggalDetail.institutionalEngines?.nakedPocs).not.toBeNull();
    expect(ggalDetail.institutionalEngines?.fvgs).not.toBeNull();
    expect(ggalDetail.institutionalEngines?.orderBlocks).not.toBeNull();
    expect(ggalDetail.institutionalEngines?.confluenceClusters).not.toBeNull();

    const ggalOpts = await fullRt.getOptionsChain('GGAL', true);
    expect(ggalOpts.quantEngines).toBeDefined();
    expect(ggalOpts.quantEngines).not.toBeNull();
    expect(ggalOpts.quantEngines?.orderFlowArs).not.toBeNull();
    expect(ggalOpts.quantEngines?.netDirectionalPremiumUsdCcl).not.toBeNull();
    expect(ggalOpts.quantEngines?.flowAdjustedGex).not.toBeNull();
    expect(ggalOpts.quantEngines?.gexCharmPin).not.toBeNull();
    expect(ggalOpts.quantEngines?.qDistribution?.status).toBe('OK');
    expect(ggalOpts.quantEngines?.pDistribution?.status).toBe('OK');
    expect(ggalOpts.quantEngines?.pqDivergence?.status).toBe('OK');
    expect(ggalOpts.quantEngines?.volCone?.status).toBe('OK');
    expect(ggalOpts.quantEngines?.syntheticRates).not.toBeNull();
    expect(ggalOpts.quantEngines?.buyWrite?.status).toBe('OK');
    expect(ggalOpts.quantEngines?.calendarRoll?.status).toBe('OK');
    expect(ggalOpts.quantEngines?.structureOptimizerBullish?.status).toBe('OK');
    expect(ggalOpts.quantEngines?.structureOptimizerBearish).not.toBeNull();
    expect(ggalOpts.quantEngines?.confluenceClusters).not.toBeNull();
  });

  it('cubre los 7 arreglos BYMA/USD: cascada IV Puts ITM, vencimiento líquido, volumeArs, alias VIST y sintéticos CIP', async () => {
    // 1) Matemática exacta de Futuros Sintéticos USD (tolerancia 1e-9) y sin fallback si falta SOFR
    const fixedNow = Date.UTC(2026, 10, 14, 15, 0, 0) / 1_000;
    expect(
      computeSyntheticUsdFuturesCurve({
        nowSec: fixedNow,
        a3500: 1000,
        arsRateTnaPct: 36,
        arsRateSource: 'BCRA TAMAR',
        usdRatePct: null,
        usdRateSource: 'NY Fed SOFR',
        ccl: 1150,
      }),
    ).toEqual([]);

    const synthCurve = computeSyntheticUsdFuturesCurve({
      nowSec: fixedNow,
      a3500: 1005.5,
      arsRateTnaPct: 34.5,
      arsRateSource: 'BCRA TAMAR',
      usdRatePct: 3.9,
      usdRateSource: 'NY Fed SOFR',
      ccl: 1180,
    });
    expect(synthCurve.length).toBe(6);
    expect(synthCurve.map((c) => c.contract)).toEqual([
      'DLR-NOV26-SINT',
      'DLR-DIC26-SINT',
      'DLR-ENE27-SINT',
      'DLR-FEB27-SINT',
      'DLR-MAR27-SINT',
      'DLR-ABR27-SINT',
    ]);
    const rArsCont = (365 / 30) * Math.log(1 + (34.5 / 100) * (30 / 365));
    const rUsdCont = Math.log(1 + 3.9 / 100);
    for (const row of synthCurve) {
      const expectedFwd = 1005.5 * Math.exp((rArsCont - rUsdCont) * (row.days / 365));
      expect(Math.abs(row.forwardPrice - expectedFwd)).toBeLessThan(1e-9);
      expect(row.badge).toBe('SINTÉTICO IMPLÍCITO');
    }

    // 2) Cascada IV Put ITM (mid < K - S), herencia por paridad, selección de vencimiento líquido, volumeArs y alias VIST
    const ggalSpot = 5005;
    const baseFetch = createOfflineArgentinaHttp({ asOfUtcSec: FIXTURE.asOfUtcSec });
    const abDays = parseBymaOptionSymbol('GFGC5000AB', ggalSpot, FIXTURE.asOfUtcSec)?.daysToExpiry ?? 39;
    const juDays = parseBymaOptionSymbol('GFGC5000JU', ggalSpot, FIXTURE.asOfUtcSec)?.daysToExpiry ?? 102;
    const juTime = Math.max(1 / 365, juDays / 365);

    const seenPaths: string[] = [];
    const customFetch: FetchFn = (url) => {
      const parsed = new URL(url);
      seenPaths.push(`${parsed.hostname}${parsed.pathname}`);
      const okJson = (payload: unknown) =>
        Promise.resolve({ ok: true, status: 200, text: JSON.stringify(payload), headers: {} });

      if (parsed.hostname.includes('newyorkfed')) {
        return okJson({
          refRates: [{ effectiveDate: '2026-11-12', type: 'SOFR', percentRate: 3.9 }],
        });
      }
      if (parsed.hostname.includes('data912') && parsed.pathname === '/live/arg_stocks') {
        return okJson([
          { symbol: 'GGAL', c: ggalSpot, px_bid: 5000, px_ask: 5010, prev_close: 4950, v: 900_000, v_ars: 4_500_000_000 },
          { symbol: 'YPFD', c: 41200, px_bid: 41100, px_ask: 41250, prev_close: 40500, v: 148_000, v_ars: 6_100_000_000 },
        ]);
      }
      if (parsed.hostname.includes('open.bymadata') && parsed.pathname.endsWith('/leading-equity')) {
        return okJson({
          data: [
            {
              symbol: 'GGAL',
              trade: ggalSpot,
              bidPrice: 5000,
              askPrice: 5010,
              closingPrice: 4950,
              volumeAmount: 4_500_000_000,
              nominalVolume: 900_000,
            },
            {
              symbol: 'YPFD',
              trade: 41200,
              bidPrice: 41100,
              askPrice: 41250,
              closingPrice: 40500,
              volumeAmount: 6_100_000_000,
              nominalVolume: 148_000,
            },
          ],
        });
      }
      if (parsed.hostname.includes('data912') && parsed.pathname === '/live/arg_options') {
        const makeFair = (k: number, isCall: boolean, days: number, volPct: number) =>
          priceBsm({
            spot: ggalSpot,
            strike: k,
            timeToExpiry: Math.max(1 / 365, days / 365),
            rate: 0.28,
            dividendYield: 0.012,
            volatility: volPct,
            contractType: isCall ? 'call' : 'put',
          });

        const sparseFrontCall = makeFair(6600, true, abDays, 1.45);
        const deepCall6000 = makeFair(6000, true, juDays, 0.52);
        return okJson([
          // Vencimiento cercano (AB) con un único strike ilíquido y vol 0 -> NO debe ser primaryLiquidExpiryCode
          { symbol: 'GFGC6600AB', c: sparseFrontCall, px_bid: sparseFrontCall * 0.95, px_ask: sparseFrontCall * 1.05, v: 0, q_op: 0 },
          // Vencimiento líquido (JU) con >= 5 strikes, volumen real y Put ITM 6000 con mid < K - S (973.5 < 995)
          { symbol: 'GFGC4400JU', c: makeFair(4400, true, juDays, 0.56), px_bid: makeFair(4400, true, juDays, 0.56) * 0.98, px_ask: makeFair(4400, true, juDays, 0.56) * 1.02, v: 50, q_op: 2 },
          { symbol: 'GFGV4400JU', c: makeFair(4400, false, juDays, 0.56), px_bid: makeFair(4400, false, juDays, 0.56) * 0.98, px_ask: makeFair(4400, false, juDays, 0.56) * 1.02, v: 80, q_op: 3 },
          { symbol: 'GFGC4800JU', c: makeFair(4800, true, juDays, 0.53), px_bid: makeFair(4800, true, juDays, 0.53) * 0.98, px_ask: makeFair(4800, true, juDays, 0.53) * 1.02, v: 420, q_op: 15 },
          { symbol: 'GFGV4800JU', c: makeFair(4800, false, juDays, 0.53), px_bid: makeFair(4800, false, juDays, 0.53) * 0.98, px_ask: makeFair(4800, false, juDays, 0.53) * 1.02, v: 210, q_op: 9 },
          { symbol: 'GFGC5000JU', c: makeFair(5000, true, juDays, 0.50), px_bid: makeFair(5000, true, juDays, 0.50) * 0.98, px_ask: makeFair(5000, true, juDays, 0.50) * 1.02, v: 1200, q_op: 45 },
          { symbol: 'GFGV5000JU', c: makeFair(5000, false, juDays, 0.50), px_bid: makeFair(5000, false, juDays, 0.50) * 0.98, px_ask: makeFair(5000, false, juDays, 0.50) * 1.02, v: 900, q_op: 32 },
          { symbol: 'GFGC5400JU', c: makeFair(5400, true, juDays, 0.51), px_bid: makeFair(5400, true, juDays, 0.51) * 0.98, px_ask: makeFair(5400, true, juDays, 0.51) * 1.02, v: 640, q_op: 21 },
          { symbol: 'GFGV5400JU', c: makeFair(5400, false, juDays, 0.51), px_bid: makeFair(5400, false, juDays, 0.51) * 0.98, px_ask: makeFair(5400, false, juDays, 0.51) * 1.02, v: 130, q_op: 4 },
          { symbol: 'GFGC6000JU', c: deepCall6000, px_bid: deepCall6000 * 0.98, px_ask: deepCall6000 * 1.02, v: 300, q_op: 11 },
          // Put ITM 6000 con mid = 973.5 (< 6000 - 5005 = 995, sobre cota europea K·e^{-rT}-S): resuelve vía cascada BSM
          { symbol: 'GFGV6000JU', c: 973.5, px_bid: 960, px_ask: 987, v: 45, q_op: 2 },
          // Put 6200 muy por debajo de la cota intrínseca americana y europea (400 < K·e^{-rT}-S): hereda IV de superficie [6000..6600] y calcula Delta propia
          { symbol: 'GFGV6200JU', c: 400, px_bid: 390, px_ask: 410, v: 10, q_op: 1 },
          { symbol: 'GFGC6600JU', c: makeFair(6600, true, juDays, 0.54), px_bid: makeFair(6600, true, juDays, 0.54) * 0.98, px_ask: makeFair(6600, true, juDays, 0.54) * 1.02, v: 180, q_op: 6 },
        ]);
      }
      if (parsed.hostname.includes('data912') && parsed.pathname === '/historical/cedears/VISTA') {
        return okJson({ Error: 'Nahh no tengo ese ticker loko' });
      }
      if (parsed.hostname.includes('data912') && parsed.pathname === '/historical/cedears/VIST') {
        return okJson(
          Array.from({ length: 70 }, (_, idx) => ({
            date: new Date((FIXTURE.asOfUtcSec - (70 - idx) * 86_400) * 1_000).toISOString().slice(0, 10),
            o: 20_000 + idx * 15,
            h: 20_100 + idx * 15,
            l: 19_900 + idx * 15,
            c: 20_050 + idx * 15,
            v: 50_000,
          })),
        );
      }
      return baseFetch(url);
    };

    expect(juTime).toBeGreaterThan(0);
    const rt = new ArgentinaMarketRuntime({
      minData912IntervalMs: 0,
      nowMsFn: () => FIXTURE.asOfUtcSec * 1_000,
      fetchFn: customFetch,
    });

    const macro = await rt.getMacro(true);
    expect(macro.variables.sofrUsdTna).toBeCloseTo(3.9, 6);
    expect(macro.syntheticFutures?.length).toBe(6);
    expect(macro.syntheticFutures?.[0]?.badge).toBe('SINTÉTICO IMPLÍCITO');

    const opts = await rt.getOptionsChain('GGAL', true);
    expect(opts.spot).toBeCloseTo(5005, 6);
    expect(opts.primaryLiquidExpiryCode).toBe('JU');
    expect(opts.quantEnginesByExpiry?.['JU']).not.toBeNull();
    const ivRank = opts.quantEngines?.volCone?.ivRank ?? null;
    expect(ivRank).not.toBeNull();
    if (ivRank !== null) {
      expect(ivRank).toBeGreaterThanOrEqual(0);
      expect(ivRank).toBeLessThanOrEqual(100);
    }

    const juExp = opts.expiries.find((e) => e.expiryCode === 'JU');
    expect(juExp).toBeDefined();
    const put6000 = juExp?.puts.find((p) => p.strike === 6000);
    expect(put6000?.iv).not.toBeNull();
    expect(put6000?.delta).not.toBeNull();
    expect(put6000?.ivOrigin).toBe('SOLVED');
    const put6200 = juExp?.puts.find((p) => p.strike === 6200);
    expect(put6200?.iv).not.toBeNull();
    expect(put6200?.delta).not.toBeNull();
    if (put6200?.delta != null) {
      expect(put6200.delta).toBeLessThan(0);
    }
    expect(put6200?.ivOrigin).toBe('INHERITED');
    expect(put6200?.source).toBe('MODEL');
    const call5000 = juExp?.calls.find((c) => c.strike === 5000);
    expect(call5000?.volumeArs).toBeCloseTo((call5000?.volume ?? 0) * (call5000?.last ?? 0) * 100, 4);

    const rel = await rt.getRelations(true);
    expect(seenPaths.some((p) => p.endsWith('/historical/cedears/VIST'))).toBe(true);
    const ypfdVist = rel.pairs.find((p) => p.id === 'ypfd-vista');
    expect(ypfdVist?.legB).toBe('VIST');
    expect(ypfdVist?.currentValue).not.toBeNull();
    expect(ypfdVist?.mean60d).not.toBeNull();
  });
});

interface RelationsMathExpected {
  readonly currentValue: number | null;
  readonly mean60d: number | null;
  readonly std60d: number | null;
  readonly zScore: number | null;
  readonly percentile60d: number | null;
  readonly halfLifeDays: number | null;
  readonly capitalFlowDeltaPct: number | null;
  readonly opportunityBadge: 'EXTREMO COMPRA' | 'EXTREMO VENTA' | 'DESVÍO MODERADO' | 'EN EQUILIBRIO' | null;
  readonly observationCount: number;
  readonly sparkline: readonly number[];
}

interface RelationsReferenceFixture {
  readonly mathCases: readonly {
    readonly name: string;
    readonly points: readonly { readonly time: number; readonly val: number }[];
    readonly shares: readonly number[] | null;
    readonly expected: RelationsMathExpected;
  }[];
  readonly basketUsdCclCase: {
    readonly cclByDate: Readonly<Record<string, number>>;
    readonly numBars: Readonly<Record<string, readonly Bar[]>>;
    readonly denBars: Readonly<Record<string, readonly Bar[]>>;
    readonly expected: RelationsMathExpected;
  };
}

const RELATIONS_FIXTURE: RelationsReferenceFixture = JSON.parse(
  readFileSync(new URL('../fixtures/relations_reference.json', import.meta.url), 'utf8'),
) as RelationsReferenceFixture;

describe('Pieza 22 — Módulo /relaciones (Rotación Sectorial, Liquidez, OU Half-Life & YPF/VIST Massive 1D)', () => {
  const activeRelServers: HttpWsServerHandle[] = [];

  afterEach(async () => {
    while (activeRelServers.length > 0) {
      const srv = activeRelServers.pop();
      if (srv !== undefined) {
        await srv.stop();
      }
    }
  });

  const expectCloseOrNull = (actual: number | null, expected: number | null, label: string): void => {
    if (expected === null) {
      expect(actual, label).toBeNull();
    } else {
      expect(actual, label).not.toBeNull();
      if (actual !== null) {
        expect(actual, label).toBeCloseTo(expected, 9);
      }
    }
  };

  it('matches Python independent OU half-life, capital flow 5d/20d, Z-score badges & USD-CCL basket reference (tol 1e-9)', () => {
    for (const mc of RELATIONS_FIXTURE.mathCases) {
      const actual = computeRelationPairStats(mc.points, mc.shares, 20);
      expectCloseOrNull(actual.currentValue, mc.expected.currentValue, `${mc.name}.currentValue`);
      expectCloseOrNull(actual.mean60d, mc.expected.mean60d, `${mc.name}.mean60d`);
      expectCloseOrNull(actual.std60d, mc.expected.std60d, `${mc.name}.std60d`);
      expectCloseOrNull(actual.zScore, mc.expected.zScore, `${mc.name}.zScore`);
      expectCloseOrNull(actual.percentile60d, mc.expected.percentile60d, `${mc.name}.percentile60d`);
      expectCloseOrNull(actual.halfLifeDays, mc.expected.halfLifeDays, `${mc.name}.halfLifeDays`);
      expectCloseOrNull(actual.capitalFlowDeltaPct, mc.expected.capitalFlowDeltaPct, `${mc.name}.capitalFlowDeltaPct`);
      expect(actual.opportunityBadge, `${mc.name}.opportunityBadge`).toBe(mc.expected.opportunityBadge);
      expect(actual.observationCount, `${mc.name}.observationCount`).toBe(mc.expected.observationCount);
      expect(actual.sparkline.length, `${mc.name}.sparkline.length`).toBe(mc.expected.sparkline.length);
      for (let i = 0; i < mc.expected.sparkline.length; i += 1) {
        expect(actual.sparkline[i]).toBeCloseTo(mc.expected.sparkline[i] ?? Number.NaN, 9);
      }
    }

    const basketCase = RELATIONS_FIXTURE.basketUsdCclCase;
    const cclMap = new Map<string, number>(Object.entries(basketCase.cclByDate));
    const series = computeBasketRelativeSeries({
      numBarsList: Object.values(basketCase.numBars),
      denBarsList: Object.values(basketCase.denBars),
      deflatorByDate: cclMap,
      denominatorAggregator: 'EQUAL_RETURN_INDEX',
      denominatorIsSuperset: false,
    });
    const actualBasket = computeRelationPairStats(series, null, 20);
    expectCloseOrNull(actualBasket.currentValue, basketCase.expected.currentValue, 'basket.currentValue');
    expectCloseOrNull(actualBasket.mean60d, basketCase.expected.mean60d, 'basket.mean60d');
    expectCloseOrNull(actualBasket.zScore, basketCase.expected.zScore, 'basket.zScore');
    expectCloseOrNull(
      actualBasket.capitalFlowDeltaPct,
      basketCase.expected.capitalFlowDeltaPct,
      'basket.capitalFlowDeltaPct',
    );
    expect(actualBasket.opportunityBadge).toBe(basketCase.expected.opportunityBadge);
  });

  it('computes YPF/VIST in USD via Massive 1D, global US rotation, AR baskets, capital flow deltas & serves /api/ar/relations without NaN', async () => {
    const asOfUtcSec = FIXTURE.asOfUtcSec;
    const endDayMs = Math.floor(asOfUtcSec / 86_400) * 86_400_000;
    const usCalls = new Map<string, number>();

    const usTickerSpecs: Readonly<
      Record<
        string,
        { readonly start: number; readonly amp: number; readonly tailMult: number; readonly volBase: number; readonly tailVolMult: number }
      >
    > = {
      YPF: { start: 25.0, amp: 0.25, tailMult: 0.72, volBase: 2_100_000, tailVolMult: 1.55 },
      VIST: { start: 48.0, amp: 0.30, tailMult: 1.18, volBase: 1_200_000, tailVolMult: 0.85 },
      SPY: { start: 580.0, amp: 2.2, tailMult: 1.01, volBase: 55_000_000, tailVolMult: 1.0 },
      QQQ: { start: 500.0, amp: 2.8, tailMult: 1.07, volBase: 32_000_000, tailVolMult: 1.25 },
      IWM: { start: 225.0, amp: 1.8, tailMult: 0.94, volBase: 24_000_000, tailVolMult: 0.9 },
      XLF: { start: 48.0, amp: 0.4, tailMult: 1.08, volBase: 30_000_000, tailVolMult: 1.35 },
      XLE: { start: 91.0, amp: 0.6, tailMult: 0.92, volBase: 14_000_000, tailVolMult: 0.85 },
      HYG: { start: 79.0, amp: 0.25, tailMult: 1.03, volBase: 28_000_000, tailVolMult: 1.15 },
      LQD: { start: 108.0, amp: 0.35, tailMult: 0.97, volBase: 19_000_000, tailVolMult: 0.9 },
      TLT: { start: 92.0, amp: 0.6, tailMult: 0.96, volBase: 25_000_000, tailVolMult: 1.0 },
      GLD: { start: 242.0, amp: 1.9, tailMult: 1.06, volBase: 8_000_000, tailVolMult: 1.3 },
      EWZ: { start: 28.0, amp: 0.3, tailMult: 0.96, volBase: 21_000_000, tailVolMult: 0.95 },
      GGAL: { start: 51.0, amp: 0.7, tailMult: 1.06, volBase: 1_500_000, tailVolMult: 1.2 },
      BMA: { start: 82.0, amp: 0.9, tailMult: 0.99, volBase: 600_000, tailVolMult: 0.95 },
      PAM: { start: 74.0, amp: 0.8, tailMult: 0.98, volBase: 450_000, tailVolMult: 0.95 },
    };

    const massiveFetch: FetchFn = (url) => {
      const u = new URL(url);
      if (u.pathname.startsWith('/v2/aggs/ticker/')) {
        const ticker = decodeURIComponent(u.pathname.split('/')[4] ?? 'SPY').toUpperCase();
        usCalls.set(ticker, (usCalls.get(ticker) ?? 0) + 1);
        const spec = usTickerSpecs[ticker] ?? {
          start: 100,
          amp: 1,
          tailMult: 1,
          volBase: 1_000_000,
          tailVolMult: 1,
        };
        const count = 80;
        const results = Array.from({ length: count }, (_, idx) => {
          const dayMs = endDayMs - (count - idx) * 86_400_000;
          const tailFactor = idx >= count - 1 ? spec.tailMult : 1.0;
          const close = Number(
            ((spec.start + Math.sin(idx * 0.45 + ticker.length) * spec.amp) * tailFactor).toFixed(4),
          );
          const volFactor = idx >= count - 5 ? spec.tailVolMult : 1.0;
          return {
            t: dayMs,
            o: Number((close * 0.995).toFixed(4)),
            h: Number((close * 1.008).toFixed(4)),
            l: Number((close * 0.992).toFixed(4)),
            c: close,
            v: Math.round(spec.volBase * volFactor),
            vw: close,
          };
        });
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({ status: 'OK', ticker, resultsCount: results.length, results }),
          headers: {},
        });
      }
      return Promise.resolve({ ok: false, status: 404, text: JSON.stringify({ error: 'Not mocked' }), headers: {} });
    };

    const usRuntime = new MarketRuntime({
      apiKey: 'test-massive-key',
      nowMsFn: () => asOfUtcSec * 1_000,
      enableWs: false,
      fetchFn: massiveFetch,
    });

    // Verificar cache 1D de MarketRuntime
    const batch1 = await usRuntime.getCachedDailyBars1dBatch(DEFAULT_RELATIONS_US_TICKERS, 90, false);
    expect(batch1.get('YPF')?.error).toBeNull();
    expect((batch1.get('YPF')?.bars.length ?? 0)).toBeGreaterThanOrEqual(70);
    expect(batch1.get('YPF')?.cacheHit).toBe(false);
    const ypfCallsBeforeCache = usCalls.get('YPF') ?? 0;

    const batch2 = await usRuntime.getCachedDailyBars1dBatch(DEFAULT_RELATIONS_US_TICKERS, 90, false);
    expect(batch2.get('YPF')?.cacheHit).toBe(true);
    expect(usCalls.get('YPF') ?? 0).toBe(ypfCallsBeforeCache);

    const baseArFetch = createOfflineArgentinaHttp({ asOfUtcSec });
    const arCustomFetch = async (url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname.includes('data912') && parsed.pathname.startsWith('/historical/stocks/')) {
        const ticker = (parsed.pathname.split('/').pop() ?? 'GGAL').toUpperCase();
        const isBank = ['GGAL', 'BMA', 'SUPV', 'BBAR'].includes(ticker);
        const isReg = ['TRAN', 'EDN', 'METR', 'TGNO4'].includes(ticker);
        const count = 75;
        const rows = Array.from({ length: count }, (_, idx) => {
          const dayMs = endDayMs - (count - idx) * 86_400_000;
          const date = new Date(dayMs).toISOString().slice(0, 10);
          const base =
            ticker === 'GGAL'
              ? 6_000
              : ticker === 'BMA'
              ? 10_000
              : ticker === 'SUPV'
              ? 2_800
              : ticker === 'BBAR'
              ? 7_200
              : ticker === 'YPFD'
              ? 38_000
              : ticker === 'PAMP'
              ? 3_600
              : isReg
              ? 2_100
              : 4_500;
          const drift = isBank ? idx * 14 : isReg ? idx * 8 : idx * 3;
          const close = Number(
            (base + drift + Math.sin(idx * 0.41 + ticker.length) * base * 0.025).toFixed(4),
          );
          const volMult = isBank && idx >= count - 5 ? 1.85 : isReg && idx >= count - 5 ? 1.45 : 1.0;
          return {
            date,
            o: Number((close * 0.996).toFixed(4)),
            h: Number((close * 1.012).toFixed(4)),
            l: Number((close * 0.988).toFixed(4)),
            c: close,
            v: Math.round(350_000 * volMult),
          };
        });
        return { ok: true, status: 200, text: JSON.stringify(rows), headers: {} };
      }

      if (parsed.hostname.includes('data912') && parsed.pathname.startsWith('/historical/bonds/')) {
        const ticker = (parsed.pathname.split('/').pop() ?? 'GD30D').toUpperCase();
        const count = 75;
        const rows = Array.from({ length: count }, (_, idx) => {
          const dayMs = endDayMs - (count - idx) * 86_400_000;
          const date = new Date(dayMs).toISOString().slice(0, 10);
          const c =
            ticker === 'GD30D'
              ? 68.5 + idx * 0.04 + Math.sin(idx * 0.25) * 0.6
              : ticker === 'AL30D'
              ? 64.2 + idx * 0.02 + Math.cos(idx * 0.22) * 0.4
              : ticker === 'GD35D'
              ? 59.8 + idx * 0.06 + Math.sin(idx * 0.31) * 0.7
              : ticker === 'GD30'
              ? (68.5 + idx * 0.04) * (1185 + idx * 0.9)
              : ticker === 'AL30'
              ? (64.2 + idx * 0.02) * (1185 + idx * 0.9)
              : ticker === 'GD30C'
              ? 67.1 + idx * 0.03 + Math.sin(idx * 0.29) * 0.35
              : 62.9 + idx * 0.015 + Math.cos(idx * 0.27) * 0.3;
          const close = Number(c.toFixed(4));
          return {
            date,
            o: Number((close * 0.996).toFixed(4)),
            h: Number((close * 1.008).toFixed(4)),
            l: Number((close * 0.992).toFixed(4)),
            c: close,
            v: 1_200_000,
          };
        });
        return { ok: true, status: 200, text: JSON.stringify(rows), headers: {} };
      }

      return baseArFetch(url);
    };

    const arRuntime = new ArgentinaMarketRuntime({
      minData912IntervalMs: 0,
      nowMsFn: () => asOfUtcSec * 1_000,
      fetchFn: arCustomFetch,
      usRuntime,
    });

    const server = createHttpWsServer({
      runtime: usRuntime,
      arRuntime,
      host: '127.0.0.1',
      port: 0,
      startRuntimeWs: false,
    });
    activeRelServers.push(server);
    const { host, port } = await server.start();
    const res = await fetch(`http://${host}:${String(port)}/api/ar/relations`);
    const bodyText = await res.text();
    expect(res.status).toBe(200);
    expect(bodyText).not.toMatch(/(?<=[:,[])\s*(?:NaN|-?Infinity|undefined)\b/);

    const rel = JSON.parse(bodyText) as ArRelationsResponse;
    expect(rel.pairs.length).toBe(3);
    expect(rel.extendedPairs?.length).toBe(5);

    const list = rel.relationPairs ?? [];
    expect(list.length).toBe(15);

    const expectedIds = [
      'ypf-vist',
      'ggal-ewz',
      'qqq-spy',
      'iwm-spy',
      'xlf-xle',
      'hyg-lqd',
      'gld-spy',
      'bancos-energia-ar',
      'reguladas-lider',
      'gd30-al30',
      'gd35-gd30',
      'ypfd-pamp',
      'ggal-bma',
      'ggal-supv',
      'ccl-mep',
    ];
    for (const id of expectedIds) {
      expect(list.some((p) => p.id === id), `missing relation ${id}`).toBe(true);
    }

    // YPF / VIST en NYSE USD real (no ARS) y con alerta EXTREMO COMPRA
    const ypfVist = list.find((p) => p.id === 'ypf-vist');
    expect(ypfVist?.source).toBe('MASSIVE_1D');
    expect(ypfVist?.legA).toBe('YPF');
    expect(ypfVist?.legB).toBe('VIST');
    expect(ypfVist?.currentValue).not.toBeNull();
    if (ypfVist?.currentValue != null) {
      expect(ypfVist.currentValue).toBeGreaterThan(0.1);
      expect(ypfVist.currentValue).toBeLessThan(1.0);
    }
    expect(ypfVist?.opportunityBadge).toBe('EXTREMO COMPRA');
    expect(ypfVist?.zScore).not.toBeNull();
    expect(ypfVist?.mean60d).not.toBeNull();
    expect(ypfVist?.std60d).not.toBeNull();
    expect(ypfVist?.percentile60d).not.toBeNull();
    expect(ypfVist?.sparkline?.length).toBe(30);
    expect(ypfVist?.capitalFlowDeltaPct).not.toBeNull();
    expect(ypfVist?.capitalFlowDeltaPct).toBeGreaterThan(10);

    // QQQ / SPY categoría corregida
    const qqqSpy = list.find((p) => p.id === 'qqq-spy');
    expect(qqqSpy?.category).toBe('ROTACIÓN US · TECH');
    expect(qqqSpy?.categoryGroup).toBe('ROTACION_SECTORIAL');
    expect(qqqSpy?.capitalFlowDeltaPct).not.toBeNull();

    // Canasta Bancos vs Energía AR USD-CCL + flujo sectorial 5d vs 20d
    const bancosEnergia = list.find((p) => p.id === 'bancos-energia-ar');
    expect(bancosEnergia?.source).toBe('MIXED_USD_CCL');
    expect(bancosEnergia?.currentValue).not.toBeNull();
    expect(bancosEnergia?.zScore).not.toBeNull();
    expect(bancosEnergia?.capitalFlowDeltaPct).not.toBeNull();
    if (bancosEnergia?.capitalFlowDeltaPct != null) {
      expect(bancosEnergia.capitalFlowDeltaPct).toBeGreaterThan(5);
    }

    // Reguladas vs Panel Líder, GD35/GD30, GGAL/SUPV, Canje CCL/MEP
    const reguladas = list.find((p) => p.id === 'reguladas-lider');
    expect(reguladas?.currentValue).not.toBeNull();
    expect(reguladas?.capitalFlowDeltaPct).not.toBeNull();

    const gd35 = list.find((p) => p.id === 'gd35-gd30');
    expect(gd35?.currentValue).not.toBeNull();
    expect(gd35?.capitalFlowDeltaPct).toBeNull();

    const ggalSupv = list.find((p) => p.id === 'ggal-supv');
    expect(ggalSupv?.currentValue).not.toBeNull();
    expect(ggalSupv?.zScore).not.toBeNull();

    const canje = list.find((p) => p.id === 'ccl-mep');
    expect(canje?.unit).toBe('%');
    expect(canje?.currentValue).not.toBeNull();
    expect(canje?.zScore).not.toBeNull();
    expect(canje?.capitalFlowDeltaPct).toBeNull();

    // Verificamos half-life AR(1) en pares con reversión cíclica (sin NaN/Infinity)
    expect(list.some((p) => p.halfLifeDays !== null && p.halfLifeDays !== undefined && p.halfLifeDays > 0)).toBe(
      true,
    );

    // Resumen agregado superior
    expect(rel.relationSummary).toBeDefined();
    expect(rel.relationSummary?.extremeTwoSigmaCount).toBeGreaterThanOrEqual(1);
    expect(rel.relationSummary?.topCapitalFlowPairId).not.toBeNull();
    expect(rel.relationSummary?.topCapitalFlowSector).not.toBeNull();
    expect(rel.relationSummary?.topCapitalFlowDeltaPct).not.toBeNull();
  });
});
