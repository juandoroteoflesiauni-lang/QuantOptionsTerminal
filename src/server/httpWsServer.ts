import { coalesceOptionQuoteUpdate } from '../core/opraOptionIntegrity.js';
/**
 * Servidor HTTP + WebSocket local (`node:http` + `ws`) para QuantOptionsTerminal (Pieza 13).
 *
 * Endpoints HTTP:
 *  - `GET /api/health`
 *  - `GET /api/snapshot?symbol=SPY`
 *  - `GET /api/bars?symbol=SPY&timeframe=5m&visibleBars=240&rthOnly=0`
 *  - `GET /api/unusual?symbol=SPY&root=...&minPremium=...&limit=100`
 *  - `GET /api/ar/overview`
 *  - `GET /api/ar/macro`
 *  - `GET /api/ar/monitoring?panel=acciones|bonos|cedears|cauciones`
 *  - `GET /api/ar/stock?symbol=GGAL`
 *  - `GET /api/ar/options?underlying=GGAL`
 *  - `GET /api/ar/relations`
 *  - `GET /api/ar/positions`
 *  - `GET /api/ar/ggal-specialist/overview`
 *  - `GET /api/ar/ggal-specialist/parity-gap`
 *  - `GET /api/ar/ggal-specialist/vol-triangle`
 *  - `GET /api/ar/ggal-specialist/dual-density`
 *  - `GET /api/ar/ggal-specialist/structure-pinning`
 *  - `POST /api/ar/ggal-specialist/strategy-selector`
 *  - `POST /api/ar/ggal-specialist/anexo-b/ingest`
 *  - `GET /api/ar/ggal-specialist/margin-risk`
 *  - `GET /api/us/providers-status` (Pieza 32: MASSIVE_WS, MASSIVE_REST_POOL,
 *    TRADIER_LIVE y ORATS con keySlot/activeRole, sin material secreto)
 *  - `GET /api/system/feeds-health` (Pieza 33: telemetría unificada de 7 feeds)
 *  - `GET /api/fmp/plan-probe` (Pieza 41.4: plan mínimo FMP por alias, sin secretos)
 *  - `POST /api/system/feeds-reconnect` (Pieza 33: reconnect/resync individual)
 *
 * WebSocket:
 *  - `ws://host:port/ws`
 *  - `ws://host:port/ws?channel=feeds-health` (solo `FEEDS_HEALTH_PULSE`)
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { constants as zlibConstants, gzip } from 'node:zlib';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  GgalAvwapAnchorMode,
  GgalDualChartCoordMode,
  GgalDualChartTimeframe,
} from '../core/ggal/institutionalContracts.js';
import { toErrorMessage } from '../data/normalizeShared.js';
import { computeLiveFxFromQuotes } from '../core/realtimePropagation.js';
import {
  ArgentinaMarketRuntime,
  resolveArDefaultTerminalMarket,
  type ArMonitoringResponse,
} from './argentinaMarketLoader.js';
import { collectArFeedSecrets } from './arFeedRouter.js';
import { GgalSpecialistRuntime } from './ggalSpecialistRuntime.js';
import {
  FeedsHealthMonitor,
  type FeedProviderId,
  type FeedsHealthPulse,
} from './feedsHealthMonitor.js';
import {
  MarketRuntime,
  RuntimeNoDataError,
  loadRuntimeAuth,
  OPTIONS_UNDERLYING_UNIVERSE,
  type RuntimeWsBroadcast,
} from './marketRuntime.js';
import { loadOratsClientConfigFromEnv } from './oratsHybridClient.js';
import { probeFmpPlans } from './fmpPlanProbe.js';
import { collectBrokerSecretsFromEnv } from './primaryRofexLoader.js';
import { redactSecrets } from './runtimeCache.js';
import {
  WS_BACKPRESSURE_CLOSE_CODE,
  computeOrderBookSignature,
  evaluateHeartbeatSweep,
  evaluateWsBackpressure,
  extractOptionUnderlying,
  hasMarketQuoteChanged,
  hasOptionQuoteChanged,
  normalizeViewScope,
  resolveScopedL2Symbol,
  shouldEmitGgalBarTickToClient,
  shouldEmitOptionQuoteToClient,
  type LiveOptionQuoteSnapshot,
} from './wsViewScopeBackpressure.js';

const LOCALHOST_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

export interface HttpWsServerOptions {
  readonly runtime?: MarketRuntime;
  readonly arRuntime?: ArgentinaMarketRuntime;
  readonly ggalRuntime?: GgalSpecialistRuntime;
  readonly host?: string;
  readonly port?: number;
  readonly secrets?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly startRuntimeWs?: boolean;
  readonly enableBackgroundWarmup?: boolean;
  readonly heartbeatIntervalMs?: number;
  readonly optionFlushIntervalMs?: number;
  readonly getClientBufferedAmount?: (ws: WebSocket) => number;
}

export interface HttpWsServerHandle {
  readonly httpServer: Server;
  readonly wss: WebSocketServer;
  readonly runtime: MarketRuntime;
  readonly arRuntime: ArgentinaMarketRuntime;
  readonly ggalRuntime: GgalSpecialistRuntime;
  readonly feedsHealthMonitor: FeedsHealthMonitor;
  start(): Promise<{ readonly host: string; readonly port: number }>;
  stop(): Promise<void>;
}

interface ScopedOrderBookPayload {
  readonly symbol: string;
  readonly bids: readonly { readonly price: number; readonly size: number; readonly orderCount: number | null }[];
  readonly asks: readonly { readonly price: number; readonly size: number; readonly orderCount: number | null }[];
  readonly microprice: number | null;
  readonly micropriceL1: number | null;
  readonly vpin: number | null;
  readonly asOfUtcSec: number | null;
  readonly source: string;
}

interface ClientSubscriptionState {
  symbols: Set<string> | null;
  needsSnapshot: boolean;
  healthOnly: boolean;
  /** Pieza 40: dueño del lease dinámico y símbolo de alta frecuencia. */
  ownerId: string;
  /** Pieza 48: scope de vista activa y control de contrapresión/revisión por cliente. */
  view: string | null;
  focusSymbol: string | null;
  focusMarket: 'AR' | 'US' | null;
  ggalMode: 'ADR' | 'ARS' | 'CCL' | null;
  ggalTimeframe: string | null;
  clientDeltaRevision: number;
  backpressureActive: boolean;
  coalescedDeltaQuotes: Map<string, ReturnType<MarketRuntime['getLiveUsQuotes']>[number]>;
  coalescedDeltaRemoved: Set<string>;
  coalescedCauciones: readonly unknown[] | null;
  coalescedFutures: readonly unknown[] | null;
  marketEvents: Map<string, RuntimeWsBroadcast>;
  focusEvents: Map<string, RuntimeWsBroadcast>;
  optionQuotesBuffer: Map<string, LiveOptionQuoteSnapshot>;
  lastSentOptionQuotes: Map<string, LiveOptionQuoteSnapshot>;
  lastSentStockQuotes: Map<string, string>;
  lastSentL2Sig: string | null;
  lastSentMacroSig: string | null;
  pongReceived: boolean;
  missedHeartbeats: number;
}

function isBenignSocketError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { readonly code?: unknown }).code;
  return code === 'ECONNRESET' || code === 'ECONNABORTED';
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && LOCALHOST_ORIGIN_PATTERN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

async function readJsonBody(
  req: IncomingMessage,
  secrets: readonly string[],
  maxBytes = 1_048_576,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) {
      throw new RuntimeNoDataError(
        'INVALID_PARAMETER',
        'Request JSON body exceeds 1 MB limit',
        secrets,
        400,
      );
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err: unknown) {
    throw new RuntimeNoDataError(
      'INVALID_PARAMETER',
      redactSecrets(`Invalid JSON request body: ${toErrorMessage(err, 'Malformed JSON')}`, secrets),
      secrets,
      400,
    );
  }
}

const GZIP_COMPRESS_THRESHOLD_BYTES = 8_192;

function appendVaryHeader(res: ServerResponse, token: string): void {
  const current = res.getHeader('Vary');
  if (typeof current === 'string' && current.trim() !== '') {
    const items = current.split(',').map((item) => item.trim().toLowerCase());
    if (!items.includes(token.toLowerCase())) {
      res.setHeader('Vary', `${current}, ${token}`);
    }
    return;
  }
  if (Array.isArray(current) && current.length > 0) {
    const joined = current.join(', ');
    if (!joined.toLowerCase().includes(token.toLowerCase())) {
      res.setHeader('Vary', `${joined}, ${token}`);
    }
    return;
  }
  res.setHeader('Vary', token);
}

