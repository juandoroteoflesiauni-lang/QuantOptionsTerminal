import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FetchResponse } from '../src/data/types.js';
import {
  collectBrokerSecretsFromEnv,
  computeOrderBookL2Metrics,
  decideGgalArsTick,
  derivePrimaryWsUrlFromApiUrl,
  loadPrimaryConfigFromEnv,
  parseMervInstrumentSymbol,
  PrimaryRofexClient,
  selectBymaL2Products,
  type GgalArsTickCache,
  type GgalArsTickFrameInput,
  type PrimaryWsFactory,
  type PrimaryWsLike,
} from '../src/server/primaryRofexLoader.js';
import { redactSecrets } from '../src/server/runtimeCache.js';
import {
  GgalTickStreamEngine,
  type GgalBarTickEvent,
} from '../src/server/ggalTickStream.js';

/* ============================================================================
   FIXTURE: referencia independiente (tools/gen_primary_eco_l2_fixture.py)
   ============================================================================ */
interface EcoConfigCase {
  readonly id: string;
  readonly env: NodeJS.ProcessEnv;
  readonly expected: {
    readonly apiUrl: string;
    readonly wsUrl: string;
    readonly usernameConfigured: boolean;
    readonly passwordConfigured: boolean;
    readonly configured: boolean;
  };
}

interface EcoTickCase {
  readonly id: string;
  readonly frame: GgalArsTickFrameInput;
  readonly cache: GgalArsTickCache | null;
  readonly expected: {
    readonly emit: boolean;
    readonly tick: { readonly price: number; readonly size: number; readonly timeSec: number } | null;
    readonly cache: GgalArsTickCache | null;
  };
}

interface EcoBookCase {
  readonly id: string;
  readonly symbol: string;
  readonly marketId: string;
  readonly frame: {
    readonly type: string;
    readonly timestamp: number;
    readonly instrumentId: { readonly marketId: string; readonly symbol: string };
    readonly marketData: {
      readonly BI?: readonly { readonly price: number; readonly size: number }[];
      readonly OF?: readonly { readonly price: number; readonly size: number }[];
      readonly LA?: { readonly price: number; readonly size: number | null; readonly date: number };
    };
  };
  readonly expected: {
    readonly bestBid: number | null;
    readonly bestAsk: number | null;
    readonly mid: number | null;
    readonly spread: number | null;
    readonly spreadPct: number | null;
    readonly bidDepthSize: number | null;
    readonly askDepthSize: number | null;
    readonly bidDepthNotional: number | null;
    readonly askDepthNotional: number | null;
    readonly vwapBid5: number | null;
    readonly vwapAsk5: number | null;
    readonly vwapBook5: number | null;
    readonly obi5: number | null;
    readonly orderedBids: readonly { readonly price: number; readonly size: number }[];
    readonly orderedAsks: readonly { readonly price: number; readonly size: number }[];
  };
}

interface EcoL2Fixture {
  readonly schemaVersion: number;
  readonly configCases: readonly EcoConfigCase[];
  readonly mervSymbolCases: readonly {
    readonly symbol: string;
    readonly parsed: { readonly ticker: string; readonly settlement: string; readonly rawSymbol: string } | null;
  }[];
  readonly selection: {
    readonly universeTickers: readonly string[];
    readonly optionPrefixes: readonly string[];
    readonly instruments: readonly { readonly marketId: string; readonly symbol: string }[];
    readonly expectedProducts: readonly { readonly marketId: string; readonly symbol: string }[];
  };
  readonly tickCases: readonly EcoTickCase[];
  readonly bookCases: readonly EcoBookCase[];
}

function loadEcoFixture(): EcoL2Fixture {
  const raw = readFileSync(resolve(process.cwd(), 'fixtures/primary_eco_l2_reference.json'), 'utf8');
  return JSON.parse(raw) as EcoL2Fixture;
}

