/**
 * Pieza 50.9 (Bloque B) — publicación coherente de snapshots US por símbolo y
 * alcance, más la opción REST `prefetch` de `GET /api/snapshot`.
 *
 * Referencia independiente: `tools/gen_snapshot_publication_pieza50_9.py`
 * (`fixtures/snapshot_publication_pieza50_9_reference.json`).
 *
 * Transporte inyectado: `fetch` global sustituido por respuestas diferidas para
 * fijar el orden de resolución entre la base y las cargas puntuales. Proveedores
 * inyectados: `MarketRuntime` con loaders y `fetchFn` offline.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MarketRuntime,
  type TerminalSnapshotResponse,
} from '../src/server/marketRuntime.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';

// ---------------------------------------------------------------------------
// Referencia independiente (funciones puras)
// ---------------------------------------------------------------------------

interface DecisionCase {
  readonly name: string;
  readonly current: Record<string, unknown> | null;
  readonly incoming: Record<string, unknown>;
  readonly expected: string;
}

interface MergeCase {
  readonly name: string;
  readonly base: Record<string, unknown>;
  readonly scope: Record<string, unknown> | null;
  readonly onlyDate?: string | null;
  readonly expected: Record<string, unknown>;
}

interface ExpiryFactCase {
  readonly name: string;
  readonly fact: Record<string, unknown>;
  readonly current: Record<string, unknown> | null;
  readonly expected: string;
}

interface Fixture {
  readonly decisionCases: readonly DecisionCase[];
  readonly pointFactCases: readonly ExpiryFactCase[];
  readonly mergeCases: readonly MergeCase[];
}

const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), 'fixtures', 'snapshot_publication_pieza50_9_reference.json'),
    'utf-8',
  ),
) as Fixture;

/**
 * `snapshotPublication.ts` vive en el mundo web (fuera del program NodeNext del
 * tsconfig raíz): se carga por import dinámico de especificador variable.
 */
interface PublicationApi {
  resolvePublicationDecision(current: unknown, incoming: unknown): string;
  resolveExpiryFactDecision(fact: unknown, current: unknown): string;
  mergeLoadedExpiriesIntoBaseSnapshot(
    base: unknown,
    scope: unknown,
    onlyDate?: string,
  ): Record<string, unknown>;
}

const publicationSpecifier = '../web/src/data/snapshotPublication';
const publication = (await import(
  /* @vite-ignore */ publicationSpecifier
)) as unknown as PublicationApi;

function rec(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function recArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? (value as readonly Record<string, unknown>[]) : [];
}

describe('Pieza 50.9 Bloque B — referencia independiente: decisión de publicación', () => {
  it('coincide con la referencia en revisión, evaluación y sello previo roto', () => {
    for (const item of fixture.decisionCases) {
      const actual = publication.resolvePublicationDecision(item.current, item.incoming);
      expect(actual, item.name).toBe(item.expected);
    }
  });

  it('la evaluación más nueva manda y la revisión desempata cuando coincide', () => {
    const greater = fixture.decisionCases.find(
      (c) => c.name === 'revision_mayor_manda_aunque_evaluacion_anterior',
    );
    expect(greater?.expected).toBe('stale');
    const lower = fixture.decisionCases.find((c) => c.name === 'misma_revision_hora_menor');
    expect(lower?.expected).toBe('stale');
    const invalid = fixture.decisionCases.find((c) => c.name === 'revision_no_entera');
    expect(invalid?.expected).toBe('stale');
    const broken = fixture.decisionCases.find(
      (c) => c.name === 'sello_previo_con_evaluacion_rota_no_bloquea',
    );
    expect(broken?.expected).toBe('accept');
  });
});

describe('Pieza 50.9 Bloque B — referencia independiente: fusión base + vencimiento', () => {
  it('coincide con la referencia en loaded, unión ordenada y expiriesByCode', () => {
    for (const item of fixture.mergeCases) {
      const actual = publication.mergeLoadedExpiriesIntoBaseSnapshot(
        item.base,
        item.scope,
        item.onlyDate ?? undefined,
      );
      expect(actual, item.name).toEqual(item.expected);
    }
  });

  it('conserva el agregado de la base y descarta los hechos no cargados del scope', () => {
    const item = fixture.mergeCases.find((c) => c.name === 'mejora_fecha_cargada_y_conserva_agregado');
    expect(item).toBeDefined();
    if (item === undefined) return;
    const actual = publication.mergeLoadedExpiriesIntoBaseSnapshot(item.base, item.scope);
    const base = rec(item.base);
    const scope = rec(item.scope);
    expect(actual['asOfUtcSec']).toBe(base['asOfUtcSec']);
    expect(rec(actual['marketContext'])['spot']).toBe(rec(base['marketContext'])['spot']);
    expect(rec(actual['marketContext'])['spot']).not.toBe(rec(scope['marketContext'])['spot']);
    const entries = recArray(rec(actual['optionsChain'])['availableExpirations']);
    const upgraded = entries.find((e) => e['expirationDate'] === '2026-08-21');
    expect(upgraded?.['loaded']).toBe(true);
    expect(upgraded?.['validCallCount']).toBe(120);
    const untouched = entries.find((e) => e['expirationDate'] === '2026-09-18');
    expect(untouched?.['loaded']).toBe(false);
    expect(untouched?.['validCallCount']).toBe(0);
    const codes = rec(rec(rec(actual['terminalEngines'])['volAnalyticsSuite'])['expiriesByCode']);
    expect(rec(codes['2026-08-21'])['ivAtm']).toBe(0.55);
    expect(rec(codes['2026-09-18'])['ivAtm']).toBe(0.42);
  });

  it('añade las fechas cargadas ausentes en orden y sin duplicar', () => {
    const item = fixture.mergeCases.find((c) => c.name === 'une_fechas_ausentes_ordenadas');
    expect(item).toBeDefined();
    if (item === undefined) return;
    const actual = publication.mergeLoadedExpiriesIntoBaseSnapshot(item.base, item.scope);
    const dates = recArray(rec(actual['optionsChain'])['availableExpirations']).map((e) =>
      String(e['expirationDate']),
    );
    expect(dates).toEqual(['2026-08-21', '2026-10-16', '2026-12-18']);
  });

  it('restringe la publicación puntual a su fecha solicitada sin pisar anclas', () => {
    const item = fixture.mergeCases.find((c) => c.name === 'restringe_publicacion_puntual_a_su_fecha');
    expect(item).toBeDefined();
    if (item === undefined) return;
    const actual = publication.mergeLoadedExpiriesIntoBaseSnapshot(
      item.base,
      item.scope,
      item.onlyDate ?? undefined,
    );
    const entries = recArray(rec(actual['optionsChain'])['availableExpirations']);
    const requested = entries.find((e) => e['expirationDate'] === '2026-08-21');
    expect(requested?.['loaded']).toBe(true);
    expect(requested?.['validCallCount']).toBe(120);
    const anchor = entries.find((e) => e['expirationDate'] === '2026-10-16');
    expect(anchor?.['loaded']).toBe(false);
    expect(anchor?.['validCallCount']).toBe(0);
    const codes = rec(rec(rec(actual['terminalEngines'])['volAnalyticsSuite'])['expiriesByCode']);
    expect(rec(codes['2026-08-21'])['ivAtm']).toBe(0.55);
    expect(rec(codes['2026-10-16'])['ivAtm']).toBe(0.41);
  });
});