function acceptsGzipEncoding(req: IncomingMessage | undefined): boolean {
  const raw = req?.headers['accept-encoding'];
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  for (const part of raw.toLowerCase().split(',')) {
    const [encodingRaw, ...params] = part.trim().split(';');
    if (encodingRaw?.trim() === 'gzip') {
      const qParam = params.find((p) => p.trim().startsWith('q='));
      if (qParam !== undefined && Number(qParam.trim().slice(2)) === 0) {
        return false;
      }
      return true;
    }
  }
  return false;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const byteLength = Buffer.byteLength(body, 'utf8');
  if (byteLength >= GZIP_COMPRESS_THRESHOLD_BYTES) {
    appendVaryHeader(res, 'Accept-Encoding');
    if (acceptsGzipEncoding(res.req)) {
      gzip(body, { level: zlibConstants.Z_BEST_SPEED }, (err, compressed) => {
        if (res.writableEnded || res.destroyed) return;
        if (err === null) {
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Content-Length', String(compressed.length));
          res.end(compressed);
          return;
        }
        res.end(body);
      });
      return;
    }
  }
  res.end(body);
}

function parseOptionalPositiveInt(
  raw: string | null,
  label: string,
  secrets: readonly string[],
): number | undefined {
  if (raw === null || raw.trim() === '') {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new RuntimeNoDataError(
      'INVALID_PARAMETER',
      `Parameter "${label}" must be a positive integer (got "${raw}")`,
      secrets,
      400,
    );
  }
  return n;
}

function parseOptionalPositiveNumber(
  raw: string | null,
  label: string,
  secrets: readonly string[],
): number | undefined {
  if (raw === null || raw.trim() === '') {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RuntimeNoDataError(
      'INVALID_PARAMETER',
      `Parameter "${label}" must be a positive number (got "${raw}")`,
      secrets,
      400,
    );
  }
  return n;
}

function parseBooleanFlag(raw: string | null): boolean {
  if (raw === null) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseMonitoringPanel(
  raw: string | null,
  secrets: readonly string[],
): ArMonitoringResponse['panel'] {
  if (raw === null || raw.trim() === '') {
    return 'acciones';
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === 'acciones' ||
    normalized === 'bonos' ||
    normalized === 'cedears' ||
    normalized === 'cauciones'
  ) {
    return normalized;
  }
  throw new RuntimeNoDataError(
    'INVALID_PARAMETER',
    `Unsupported panel "${raw}". Expected one of: acciones, bonos, cedears, cauciones`,
    secrets,
    400,
  );
}

function shouldSendBroadcast(
  state: ClientSubscriptionState,
  event: RuntimeWsBroadcast,
): boolean {
  if (event.type === 'status') {
    return true;
  }
  const eventSymbol =
    event.type === 'bar_update' || event.type === 'trade' || event.type === 'quote'
      ? event.symbol
      : '';
  if (state.symbols === null || state.symbols.size === 0 || state.symbols.has('*')) {
    return true;
  }
  if (state.symbols.has(eventSymbol)) {
    return true;
  }
  for (const watched of state.symbols) {
    if (eventSymbol.startsWith(`O:${watched}`)) {
      return true;
    }
  }
  return false;
}

/** Pieza 40: clave estable para latest-write-wins dentro de cada ciclo. */
export function coalesceEventKey(event: RuntimeWsBroadcast): string {
  if (event.type === 'ggal_bar_tick') {
    return `${event.type}:${event.mode}:${event.timeframe}:${event.symbol}:${String(event.bar.timeSec)}`;
  }
  if (event.type === 'status') {
    return `${event.type}:${event.cluster}`;
  }
  return `${event.type}:${event.cluster}:${event.symbol}`;
}

export function enqueueCoalescedEvent(
  pending: Map<string, RuntimeWsBroadcast>,
  key: string,
  event: RuntimeWsBroadcast,
): void {
  const existing = pending.get(key);
  if (event.type === 'ggal_bar_tick' && existing?.type === 'ggal_bar_tick' &&
      (existing.bucketRevision ?? 0) > (event.bucketRevision ?? 0)) return;
  pending.set(key, event);
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim() !== '') {
    return err.message;
  }
  return toErrorMessage(err, fallback);
}

