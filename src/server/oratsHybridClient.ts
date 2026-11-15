/**
 * Decoupled ORATS hybrid options surface client (Pieza 28).
 *
 * Strictly decouples US ADR spot/OHLC bars (sourced from Massive NBBO/bars +
 * Yang-Zhang realized vol estimator) from ORATS options surface analytics
 * using exact ORATS field names:
 * `smvVol`, `callValue`, `putValue`, `annIdiv`, `impliedNextDiv`, `borrow30`,
 * `yieldRate`, `impliedMove`, `iv10d`..`iv1y`, `exErnIv*`, `fwd30_20`, `fwd60_30`, `fwd90_60`.
 *
 * Zero Silent Fallbacks: when `ORATS_API_KEY` is absent or requests fail, returns
 * explicit `UNAVAILABLE` payload with secret redaction.
 */

import type {
  OratsHybridSurfaceOperational,
  OratsHybridSurfacePayload,
  OratsSurfaceStrikeRow,
} from '../core/ggal/institutionalContracts.js';
import { redactSecrets } from './runtimeCache.js';

export type OratsHttpFn = (
  url: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}>;

export interface OratsHybridClientDeps {
  readonly apiKey: string | null;
  readonly baseUrl: string;
  readonly fetchFn: OratsHttpFn;
  readonly nowMsFn: () => number;
  readonly cacheTtlMs: number;
  readonly secrets: readonly string[];
}

export interface FetchOratsHybridInput {
  readonly ticker: string;
  readonly massiveSpotPrice: number | null;
  readonly massiveSpotSourceMode: 'MASSIVE_NBBO' | 'MASSIVE_BARS' | 'UNAVAILABLE';
  readonly yangZhangAdrVol: number;
  readonly forceRefresh: boolean;
}

const DEFAULT_ORATS_BASE_URL = 'https://api.orats.io/datav2';
const DEFAULT_ORATS_CACHE_TTL_MS = 30_000;