describe('Pieza 50.9 Bloque B — referencia independiente: hecho puntual por vencimiento', () => {
  it('coincide con la referencia: sin datos cargados publica y con datos cargados gana el estrictamente más nuevo', () => {
    for (const item of fixture.pointFactCases) {
      const actual = publication.resolveExpiryFactDecision(item.fact, item.current);
      expect(actual, item.name).toBe(item.expected);
    }
  });

  it('un hecho sin datos o con evaluación inválida nunca publica; la omisión de la base siempre publica', () => {
    const notLoaded = fixture.pointFactCases.find((c) => c.name === 'hecho_sin_cargar_no_publica');
    expect(notLoaded?.expected).toBe('keep');
    const invalid = fixture.pointFactCases.find(
      (c) => c.name === 'hecho_con_evaluacion_invalida_no_publica',
    );
    expect(invalid?.expected).toBe('keep');
    const omission = fixture.pointFactCases.find((c) => c.name === 'base_omite_la_fecha_publica');
    expect(omission?.expected).toBe('publish');
  });
});

// ---------------------------------------------------------------------------
// Puente en vivo: publicación por símbolo + alcance con transporte diferido
// ---------------------------------------------------------------------------

interface BridgeStateLike {
  readonly usSnapshotsBySymbol: Readonly<Record<string, Record<string, unknown> | undefined>>;
  readonly optionsByUnderlying: Readonly<Record<string, Record<string, unknown> | undefined>>;
}

interface BridgeApi {
  getLiveMarketStateSnapshot(): BridgeStateLike;
  requestUsSnapshot(
    symbol: string,
    options?: { readonly force?: boolean; readonly signal?: AbortSignal; readonly prefetch?: boolean },
  ): Promise<unknown>;
  requestOptionsChain(underlying: string, force?: boolean, expiration?: string): Promise<void>;
  requestUsOptionExpiry(underlying: string, expirationDate: string, force?: boolean): Promise<void>;
}

const bridgeSpecifier = '../web/src/data/liveRuntimeBridge';
const bridge = (await import(/* @vite-ignore */ bridgeSpecifier)) as unknown as BridgeApi;

interface DeferredFetch {
  readonly url: string;
  readonly signal: AbortSignal | undefined;
  readonly resolveJson: (body: unknown) => void;
  readonly fail: (status: number) => void;
}

const pendingFetches: DeferredFetch[] = [];

async function waitForFetchCount(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(pendingFetches.length, `fetches pendientes=${String(pendingFetches.length)}`).toBe(count);
  });
}

function fetchAt(index: number): DeferredFetch {
  const entry = pendingFetches[index];
  if (entry === undefined) throw new Error(`fetch pendiente #${String(index)} no programado`);
  return entry;
}

type SnapshotOptions = NonNullable<Parameters<MarketRuntime['getSnapshot']>[1]>;

function optionsAt(
  calls: readonly { readonly options: SnapshotOptions }[],
  index: number,
): SnapshotOptions {
  const call = calls[index];
  if (call === undefined) throw new Error(`getSnapshot #${String(index)} no registrado`);
  return call.options;
}

function expiryFact(
  date: string,
  input: { readonly loaded: boolean; readonly calls: number; readonly puts: number },
): Record<string, unknown> {
  return {
    expirationDate: date,
    daysToExpiry: 21,
    loaded: input.loaded,
    validCallCount: input.calls,
    validPutCount: input.puts,
    nearAtmLiquidity: input.loaded ? 90_000 : 0,
    inDefaultWindow: true,
    hasCompleteAtmChain: input.loaded,
  };
}

function analyticsCode(date: string, ivAtm: number): Record<string, unknown> {
  return { expiryCode: date, daysToExpiry: 21, ivAtm };
}