export function createHttpWsServer(options: HttpWsServerOptions = {}): HttpWsServerHandle {
  const auth = loadRuntimeAuth(options.env ?? process.env);
  const runtime = options.runtime ?? new MarketRuntime();
  const brokerSecrets = collectBrokerSecretsFromEnv(options.env ?? process.env);
  const secrets = [...new Set([...(options.secrets ?? auth.secrets), ...brokerSecrets])];
  const arRuntime = options.arRuntime ?? new ArgentinaMarketRuntime({
    secrets,
    env: options.env ?? process.env,
    usRuntime: runtime,
  });
  const effectiveEnv = options.env ?? process.env;
  const oratsKey = loadOratsClientConfigFromEnv(effectiveEnv).apiKey;
  const extraSecrets = [
    ...collectArFeedSecrets(effectiveEnv),
    ...(oratsKey !== null ? [oratsKey] : []),
  ];
  const getAllSecrets = (): readonly string[] => [
    ...new Set([...secrets, ...extraSecrets, ...arRuntime.getSecrets()]),
  ];
  const sharedOrats = runtime.getOratsClient();
  const ggalRuntime =
    options.ggalRuntime ??
    new GgalSpecialistRuntime({
      ...(sharedOrats ? { oratsClient: sharedOrats } : {}),
      runtime,
      arRuntime,
      secrets: getAllSecrets(),
      env: effectiveEnv,
    });
  const getOrats = () => {
    const us = runtime.getOratsFeedHealth();
    const ggal = ggalRuntime.getOratsFeedHealth();
    if (!us || !us.configured) return ggal;
    if (!ggal.configured) return us;
    const priority = (h: typeof us) => h.lastFetchAtUtcSec === null ? 0 : h.healthStatus === 'OPERATIONAL' ? 1 : 2;
    return priority(us) > priority(ggal) || (priority(us) === priority(ggal) && (us.lastFetchAtUtcSec ?? 0) > (ggal.lastFetchAtUtcSec ?? 0)) ? us : ggal;
  };
  const feedsHealthMonitor = new FeedsHealthMonitor({
    getMassiveWs: () => runtime.getMassiveWsFeedHealth(),
    getMassiveRest: () => runtime.getMassiveRestFeedHealth(),
    getTradier: () => runtime.getTradierFeedHealth(),
    getFmp: () => runtime.getFmpEnterpriseFeedHealth(),
    getOrats,
    getPrimary: () => arRuntime.getPrimaryFeedHealth(),
    getBmb: () => arRuntime.getBmbFeedHealth(),
    getIol: () => arRuntime.getIolFeedHealth(),
    reconnectMassiveWs: () => runtime.reconnectMassiveStocksWs(),
    resyncMassiveRest: () => runtime.resyncMassiveRestPool(),
    reconnectTradier: () => runtime.reconnectTradierLive(),
    resyncFmp: () => runtime.resyncFmpEnterpriseBatch(),
    resyncOrats: () => ggalRuntime.resyncOrats(),
    reconnectPrimary: () => arRuntime.reconnectPrimaryDlr(),
    reconnectBmb: () => arRuntime.reconnectBmb(),
    reconnectIol: () => arRuntime.reconnectIol(),
    secrets: getAllSecrets(),
  });
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const startRuntimeWs = options.startRuntimeWs ?? false;
  const enableBackgroundWarmup = options.enableBackgroundWarmup ?? false;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;
  const optionFlushIntervalMs = options.optionFlushIntervalMs ?? 200;
  const getClientBufferedAmount = options.getClientBufferedAmount ?? ((ws: WebSocket): number => ws.bufferedAmount);
  let warmupStatus: 'IDLE' | 'WARMING_UP' | 'READY' = 'IDLE';

  const clientStates = new WeakMap<WebSocket, ClientSubscriptionState>();
  let marketTickSequence = 0;
  let deltaRevision = 0;
  let marketTickTimer: ReturnType<typeof setInterval> | null = null;
  let focusTickTimer: ReturnType<typeof setInterval> | null = null;
  let optionQuotesTimer: ReturnType<typeof setInterval> | null = null;
  let feedsHealthTimer: ReturnType<typeof setInterval> | null = null;
  let wsClientIdSequence = 0;
  let previousDeltaQuotes = new Map<string, (ReturnType<MarketRuntime['getLiveUsQuotes']>)[number]>();
  let previousDeltaCauciones = '';
  let previousDeltaFutures = '';

  const resolveLiveOrderBookForSymbol = (symbol: string): ScopedOrderBookPayload | null => {
    const clean = symbol.trim().toUpperCase();
    if (clean === '') return null;
    const bmbSnap = arRuntime.getCachedBmbSnapshot();
    const bmbBook = bmbSnap?.orderBooksBySymbol[clean];
    if (bmbBook !== undefined && (bmbBook.bids.length > 0 || bmbBook.asks.length > 0)) {
      return {
        symbol: clean,
        bids: bmbBook.bids.map((l) => ({ price: l.price, size: l.size, orderCount: l.orderCount ?? null })),
        asks: bmbBook.asks.map((l) => ({ price: l.price, size: l.size, orderCount: l.orderCount ?? null })),
        microprice: null,
        micropriceL1: null,
        vpin: null,
        asOfUtcSec: bmbBook.asOfUtcSec,
        source: bmbBook.source,
      };
    }
    const primaryBook = arRuntime.getCachedPrimaryMervBook(clean);
    if (primaryBook !== null && (primaryBook.bids.length > 0 || primaryBook.asks.length > 0)) {
      return {
        symbol: clean,
        bids: primaryBook.bids.map((l) => ({ price: l.price, size: l.size, orderCount: l.orderCount ?? null })),
        asks: primaryBook.asks.map((l) => ({ price: l.price, size: l.size, orderCount: l.orderCount ?? null })),
        microprice: null,
        micropriceL1: null,
        vpin: null,
        asOfUtcSec: primaryBook.asOfUtcSec,
        source: primaryBook.source,
      };
    }
    return null;
  };

  const clearClientBuffers = (state: ClientSubscriptionState): void => {
    state.marketEvents.clear();
    state.focusEvents.clear();
    state.coalescedDeltaQuotes.clear();
    state.coalescedDeltaRemoved.clear();
    state.coalescedCauciones = null;
    state.coalescedFutures = null;
    state.optionQuotesBuffer.clear();
  };

  const checkClientBackpressure = (
    client: WebSocket,
    state: ClientSubscriptionState,
  ): 'SEND' | 'COALESCE' | 'KILL' => {
    const decision = evaluateWsBackpressure(getClientBufferedAmount(client), state.backpressureActive);
    state.backpressureActive = decision.nextConflating;
    if (decision.action === 'KILL') {
      clearClientBuffers(state);
      try {
        client.close(WS_BACKPRESSURE_CLOSE_CODE, 'backpressure_kill_water_mark');
      } catch {
        // Ignore close errors if already closing.
      }
      return 'KILL';
    }
    return decision.action;
  };

  const buildMarketTickBatch = (clientRevision?: number) => {
    marketTickSequence += 1;
    const ar = arRuntime.getLiveArMarketSnapshot();
    const quotes = [...runtime.getLiveUsQuotes(), ...ar.quotes];
    const liveFx = computeLiveFxFromQuotes(quotes);
    return {
      type: 'MARKET_TICK_BATCH' as const,
      sequence: marketTickSequence,
      deltaRevision: clientRevision ?? deltaRevision,
      serverTimeSec: Math.floor(Date.now() / 1_000),
      quotes,
      liveFx,
      cclMedian: liveFx.cclMedian ?? ar.overview?.cclMedian ?? ar.monitoring?.cclMedian ?? null,
      mepMedian: liveFx.mepMedian ?? ar.overview?.mepMedian ?? ar.monitoring?.mepMedian ?? null,
      arSourceMode: ar.sourceMode,
      usSourceMode: runtime.getUsLiveSourceMode(),
      arFeedStatus: ar.overview?.feedStatus ?? ar.monitoring?.feedStatus ?? 'NO_DATA',
      cauciones: ar.cauciones.map((row) => ({
        termDays: row.termDays,
        currency: row.currency,
        tnaWeighted: row.tnaWeighted,
        teaEffective: row.teaEffective,
        bidTna: row.bidTna,
        askTna: row.askTna,
        turnoverArs: row.volumeArs,
        spreadVsBadlarBps: row.spreadVsBadlarBps,
        asOfUtcSec: row.asOfUtcSec,
        source:
          row.source === 'PRIMARY_ECO_WS'
            ? 'PRIMARY_ECO_WS'
            : row.source === 'BMB_HOMEBROKER'
              ? 'BMB_HOMEBROKER'
              : row.source === 'IOL_REST'
                ? 'IOL_REST'
                : 'BCRA_LECAP_REF',
        referenceInstrument: row.referenceInstrument,
      })),
      futures: ar.futures.map((contract) => ({
        contract: contract.contract,
        category: contract.category,
        maturity: contract.maturity,
        days: contract.days,
        price: contract.price,
        priceBasis: contract.priceBasis,
        last: contract.last,
        settlement: contract.settlement,
        close: contract.close,
        bid: contract.bid,
        bidPrice: contract.bidPrice,
        bidSize: contract.bidSize,
        ask: contract.ask,
        askPrice: contract.askPrice,
        askSize: contract.askSize,
        openInterest: contract.openInterest,
        nominalVolume: contract.nominalVolume,
        spotUsed: contract.spotUsed,
        spotSource: contract.spotSource,
        devalDirectaPct: contract.devalDirectaPct,
        tnaImplicitaPct: contract.tnaImplicitaPct,
        teaImplicitaPct: contract.teaImplicitaPct,
        temImplicitaPct: contract.temImplicitaPct,
        forwardToForwardPct: contract.forwardToForwardPct,
        updatedAtUtcSec: contract.updatedAtUtcSec,
        source: contract.source,
      })),
      futuresSource: ar.futuresSource,
    };
  };

  const buildTickDelta = () => {
    deltaRevision += 1;
    const snapshot = buildMarketTickBatch();
    const nextQuotes = new Map<string, (typeof snapshot.quotes)[number]>(
      snapshot.quotes.map((quote) => [`${quote.market}:${quote.symbol}:${quote.settlement ?? ''}`, quote] as const),
    );
    const changed: typeof snapshot.quotes[number][] = [];
    for (const [key, quote] of nextQuotes) {
      const previous = previousDeltaQuotes.get(key);
      if (hasMarketQuoteChanged(previous, quote)) changed.push(quote);
    }
    const removed = [...previousDeltaQuotes.keys()].filter((key) => !nextQuotes.has(key));
    const caucionesJson = JSON.stringify(snapshot.cauciones);
    const caucionesChanged = caucionesJson !== previousDeltaCauciones;
    const futuresJson = JSON.stringify(snapshot.futures);
    const futuresChanged = futuresJson !== previousDeltaFutures;
    previousDeltaQuotes = nextQuotes;
    previousDeltaCauciones = caucionesJson;
    previousDeltaFutures = futuresJson;
    const { cauciones: allCauciones, futures: allFutures, ...snapshotRest } = snapshot;
    return {
      ...snapshotRest,
      type: 'TICK_DELTA' as const,
      quotes: changed,
      removed,
      ...(caucionesChanged ? { cauciones: allCauciones } : {}),
      ...(futuresChanged ? { futures: allFutures } : {}),
    };
  };

  const formatMacroSig = (batch: {
    readonly arSourceMode: string | null | undefined;
    readonly usSourceMode: string | null | undefined;
    readonly arFeedStatus: string | null | undefined;
    readonly futuresSource?: string | null | undefined;
    readonly cclMedian: number | null | undefined;
    readonly mepMedian: number | null | undefined;
  }): string =>
    `${batch.arSourceMode ?? ''}|${batch.usSourceMode ?? ''}|${batch.arFeedStatus ?? ''}|${batch.futuresSource ?? ''}|${batch.cclMedian !== null && batch.cclMedian !== undefined ? String(batch.cclMedian) : ''}|${batch.mepMedian !== null && batch.mepMedian !== undefined ? String(batch.mepMedian) : ''}`;

  const sendMarketTickBatch = (client: WebSocket, state?: ClientSubscriptionState): void => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (state !== undefined) {
      if (checkClientBackpressure(client, state) !== 'SEND') return;
      const batch = buildMarketTickBatch(state.clientDeltaRevision);
      state.lastSentMacroSig = formatMacroSig(batch);
      client.send(JSON.stringify(batch));
      return;
    }
    if (getClientBufferedAmount(client) > 1_048_576) return;
    client.send(JSON.stringify(buildMarketTickBatch()));
  };

  const sendFeedsHealthPulse = (client: WebSocket, pulse: FeedsHealthPulse): void => {
    if (client.readyState !== WebSocket.OPEN) return;
    const state = clientStates.get(client);
    if (state !== undefined) {
      if (checkClientBackpressure(client, state) !== 'SEND') return;
    } else if (getClientBufferedAmount(client) > 1_048_576) {
      return;
    }
    client.send(JSON.stringify(pulse));
  };

  const sendMarketBatch = (
    client: WebSocket,
    state: ClientSubscriptionState,
    events: readonly RuntimeWsBroadcast[],
    delta: Record<string, unknown> | null,
  ): void => {
    if (client.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, unknown> = {
      type: 'market_batch',
      serverTimeSec: Math.floor(Date.now() / 1_000),
      focusSymbol: state.focusSymbol,
      events,
    };
    if (delta !== null) payload['delta'] = delta;
    client.send(JSON.stringify(payload));
  };

  const flushGeneralMarketBatches = (): void => {
    const globalDelta = buildTickDelta();
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const state = clientStates.get(client);
      if (state === undefined || state.healthOnly) continue;

      for (const quote of globalDelta.quotes) {
        const key = `${quote.market}:${quote.symbol}:${quote.settlement ?? ''}`;
        state.coalescedDeltaQuotes.set(key, quote);
        state.coalescedDeltaRemoved.delete(key);
      }
      for (const removedKey of globalDelta.removed) {
        state.coalescedDeltaQuotes.delete(removedKey);
        state.coalescedDeltaRemoved.add(removedKey);
      }
      if (globalDelta.cauciones !== undefined) {
        state.coalescedCauciones = globalDelta.cauciones;
      }
      if (globalDelta.futures !== undefined) {
        state.coalescedFutures = globalDelta.futures;
      }

      if (checkClientBackpressure(client, state) !== 'SEND') {
        continue;
      }

      if (state.needsSnapshot) {
        sendMarketTickBatch(client, state);
        state.needsSnapshot = false;
        clearClientBuffers(state);
        continue;
      }

      const l2Sym = resolveScopedL2Symbol(state);
      let liveOrderBook: ScopedOrderBookPayload | undefined;
      if (l2Sym !== null) {
        const book = resolveLiveOrderBookForSymbol(l2Sym);
        const sig = computeOrderBookSignature(book);
        if (book !== null && sig !== null && sig !== state.lastSentL2Sig) {
          liveOrderBook = book;
          state.lastSentL2Sig = sig;
        }
      }

      const macroSig = formatMacroSig(globalDelta);
      const hasEffectiveChanges =
        state.coalescedDeltaQuotes.size > 0 ||
        state.coalescedDeltaRemoved.size > 0 ||
        state.coalescedCauciones !== null ||
        state.coalescedFutures !== null ||
        liveOrderBook !== undefined ||
        state.marketEvents.size > 0 ||
        state.lastSentMacroSig !== macroSig;
      if (!hasEffectiveChanges) {
        continue;
      }

      state.lastSentMacroSig = macroSig;
      state.clientDeltaRevision += 1;
      const clientDelta: Record<string, unknown> = {
        type: globalDelta.type,
        sequence: globalDelta.sequence,
        serverTimeSec: globalDelta.serverTimeSec,
        liveFx: globalDelta.liveFx,
        cclMedian: globalDelta.cclMedian,
        mepMedian: globalDelta.mepMedian,
        arSourceMode: globalDelta.arSourceMode,
        usSourceMode: globalDelta.usSourceMode,
        arFeedStatus: globalDelta.arFeedStatus,
        futuresSource: globalDelta.futuresSource,
        deltaRevision: state.clientDeltaRevision,
        quotes: [...state.coalescedDeltaQuotes.values()],
        removed: [...state.coalescedDeltaRemoved],
        ...(state.coalescedCauciones !== null ? { cauciones: state.coalescedCauciones } : {}),
        ...(state.coalescedFutures !== null ? { futures: state.coalescedFutures } : {}),
        ...(liveOrderBook !== undefined ? { liveOrderBook } : {}),
      };

      sendMarketBatch(client, state, [...state.marketEvents.values()], clientDelta);
      state.marketEvents.clear();
      state.coalescedDeltaQuotes.clear();
      state.coalescedDeltaRemoved.clear();
      state.coalescedCauciones = null;
      state.coalescedFutures = null;
    }
  };

  const flushFocusedMarketBatches = (): void => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const state = clientStates.get(client);
      if (state === undefined || state.healthOnly || state.focusSymbol === null) continue;
      if (state.focusEvents.size === 0) continue;
      if (checkClientBackpressure(client, state) !== 'SEND') {
        continue;
      }
      const events = [...state.focusEvents.values()];
      sendMarketBatch(client, state, events, null);
      state.focusEvents.clear();
    }
  };

  const flushOptionQuotesBatches = (): void => {
    const serverTimeSec = Math.floor(Date.now() / 1_000);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const state = clientStates.get(client);
      if (state === undefined || state.healthOnly || state.view !== 'options') continue;
      if (state.optionQuotesBuffer.size === 0) continue;
      if (checkClientBackpressure(client, state) !== 'SEND') {
        continue;
      }
      const changed: LiveOptionQuoteSnapshot[] = [];
      for (const quote of state.optionQuotesBuffer.values()) {
        if (!shouldEmitOptionQuoteToClient(state, quote.underlying)) continue;
        const prev = state.lastSentOptionQuotes.get(quote.symbol);
        if (hasOptionQuoteChanged(prev, quote)) {
          changed.push(quote);
          state.lastSentOptionQuotes.set(quote.symbol, quote);
        }
      }
      state.optionQuotesBuffer.clear();
      if (changed.length > 0) {
        client.send(
          JSON.stringify({
            type: 'option_quotes_batch',
            schemaVersion: 2,
            underlying: state.focusSymbol,
            serverTimeSec,
            quotes: changed,
          }),
        );
      }
    }
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    applyCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, {
        status: 'NO_DATA',
        reason: 'INVALID_PARAMETER',
        detail: `Method ${req.method ?? 'UNKNOWN'} not allowed`,
      });
      return;
    }

    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${String(port)}`}`);
    const pathname = requestUrl.pathname;
    const params = requestUrl.searchParams;

    const isPostOnlyRoute =
      pathname === '/api/ar/ggal-specialist/strategy-selector' ||
      pathname === '/api/ar/ggal-specialist/anexo-b/ingest' ||
      pathname === '/api/system/feeds-reconnect';
    if ((req.method === 'POST' && !isPostOnlyRoute) || (req.method !== 'POST' && isPostOnlyRoute)) {
      sendJson(res, 405, {
        status: 'NO_DATA',
        reason: 'INVALID_PARAMETER',
        detail: `Method ${req.method ?? 'UNKNOWN'} not allowed for ${pathname}`,
      });
      return;
    }

    try {
      if (pathname === '/api/market/ticks') {
        sendJson(res, 200, buildMarketTickBatch());
        return;
      }

      if (pathname === '/api/health') {
        const activeSecrets = getAllSecrets();
        const rawConnectors = arRuntime.getConnectorHealth();
        const safePrimary = {
          ...rawConnectors.primaryRofex,
          lastError:
            rawConnectors.primaryRofex.lastError !== null
              ? redactSecrets(rawConnectors.primaryRofex.lastError, activeSecrets)
              : null,
        };
        const safeBmb = {
          ...rawConnectors.bullMarket,
          error:
            rawConnectors.bullMarket.error !== null
              ? redactSecrets(rawConnectors.bullMarket.error, activeSecrets)
              : null,
        };
        const safeIol = {
          ...rawConnectors.iol,
          error: rawConnectors.iol.error !== null ? redactSecrets(rawConnectors.iol.error, activeSecrets) : null,
        };
        sendJson(res, 200, {
          ...runtime.getHealth(),
          orats: getOrats(),
          warmupStatus,
          connectors: {
            primaryRofex: safePrimary,
            bullMarket: safeBmb,
            iol: safeIol,
          },
        });
        return;
      }

      if (pathname === '/api/fmp/plan-probe') {
        const planProbe = await probeFmpPlans();
        sendJson(res, 200, planProbe);
        return;
      }

      if (pathname === '/api/snapshot') {
        const symbol = params.get('symbol') ?? 'SPY';
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const expiration = params.get('expiration')?.trim() || undefined;
        // Pieza 50.9 (Bloque B): `prefetch=0` evita lanzar los snapshots adicionales
        // por fecha; ausente o cualquier otro valor conserva el prefetch habilitado.
        // La clave de caché, el TTL y SingleFlight de `getSnapshot` no cambian.
        const prefetch = params.get('prefetch')?.trim() === '0' ? false : true;
        const snapshot = await runtime.getSnapshot(symbol, {
          forceRefresh,
          prefetch,
          ...(expiration === undefined ? {} : { expiration }),
        });
        sendJson(res, 200, snapshot);
        return;
      }

      if (pathname === '/api/bars') {
        const symbol = params.get('symbol') ?? 'SPY';
        const timeframe = params.get('timeframe') ?? '5m';
        const marketRaw = (params.get('market') ?? '').trim().toUpperCase();
        if (marketRaw !== '' && marketRaw !== 'US' && marketRaw !== 'AR') {
          throw new RuntimeNoDataError(
            'INVALID_PARAMETER',
            `Unsupported market "${marketRaw}". Expected one of: US, AR`,
            secrets,
            400,
          );
        }
        const visibleBars = parseOptionalPositiveInt(params.get('visibleBars'), 'visibleBars', secrets);
        const rthOnly = parseBooleanFlag(params.get('rthOnly'));
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const overlaysRaw = params.get('overlays')?.trim().toLowerCase();
        const includeOverlays = overlaysRaw === '0' || overlaysRaw === 'false' ? false : true;
        const fullHistory = parseBooleanFlag(params.get('fullHistory'));
        // Pieza 38: los locales BYMA (Panel Líder / Panel General + soberanos) y
        // todo `market=AR` explícito resuelven al histórico real en ARS de
        // argentinaMarketLoader (Data912). Los CEDEARs colisionan con el ticker
        // US del subyacente (NVDA CEDEAR ARS vs NVDA stock USD, SPEC punto 10):
        // sin `market=AR` siguen siendo US.
        if (marketRaw === 'AR' || (marketRaw === '' && resolveArDefaultTerminalMarket(symbol) === 'AR')) {
          const arBars = await arRuntime.getArTerminalBars(symbol, timeframe, {
            ...(visibleBars === undefined ? {} : { visibleBars }),
            forceRefresh,
          });
          sendJson(res, 200, arBars);
          return;
        }
        const bars = await runtime.getBars(symbol, timeframe, {
          ...(visibleBars === undefined ? {} : { visibleBars }),
          rthOnly,
          forceRefresh,
          ...(parseBooleanFlag(params.get('ema20_5m')) ? {includeMtfEma:true} : {}),
          ...(parseBooleanFlag(params.get('vpHorizons')) ? { includeVpHorizons: true } : {}),
          ...(!includeOverlays ? { includeOverlays: false } : {}),
          ...(fullHistory ? { fullHistory: true } : {}),
        });
        sendJson(res, 200, bars);
        return;
      }

      if (pathname === '/api/us/panel-analytics') {
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const analytics = await runtime.getUsEquityPanelAnalytics(forceRefresh);
        sendJson(res, 200, analytics);
        return;
      }

      // Pieza 32: estado real de proveedores de mercado US. `TRADIER LIVE + ORATS`
      // se muestra cuando el stream Tradier está configurado y conectado; en otro
      // caso `MASSIVE + ORATS` (cero fallbacks silenciosos: cada proveedor expone
      // configured/connected/keySlot/activeRole sin material secreto).
      if (pathname === '/api/options/underlyings') {
        sendJson(res, 200, {
          status: 'OK' as const,
          asOfUtcSec: Math.floor(Date.now() / 1_000),
          underlyings: OPTIONS_UNDERLYING_UNIVERSE,
        });
        return;
      }

      // Pieza 50.2: carga on-demand del cuantitativo completo de un vencimiento OPRA
      // exacto (`?expiration=YYYY-MM-DD`) sin re-consultar barras/MTF/macro completos.
      if (pathname === '/api/options/expiry') {
        const symbol = params.get('symbol')?.trim() ?? '';
        if (symbol === '') {
          throw new RuntimeNoDataError(
            'INVALID_PARAMETER',
            'Parameter "symbol" is required',
            secrets,
            400,
          );
        }
        const expiration = params.get('expiration')?.trim() ?? '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
          throw new RuntimeNoDataError(
            'INVALID_PARAMETER',
            `Parameter "expiration" must be a valid YYYY-MM-DD date (got "${expiration}")`,
            secrets,
            400,
          );
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const expiryChain = await runtime.getUsOptionExpiryChain(symbol, expiration, {
          forceRefresh,
        });
        sendJson(res, 200, expiryChain);
        return;
      }

      if (pathname === '/api/us/vol-surface') {
        const symbol = params.get('symbol')?.trim() || 'SPY';
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const volSurface = await runtime.getUsVolSurface(symbol, {
          ...(forceRefresh ? { forceRefresh: true } : {}),
        });
        sendJson(res, 200, volSurface);
        return;
      }

      if (pathname === '/api/options/catalysts') {
        const symbol = params.get('symbol')?.trim() || 'SPY';
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const catalysts = await runtime.getSymbolCatalysts(symbol, {
          ...(forceRefresh ? { forceRefresh: true } : {}),
        });
        sendJson(res, 200, catalysts);
        return;
      }

      if (pathname === '/api/us/providers-status') {        const usProviders = runtime.getUsProvidersStatus();
        const oratsStatus = { ...getOrats(), activeRole: 'SURFACE' };
        const tradierLive = usProviders.TRADIER_LIVE;
        const usOptionsFeedBadge: 'TRADIER LIVE + ORATS' | 'MASSIVE + ORATS' =
          tradierLive.configured && tradierLive.connected
            ? 'TRADIER LIVE + ORATS'
            : 'MASSIVE + ORATS';
        sendJson(res, 200, {
          status: 'OK' as const,
          ...usProviders,
          providers: {
            MASSIVE_WS: usProviders.MASSIVE_WS,
            MASSIVE_REST_POOL: usProviders.MASSIVE_REST_POOL,
            TRADIER_LIVE: tradierLive,
            ORATS: oratsStatus,
          },
          usOptionsFeedBadge,
        });
        return;
      }

      if (pathname === '/api/system/feeds-health') {
        sendJson(res, 200, feedsHealthMonitor.getSnapshot());
        return;
      }

      if (pathname === '/api/system/feeds-reconnect') {
        const body = await readJsonBody(req, secrets);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw new RuntimeNoDataError(
            'INVALID_PARAMETER',
            'Expected JSON object body with provider',
            secrets,
            400,
          );
        }
        const rawProvider = (body as { readonly provider?: unknown }).provider;
        if (typeof rawProvider !== 'string' || !feedsHealthMonitor.isKnownProvider(rawProvider)) {
          throw new RuntimeNoDataError(
            'INVALID_PARAMETER',
            `Unsupported feed provider "${typeof rawProvider === 'string' ? rawProvider : 'UNKNOWN'}"`,
            secrets,
            400,
          );
        }
        const provider: FeedProviderId = rawProvider;
        const result = await feedsHealthMonitor.reconnect(provider);
        if (!result.ok) {
          sendJson(res, 503, {
            status: 'NO_DATA',
            reason: 'PROVIDER_ERROR',
            detail: result.detail,
          });
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/unusual') {
        const symbolParam = params.get('symbol');
        const tickerParam = params.get('ticker');
        const rootParam = params.get('root');
        const limit = parseOptionalPositiveInt(params.get('limit'), 'limit', secrets);
        const minPremium = parseOptionalPositiveNumber(
          params.get('minPremium'),
          'minPremium',
          secrets,
        );
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));

        const unusual = await runtime.getUnusualTrades({
          ...(symbolParam !== null && symbolParam.trim() !== ''
            ? { symbol: symbolParam.trim() }
            : {}),
          ...(tickerParam !== null && tickerParam.trim() !== ''
            ? { ticker: tickerParam.trim() }
            : {}),
          ...(rootParam !== null && rootParam.trim() !== ''
            ? { root: rootParam.trim() }
            : {}),
          ...(limit === undefined ? {} : { limit }),
          ...(minPremium === undefined ? {} : { minPremium }),
          forceRefresh,
        });
        sendJson(res, 200, unusual);
        return;
      }

      if (pathname === '/api/ar/overview') {
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const overview = await arRuntime.getOverview(forceRefresh);
        sendJson(res, 200, overview);
        return;
      }

      if (pathname === '/api/ar/macro') {
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const macro = await arRuntime.getMacro(forceRefresh);
        sendJson(res, 200, macro);
        return;
      }

      if (pathname === '/api/ar/monitoring') {
        const panel = parseMonitoringPanel(params.get('panel'), secrets);
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const monitoring = await arRuntime.getMonitoring(panel, forceRefresh);
        sendJson(res, 200, monitoring);
        return;
      }

      if (pathname === '/api/ar/stock') {
        const symbol = params.get('symbol')?.trim() || 'GGAL';
        const tfRaw = params.get('timeframe')?.trim() ?? '1D';
        const validTf = (['1m', '5m', '15m', '1h', '4h', '1D'] as const).find(
          (t) => t.toLowerCase() === tfRaw.toLowerCase(),
        ) ?? '1D';
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const stock = await arRuntime.getStockDetail(symbol, forceRefresh, validTf);
        sendJson(res, 200, stock);
        return;
      }

      if (pathname === '/api/ar/options') {
        const underlying = params.get('underlying')?.trim() || 'GGAL';
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const optionsChain = await arRuntime.getOptionsChain(underlying, forceRefresh, {
          allowProxyOi: params.get('allowProxyOi') === 'true',
        });
        sendJson(res, 200, optionsChain);
        return;
      }

      if (pathname === '/api/ar/relations') {
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const relations = await arRuntime.getRelations(forceRefresh);
        sendJson(res, 200, relations);
        return;
      }

      if (pathname === '/api/ar/positions') {
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const brokerPositions = await arRuntime.getPositionsAndAccount(forceRefresh);
        sendJson(res, 200, brokerPositions);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/overview') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const overview = await ggalRuntime.getOverview(forceRefresh);
        sendJson(res, 200, overview);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/parity-gap') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const parityGap = await ggalRuntime.getParityGap(forceRefresh);
        sendJson(res, 200, parityGap);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/vol-triangle') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const volTriangle = await ggalRuntime.getVolTriangle(forceRefresh);
        sendJson(res, 200, volTriangle);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/dual-density') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const dualDensity = await ggalRuntime.getDualDensity(forceRefresh);
        sendJson(res, 200, dualDensity);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/structure-pinning') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const targetExpiry = params.get('targetExpiry') ?? params.get('expiryCode');
        const structurePinning = await ggalRuntime.getStructurePinning(forceRefresh, {
          ...(targetExpiry !== null ? { targetExpiry } : {}),
          allowProxyOi: params.get('allowProxyOi') === 'true',
        });
        sendJson(res, 200, structurePinning);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/strategy-selector') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const body = await readJsonBody(req, secrets);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw new RuntimeNoDataError('INVALID_PARAMETER', 'Expected JSON object body for strategy-selector', secrets, 400);
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const selector = await ggalRuntime.runStrategySelector(body, forceRefresh);
        sendJson(res, 200, selector);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/anexo-b/ingest') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const body = await readJsonBody(req, secrets);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw new RuntimeNoDataError('INVALID_PARAMETER', 'Expected JSON object body for anexo-b/ingest', secrets, 400);
        }
        const ingested = ggalRuntime.ingestAnexoB(body);
        sendJson(res, 200, ingested);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/feed-status') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const feedStatus = await ggalRuntime.getFeedStatus(forceRefresh);
        sendJson(res, 200, feedStatus);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/dual-chart') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const coordRaw = (params.get('coord') ?? 'ARS_BYMA').trim().toUpperCase();
        if (coordRaw !== 'ARS_BYMA' && coordRaw !== 'USD_ADR_NASDAQ' && coordRaw !== 'RATIO_CCL') {
          throw new RuntimeNoDataError(
            'INVALID_PARAMETER',
            `Invalid coord "${coordRaw}". Expected ARS_BYMA | USD_ADR_NASDAQ | RATIO_CCL`,
            secrets,
            400,
          );
        }
        const coordMode: GgalDualChartCoordMode = coordRaw;

        const tfRaw = (params.get('timeframe') ?? '1D').trim();
        let timeframe: GgalDualChartTimeframe;
        if (
          tfRaw === '1m' ||
          tfRaw === '5m' ||
          tfRaw === '15m' ||
          tfRaw === '1H' ||
          tfRaw === '4H' ||
          tfRaw === '1D'
        ) {
          timeframe = tfRaw;
        } else {
          throw new RuntimeNoDataError(
            'INVALID_PARAMETER',
            `Invalid timeframe "${tfRaw}". Expected 1m | 5m | 15m | 1H | 4H | 1D`,
            secrets,
            400,
          );
        }

        const anchorRaw = (params.get('avwapAnchor') ?? 'MONTH_START').trim().toUpperCase();
        let avwapAnchor: GgalAvwapAnchorMode;
        if (
          anchorRaw === 'MONTH_START' ||
          anchorRaw === 'LAST_BIMONTHLY_EXPIRY' ||
          anchorRaw === 'LAST_EARNINGS' ||
          anchorRaw === 'ELECTORAL_GAP'
        ) {
          avwapAnchor = anchorRaw;
        } else {
          throw new RuntimeNoDataError(
            'INVALID_PARAMETER',
            `Invalid avwapAnchor "${anchorRaw}"`,
            secrets,
            400,
          );
        }

        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const light = parseBooleanFlag(params.get('light'));
        const subPaneMode = params.get('subPaneMode')?.trim() || undefined;
        const dualChart = await ggalRuntime.getDualChart({
          coordMode,
          timeframe,
          avwapAnchor,
          forceRefresh,
          ...(light ? { light: true } : {}),
          ...(subPaneMode !== undefined ? { subPaneMode } : {}),
        });
        sendJson(res, 200, dualChart);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/microstructure') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const microstructure = await ggalRuntime.getMicrostructure(forceRefresh);
        sendJson(res, 200, microstructure);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/options-surface') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const surface = await ggalRuntime.getOptionsSurface(forceRefresh);
        sendJson(res, 200, surface);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/clearing-risk') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const clearingRisk = await ggalRuntime.getClearingRisk(forceRefresh);
        sendJson(res, 200, clearingRisk);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/regime-2027') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { status: 'NO_DATA', reason: 'INVALID_PARAMETER', detail: `Method ${req.method ?? ''} not allowed` });
          return;
        }
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const regime2027 = await ggalRuntime.getRegime2027(forceRefresh);
        sendJson(res, 200, regime2027);
        return;
      }

      if (pathname === '/api/ar/ggal-specialist/margin-risk') {
        const forceRefresh = parseBooleanFlag(params.get('refresh')) || parseBooleanFlag(params.get('force'));
        const strategyParam = params.get('strategyKind') ?? undefined;
        const allowedStrategies = new Set([
          'UNCOVERED_SHORT',
          'VERTICAL_DEBIT_SPREAD',
          'VERTICAL_CREDIT_SPREAD',
          'RATIO_SPREAD_1X2',
          'RATIO_SPREAD_1X3',
          'SHORT_STRADDLE_STRANGLE',
          'COVERED_CALL',
          'CROSS_COLLATERAL_STRATEGY',
        ]);
        if (strategyParam !== undefined && !allowedStrategies.has(strategyParam)) {
          throw new RuntimeNoDataError('INVALID_PARAMETER', `Unsupported strategyKind=${strategyParam}`, secrets, 400);
        }
        const collateralKindParam = params.get('collateralKind') ?? undefined;
        const allowedCollateral = new Set([
          'US_TREASURY_BILL',
          'US_TREASURY_NOTE',
          'US_TREASURY_BOND',
          'CASH_ARS',
          'CASH_USD',
          'LECAP',
          'SOVEREIGN_BOND_AR',
          'EQUITY_LOCAL',
        ]);
        if (collateralKindParam !== undefined && !allowedCollateral.has(collateralKindParam)) {
          throw new RuntimeNoDataError('INVALID_PARAMETER', `Unsupported collateralKind=${collateralKindParam}`, secrets, 400);
        }
        const sideParam = params.get('side') ?? undefined;
        if (sideParam !== undefined && sideParam !== 'BUY' && sideParam !== 'SELL') {
          throw new RuntimeNoDataError('INVALID_PARAMETER', `Unsupported side=${sideParam}`, secrets, 400);
        }
        const parseOptPosNum = (raw: string | null, name: string): number | undefined => {
          if (raw === null || raw.trim() === '') return undefined;
          const n = Number(raw);
          if (!Number.isFinite(n) || n <= 0) {
            throw new RuntimeNoDataError('INVALID_PARAMETER', `Invalid ${name}=${raw}`, secrets, 400);
          }
          return n;
        };
        const capitalArs = parseOptPosNum(params.get('capitalArs'), 'capitalArs');
        const collateralValueArs = (() => {
          const raw = params.get('collateralValueArs');
          if (raw === null || raw.trim() === '') return undefined;
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) {
            throw new RuntimeNoDataError('INVALID_PARAMETER', `Invalid collateralValueArs=${raw}`, secrets, 400);
          }
          return n;
        })();
        const collateralAforo = parseOptPosNum(params.get('collateralAforo'), 'collateralAforo');
        if (collateralAforo !== undefined && collateralAforo > 1) {
          throw new RuntimeNoDataError('INVALID_PARAMETER', 'collateralAforo must be in (0, 1]', secrets, 400);
        }
        const collateralDurationYears = parseOptPosNum(params.get('collateralDurationYears'), 'collateralDurationYears');
        const desiredLots = parseOptPosNum(params.get('desiredLots'), 'desiredLots');
        const sharesParam = params.get('underlyingSharesHeld');
        const underlyingSharesHeld = sharesParam === null ? undefined : Number(sharesParam);
        if (sharesParam !== null && (!/^\d+$/.test(sharesParam) || !Number.isSafeInteger(underlyingSharesHeld))) {
          throw new RuntimeNoDataError('INVALID_PARAMETER', 'underlyingSharesHeld debe ser un entero no negativo', secrets, 400);
        }

        const report = await ggalRuntime.getMarginAndRiskReport(
          {
            ...(strategyParam !== undefined ? { strategyKind: strategyParam as NonNullable<Parameters<GgalSpecialistRuntime['getMarginAndRiskReport']>[0]>['strategyKind'] } : {}),
            ...(capitalArs !== undefined ? { capitalArs } : {}),
            ...(collateralKindParam !== undefined ? { collateralKind: collateralKindParam as NonNullable<Parameters<GgalSpecialistRuntime['getMarginAndRiskReport']>[0]>['collateralKind'] } : {}),
            ...(collateralValueArs !== undefined ? { collateralValueArs } : {}),
            ...(collateralAforo !== undefined ? { collateralAforo } : {}),
            ...(underlyingSharesHeld !== undefined ? { underlyingSharesHeld } : {}),
            ...(collateralDurationYears !== undefined ? { collateralDurationYears } : {}),
            ...(desiredLots !== undefined ? { desiredLots } : {}),
            ...(sideParam !== undefined ? { side: sideParam } : {}),
          },
          forceRefresh,
        );
        sendJson(res, 200, report);
        return;
      }

      if (req.method !== 'GET') {
        sendJson(res, 405, {
          status: 'NO_DATA',
          reason: 'INVALID_PARAMETER',
          detail: `Method ${req.method ?? 'UNKNOWN'} not allowed for ${pathname}`,
        });
        return;
      }

      sendJson(res, 404, {
        status: 'NO_DATA',
        reason: 'INVALID_PARAMETER',
        detail: `Route ${pathname} not found`,
      });
    } catch (err: unknown) {
      if (err instanceof RuntimeNoDataError) {
        sendJson(res, err.httpStatus, err.toPayload());
        return;
      }
      const message = redactSecrets(extractErrorMessage(err, 'Internal runtime error'), getAllSecrets());
      sendJson(res, 503, {
        status: 'NO_DATA',
        reason: 'PROVIDER_ERROR',
        detail: message,
      });
    }
  };

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res);
  });

  const wss = new WebSocketServer({
    noServer: true,
    path: '/ws',
    clientTracking: true,
    perMessageDeflate: false,
  });

  wss.on('error', (err) => {
    if (isBenignSocketError(err)) return;
    console.warn(`[ws] server error: ${err.message}`);
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const upgradeSocket = socket as Socket;
    upgradeSocket.setNoDelay(true);
    upgradeSocket.on('error', (err) => {
      if (isBenignSocketError(err)) return;
      console.warn(`[ws] upgrade socket error: ${err.message}`);
    });

    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${String(port)}`}`).pathname;
    } catch {
      upgradeSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (pathname !== '/ws') {
      upgradeSocket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    try {
      wss.handleUpgrade(request, upgradeSocket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } catch {
      if (upgradeSocket.writable) {
        upgradeSocket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
      }
    }
  });

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  wss.on('connection', (ws, request) => {
    let healthOnly = false;
    try {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${String(port)}`}`);
      healthOnly = requestUrl.searchParams.get('channel') === 'feeds-health';
    } catch {
      healthOnly = false;
    }
    const state: ClientSubscriptionState = {
      symbols: null,
      needsSnapshot: false,
      healthOnly,
      ownerId: `ws-${String(++wsClientIdSequence)}`,
      view: null,
      focusSymbol: null,
      focusMarket: null,
      ggalMode: null,
      ggalTimeframe: null,
      clientDeltaRevision: 0,
      backpressureActive: false,
      coalescedDeltaQuotes: new Map(),
      coalescedDeltaRemoved: new Set(),
      coalescedCauciones: null,
      coalescedFutures: null,
      marketEvents: new Map(),
      focusEvents: new Map(),
      optionQuotesBuffer: new Map(),
      lastSentOptionQuotes: new Map(),
      lastSentStockQuotes: new Map(),
      lastSentL2Sig: null,
      lastSentMacroSig: null,
      pongReceived: true,
      missedHeartbeats: 0,
    };
    clientStates.set(ws, state);
    ws.on('pong', () => {
      state.pongReceived = true;
      state.missedHeartbeats = 0;
    });
    ws.on('error', (err) => {
      if (isBenignSocketError(err)) return;
      console.warn(`[ws] client error: ${err.message}`);
    });

    const connectedEvent: RuntimeWsBroadcast = {
      type: 'status',
      cluster: 'stocks',
      state: 'connected',
      message: 'Connected to QuantOptionsTerminal runtime WS',
      time: Math.floor(Date.now() / 1_000),
    };
    if (ws.readyState === WebSocket.OPEN) {
      if (state.healthOnly) {
        sendFeedsHealthPulse(ws, feedsHealthMonitor.getPulse());
      } else {
        ws.send(JSON.stringify(connectedEvent));
        sendMarketTickBatch(ws, state);
      }
    }

    ws.on('close', () => {
      runtime.releaseMassiveStockOwner(state.ownerId);
      clearClientBuffers(state);
      state.lastSentOptionQuotes.clear();
      state.lastSentStockQuotes.clear();
    });

    ws.on('message', (raw) => {
      try {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8');
        const parsed = JSON.parse(text) as {
          readonly type?: unknown;
          readonly action?: unknown;
          readonly symbols?: unknown;
          readonly symbol?: unknown;
          readonly view?: unknown;
          readonly focusSymbol?: unknown;
          readonly focusMarket?: unknown;
          readonly ggalMode?: unknown;
          readonly ggalTimeframe?: unknown;
        };
        if (parsed.type === 'set_view_scope') {
          const scope = normalizeViewScope({
            view: parsed.view,
            focusSymbol: parsed.focusSymbol,
            focusMarket: parsed.focusMarket,
            ggalMode: parsed.ggalMode,
            ggalTimeframe: parsed.ggalTimeframe,
          });
          const previousFocus = state.focusSymbol;
          const previousMarket = state.focusMarket;
          state.view = scope.view;
          state.focusSymbol = scope.focusSymbol;
          state.focusMarket = scope.focusMarket;
          state.ggalMode = scope.ggalMode ?? null;
          state.ggalTimeframe = scope.ggalTimeframe ?? null;

          for (const [key, event] of state.focusEvents) {
            if (event.type === 'status') continue;
            if (scope.focusSymbol === null || event.symbol !== scope.focusSymbol) {
              state.marketEvents.set(key, event);
            }
          }
          state.focusEvents.clear();

          if (
            previousFocus !== null &&
            previousMarket !== 'AR' &&
            (previousFocus !== scope.focusSymbol || scope.focusMarket === 'AR')
          ) {
            runtime.releaseMassiveStockSymbol(previousFocus, state.ownerId);
          }
          if (scope.focusSymbol !== null && scope.focusMarket !== 'AR') {
            runtime.acquireMassiveStockSymbol(scope.focusSymbol, state.ownerId);
          }

          state.optionQuotesBuffer.clear();
          state.lastSentOptionQuotes.clear();
          state.lastSentL2Sig = null;

          if (scope.view === 'options' && scope.focusSymbol !== null) {
            for (const quote of runtime.getLiveOptionQuotes(scope.focusSymbol)) {
              state.optionQuotesBuffer.set(quote.symbol, { ...quote, updatedChannels: ['Q', 'T'] });
            }
          }
        } else if (parsed.action === 'subscribe' && Array.isArray(parsed.symbols)) {
          const nextSet = new Set<string>();
          for (const item of parsed.symbols) {
            if (typeof item === 'string' && item.trim() !== '') {
              nextSet.add(item.trim().toUpperCase());
            }
          }
          state.symbols = nextSet.size > 0 ? nextSet : null;
        } else if (parsed.action === 'focus' && typeof parsed.symbol === 'string') {
          const nextFocusRaw = parsed.symbol.trim().toUpperCase();
          const nextFocus = nextFocusRaw === '' ? null : nextFocusRaw;
          const previousFocus = state.focusSymbol;
          state.focusSymbol = nextFocus;
          // Los eventos pendientes del foco anterior vuelven al carril general.
          for (const [key, event] of state.focusEvents) {
            if (event.type === 'status') continue;
            if (nextFocus === null || event.symbol !== nextFocus) {
              state.marketEvents.set(key, event);
            }
          }
          state.focusEvents.clear();
          if (previousFocus !== null && previousFocus !== nextFocus) {
            runtime.releaseMassiveStockSymbol(previousFocus, state.ownerId);
          }
          if (nextFocus !== null) {
            runtime.acquireMassiveStockSymbol(nextFocus, state.ownerId);
          }
        }
      } catch {
        // Mensajes malformados del cliente WS se ignoran sin tumbar el socket.
      }
    });
  });

  const removeListener = runtime.addWsListener((event) => {
    if (event.type === 'status') {
      const serialized = JSON.stringify(event);
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) {
          continue;
        }
        const state = clientStates.get(client);
        if (state === undefined || state.healthOnly) continue;
        if (checkClientBackpressure(client, state) !== 'SEND') continue;
        if (shouldSendBroadcast(state, event)) {
          client.send(serialized);
        }
      }
      return;
    }

    if ((event.type === 'trade' || event.type === 'quote') && event.cluster === 'options') {
      const underlying = extractOptionUnderlying(event.symbol);
      if (underlying === null) return;
      const key = event.symbol.trim().toUpperCase();
      const runtimeSnapshot = runtime.getLiveOptionQuoteSnapshot(key);
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        const state = clientStates.get(client);
        if (state === undefined || state.healthOnly) continue;
        if (!shouldEmitOptionQuoteToClient(state, underlying)) continue;
        const prevOpt = state.optionQuotesBuffer.get(key) ?? state.lastSentOptionQuotes.get(key);
        const optSnapshot: LiveOptionQuoteSnapshot =
          runtimeSnapshot ??
          (event.type === 'trade'
            ? {
                symbol: key,
                underlying,
                time: event.time,
                updatedChannels: ['T'], tradeSeq: event.seq ?? null, tradeTimestampMs: event.eventTimeMs ?? event.time * 1000, tradeId: event.tradeId ?? null,
                bid: null,
                ask: null,
                mid: null,
                last: event.price,
                size: event.size,
              }
            : {
                symbol: key,
                underlying,
                time: event.time,
                bid: event.bid,
                ask: event.ask,
                mid: event.mid,
                updatedChannels: ['Q'], quoteSeq: event.seq ?? null, quoteTimestampMs: event.eventTimeMs ?? event.time * 1000,
                bidSize: event.bidSize ?? null, askSize: event.askSize ?? null, last: null,
                size: null,
              });
        const buffered = state.optionQuotesBuffer.get(key);
        const base = buffered ?? (prevOpt && { ...prevOpt, updatedChannels: [] });
        const merged = coalesceOptionQuoteUpdate(base, optSnapshot);
        if (merged !== base && merged.updatedChannels?.length) state.optionQuotesBuffer.set(key, merged);
      }
      return;
    }

    const broadcastTypes = new Set<RuntimeWsBroadcast['type']>(['bar_update', 'trade', 'quote', 'ggal_bar_tick']);
    if (!broadcastTypes.has(event.type)) {
      return;
    }
    const key = coalesceEventKey(event);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }
      const state = clientStates.get(client);
      if (state === undefined || state.healthOnly) continue;
      if (
        event.type === 'ggal_bar_tick' &&
        !shouldEmitGgalBarTickToClient(state, {
          mode: event.mode,
          timeframe: event.timeframe,
        })
      ) {
        continue;
      }
      if (!shouldSendBroadcast(state, event)) continue;
      if (event.type === 'quote' && event.cluster === 'stocks') {
        const sig = `${String(event.bid ?? '')}|${String(event.ask ?? '')}|${String(event.mid ?? '')}`;
        if (state.lastSentStockQuotes.get(event.symbol) === sig) {
          continue;
        }
        state.lastSentStockQuotes.set(event.symbol, sig);
      }
      const pending = state.focusSymbol !== null && event.symbol === state.focusSymbol
        ? state.focusEvents : state.marketEvents;
      enqueueCoalescedEvent(pending, key, event);
    }
  });

  return {
    httpServer,
    wss,
    runtime,
    arRuntime,
    ggalRuntime,
    feedsHealthMonitor,
    async start(): Promise<{ readonly host: string; readonly port: number }> {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (err: Error): void => {
          rejectListen(err);
        };
        httpServer.once('error', onError);
        httpServer.listen(port, host, () => {
          httpServer.off('error', onError);
          resolveListen();
        });
      });

      marketTickTimer = setInterval(() => {
        flushGeneralMarketBatches();
      }, 100);
      marketTickTimer.unref();

      focusTickTimer = setInterval(() => {
        flushFocusedMarketBatches();
      }, 50);
      focusTickTimer.unref();

      optionQuotesTimer = setInterval(() => {
        flushOptionQuotesBatches();
      }, optionFlushIntervalMs);
      optionQuotesTimer.unref();

      feedsHealthTimer = setInterval(() => {
        const pulse = feedsHealthMonitor.getPulse();
        for (const client of wss.clients) {
          sendFeedsHealthPulse(client, pulse);
        }
      }, 5_000);
      feedsHealthTimer.unref();

      heartbeatTimer = setInterval(() => {
        for (const client of wss.clients) {
          if (client.readyState !== WebSocket.OPEN) continue;
          const state = clientStates.get(client);
          if (state === undefined) continue;
          const decision = evaluateHeartbeatSweep(state.pongReceived, state.missedHeartbeats);
          state.missedHeartbeats = decision.nextMissed;
          if (decision.action === 'TERMINATE') {
            client.terminate();
            continue;
          }
          state.pongReceived = false;
          try {
            client.ping();
          } catch {
            client.terminate();
          }
        }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();

      if (startRuntimeWs) {
        await runtime.startWs();
      }

      if (enableBackgroundWarmup) {
        warmupStatus = 'WARMING_UP';
        arRuntime.startLiveStreaming();
        ggalRuntime.startRecorder();
        void (async () => {
          // Calentamos Argentina primero (ligero, <1.5s) para que /inicio responda de inmediato
          // antes de iniciar el warmup de las cadenas americanas.
          await arRuntime.warmup();
          await new Promise<void>((r) => setTimeout(r, 20));
          await runtime.warmup();
        })().finally(() => {
          warmupStatus = 'READY';
        });
      }

      const address = httpServer.address();
      if (address !== null && typeof address === 'object') {
        const info: AddressInfo = address;
        return { host: info.address, port: info.port };
      }
      return { host, port };
    },
    async stop(): Promise<void> {
      if (marketTickTimer !== null) clearInterval(marketTickTimer);
      marketTickTimer = null;
      if (focusTickTimer !== null) clearInterval(focusTickTimer);
      focusTickTimer = null;
      if (optionQuotesTimer !== null) clearInterval(optionQuotesTimer);
      optionQuotesTimer = null;
      if (feedsHealthTimer !== null) clearInterval(feedsHealthTimer);
      feedsHealthTimer = null;
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      ggalRuntime.stop();
      arRuntime.close();
      removeListener();
      runtime.stopWs();
      for (const client of wss.clients) {
        try {
          client.close(1000, 'server_stop');
        } catch {
          // Ignore close failures during shutdown.
        }
      }
      await new Promise<void>((resolveWss) => {
        wss.close(() => {
          resolveWss();
        });
      });
      await new Promise<void>((resolveHttp) => {
        httpServer.close(() => {
          resolveHttp();
        });
      });
    },
  };
}