function expectCloseOrNaN(actual: number, expected: number | null, tol = 1e-9): void {
  if (expected === null) {
    expect(Number.isNaN(actual)).toBe(true);
    return;
  }
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

/* ============================================================================
   ENTORNO DE PRUEBA — credenciales sintéticas, JAMÁS valores reales de .env
   ============================================================================ */
const ECO_ENV = {
  PRIMARY_BASE_URL: 'https://api.eco.xoms.com.ar',
  ECO_MATRIZ_USERNAME: 'eco_user_secret_337',
  ECO_MATRIZ_PASSWORD: 'eco_pass_secret_448',
} as const satisfies NodeJS.ProcessEnv;
const ECO_TOKEN = 'tok_eco_secret_header_919';

// Frame timestamps del fixture: 2026-11-20 19:20 UTC (viernes, en sesión BYMA).
const FIXTURE_FRAME_TS_MS = 1_795_202_400_000;
const TEST_NOW_MS = FIXTURE_FRAME_TS_MS + 1_500;

function makeJsonResp(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  };
}

interface MockWsHarness {
  readonly sentPayloads: string[];
  readonly wsUrls: string[];
  readonly wsHeaderCaptures: Readonly<Record<string, string>>[];
  readonly messageHandlers: ((data: unknown) => void)[];
}

function createMockWsFactory(harness: MockWsHarness): PrimaryWsFactory {
  return (url: string, headers: Readonly<Record<string, string>>): PrimaryWsLike => {
    harness.wsUrls.push(url);
    harness.wsHeaderCaptures.push(headers);
    const closeHandlers: (() => void)[] = [];
    const onFn = ((
      event: 'open' | 'message' | 'error' | 'close',
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'open') {
        queueMicrotask(() => {
          listener();
        });
      } else if (event === 'message') {
        harness.messageHandlers.push(listener);
      } else if (event === 'close') {
        closeHandlers.push(listener);
      }
      return sock;
    }) as PrimaryWsLike['on'];
    const sock: PrimaryWsLike = {
      readyState: 1,
      send(data: string) {
        harness.sentPayloads.push(data);
      },
      close() {
        for (const cb of closeHandlers) {
          cb();
        }
      },
      on: onFn,
    };
    return sock;
  };
}

function injectMdFrame(handlers: readonly ((data: unknown) => void)[], frame: unknown): void {
  for (const handler of handlers) {
    handler(JSON.stringify(frame));
  }
}