function usSnapshotPayload(input: {
  readonly symbol: string;
  readonly asOfUtcSec: number;
  readonly spot: number;
  readonly aggregateGex: number;
  readonly traceSpot: number;
  readonly entries: readonly Record<string, unknown>[];
  readonly codes: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    status: 'OK',
    feedMode: 'LIVE',
    quoteMode: 'LIVE_NBBO',
    symbol: input.symbol,
    asOfUtcSec: input.asOfUtcSec,
    envelope: { snapshot: { metrics: { spot: input.spot } } },
    marketContext: {
      unifiedQuotes: [
        {
          ticker: input.symbol,
          assetType: 'stock',
          price: input.spot,
          change: 0,
          changePct: 0,
          previousClose: input.spot,
          dayLow: input.spot,
          dayHigh: input.spot,
          dayRangePos: 0.5,
          volumeM: 1,
          iv30d: 0.22,
          marketStatus: 'open',
          volume: 1_000_000,
        },
      ],
      treasury: { rate30d: 0.05, dividendYieldFront: 0 },
    },
    optionsChain: {
      selectedExpirationDate: '2026-08-21',
      selectionReason: 'DEFAULT_LIQUID_14_45_DTE',
      prefetchExpirationDates: [],
      availableExpirations: input.entries,
    },
    exposureSummary: {
      netGex: input.aggregateGex,
      netDex: 1,
      netVex: null,
      netCex: null,
      vannaRegime: 'NEUTRAL',
      charmPinStrike: null,
      callWallStrike: 65,
      putWallStrike: 60,
      gammaFlipSpot: 62,
      gammaFlipStatus: 'ABOVE',
      trace: {
        evaluationSec: input.asOfUtcSec,
        valuationSpot: input.traceSpot,
        valuationSpotSource: 'PARITY_IMPLIED',
        headerSpot: input.spot,
        spotDivergenceBps: 0,
        quoteMode: 'LIVE_NBBO',
        coverage: 'partial',
        engineExpirationsCount: input.entries.length,
        engineExpirationDates: input.entries.map((e) => String(e['expirationDate'])),
        engineStrikeRange: { min: 60, max: 65 },
        engineStrikeCount: 2,
        byStrikeRange: { min: 60, max: 65 },
        byStrikeCount: 4,
        catalogExpirationsCount: null,
        catalogExpirationDates: [],
        payloadContractCount: 4,
        payloadExpirationDates: ['2026-08-21'],
        quoteTimes: null,
        chainCoverage: null,
      },
    },
    terminalEngines: {
      volAnalyticsSuite: { expiriesByCode: input.codes },
    },
    volSurfaceSummary: { iv30d: 0.22, frontSlice: null, slices: [], contracts: [] },
  };
}

function expiryChainPayload(input: {
  readonly symbol: string;
  readonly expirationDate: string;
  readonly asOfUtcSec: number;
  readonly calls: number;
  readonly puts: number;
  readonly ivAtm: number;
}): Record<string, unknown> {
  return {
    status: 'OK',
    feedMode: 'LIVE',
    quoteMode: 'LIVE_NBBO',
    symbol: input.symbol,
    expirationDate: input.expirationDate,
    asOfUtcSec: input.asOfUtcSec,
    spot: 61.5,
    daysToExpiry: 21,
    expiryMeta: {
      expirationDate: input.expirationDate,
      daysToExpiry: 21,
      loaded: true,
      validCallCount: input.calls,
      validPutCount: input.puts,
      nearAtmLiquidity: 88_000,
      inDefaultWindow: true,
      hasCompleteAtmChain: true,
    },
    contracts: [],
    slice: null,
    exposureSummary: null,
    syntheticRates: null,
    volAnalyticsExpiry: {
      expiryCode: input.expirationDate,
      daysToExpiry: 21,
      ivAtm: input.ivAtm,
    },
    dataQuality: { parityExpiries: 1 },
  };
}

function arOptionsPayload(): Record<string, unknown> {
  return {
    asOfUtcSec: 1_000,
    feedStatus: 'LIVE',
    underlying: 'GGAL',
    market: 'AR',
    spot: 100,
    rateTna: null,
    continuousRate: null,
    dividendYield: 0,
    lotSize: 100,
    settlement: 'T+2',
    exerciseCutoffArt: '15:30 ART',
    realizedVol20d: null,
    realizedVol60d: null,
    histMedianIv: null,
    vrpSpread: null,
    historicalCloses: [],
    termStructure: [],
    expiries: [],
    exposureSummary: null,
    costSchedule: {
      rvMarketFeeRate: 0.002,
      optionsFeeRate: 0.002,
      shortLoanFeeRate: 0,
      vatRate: 0,
      bondsVatExempt: true,
    },
    providerErrors: [],
  };
}

const POINT_DATE = '2026-08-21';

function basePayload(symbol: string): Record<string, unknown> {
  return usSnapshotPayload({
    symbol,
    asOfUtcSec: 1_000,
    spot: 61.5,
    aggregateGex: 111.5,
    traceSpot: 61.2,
    entries: [
      expiryFact(POINT_DATE, { loaded: false, calls: 0, puts: 0 }),
      expiryFact('2026-09-18', { loaded: false, calls: 0, puts: 0 }),
    ],
    codes: {
      [POINT_DATE]: analyticsCode(POINT_DATE, 0.4),
      '2026-09-18': analyticsCode('2026-09-18', 0.42),
    },
  });
}

function pointPayload(symbol: string): Record<string, unknown> {
  return usSnapshotPayload({
    symbol,
    asOfUtcSec: 2_000,
    spot: 99.9,
    aggregateGex: 999,
    traceSpot: 99.1,
    entries: [expiryFact(POINT_DATE, { loaded: true, calls: 120, puts: 140 })],
    codes: { [POINT_DATE]: analyticsCode(POINT_DATE, 0.55) },
  });
}

function expectPublishedFacts(symbol: string): void {
  const snap = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol[symbol];
  expect(snap, symbol).toBeDefined();
  if (snap === undefined) return;
  expect(snap['asOfUtcSec'], symbol).toBe(1_000);
  const exposure = rec(snap['exposureSummary']);
  expect(exposure['netGex'], symbol).toBe(111.5);
  expect(rec(exposure['trace'])['valuationSpot'], symbol).toBe(61.2);
  expect(rec(snap['marketContext'])['unifiedQuotes'], symbol).toBeDefined();
  const entries = recArray(rec(snap['optionsChain'])['availableExpirations']);
  const loadedEntry = entries.find((e) => e['expirationDate'] === POINT_DATE);
  expect(loadedEntry?.['loaded'], symbol).toBe(true);
  expect(loadedEntry?.['validCallCount'], symbol).toBe(120);
  expect(loadedEntry?.['validPutCount'], symbol).toBe(140);
  const untouched = entries.find((e) => e['expirationDate'] === '2026-09-18');
  expect(untouched?.['loaded'], symbol).toBe(false);
  const codes = rec(rec(rec(snap['terminalEngines'])['volAnalyticsSuite'])['expiriesByCode']);
  expect(rec(codes[POINT_DATE])['ivAtm'], symbol).toBe(0.55);
  expect(rec(codes['2026-09-18'])['ivAtm'], symbol).toBe(0.42);
}