async function defaultOratsFetch(
  url: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  },
): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}> {
  const controller = new AbortController();
  const timeoutMs = init?.timeoutMs ?? 10_000;
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const reqInit: RequestInit = {
      method: init?.method ?? 'GET',
      signal: controller.signal,
    };
    if (init?.headers !== undefined) {
      reqInit.headers = init.headers;
    }
    const resp = await fetch(url, reqInit);
    return {
      ok: resp.ok,
      status: resp.status,
      json: async (): Promise<unknown> => {
        const parsed: unknown = await resp.json();
        return parsed;
      },
      text: () => resp.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function extractDataRows(payload: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  }
  const obj = asRecord(payload);
  if (obj !== null && Array.isArray(obj['data'])) {
    return obj['data'].map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  }
  return obj !== null ? [obj] : [];
}

function readNum(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && v.trim().length > 0) {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

function readStr(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v.trim() : '';
}

export function loadOratsClientConfigFromEnv(env: NodeJS.ProcessEnv): {
  readonly apiKey: string | null;
  readonly baseUrl: string;
} {
  const key = env['ORATS_API_KEY']?.trim() ?? null;
  const baseUrlRaw = env['ORATS_BASE_URL']?.trim();
  const baseUrl =
    baseUrlRaw !== undefined && baseUrlRaw.length > 0
      ? baseUrlRaw.replace(/\/+$/, '')
      : DEFAULT_ORATS_BASE_URL;
  return {
    apiKey: key !== null && key.length > 0 ? key : null,
    baseUrl,
  };
}

export function parseOratsStrikeRow(row: Record<string, unknown>): OratsSurfaceStrikeRow | null {
  const strike = readNum(row, 'strike');
  const expirDate = readStr(row, 'expirDate');
  const dte = readNum(row, 'dte');
  if (!Number.isFinite(strike) || strike <= 0 || expirDate.length === 0 || !Number.isFinite(dte)) {
    return null;
  }
  return {
    strike,
    expirDate,
    dte,
    smvVol: readNum(row, 'smvVol'),
    callValue: readNum(row, 'callValue'),
    putValue: readNum(row, 'putValue'),
    callMidIv: readNum(row, 'callMidIv'),
    putMidIv: readNum(row, 'putMidIv'),
    delta: readNum(row, 'delta'),
    gamma: readNum(row, 'gamma'),
    theta: readNum(row, 'theta'),
    vega: readNum(row, 'vega'),
  };
}

export class OratsHybridClient {
  private readonly deps: OratsHybridClientDeps;
  private readonly surfaceCache = new Map<
    string,
    { readonly fetchedAtMs: number; readonly payload: OratsHybridSurfaceOperational }
  >();

  public constructor(opts?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetchFn?: OratsHttpFn;
    readonly nowMsFn?: () => number;
    readonly cacheTtlMs?: number;
    readonly secrets?: readonly string[];
  }) {
    const env = opts?.env ?? {};
    const cfg = loadOratsClientConfigFromEnv(env);
    const secrets = [...(opts?.secrets ?? [])];
    if (cfg.apiKey !== null && !secrets.includes(cfg.apiKey)) {
      secrets.push(cfg.apiKey);
    }
    this.deps = {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      fetchFn: opts?.fetchFn ?? defaultOratsFetch,
      nowMsFn: opts?.nowMsFn ?? (() => Date.now()),
      cacheTtlMs: opts?.cacheTtlMs ?? DEFAULT_ORATS_CACHE_TTL_MS,
      secrets,
    };
  }

  public isConfigured(): boolean {
    return this.deps.apiKey !== null;
  }

  public async fetchHybridSurface(
    input: FetchOratsHybridInput,
  ): Promise<OratsHybridSurfacePayload> {
    const ticker = input.ticker.trim().toUpperCase();
    const nowMs = this.deps.nowMsFn();
    const asOfUtcSec = Math.floor(nowMs / 1000);

    if (this.deps.apiKey === null) {
      return {
        status: 'UNAVAILABLE',
        source: 'ORATS_DELAYED_CORE',
        ticker,
        asOfUtcSec,
        reason: 'ORATS_API_KEY_NOT_CONFIGURED',
        massiveSpotPrice: input.massiveSpotPrice,
        massiveSpotSourceMode: input.massiveSpotSourceMode,
        yangZhangAdrVol: input.yangZhangAdrVol,
      };
    }

    const cached = this.surfaceCache.get(ticker);
    if (!input.forceRefresh && cached !== undefined && nowMs - cached.fetchedAtMs < this.deps.cacheTtlMs) {
      return {
        ...cached.payload,
        massiveSpotPrice: input.massiveSpotPrice,
        massiveSpotSourceMode: input.massiveSpotSourceMode,
        yangZhangAdrVol: input.yangZhangAdrVol,
      };
    }

    const token = encodeURIComponent(this.deps.apiKey);
    const symbolEnc = encodeURIComponent(ticker);
    const coresUrl = `${this.deps.baseUrl}/cores?token=${token}&ticker=${symbolEnc}`;
    const strikesUrl = `${this.deps.baseUrl}/strikes?token=${token}&ticker=${symbolEnc}`;

    try {
      const [coresResp, strikesResp] = await Promise.all([
        this.deps.fetchFn(coresUrl, { timeoutMs: 10_000 }),
        this.deps.fetchFn(strikesUrl, { timeoutMs: 10_000 }),
      ]);

      if (!coresResp.ok) {
        return {
          status: 'UNAVAILABLE',
          source: 'ORATS_DELAYED_CORE',
          ticker,
          asOfUtcSec,
          reason: `ORATS_CORES_HTTP_${String(coresResp.status)}`,
          massiveSpotPrice: input.massiveSpotPrice,
          massiveSpotSourceMode: input.massiveSpotSourceMode,
          yangZhangAdrVol: input.yangZhangAdrVol,
        };
      }

      const coresJson = await coresResp.json();
      const coreRows = extractDataRows(coresJson);
      const coreRow = coreRows[0];
      if (coreRow === undefined) {
        return {
          status: 'UNAVAILABLE',
          source: 'ORATS_DELAYED_CORE',
          ticker,
          asOfUtcSec,
          reason: 'ORATS_CORES_EMPTY_RESPONSE',
          massiveSpotPrice: input.massiveSpotPrice,
          massiveSpotSourceMode: input.massiveSpotSourceMode,
          yangZhangAdrVol: input.yangZhangAdrVol,
        };
      }

      let strikeRows: readonly OratsSurfaceStrikeRow[] = [];
      if (strikesResp.ok) {
        const strikesJson = await strikesResp.json();
        strikeRows = extractDataRows(strikesJson)
          .map(parseOratsStrikeRow)
          .filter((r): r is OratsSurfaceStrikeRow => r !== null);
      }

      const tradeDateRaw = readStr(coreRow, 'tradeDate');
      const operational: OratsHybridSurfaceOperational = {
        status: 'OPERATIONAL',
        source: 'ORATS_DELAYED_CORE',
        ticker,
        tradeDate: tradeDateRaw.length > 0 ? tradeDateRaw : new Date(nowMs).toISOString().slice(0, 10),
        asOfUtcSec,
        stockPrice: readNum(coreRow, 'stockPrice'),
        massiveSpotPrice: input.massiveSpotPrice,
        massiveSpotSourceMode: input.massiveSpotSourceMode,
        smvVol: readNum(coreRow, 'smvVol'),
        iv10d: readNum(coreRow, 'iv10d'),
        iv20d: readNum(coreRow, 'iv20d'),
        iv30d: readNum(coreRow, 'iv30d'),
        iv60d: readNum(coreRow, 'iv60d'),
        iv90d: readNum(coreRow, 'iv90d'),
        iv6m: readNum(coreRow, 'iv6m'),
        iv1y: readNum(coreRow, 'iv1y'),
        exErnIv10d: readNum(coreRow, 'exErnIv10d'),
        exErnIv20d: readNum(coreRow, 'exErnIv20d'),
        exErnIv30d: readNum(coreRow, 'exErnIv30d'),
        exErnIv60d: readNum(coreRow, 'exErnIv60d'),
        exErnIv90d: readNum(coreRow, 'exErnIv90d'),
        fwd30_20: readNum(coreRow, 'fwd30_20'),
        fwd60_30: readNum(coreRow, 'fwd60_30'),
        fwd90_60: readNum(coreRow, 'fwd90_60'),
        impliedMove: readNum(coreRow, 'impliedMove'),
        annIdiv: readNum(coreRow, 'annIdiv'),
        impliedNextDiv: readNum(coreRow, 'impliedNextDiv'),
        borrow30: readNum(coreRow, 'borrow30'),
        yieldRate: readNum(coreRow, 'yieldRate'),
        yangZhangAdrVol: input.yangZhangAdrVol,
        strikes: strikeRows,
        reason: null,
      };

      this.surfaceCache.set(ticker, { fetchedAtMs: nowMs, payload: operational });
      return operational;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'UNAVAILABLE',
        source: 'ORATS_DELAYED_CORE',
        ticker,
        asOfUtcSec,
        reason: `ORATS_FETCH_ERROR: ${redactSecrets(msg, this.deps.secrets)}`,
        massiveSpotPrice: input.massiveSpotPrice,
        massiveSpotSourceMode: input.massiveSpotSourceMode,
        yangZhangAdrVol: input.yangZhangAdrVol,
      };
    }
  }
}
