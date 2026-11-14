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
 *
 * WebSocket:
 *  - `ws://host:port/ws`
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { toErrorMessage } from '../data/normalizeShared.js';
import {
  ArgentinaMarketRuntime,
  type ArMonitoringResponse,
} from './argentinaMarketLoader.js';
import {
  MarketRuntime,
  RuntimeNoDataError,
  loadRuntimeAuth,
  type RuntimeWsBroadcast,
} from './marketRuntime.js';
import { redactSecrets } from './runtimeCache.js';

const LOCALHOST_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

export interface HttpWsServerOptions {
  readonly runtime?: MarketRuntime;
  readonly arRuntime?: ArgentinaMarketRuntime;
  readonly host?: string;
  readonly port?: number;
  readonly secrets?: readonly string[];
  readonly startRuntimeWs?: boolean;
}

export interface HttpWsServerHandle {
  readonly httpServer: Server;
  readonly wss: WebSocketServer;
  readonly runtime: MarketRuntime;
  readonly arRuntime: ArgentinaMarketRuntime;
  start(): Promise<{ readonly host: string; readonly port: number }>;
  stop(): Promise<void>;
}

interface ClientSubscriptionState {
  symbols: Set<string> | null;
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && LOCALHOST_ORIGIN_PATTERN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
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
  if (state.symbols === null || state.symbols.size === 0) {
    return true;
  }
  if (state.symbols.has(event.symbol)) {
    return true;
  }
  for (const watched of state.symbols) {
    if (event.symbol.startsWith(`O:${watched}`)) {
      return true;
    }
  }
  return false;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim() !== '') {
    return err.message;
  }
  return toErrorMessage(err, fallback);
}

export function createHttpWsServer(options: HttpWsServerOptions = {}): HttpWsServerHandle {
  const auth = loadRuntimeAuth();
  const runtime = options.runtime ?? new MarketRuntime();
  const arRuntime = options.arRuntime ?? new ArgentinaMarketRuntime({ secrets: options.secrets ?? auth.secrets });
  const secrets = options.secrets ?? auth.secrets;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const startRuntimeWs = options.startRuntimeWs ?? false;

  const clientStates = new WeakMap<WebSocket, ClientSubscriptionState>();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    applyCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'GET') {
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

    try {
      if (pathname === '/api/health') {
        sendJson(res, 200, runtime.getHealth());
        return;
      }

      if (pathname === '/api/snapshot') {
        const symbol = params.get('symbol') ?? 'SPY';
        const forceRefresh = parseBooleanFlag(params.get('refresh'));
        const snapshot = await runtime.getSnapshot(symbol, { forceRefresh });
        sendJson(res, 200, snapshot);
        return;
      }

      if (pathname === '/api/bars') {
        const symbol = params.get('symbol') ?? 'SPY';
        const timeframe = params.get('timeframe') ?? '5m';
        const visibleBars = parseOptionalPositiveInt(params.get('visibleBars'), 'visibleBars', secrets);
        const rthOnly = parseBooleanFlag(params.get('rthOnly'));
        const forceRefresh = parseBooleanFlag(params.get('refresh'));
        const bars = await runtime.getBars(symbol, timeframe, {
          ...(visibleBars === undefined ? {} : { visibleBars }),
          rthOnly,
          forceRefresh,
        });
        sendJson(res, 200, bars);
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
        const forceRefresh = parseBooleanFlag(params.get('refresh'));

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
        const forceRefresh = parseBooleanFlag(params.get('refresh'));
        const overview = await arRuntime.getOverview(forceRefresh);
        sendJson(res, 200, overview);
        return;
      }

      if (pathname === '/api/ar/macro') {
        const forceRefresh = parseBooleanFlag(params.get('refresh'));
        const macro = await arRuntime.getMacro(forceRefresh);
        sendJson(res, 200, macro);
        return;
      }

      if (pathname === '/api/ar/monitoring') {
        const panel = parseMonitoringPanel(params.get('panel'), secrets);
        const forceRefresh = parseBooleanFlag(params.get('refresh'));
        const monitoring = await arRuntime.getMonitoring(panel, forceRefresh);
        sendJson(res, 200, monitoring);
        return;
      }

      if (pathname === '/api/ar/stock') {
        const symbol = params.get('symbol')?.trim() || 'GGAL';
        const forceRefresh = parseBooleanFlag(params.get('refresh'));
        const stock = await arRuntime.getStockDetail(symbol, forceRefresh);
        sendJson(res, 200, stock);
        return;
      }

      if (pathname === '/api/ar/options') {
        const underlying = params.get('underlying')?.trim() || 'GGAL';
        const forceRefresh = parseBooleanFlag(params.get('refresh'));
        const optionsChain = await arRuntime.getOptionsChain(underlying, forceRefresh);
        sendJson(res, 200, optionsChain);
        return;
      }

      if (pathname === '/api/ar/relations') {
        const forceRefresh = parseBooleanFlag(params.get('refresh'));
        const relations = await arRuntime.getRelations(forceRefresh);
        sendJson(res, 200, relations);
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
      const message = redactSecrets(extractErrorMessage(err, 'Internal runtime error'), secrets);
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
    server: httpServer,
    path: '/ws',
  });

  wss.on('connection', (ws) => {
    const state: ClientSubscriptionState = { symbols: null };
    clientStates.set(ws, state);

    const connectedEvent: RuntimeWsBroadcast = {
      type: 'status',
      cluster: 'stocks',
      state: 'connected',
      message: 'Connected to QuantOptionsTerminal runtime WS',
      time: Math.floor(Date.now() / 1_000),
    };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(connectedEvent));
    }

    ws.on('message', (raw) => {
      try {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8');
        const parsed = JSON.parse(text) as { readonly action?: unknown; readonly symbols?: unknown };
        if (parsed.action === 'subscribe' && Array.isArray(parsed.symbols)) {
          const nextSet = new Set<string>();
          for (const item of parsed.symbols) {
            if (typeof item === 'string' && item.trim() !== '') {
              nextSet.add(item.trim().toUpperCase());
            }
          }
          state.symbols = nextSet.size > 0 ? nextSet : null;
        }
      } catch {
        // Mensajes malformados del cliente WS se ignoran sin tumbar el socket.
      }
    });
  });

  const removeListener = runtime.addWsListener((event) => {
    const serialized = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }
      const state = clientStates.get(client) ?? { symbols: null };
      if (shouldSendBroadcast(state, event)) {
        client.send(serialized);
      }
    }
  });

  return {
    httpServer,
    wss,
    runtime,
    arRuntime,
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

      if (startRuntimeWs) {
        await runtime.startWs();
      }

      const address = httpServer.address();
      if (address !== null && typeof address === 'object') {
        const info: AddressInfo = address;
        return { host: info.address, port: info.port };
      }
      return { host, port };
    },
    async stop(): Promise<void> {
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