describe('Pieza 50.9 Bloque B — publicación del puente por símbolo y alcance', () => {
  beforeEach(() => {
    pendingFetches.length = 0;
    vi.stubGlobal('fetch', (rawUrl: unknown, init?: { readonly signal?: AbortSignal }) => {
      return new Promise((resolve) => {
        pendingFetches.push({
          url: String(rawUrl),
          signal: init?.signal,
          resolveJson: (body) => {
            resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
          },
          fail: (status) => {
            resolve({ ok: false, status, json: () => Promise.resolve({}) });
          },
        });
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resuelve base y vencimiento en ambos órdenes sin perder hechos ni el agregado', async () => {
    // Orden 1: el puntual termina antes de que exista la primera base.
    const pendingPoint = bridge.requestOptionsChain('US:ZQPA', false, POINT_DATE);
    await waitForFetchCount(1);
    const firstBase = bridge.requestUsSnapshot('ZQPA');
    await waitForFetchCount(2);
    fetchAt(0).resolveJson(pointPayload('ZQPA'));
    await pendingPoint;
    expect(bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['ZQPA']).toBeUndefined();
    fetchAt(1).resolveJson(basePayload('ZQPA'));
    await firstBase;

    // Orden 2: base primero y puntual después.
    const secondBase = bridge.requestUsSnapshot('ZQPB');
    await waitForFetchCount(3);
    fetchAt(2).resolveJson(basePayload('ZQPB'));
    await secondBase;
    const latePoint = bridge.requestOptionsChain('US:ZQPB', false, POINT_DATE);
    await waitForFetchCount(4);
    fetchAt(3).resolveJson(pointPayload('ZQPB'));
    await latePoint;

    expectPublishedFacts('ZQPA');
    expectPublishedFacts('ZQPB');
  });

  it('descarta una base tardía del mismo alcance y nunca muta el estado con ella', async () => {
    const slowBase = bridge.requestOptionsChain('US:ZQPC');
    await waitForFetchCount(1);
    const freshBase = bridge.requestUsSnapshot('ZQPC');
    await waitForFetchCount(2);
    fetchAt(1).resolveJson(basePayload('ZQPC'));
    await freshBase;
    fetchAt(0).resolveJson(
      usSnapshotPayload({
        symbol: 'ZQPC',
        asOfUtcSec: 5_000,
        spot: 88,
        aggregateGex: 777,
        traceSpot: 87.5,
        entries: [expiryFact(POINT_DATE, { loaded: true, calls: 7, puts: 9 })],
        codes: { [POINT_DATE]: analyticsCode(POINT_DATE, 0.11) },
      }),
    );
    await slowBase;

    const state = bridge.getLiveMarketStateSnapshot();
    const snap = state.usSnapshotsBySymbol['ZQPC'];
    expect(snap).toBeDefined();
    expect(snap?.['asOfUtcSec']).toBe(1_000);
    expect(rec(snap?.['exposureSummary'])['netGex']).toBe(111.5);
    const entry = recArray(rec(snap?.['optionsChain'])['availableExpirations']).find(
      (e) => e['expirationDate'] === POINT_DATE,
    );
    expect(entry?.['validCallCount']).toBe(0);
    // La respuesta obsoleta no hidrató el módulo de opciones.
    expect(state.optionsByUnderlying['US:ZQPC']).toBeUndefined();
  });

  it('una cancelación conserva el último snapshot válido', async () => {
    const ok = bridge.requestUsSnapshot('ZQPD');
    await waitForFetchCount(1);
    fetchAt(0).resolveJson(basePayload('ZQPD'));
    await ok;

    const controller = new AbortController();
    const cancelled = bridge.requestUsSnapshot('ZQPD', { force: true, signal: controller.signal });
    await waitForFetchCount(2);
    controller.abort();
    fetchAt(1).resolveJson(
      usSnapshotPayload({
        symbol: 'ZQPD',
        asOfUtcSec: 7_000,
        spot: 77,
        aggregateGex: 666,
        traceSpot: 76.5,
        entries: [expiryFact(POINT_DATE, { loaded: true, calls: 50, puts: 60 })],
        codes: { [POINT_DATE]: analyticsCode(POINT_DATE, 0.22) },
      }),
    );
    await cancelled;

    const snap = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['ZQPD'];
    expect(snap?.['asOfUtcSec']).toBe(1_000);
    expect(rec(snap?.['exposureSummary'])['netGex']).toBe(111.5);
  });

  it('un fallo de transporte conserva el último snapshot válido', async () => {
    const ok = bridge.requestUsSnapshot('ZQPE');
    await waitForFetchCount(1);
    fetchAt(0).resolveJson(basePayload('ZQPE'));
    await ok;

    const failed = bridge.requestUsSnapshot('ZQPE', { force: true });
    await waitForFetchCount(2);
    fetchAt(1).fail(500);
    await failed;

    const snap = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['ZQPE'];
    expect(snap?.['asOfUtcSec']).toBe(1_000);
    expect(rec(snap?.['exposureSummary'])['netGex']).toBe(111.5);
  });

  it('un puntual obsoleto no pisa la cadena vigente y su hecho pendiente alimenta la base', async () => {
    const DATE = '2026-11-20';
    const slowPoint = bridge.requestOptionsChain('US:ZQPF', false, DATE);
    await waitForFetchCount(1);
    const freshChain = bridge.requestUsOptionExpiry('US:ZQPF', DATE);
    await waitForFetchCount(2);
    fetchAt(1).resolveJson(
      expiryChainPayload({
        symbol: 'ZQPF',
        expirationDate: DATE,
        asOfUtcSec: 2_000,
        calls: 120,
        puts: 140,
        ivAtm: 0.55,
      }),
    );
    await freshChain;
    fetchAt(0).resolveJson(
      usSnapshotPayload({
        symbol: 'ZQPF',
        asOfUtcSec: 1_900,
        spot: 42,
        aggregateGex: 500,
        traceSpot: 41.5,
        entries: [expiryFact(DATE, { loaded: true, calls: 7, puts: 9 })],
        codes: { [DATE]: analyticsCode(DATE, 0.11) },
      }),
    );
    await slowPoint;

    expect(bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['ZQPF']).toBeUndefined();

    const base = bridge.requestUsSnapshot('ZQPF');
    await waitForFetchCount(3);
    fetchAt(2).resolveJson(
      usSnapshotPayload({
        symbol: 'ZQPF',
        asOfUtcSec: 1_000,
        spot: 61.5,
        aggregateGex: 111.5,
        traceSpot: 61.2,
        entries: [expiryFact(DATE, { loaded: false, calls: 0, puts: 0 })],
        codes: {},
      }),
    );
    await base;

    const snap = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['ZQPF'];
    expect(snap).toBeDefined();
    const entry = recArray(rec(snap?.['optionsChain'])['availableExpirations']).find(
      (e) => e['expirationDate'] === DATE,
    );
    expect(entry?.['loaded']).toBe(true);
    expect(entry?.['validCallCount']).toBe(120);
    const codes = rec(rec(rec(snap?.['terminalEngines'])['volAnalyticsSuite'])['expiriesByCode']);
    expect(rec(codes[DATE])['ivAtm']).toBe(0.55);
  });

  it('aísla símbolos distintos y respeta la separación US/AR', async () => {
    const us = bridge.requestUsSnapshot('ZQPG');
    await waitForFetchCount(1);
    const ar = bridge.requestOptionsChain('AR:GGAL');
    await waitForFetchCount(2);
    fetchAt(0).resolveJson(basePayload('ZQPG'));
    fetchAt(1).resolveJson(arOptionsPayload());
    await Promise.all([us, ar]);

    const state = bridge.getLiveMarketStateSnapshot();
    expect(state.usSnapshotsBySymbol['ZQPG']).toBeDefined();
    expect(state.usSnapshotsBySymbol['GGAL']).toBeUndefined();
    expect(state.optionsByUnderlying['AR:GGAL']).toBeDefined();
    expect(state.optionsByUnderlying['US:ZQPG']).toBeUndefined();
  });

  it('requestUsSnapshot: prefetch explícito y URL por defecto intacta', async () => {
    const off = bridge.requestUsSnapshot('ZQPH', { prefetch: false });
    await waitForFetchCount(1);
    fetchAt(0).resolveJson(basePayload('ZQPH'));
    await off;
    expect(fetchAt(0).url).toBe('/api/snapshot?symbol=ZQPH&timeframe=5m&prefetch=0');

    const byDefault = bridge.requestUsSnapshot('ZQPI');
    await waitForFetchCount(2);
    fetchAt(1).resolveJson(basePayload('ZQPI'));
    await byDefault;
    expect(fetchAt(1).url).toBe('/api/snapshot?symbol=ZQPI&timeframe=5m');

    const on = bridge.requestUsSnapshot('ZQPJ', { prefetch: true });
    await waitForFetchCount(3);
    fetchAt(2).resolveJson(basePayload('ZQPJ'));
    await on;
    expect(fetchAt(2).url).toBe('/api/snapshot?symbol=ZQPJ&timeframe=5m');
  });

  it('una solicitud nueva con evaluación anterior no retrocede la valuación ni la traza', async () => {
    const fresh = bridge.requestUsSnapshot('ZQRA');
    await waitForFetchCount(1);
    fetchAt(0).resolveJson(basePayload('ZQRA'));
    await fresh;

    const retrograde = bridge.requestUsSnapshot('ZQRA', { force: true });
    await waitForFetchCount(2);
    fetchAt(1).resolveJson(
      usSnapshotPayload({
        symbol: 'ZQRA',
        asOfUtcSec: 900,
        spot: 42,
        aggregateGex: 777,
        traceSpot: 41.5,
        entries: [expiryFact(POINT_DATE, { loaded: true, calls: 7, puts: 9 })],
        codes: { [POINT_DATE]: analyticsCode(POINT_DATE, 0.11) },
      }),
    );
    await retrograde;

    const snap = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['ZQRA'];
    expect(snap?.['asOfUtcSec']).toBe(1_000);
    expect(rec(snap?.['exposureSummary'])['netGex']).toBe(111.5);
    expect(rec(rec(snap?.['exposureSummary'])['trace'])['valuationSpot']).toBe(61.2);
    const entry = recArray(rec(snap?.['optionsChain'])['availableExpirations']).find(
      (e) => e['expirationDate'] === POINT_DATE,
    );
    expect(entry?.['validCallCount']).toBe(0);
  });

  it('en alcance puntual, una evaluación anterior no reemplaza la cadena vigente retenida', async () => {
    const DATE = '2026-10-16';
    const first = bridge.requestUsOptionExpiry('US:ZQRB', DATE);
    await waitForFetchCount(1);
    fetchAt(0).resolveJson(
      expiryChainPayload({
        symbol: 'ZQRB',
        expirationDate: DATE,
        asOfUtcSec: 2_000,
        calls: 120,
        puts: 140,
        ivAtm: 0.55,
      }),
    );
    await first;

    const retrograde = bridge.requestUsOptionExpiry('US:ZQRB', DATE, true);
    await waitForFetchCount(2);
    fetchAt(1).resolveJson(
      expiryChainPayload({
        symbol: 'ZQRB',
        expirationDate: DATE,
        asOfUtcSec: 1_900,
        calls: 7,
        puts: 9,
        ivAtm: 0.11,
      }),
    );
    await retrograde;

    const base = bridge.requestUsSnapshot('ZQRB');
    await waitForFetchCount(3);
    fetchAt(2).resolveJson(
      usSnapshotPayload({
        symbol: 'ZQRB',
        asOfUtcSec: 1_000,
        spot: 61.5,
        aggregateGex: 111.5,
        traceSpot: 61.2,
        entries: [expiryFact(DATE, { loaded: false, calls: 0, puts: 0 })],
        codes: {},
      }),
    );
    await base;

    const snap = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['ZQRB'];
    const entry = recArray(rec(snap?.['optionsChain'])['availableExpirations']).find(
      (e) => e['expirationDate'] === DATE,
    );
    expect(entry?.['loaded']).toBe(true);
    expect(entry?.['validCallCount']).toBe(120);
    expect(entry?.['validPutCount']).toBe(140);
    const codes = rec(rec(rec(snap?.['terminalEngines'])['volAnalyticsSuite'])['expiriesByCode']);
    expect(rec(codes[DATE])['ivAtm']).toBe(0.55);
  });

  it('publica solo la fecha solicitada aunque la respuesta puntual traiga otras cargadas', async () => {
    const A = POINT_DATE;
    const B = '2026-09-18';
    const pointWithAnchors = (symbol: string): Record<string, unknown> =>
      usSnapshotPayload({
        symbol,
        asOfUtcSec: 2_000,
        spot: 99.9,
        aggregateGex: 999,
        traceSpot: 99.1,
        entries: [
          expiryFact(A, { loaded: true, calls: 111, puts: 112 }),
          expiryFact(B, { loaded: true, calls: 222, puts: 223 }),
        ],
        codes: { [A]: analyticsCode(A, 0.11), [B]: analyticsCode(B, 0.22) },
      });

    // Con base previa: el puntual de A no debe tocar B.
    const base1 = bridge.requestUsSnapshot('ZQRC');
    await waitForFetchCount(1);
    fetchAt(0).resolveJson(basePayload('ZQRC'));
    await base1;
    const point1 = bridge.requestOptionsChain('US:ZQRC', false, A);
    await waitForFetchCount(2);
    fetchAt(1).resolveJson(pointWithAnchors('ZQRC'));
    await point1;

    // Sin base inicial: el hecho retenido de A tampoco toca B al llegar la base.
    const point2 = bridge.requestOptionsChain('US:ZQRD', false, A);
    await waitForFetchCount(3);
    fetchAt(2).resolveJson(pointWithAnchors('ZQRD'));
    await point2;
    const base2 = bridge.requestUsSnapshot('ZQRD');
    await waitForFetchCount(4);
    fetchAt(3).resolveJson(basePayload('ZQRD'));
    await base2;

    for (const symbol of ['ZQRC', 'ZQRD']) {
      const snap = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol[symbol];
      expect(snap, symbol).toBeDefined();
      const entries = recArray(rec(snap?.['optionsChain'])['availableExpirations']);
      const requested = entries.find((e) => e['expirationDate'] === A);
      expect(requested?.['loaded'], symbol).toBe(true);
      expect(requested?.['validCallCount'], symbol).toBe(111);
      const anchor = entries.find((e) => e['expirationDate'] === B);
      expect(anchor?.['loaded'], symbol).toBe(false);
      expect(anchor?.['validCallCount'], symbol).toBe(0);
      const codes = rec(rec(rec(snap?.['terminalEngines'])['volAnalyticsSuite'])['expiriesByCode']);
      expect(rec(codes[A])['ivAtm'], symbol).toBe(0.11);
      expect(rec(codes[B])['ivAtm'], symbol).toBe(0.42);
    }
  });

  it('una base nueva con datos más recientes de A no es sobrescrita por el hecho puntual retenido', async () => {
    const A = POINT_DATE;

    // Visible: el puntual de A queda publicado y retenido; la base nueva lo supera.
    const base1 = bridge.requestUsSnapshot('ZQRE');
    await waitForFetchCount(1);
    fetchAt(0).resolveJson(basePayload('ZQRE'));
    await base1;
    const point = bridge.requestOptionsChain('US:ZQRE', false, A);
    await waitForFetchCount(2);
    fetchAt(1).resolveJson(pointPayload('ZQRE'));
    await point;

    const newerBase = bridge.requestUsSnapshot('ZQRE');
    await waitForFetchCount(3);
    fetchAt(2).resolveJson(
      usSnapshotPayload({
        symbol: 'ZQRE',
        asOfUtcSec: 3_000,
        spot: 61.5,
        aggregateGex: 333,
        traceSpot: 61.4,
        entries: [
          expiryFact(A, { loaded: true, calls: 300, puts: 301 }),
          expiryFact('2026-09-18', { loaded: false, calls: 0, puts: 0 }),
        ],
        codes: { [A]: analyticsCode(A, 0.33), '2026-09-18': analyticsCode('2026-09-18', 0.42) },
      }),
    );
    await newerBase;

    const afterNewer = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['ZQRE'];
    expect(afterNewer?.['asOfUtcSec']).toBe(3_000);
    const newerEntry = recArray(rec(afterNewer?.['optionsChain'])['availableExpirations']).find(
      (e) => e['expirationDate'] === A,
    );
    expect(newerEntry?.['validCallCount']).toBe(300);
    const newerCodes = rec(
      rec(rec(afterNewer?.['terminalEngines'])['volAnalyticsSuite'])['expiriesByCode'],
    );
    expect(rec(newerCodes[A])['ivAtm']).toBe(0.33);

    // Una base posterior que omite A conserva la información vigente de A.
    const omittingBase = bridge.requestUsSnapshot('ZQRE');
    await waitForFetchCount(4);
    fetchAt(3).resolveJson(
      usSnapshotPayload({
        symbol: 'ZQRE',
        asOfUtcSec: 4_000,
        spot: 61.5,
        aggregateGex: 444,
        traceSpot: 61.45,
        entries: [expiryFact('2026-09-18', { loaded: false, calls: 0, puts: 0 })],
        codes: { '2026-09-18': analyticsCode('2026-09-18', 0.42) },
      }),
    );
    await omittingBase;

    const afterOmit = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['ZQRE'];
    expect(afterOmit?.['asOfUtcSec']).toBe(4_000);
    const keptEntry = recArray(rec(afterOmit?.['optionsChain'])['availableExpirations']).find(
      (e) => e['expirationDate'] === A,
    );
    expect(keptEntry?.['loaded']).toBe(true);
    expect(keptEntry?.['validCallCount']).toBe(300);

    // Pendiente: si la base nueva trae A más nueva, el hecho retenido no revive.
    const pendingPoint = bridge.requestOptionsChain('US:ZQRF', false, A);
    await waitForFetchCount(5);
    fetchAt(4).resolveJson(pointPayload('ZQRF'));
    await pendingPoint;
    const pendingBase = bridge.requestUsSnapshot('ZQRF');
    await waitForFetchCount(6);
    fetchAt(5).resolveJson(
      usSnapshotPayload({
        symbol: 'ZQRF',
        asOfUtcSec: 3_000,
        spot: 61.5,
        aggregateGex: 333,
        traceSpot: 61.4,
        entries: [expiryFact(A, { loaded: true, calls: 300, puts: 301 })],
        codes: { [A]: analyticsCode(A, 0.33) },
      }),
    );
    await pendingBase;

    const pendingSnap = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['ZQRF'];
    const pendingEntry = recArray(rec(pendingSnap?.['optionsChain'])['availableExpirations']).find(
      (e) => e['expirationDate'] === A,
    );
    expect(pendingEntry?.['validCallCount']).toBe(300);
    const pendingCodes = rec(
      rec(rec(pendingSnap?.['terminalEngines'])['volAnalyticsSuite'])['expiriesByCode'],
    );
    expect(rec(pendingCodes[A])['ivAtm']).toBe(0.33);
  });
});

// ---------------------------------------------------------------------------
// REST: GET /api/snapshot?prefetch=0 con proveedores inyectados
// ---------------------------------------------------------------------------

type RuntimeDeps = NonNullable<ConstructorParameters<typeof MarketRuntime>[0]>;

class RecordingMarketRuntime extends MarketRuntime {
  public readonly snapshotCalls: {
    readonly symbol: string;
    readonly options: SnapshotOptions;
  }[] = [];

  public override async getSnapshot(
    rawSymbol: string,
    options: Parameters<MarketRuntime['getSnapshot']>[1] = {},
  ): Promise<TerminalSnapshotResponse> {
    this.snapshotCalls.push({ symbol: rawSymbol, options });
    return super.getSnapshot(rawSymbol, options);
  }
}

function createOfflineServerRuntime(): {
  readonly runtime: RecordingMarketRuntime;
  readonly barsCalls: string[];
} {
  const nowMs = Date.UTC(2026, 6, 15, 14, 30, 0); // miércoles 10:30 ET (RTH)
  const nowSec = Math.floor(nowMs / 1_000);
  const barsCalls: string[] = [];
  const dailyBars = Array.from({ length: 30 }, (_, index) => ({
    time: nowSec - (29 - index) * 86_400,
    open: 60 + index * 0.1,
    high: 60.5 + index * 0.1,
    low: 59.5 + index * 0.1,
    close: 60 + index * 0.1,
    volume: 10_000,
  }));
  const intradayBars = Array.from({ length: 40 }, (_, index) => ({
    time: nowSec - (39 - index) * 300,
    open: 62,
    high: 62.2,
    low: 61.8,
    close: 62,
    volume: 500,
  }));
  const treasuryObs = {
    date: '2026-07-14',
    dateTime: nowSec - 86_400,
    yield1Month: 0.05,
    yield3Month: 0.05,
    yield6Month: 0.05,
    yield1Year: 0.05,
    yield2Year: 0.05,
    yield3Year: 0.05,
    yield5Year: 0.05,
    yield7Year: 0.05,
    yield10Year: 0.05,
    yield20Year: 0.05,
    yield30Year: 0.05,
    finiteTenors: 11,
  };
  const runtime = new RecordingMarketRuntime({
    apiKey: 'pieza509b-server-key',
    secrets: ['pieza509b-server-key'],
    enableWs: false,
    nowMsFn: () => nowMs,
    fetchFn: (() =>
      Promise.resolve({ ok: false, status: 404, text: '{}' })) as unknown as NonNullable<
      RuntimeDeps['fetchFn']
    >,
    loadBarsFn: ((req: { readonly timeframe?: string }) => {
      barsCalls.push(req.timeframe ?? 'unknown');
      return Promise.resolve({
        bars: req.timeframe === '1D' ? dailyBars : intradayBars,
        visibleStart: 0,
        report: { provider: 'massive', fetchedPages: 1, barsCount: 30, providerError: null },
      });
    }) as unknown as NonNullable<RuntimeDeps['loadBarsFn']>,
    loadUnifiedSnapshotFn: (() =>
      Promise.resolve({
        stocks: [
          {
            ticker: 'SPY',
            marketStatus: 'open',
            session: {
              open: 61,
              high: 63,
              low: 60,
              close: 62,
              previousClose: 61,
              change: 1,
              changePercent: 1.6,
              volume: 1_000_000,
              vwap: 62,
            },
            lastQuote: { bid: 61.9, ask: 62.1, midpoint: 62, bidSize: 100, askSize: 100 },
            lastTrade: { price: 62, size: 100, timeSec: nowSec },
          },
        ],
        indices: [],
        options: [],
        other: [],
        tickerErrors: [],
        report: { providerError: null },
      })) as unknown as NonNullable<RuntimeDeps['loadUnifiedSnapshotFn']>,
    loadOptionChainFn: (() =>
      Promise.resolve({
        contracts: [],
        underlying: null,
        report: {
          provider: 'massive',
          fetchedPages: 1,
          providerError: null,
          stoppedReason: 'noMorePages',
        },
      })) as unknown as NonNullable<RuntimeDeps['loadOptionChainFn']>,
    loadOptionContractsFn: (() =>
      Promise.resolve({
        contracts: [],
        report: { providerError: null, stoppedReason: 'noMorePages' },
      })) as unknown as NonNullable<RuntimeDeps['loadOptionContractsFn']>,
    loadTreasuryYieldsFn: (() =>
      Promise.resolve({
        observations: [treasuryObs],
        report: { providerError: null },
      })) as unknown as NonNullable<RuntimeDeps['loadTreasuryYieldsFn']>,
    loadFundingConditionsFn: (() =>
      Promise.resolve({ observations: [], report: { providerError: null } })) as unknown as NonNullable<
      RuntimeDeps['loadFundingConditionsFn']
    >,
    loadDividendsFn: (() =>
      Promise.resolve({ dividends: [], report: { providerError: null } })) as unknown as NonNullable<
      RuntimeDeps['loadDividendsFn']
    >,
  });
  return { runtime, barsCalls };
}

describe('Pieza 50.9 Bloque B — GET /api/snapshot?prefetch=0', () => {
  const activeServers: HttpWsServerHandle[] = [];

  afterAll(async () => {
    for (const server of activeServers) {
      await server.stop();
    }
  });

  it('conserva clave, cuerpo y TTL: sin cargas adicionales en frío ni en caliente, y omisión con el contrato previo', async () => {
    const { runtime, barsCalls } = createOfflineServerRuntime();
    const server = createHttpWsServer({
      runtime,
      host: '127.0.0.1',
      port: 0,
      secrets: ['pieza509b-server-key'],
      startRuntimeWs: false,
    });
    activeServers.push(server);
    const { host, port } = await server.start();
    const base = `http://${host}:${String(port)}`;

    const coldRes = await fetch(`${base}/api/snapshot?symbol=SPY&timeframe=5m&prefetch=0`);
    expect(coldRes.status).toBe(200);
    const coldBody = (await coldRes.json()) as Record<string, unknown>;
    expect(coldBody['symbol']).toBe('SPY');
    // Identidad del snapshot base cacheado (el overlay live puede enriquecer
    // cotizaciones entre llamadas sin recomputar el snapshot).
    const baseIdentity = (body: Record<string, unknown>): Record<string, unknown> => ({
      status: body['status'],
      symbol: body['symbol'],
      asOfUtcSec: body['asOfUtcSec'],
      optionsChain: body['optionsChain'],
    });
    const coldIdentity = baseIdentity(coldBody);
    const coldBars = barsCalls.length;
    expect(coldBars).toBeGreaterThan(0);
    expect(runtime.snapshotCalls).toHaveLength(1);
    expect(optionsAt(runtime.snapshotCalls, 0)).toEqual({ forceRefresh: false, prefetch: false });

    // Hit de caché con la misma clave: misma base y cero recomputos.
    const hitRes = await fetch(`${base}/api/snapshot?symbol=SPY&timeframe=5m&prefetch=0`);
    expect(hitRes.status).toBe(200);
    expect(baseIdentity((await hitRes.json()) as Record<string, unknown>)).toEqual(coldIdentity);
    expect(barsCalls.length).toBe(coldBars);
    expect(runtime.snapshotCalls).toHaveLength(2);
    expect(optionsAt(runtime.snapshotCalls, 1)).toEqual({ forceRefresh: false, prefetch: false });

    // Sin parámetro: contrato previo (`prefetch: true`) y misma entrada de caché.
    const defaultRes = await fetch(`${base}/api/snapshot?symbol=SPY&timeframe=5m`);
    expect(defaultRes.status).toBe(200);
    expect(baseIdentity((await defaultRes.json()) as Record<string, unknown>)).toEqual(coldIdentity);
    expect(optionsAt(runtime.snapshotCalls, 2)).toEqual({ forceRefresh: false, prefetch: true });

    // `prefetch=1` también mantiene el prefetch habilitado (solo `0` lo omite).
    const oneRes = await fetch(`${base}/api/snapshot?symbol=SPY&timeframe=5m&prefetch=1`);
    expect(oneRes.status).toBe(200);
    expect(optionsAt(runtime.snapshotCalls, 3)).toEqual({ forceRefresh: false, prefetch: true });

    // `refresh=1&prefetch=0`: recomputa la base sin lanzar prefetch.
    const refreshRes = await fetch(
      `${base}/api/snapshot?symbol=SPY&timeframe=5m&refresh=1&prefetch=0`,
    );
    expect(refreshRes.status).toBe(200);
    const refreshedBars = barsCalls.length;
    expect(refreshedBars).toBeGreaterThan(coldBars);
    expect(optionsAt(runtime.snapshotCalls, 4)).toEqual({ forceRefresh: true, prefetch: false });

    // `expiration` sigue pasando tal cual junto a la opción.
    const expiryRes = await fetch(
      `${base}/api/snapshot?symbol=SPY&timeframe=5m&expiration=2026-08-21&prefetch=0`,
    );
    expect(expiryRes.status).toBe(200);
    expect(optionsAt(runtime.snapshotCalls, 5)).toEqual({
      forceRefresh: false,
      prefetch: false,
      expiration: '2026-08-21',
    });

    // Estabilidad: ningún prefetch fire-and-forget pudo alterar los conteos.
    const barsBeforeSettle = barsCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(barsCalls.length).toBe(barsBeforeSettle);
    expect(runtime.snapshotCalls).toHaveLength(6);
    const expiryCalls = runtime.snapshotCalls.filter(
      (call) => call.options.expiration !== undefined,
    );
    expect(expiryCalls).toHaveLength(1);
    expect(optionsAt(expiryCalls, 0).expiration).toBe('2026-08-21');
  });
});