describe('Primary Eco Valores XOMS — L2 BYMA 5 puntas (MERV) + curva ROFEX', () => {
  /* --------------------------------------------------------------------------
   * 1) Paridad pura contra la referencia Python independiente (< 1e-9)
   * -------------------------------------------------------------------------- */
  it('deriva config multi-mercado (PRIMARY_BASE_URL / WS derivada / ECO_MATRIZ_*) contra fixtures/primary_eco_l2_reference.json', () => {
    const fixture = loadEcoFixture();
    for (const c of fixture.configCases) {
      const config = loadPrimaryConfigFromEnv(c.env);
      expect(config.apiUrl, c.id).toBe(c.expected.apiUrl);
      expect(config.wsUrl, c.id).toBe(c.expected.wsUrl);
      expect(config.username !== '', c.id).toBe(c.expected.usernameConfigured);
      expect(config.password !== '', c.id).toBe(c.expected.passwordConfigured);
      expect(config.configured, c.id).toBe(c.expected.configured);
    }
    // Derivación directa wss/ws y rechazo explícito de URLs no http(s)
    expect(derivePrimaryWsUrlFromApiUrl('https://api.eco.xoms.com.ar')).toBe('wss://api.eco.xoms.com.ar/');
    expect(derivePrimaryWsUrlFromApiUrl('https://api.eco.xoms.com.ar/')).toBe('wss://api.eco.xoms.com.ar/');
    expect(derivePrimaryWsUrlFromApiUrl('http://api.remarkets.primary.com.ar')).toBe('ws://api.remarkets.primary.com.ar/');
    expect(derivePrimaryWsUrlFromApiUrl('')).toBeNull();
    expect(derivePrimaryWsUrlFromApiUrl('ftp://invalid.example')).toBeNull();
  });

  it('parsea símbolos MERV con alias T1 -> 24hs contra la referencia Python', () => {
    const fixture = loadEcoFixture();
    for (const c of fixture.mervSymbolCases) {
      const parsed = parseMervInstrumentSymbol(c.symbol);
      if (c.parsed === null) {
        expect(parsed, c.symbol).toBeNull();
        continue;
      }
      expect(parsed?.ticker, c.symbol).toBe(c.parsed.ticker);
      expect(parsed?.settlement, c.symbol).toBe(c.parsed.settlement);
      expect(parsed?.rawSymbol, c.symbol).toBe(c.parsed.rawSymbol);
    }
  });

  it('selecciona el universo BYMA L2 (Merval + CEDEARs + GFGC/GFGV, CI de GGAL, fallback CI) contra la referencia Python', () => {
    const fixture = loadEcoFixture();
    const products = selectBymaL2Products(fixture.selection.instruments, {
      universeTickers: fixture.selection.universeTickers,
      optionPrefixes: fixture.selection.optionPrefixes,
    });
    expect(products).toEqual(fixture.selection.expectedProducts);
    // Invariantes explícitas del universo institucional:
    const symbols = products.map((p) => p.symbol);
    expect(symbols).toContain('MERV - XMEV - GGAL - 24hs');
    expect(symbols).toContain('MERV - XMEV - GGAL - CI');
    expect(symbols).toContain('MERV - XMEV - GFGC61120C - 24hs');
    expect(symbols).toContain('MERV - XMEV - GFGV62000P - CI');
    expect(symbols.filter((s) => s.includes(' - 48HS'))).toHaveLength(0);
    expect(symbols.filter((s) => s.includes('SPOT'))).toHaveLength(0);
    expect(symbols).not.toContain('MERV - XMEV - YPFD61120C - 24hs');
    // marketId descubierto se respeta (MERV en Eco, ROFX en reMarkets)
    const pamp = products.find((p) => p.symbol === 'MERV - XMEV - PAMP - 24hs');
    expect(pamp?.marketId).toBe('ROFX');
    const ggal = products.find((p) => p.symbol === 'MERV - XMEV - GGAL - 24hs');
    expect(ggal?.marketId).toBe('MERV');
  });

  it('decide la emisión del tick ARS de GGAL (LA vs BI/OF, sin doble conteo) contra la referencia Python', () => {
    const fixture = loadEcoFixture();
    for (const c of fixture.tickCases) {
      const decision = decideGgalArsTick(c.frame, c.cache);
      expect(decision.emit, c.id).toBe(c.expected.emit);
      if (c.expected.tick === null) {
        expect(decision.tick, c.id).toBeNull();
      } else {
        expect(decision.tick?.price, c.id).toBe(c.expected.tick.price);
        expect(decision.tick?.size, c.id).toBe(c.expected.tick.size);
        expect(decision.tick?.timeSec, c.id).toBe(c.expected.tick.timeSec);
      }
      if (c.expected.cache === null) {
        expect(decision.cache, c.id).toBeNull();
      } else {
        expect(decision.cache?.price, c.id).toBe(c.expected.cache.price);
        expect(decision.cache?.size, c.id).toBe(c.expected.cache.size);
        expect(decision.cache?.timeSec, c.id).toBe(c.expected.cache.timeSec);
      }
    }
  });

  /* --------------------------------------------------------------------------
   * 2) Integración: auth Eco XOMS -> /rest/instruments/all -> smd level 2 ->
   *    frames Md 5 niveles -> libro L2 en vivo + ticks ARS + redacción total
   * -------------------------------------------------------------------------- */
  it('autentica en Eco XOMS con ECO_MATRIZ_*, descubre por /rest/instruments/all, suscribe un único smd level 2 (MERV + DLR) y sirve la 5 puntas en vivo sin REST', async () => {
    const fixture = loadEcoFixture();
    const harness: MockWsHarness = {
      sentPayloads: [],
      wsUrls: [],
      wsHeaderCaptures: [],
      messageHandlers: [],
    };
    let authCalls = 0;
    const marketdataGetPaths: string[] = [];

    const client = new PrimaryRofexClient({
      env: ECO_ENV,
      nowMsFn: () => TEST_NOW_MS,
      wsFactory: createMockWsFactory(harness),
      fetchFn: async (url, init) => {
        await Promise.resolve();
        if (url === 'https://api.eco.xoms.com.ar/auth/getToken') {
          authCalls += 1;
          expect(init?.method).toBe('POST');
          expect(init?.headers?.['X-Username']).toBe(ECO_ENV.ECO_MATRIZ_USERNAME);
          expect(init?.headers?.['X-Password']).toBe(ECO_ENV.ECO_MATRIZ_PASSWORD);
          return makeJsonResp({ status: 'OK' }, 200, { 'x-auth-token': `${ECO_TOKEN}_${String(authCalls)}` });
        }
        expect(init?.headers?.['X-Auth-Token']?.startsWith(ECO_TOKEN)).toBe(true);

        if (url === 'https://api.eco.xoms.com.ar/rest/instruments/all') {
          return makeJsonResp({ status: 'OK', instruments: fixture.selection.instruments });
        }
        if (url.includes('/rest/instruments/bySegment?MarketSegmentID=MERV&MarketID=ROFX')) {
          return makeJsonResp({
            status: 'OK',
            instruments: [
              { marketId: 'MERV', symbol: 'MERV - XMEV - GGAL - 24hs' },
              { marketId: 'MERV', symbol: 'MERV - XMEV - GGAL - CI' },
              { marketId: 'MERV', symbol: 'MERV - XMEV - GFGC61120C - 24hs' },
            ],
          });
        }
        if (url.includes('/rest/instruments/byCFICode')) {
          return makeJsonResp({
            status: 'OK',
            instruments: [
              { marketId: 'ROFX', symbol: 'DLR/NOV26' },
              { marketId: 'ROFX', symbol: 'DLR/NOV26M' },
            ],
          });
        }
        if (url.includes('/rest/instruments/bySegment?MarketSegmentID=DDF&MarketID=ROFX')) {
          return makeJsonResp({
            status: 'OK',
            instruments: [
              { marketId: 'ROFX', symbol: 'DLR/NOV26' },
              { marketId: 'ROFX', symbol: 'DLR/SPOT' },
            ],
          });
        }
        if (url.includes('/rest/marketdata/get')) {
          marketdataGetPaths.push(url);
          return makeJsonResp({ status: 'OK', marketData: { BI: [], OF: [] }, depth: 5 });
        }
        return makeJsonResp({ status: 'ERROR', description: `Unhandled ${url}` }, 404);
      },
    });

    // Ticks ARS hacia el motor del GGAL Specialist (vela ARS + CCL implícito).
    const engineEvents: GgalBarTickEvent[] = [];
    const engine = new GgalTickStreamEngine({
      nowMsFn: () => TEST_NOW_MS,
      emit: (event) => engineEvents.push(event),
    });
    client.setGgalArsTickListener((tick) => {
      engine.applyArsTick(tick);
    });

    // 1) Stream productivo: descubre y suscribe MERV + DLR en UN único `smd` level 2.
    await client.startBymaL2LiveStream();

    expect(harness.wsUrls).toEqual(['wss://api.eco.xoms.com.ar/']);
    expect(harness.wsHeaderCaptures[0]?.['X-Auth-Token']).toBe(`${ECO_TOKEN}_1`);
    expect(harness.sentPayloads.length).toBe(1);
    const smd = JSON.parse(harness.sentPayloads[0] ?? '{}') as {
      type: string;
      level: number;
      entries: string[];
      depth: number;
      products: readonly { marketId: string; symbol: string }[];
    };
    expect(smd.type).toBe('smd');
    expect(smd.level).toBe(2);
    expect(smd.depth).toBe(5);
    expect(smd.entries).toEqual(['BI', 'OF', 'LA', 'OP', 'CL', 'SE', 'HI', 'LO', 'NV', 'OI']);
    const expectedSymbols = [
      ...fixture.selection.expectedProducts.map((p) => p.symbol),
      'DLR/ABR27',
      'DLR/DIC26',
      'DLR/NOV26',
    ].sort();
    expect(smd.products.map((p) => p.symbol)).toEqual(expectedSymbols);
    const ggalProduct = smd.products.find((p) => p.symbol === 'MERV - XMEV - GGAL - 24hs');
    expect(ggalProduct?.marketId).toBe('MERV');

    // 2) Cobertura: startDlrLiveStream NO agrega un segundo grupo (la curva ya está suscripta).
    await client.startDlrLiveStream();
    expect(harness.sentPayloads.length).toBe(1);

    // 3) Frames `Md` reales: 5 niveles BI/OF para GGAL 24hs y opción GFGC.
    const ggalCase = fixture.bookCases.find((c) => c.symbol === 'MERV - XMEV - GGAL - 24hs');
    const gfgcCase = fixture.bookCases.find((c) => c.symbol === 'MERV - XMEV - GFGC61120C - 24hs');
    expect(ggalCase).toBeDefined();
    expect(gfgcCase).toBeDefined();
    injectMdFrame(harness.messageHandlers, ggalCase?.frame);
    injectMdFrame(harness.messageHandlers, gfgcCase?.frame);

    // 4) Libro L2 en vivo desde el snapshot WS, SIN REST de marketdata.
    const ggalBook = await client.getMervOrderBook5Levels('GGAL', false, '24HS');
    expect(ggalBook?.source).toBe('PRIMARY_MERV');
    expect(ggalBook?.marketState).toBe('LIVE');
    expect(ggalBook?.settlement).toBe('24hs');
    expect(ggalBook?.asOfUtcSec).toBe(1_795_202_399);
    expect(ggalBook?.last).toBe(7195);
    expect(ggalBook?.bids.map((l) => [l.price, l.size])).toEqual(
      ggalCase?.expected.orderedBids.map((l) => [l.price, l.size]),
    );
    expect(ggalBook?.asks.map((l) => [l.price, l.size])).toEqual(
      ggalCase?.expected.orderedAsks.map((l) => [l.price, l.size]),
    );
    expectCloseOrNaN(ggalBook?.bestBid ?? Number.NaN, ggalCase?.expected.bestBid ?? null);
    expectCloseOrNaN(ggalBook?.bestAsk ?? Number.NaN, ggalCase?.expected.bestAsk ?? null);
    expectCloseOrNaN(ggalBook?.mid ?? Number.NaN, ggalCase?.expected.mid ?? null);
    expectCloseOrNaN(ggalBook?.spreadArs ?? Number.NaN, ggalCase?.expected.spread ?? null);
    expectCloseOrNaN(ggalBook?.spreadPct ?? Number.NaN, ggalCase?.expected.spreadPct ?? null);
    expectCloseOrNaN(ggalBook?.bidDepthSize ?? Number.NaN, ggalCase?.expected.bidDepthSize ?? null);
    expectCloseOrNaN(ggalBook?.askDepthSize ?? Number.NaN, ggalCase?.expected.askDepthSize ?? null);
    expectCloseOrNaN(ggalBook?.vwapBid5 ?? Number.NaN, ggalCase?.expected.vwapBid5 ?? null);
    expectCloseOrNaN(ggalBook?.vwapAsk5 ?? Number.NaN, ggalCase?.expected.vwapAsk5 ?? null);
    expectCloseOrNaN(ggalBook?.vwapBook5 ?? Number.NaN, ggalCase?.expected.vwapBook5 ?? null);
    expectCloseOrNaN(ggalBook?.obi5 ?? Number.NaN, ggalCase?.expected.obi5 ?? null);
    expect(marketdataGetPaths).toHaveLength(0);

    const gfgcBook = await client.getMervOrderBook5Levels('GFGC61120C', false, '24HS');
    expect(gfgcBook?.marketState).toBe('LIVE');
    expect(gfgcBook?.bids.map((l) => [l.price, l.size])).toEqual(
      gfgcCase?.expected.orderedBids.map((l) => [l.price, l.size]),
    );
    expect(gfgcBook?.asks.map((l) => [l.price, l.size])).toEqual(
      gfgcCase?.expected.orderedAsks.map((l) => [l.price, l.size]),
    );
    expectCloseOrNaN(gfgcBook?.spreadArs ?? Number.NaN, gfgcCase?.expected.spread ?? null);
    expectCloseOrNaN(gfgcBook?.obi5 ?? Number.NaN, gfgcCase?.expected.obi5 ?? null);
    // Paridad pura de métricas (incluye nocionales) sobre las puntas mapeadas.
    const gfgcMetrics = computeOrderBookL2Metrics(
      gfgcBook?.bids ?? [],
      gfgcBook?.asks ?? [],
    );
    expectCloseOrNaN(gfgcMetrics.bidDepthNotional, gfgcCase?.expected.bidDepthNotional ?? null);
    expectCloseOrNaN(gfgcMetrics.askDepthNotional, gfgcCase?.expected.askDepthNotional ?? null);

    // 5) Tick ARS: el frame LA emite el trade (volumen real); ningún tick infla volumen.
    const arsEvents = engineEvents.filter((e) => e.mode === 'ARS');
    expect(arsEvents.length).toBeGreaterThan(0);
    const firstArs = arsEvents[0];
    expect(firstArs?.bar.close).toBe(7195);
    expect(firstArs?.bar.volume).toBe(100);
    // Frame book-only posterior: solo re-emite el último precio con size 0.
    injectMdFrame(harness.messageHandlers, {
      type: 'Md',
      timestamp: FIXTURE_FRAME_TS_MS + 3_000,
      instrumentId: { marketId: 'MERV', symbol: 'MERV - XMEV - GGAL - 24hs' },
      marketData: {
        BI: [{ price: 7192, size: 900 }],
        OF: [{ price: 7203, size: 550 }],
      },
    });
    for (const event of engineEvents.filter((e) => e.mode === 'ARS')) {
      expect(event.bar.volume).toBeLessThanOrEqual(100);
    }

    // 6) CCL implícito: `GGAL_ARS * 10 / GGAL_ADR` desde el motor tick.
    engine.applyAdrMinute({
      timeSec: 1_795_202_399,
      open: 50.4,
      high: 50.6,
      low: 50.3,
      close: 50.5,
      volume: 1_000,
    });
    const cclEvents = engineEvents.filter((e) => e.mode === 'CCL');
    expect(cclEvents.length).toBeGreaterThan(0);
    const expectedCcl = (7195 * 10) / 50.5;
    for (const event of cclEvents) {
      expectCloseOrNaN(event.bar.close, expectedCcl);
    }

    // 7) Curva DLR/*: el mismo stream alimenta los contratos derivados.
    injectMdFrame(harness.messageHandlers, {
      type: 'Md',
      timestamp: FIXTURE_FRAME_TS_MS + 2_000,
      instrumentId: { marketId: 'ROFX', symbol: 'DLR/NOV26' },
      marketData: {
        BI: [{ price: 1540, size: 50 }],
        OF: [{ price: 1544, size: 40 }],
        LA: { price: 1542, size: 10, date: FIXTURE_FRAME_TS_MS - 1_000 },
      },
    });
    client.setReferenceSpotA3500(1445);
    const nov26 = client.getLiveDlrFutures().find((c) => c.contract === 'DLR/NOV26');
    expect(nov26?.priceBasis).toBe('LAST');
    expect(nov26?.price).toBe(1542);
    expect(nov26?.tnaImplicitaPct).not.toBeNull();
    expect(nov26?.spotSource).toBe('A3500_BCRA');

    // 8) Telemetría/health: entorno Eco, counts BYMA L2 + ROFEX, libros vivos, cero secretos.
    const health = client.getSafeHealthStatus();
    expect(health.wsEnvironment).toBe('PRIMARY_ECO_XOMS_WS');
    expect(health.apiUrl).toBe('https://api.eco.xoms.com.ar');
    expect(health.wsConnected).toBe(true);
    expect(health.mervSubscribedCount).toBe(fixture.selection.expectedProducts.length);
    expect(health.liveMervBookCount).toBe(2);
    expect(health.dlrSubscribedCount).toBe(3);
    const healthJson = JSON.stringify(health);
    expect(healthJson).not.toContain(ECO_ENV.ECO_MATRIZ_USERNAME);
    expect(healthJson).not.toContain(ECO_ENV.ECO_MATRIZ_PASSWORD);
    expect(healthJson).not.toContain(ECO_TOKEN);

    // 9) Reconexión (token renovado): el grupo BYMA L2 se re-envía íntegro.
    await client.reconnectDlrLiveStream();
    expect(authCalls).toBe(2);
    expect(harness.sentPayloads.length).toBe(2);
    const reSent = JSON.parse(harness.sentPayloads[1] ?? '{}') as typeof smd;
    expect(reSent.level).toBe(2);
    expect(reSent.products.map((p) => p.symbol)).toEqual(expectedSymbols);
    expect(harness.wsHeaderCaptures[1]?.['X-Auth-Token']).toBe(`${ECO_TOKEN}_2`);

    client.closeWebSocket();
    expect(client.getSafeHealthStatus().wsConnected).toBe(false);
    expect(client.getSafeHealthStatus().liveMervBookCount).toBe(0);
  });

  /* --------------------------------------------------------------------------
   * 3) Redacción total de credenciales (PRIMARY_* y ECO_MATRIZ_*)
   * -------------------------------------------------------------------------- */
  it('redacta por completo credenciales PRIMARY y ECO_MATRIZ en errores y no las serializa nunca', async () => {
    const secrets = collectBrokerSecretsFromEnv(ECO_ENV);
    expect(secrets).toContain(ECO_ENV.ECO_MATRIZ_USERNAME);
    expect(secrets).toContain(ECO_ENV.ECO_MATRIZ_PASSWORD);

    // El cliente extiende el set de redacción con el X-Auth-Token vivo (getSecrets()).
    const dirty = `auth failed user=${ECO_ENV.ECO_MATRIZ_USERNAME} pass=${ECO_ENV.ECO_MATRIZ_PASSWORD} token=${ECO_TOKEN}`;
    const clean = redactSecrets(dirty, [...secrets, ECO_TOKEN]);
    expect(clean).not.toContain(ECO_ENV.ECO_MATRIZ_USERNAME);
    expect(clean).not.toContain(ECO_ENV.ECO_MATRIZ_PASSWORD);
    expect(clean).not.toContain(ECO_TOKEN);
    expect(clean).toContain('<redacted>');

    const harness: MockWsHarness = { sentPayloads: [], wsUrls: [], wsHeaderCaptures: [], messageHandlers: [] };
    const client = new PrimaryRofexClient({
      env: ECO_ENV,
      nowMsFn: () => TEST_NOW_MS,
      wsFactory: createMockWsFactory(harness),
      fetchFn: async (url) => {
        await Promise.resolve();
        if (url.endsWith('/auth/getToken')) {
          return makeJsonResp({ status: 'OK' }, 200, { 'x-auth-token': ECO_TOKEN });
        }
        return makeJsonResp(
          {
            status: 'ERROR',
            description: `denied for ${ECO_ENV.ECO_MATRIZ_USERNAME} with ${ECO_ENV.ECO_MATRIZ_PASSWORD} ${ECO_TOKEN}`,
          },
          200,
        );
      },
    });

    await expect(client.startBymaL2LiveStream()).rejects.toThrow();
    const healthJson = JSON.stringify(client.getSafeHealthStatus());
    expect(healthJson).not.toContain(ECO_ENV.ECO_MATRIZ_USERNAME);
    expect(healthJson).not.toContain(ECO_ENV.ECO_MATRIZ_PASSWORD);
    expect(healthJson).not.toContain(ECO_TOKEN);
    expect(harness.sentPayloads).toHaveLength(0);
  });

  /* --------------------------------------------------------------------------
   * 4) Sin credenciales: no hay red ni suscripción (degradación explícita)
   * -------------------------------------------------------------------------- */
  it('no abre socket ni REST sin credenciales configuradas', async () => {
    const harness: MockWsHarness = { sentPayloads: [], wsUrls: [], wsHeaderCaptures: [], messageHandlers: [] };
    let networkCalled = false;
    const client = new PrimaryRofexClient({
      env: { PRIMARY_BASE_URL: 'https://api.eco.xoms.com.ar' },
      nowMsFn: () => TEST_NOW_MS,
      wsFactory: createMockWsFactory(harness),
      fetchFn: async () => {
        await Promise.resolve();
        networkCalled = true;
        return makeJsonResp({});
      },
    });
    await client.startBymaL2LiveStream();
    await client.startDlrLiveStream();
    expect(networkCalled).toBe(false);
    expect(harness.sentPayloads).toHaveLength(0);
    expect(harness.wsUrls).toHaveLength(0);
    const health = client.getSafeHealthStatus();
    expect(health.configured).toBe(false);
    expect(health.wsEnvironment).toBe('PRIMARY_ECO_XOMS_WS');
    expect(health.mervSubscribedCount).toBe(0);
  });
});
