/** Read-only IOL REST v2 L1 adapter with OAuth password/refresh-token lifecycle. */

import type { MarketTickQuote } from './massiveStocksStream.js';
import { isBymaL2SessionUtcSec } from './bmbFeedAdapter.js';
import {
  RollingFeedTelemetry,
  type FeedTelemetrySnapshot,
} from './feedsHealthMonitor.js';
import { redactSecrets } from './runtimeCache.js';

export const IOL_L1_POLL_INTERVAL_MS = 2_500;
const IOL_REQUEST_TIMEOUT_MS = 5_000;
const IOL_PANEL_STALE_MS = 15_000;

export interface IolHttpRequestInit {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface IolHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

export type IolHttpFn = (url: string, init?: IolHttpRequestInit) => Promise<IolHttpResponse>;

export interface IolFeedAdapterDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchFn?: IolHttpFn;
  readonly nowMsFn?: () => number;
  readonly baseUrl?: string;
  readonly secrets?: readonly string[];
}

export interface IolCaucionQuote {
  readonly symbol: string;
  readonly termDays: number;
  readonly currency: 'ARS' | 'USD';
  readonly tnaWeighted: number | null;
  readonly bidTna: number | null;
  readonly askTna: number | null;
  readonly turnoverArs: number | null;
  readonly asOfUtcSec: number | null;
}

type PanelId =
  | 'acciones'
  | 'accionesPanelGeneral'
  | 'cedears'
  | 'bonos'
  | 'letras'
  | 'obligacionesNegociables'
  | 'cauciones';

/**
 * Fallback de CEDEARs ante HTTP 400/404 en la ruta primaria: el panel
 * `CEDEARs` también responde bajo el instrumento `acciones`.
 */
export const IOL_CEDEARS_FALLBACK_PATH = '/api/v2/Cotizaciones/acciones/CEDEARs/argentina';

/**
 * Rutas válidas de la API v2 de InvertirOnline:
 * - `acciones` usa paneles nombrados: "Merval" (líderes) y "Panel General"
 *   (URL-encoded como `Panel%20General`); `acciones/todas` devuelve HTTP 404.
 * - CEDEARs exige el nombre de panel `CEDEARs`: `cedear/todas` y
 *   `cedears/todas` devuelven HTTP 400 en producción. La ruta primaria
 *   `cedears/CEDEARs` cae a `IOL_CEDEARS_FALLBACK_PATH` ante HTTP 400/404.
 */
export const IOL_PANELS: readonly { readonly id: PanelId; readonly path: string }[] = [
  { id: 'acciones', path: '/api/v2/Cotizaciones/acciones/Merval/argentina' },
  { id: 'accionesPanelGeneral', path: '/api/v2/Cotizaciones/acciones/Panel%20General/argentina' },
  { id: 'cedears', path: '/api/v2/Cotizaciones/cedears/CEDEARs/argentina' },
  { id: 'bonos', path: '/api/v2/Cotizaciones/bonos/todas/argentina' },
  { id: 'letras', path: '/api/v2/Cotizaciones/letras/todas/argentina' },
  { id: 'obligacionesNegociables', path: '/api/v2/Cotizaciones/obligacionesNegociables/todas/argentina' },
  { id: 'cauciones', path: '/api/v2/Cotizaciones/cauciones/todas/argentina' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function parseUtcSec(value: unknown): number | null {
  const numeric = finite(value);
  if (numeric !== null && numeric > 0) {
    return Math.floor(numeric > 10_000_000_000 ? numeric / 1_000 : numeric);
  }
  const raw = nonEmpty(value);
  if (raw === null) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = hasZone ? raw : `${raw}-03:00`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
}

function defaultFetch(url: string, init: IolHttpRequestInit = {}): Promise<IolHttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, init.timeoutMs ?? IOL_REQUEST_TIMEOUT_MS);
  return fetch(url, {
    method: init.method ?? 'GET',
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: controller.signal,
  })
    .then(async (response) => ({ ok: response.ok, status: response.status, text: await response.text() }))
    .finally(() => {
      clearTimeout(timeout);
    });
}

export class IolFeedAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: IolHttpFn;
  private readonly nowMsFn: () => number;
  private readonly baseUrl: string;
  private readonly baseSecrets: readonly string[];
  private readonly configured: boolean;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private accessTokenExpiresAtMs = 0;
  private authInFlight: Promise<void> | null = null;
  private authInFlightGeneration = -1;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private polling = false;
  private readonly quotesByPanel = new Map<PanelId, readonly MarketTickQuote[]>();
  private readonly caucionesByPanel = new Map<PanelId, readonly IolCaucionQuote[]>();
  private readonly panelSuccessAtMs = new Map<PanelId, number>();
  private lastSuccessAtMs: number | null = null;
  private lastError: string | null = null;
  private readonly panelErrors = new Map<PanelId, string>();
  private generation = 0;
  private readonly httpTelemetry = new RollingFeedTelemetry({
    latencyKind: 'HTTP_ROUND_TRIP',
  });
  private authMethod: 'PASSWORD' | 'REFRESH_TOKEN' | null = null;
  private passwordAuthCount = 0;
  private refreshAuthCount = 0;
  private lastAuthAtMs: number | null = null;
  private authGeneration = 0;

  public constructor(deps: IolFeedAdapterDeps = {}) {
    this.env = deps.env ?? process.env;
    this.fetchFn = deps.fetchFn ?? defaultFetch;
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.baseUrl = (deps.baseUrl ?? this.env['IOL_BASE_URL']?.trim() ?? 'https://api.invertironline.com').replace(/\/+$/, '');
    this.configured = Boolean(this.env['IOL_USERNAME']?.trim() && this.env['IOL_PASSWORD']?.trim());
    this.baseSecrets = [
      ...(deps.secrets ?? []),
      this.env['IOL_USERNAME']?.trim() ?? '',
      this.env['IOL_PASSWORD']?.trim() ?? '',
    ].filter((value) => value !== '');
  }

  public getSecrets(): readonly string[] {
    return [...this.baseSecrets, this.accessToken ?? '', this.refreshToken ?? ''].filter((value) => value !== '');
  }

  public getHealth(): {
    readonly configured: boolean;
    readonly connected: boolean;
    readonly lastMessageUtcSec: number | null;
    readonly quoteCount: number;
    readonly error: string | null;
  } {
    const nowMs = this.nowMsFn();
    const connected =
      this.lastSuccessAtMs !== null &&
      nowMs >= this.lastSuccessAtMs &&
      nowMs - this.lastSuccessAtMs <= IOL_PANEL_STALE_MS;
    return {
      configured: this.configured,
      connected,
      lastMessageUtcSec: this.lastSuccessAtMs === null ? null : Math.floor(this.lastSuccessAtMs / 1_000),
      quoteCount: this.getQuotes().length,
      error: [...new Set([...(this.lastError !== null ? [this.lastError] : []), ...this.panelErrors.values()])].join(' | ') || null,
    };
  }

  private isActiveGeneration(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  public start(): void {
    if (this.running || !this.configured) return;
    this.running = true;
    const generation = ++this.generation;
    const run = async (): Promise<void> => {
      if (!this.running || generation !== this.generation) return;
      const inSession = isBymaL2SessionUtcSec(Math.floor(this.nowMsFn() / 1_000));
      if (inSession && !this.polling) {
        this.polling = true;
        try {
          await this.pollPanels(generation);
        } catch (error: unknown) {
          this.setError(error instanceof Error ? error.message : String(error));
        } finally {
          this.polling = false;
        }
      }
      if (this.isActiveGeneration(generation)) {
        this.pollTimer = setTimeout(() => {
          void run();
        }, inSession ? IOL_L1_POLL_INTERVAL_MS : 5_000);
        this.pollTimer.unref();
      }
    };
    void run();
  }

  public stop(): void {
    this.running = false;
    this.generation += 1;
    this.authGeneration += 1;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  public getFeedTelemetrySnapshot(nowMs: number): FeedTelemetrySnapshot {
    return this.httpTelemetry.snapshot(nowMs);
  }

  public getFeedHealth() {
    const health = this.getHealth();
    const nowMs = this.nowMsFn();
    return {
      configured: health.configured,
      connected: health.connected,
      authMethod: this.authMethod,
      passwordAuthCount: this.passwordAuthCount,
      refreshAuthCount: this.refreshAuthCount,
      tokenExpiresAtUtcSec:
        this.accessTokenExpiresAtMs > 0 && nowMs < this.accessTokenExpiresAtMs
          ? Math.floor(this.accessTokenExpiresAtMs / 1_000)
          : null,
      lastAuthAtUtcSec:
        this.lastAuthAtMs !== null && nowMs >= this.lastAuthAtMs
          ? Math.floor(this.lastAuthAtMs / 1_000)
          : null,
      quoteCount: health.quoteCount,
      lastError: health.error,
      telemetry: this.httpTelemetry.snapshot(nowMs),
    };
  }

  /** Pieza 33: invalida tokens en memoria, reautentica y reanuda polling. */
  public async reconnect(): Promise<string> {
    if (!this.configured) {
      throw new Error('IOL_USERNAME / IOL_PASSWORD not configured');
    }
    this.stop();
    this.accessToken = null;
    this.refreshToken = null;
    this.accessTokenExpiresAtMs = 0;
    this.authMethod = null;
    this.start();
    this.authGeneration += 1;
    await this.authenticate();
    return 'IOL_REST_V2_RECONNECT_AUTHENTICATED';
  }

  public getQuotes(): readonly MarketTickQuote[] {
    const nowMs = this.nowMsFn();
    const out: MarketTickQuote[] = [];
    for (const panel of IOL_PANELS) {
      const successAt = this.panelSuccessAtMs.get(panel.id);
      if (successAt === undefined || nowMs < successAt || nowMs - successAt > IOL_PANEL_STALE_MS) continue;
      out.push(...(this.quotesByPanel.get(panel.id) ?? []));
    }
    return out.map((quote) => ({ ...quote }));
  }

  public getCauciones(): readonly IolCaucionQuote[] {
    const successAt = this.panelSuccessAtMs.get('cauciones');
    const nowMs = this.nowMsFn();
    if (successAt === undefined || nowMs < successAt || nowMs - successAt > IOL_PANEL_STALE_MS) return [];
    return (this.caucionesByPanel.get('cauciones') ?? []).map((row) => ({ ...row }));
  }

  private setError(message: string): void {
    this.lastError = redactSecrets(message, this.getSecrets());
  }

  private async authenticate(): Promise<void> {
    if (this.authInFlight !== null && this.authInFlightGeneration === this.authGeneration) {
      return this.authInFlight;
    }
    const generationAtStart = this.authGeneration;
    const useRefresh = this.refreshToken !== null;
    const work = (async (): Promise<void> => {
      const params = new URLSearchParams();
      if (useRefresh) {
        params.set('grant_type', 'refresh_token');
        params.set('refresh_token', this.refreshToken ?? '');
      } else {
        params.set('grant_type', 'password');
        params.set('username', this.env['IOL_USERNAME']?.trim() ?? '');
        params.set('password', this.env['IOL_PASSWORD']?.trim() ?? '');
      }
      const startedAtMs = this.nowMsFn();
      let response: IolHttpResponse;
      try {
        response = await this.fetchFn(`${this.baseUrl}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: params.toString(),
          timeoutMs: IOL_REQUEST_TIMEOUT_MS,
        });
        const completedAtMs = this.nowMsFn();
        this.httpTelemetry.record({
          atMs: completedAtMs,
          latencyMs: completedAtMs - startedAtMs,
          httpStatus: response.status,
        });
      } catch (err: unknown) {
        const completedAtMs = this.nowMsFn();
        this.httpTelemetry.record({
          atMs: completedAtMs,
          latencyMs: completedAtMs - startedAtMs,
        });
        throw err;
      }
      if (generationAtStart !== this.authGeneration) {
        throw new Error('IOL authentication superseded');
      }
      if (!response.ok) {
        if (useRefresh) this.refreshToken = null;
        throw new Error(`IOL authentication HTTP ${String(response.status)}`);
      }
      const body: unknown = JSON.parse(response.text);
      if (!isRecord(body)) throw new Error('IOL authentication returned malformed JSON');
      const access = nonEmpty(body['access_token']);
      if (access === null) throw new Error('IOL authentication omitted access_token');
      const refresh = nonEmpty(body['refresh_token']);
      const expiresIn = positive(body['expires_in']) ?? 900;
      this.accessToken = access;
      if (refresh !== null) this.refreshToken = refresh;
      this.accessTokenExpiresAtMs = this.nowMsFn() + Math.max(30, expiresIn - 60) * 1_000;
      this.authMethod = useRefresh ? 'REFRESH_TOKEN' : 'PASSWORD';
      if (useRefresh) this.refreshAuthCount += 1;
      else this.passwordAuthCount += 1;
      this.lastAuthAtMs = this.nowMsFn();
      this.lastError = null;
    })();
    this.authInFlight = work;
    this.authInFlightGeneration = generationAtStart;
    try {
      await work;
    } finally {
      if (this.authInFlight === work) this.authInFlight = null;
    }
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken !== null && this.nowMsFn() < this.accessTokenExpiresAtMs) return this.accessToken;
    await this.authenticate();
    if (this.accessToken === null) throw new Error('IOL access token unavailable');
    return this.accessToken;
  }

  private async getPanel(path: string, retry = true, fallbackPath?: string): Promise<unknown> {
    const token = await this.ensureToken();
    const startedAtMs = this.nowMsFn();
    let response: IolHttpResponse;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeoutMs: IOL_REQUEST_TIMEOUT_MS,
      });
      const completedAtMs = this.nowMsFn();
      this.httpTelemetry.record({
        atMs: completedAtMs,
        latencyMs: completedAtMs - startedAtMs,
        httpStatus: response.status,
      });
    } catch (err: unknown) {
      const completedAtMs = this.nowMsFn();
      this.httpTelemetry.record({
        atMs: completedAtMs,
        latencyMs: completedAtMs - startedAtMs,
      });
      throw err;
    }
    if (response.status === 401 && retry) {
      this.accessToken = null;
      this.accessTokenExpiresAtMs = 0;
      await this.authenticate();
      return this.getPanel(path, false, fallbackPath);
    }
    if (!response.ok && fallbackPath !== undefined && (response.status === 400 || response.status === 404)) {
      return this.getPanel(fallbackPath, retry);
    }
    if (!response.ok) throw new Error(`IOL panel HTTP ${String(response.status)} for ${path}`);
    return JSON.parse(response.text) as unknown;
  }

  private async pollPanels(generation: number): Promise<void> {
    const results = await Promise.allSettled(IOL_PANELS.map(async (panel) => {
      const body = await this.getPanel(
        panel.path,
        true,
        panel.id === 'cedears' ? IOL_CEDEARS_FALLBACK_PATH : undefined,
      );
      return { panel, body };
    }));
    if (generation !== this.generation || !this.running) return;
    let success = false;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const panel = IOL_PANELS[index];
      if (result === undefined || panel === undefined) continue;
      if (result.status === 'rejected') {
        const message = redactSecrets(result.reason instanceof Error ? result.reason.message : String(result.reason), this.getSecrets());
        this.panelErrors.set(panel.id, `${panel.id}: ${message}`);
        continue;
      }
      const { body } = result.value;
      const rows = isRecord(body) && Array.isArray(body['titulos'])
        ? body['titulos']
        : Array.isArray(body)
          ? body
          : null;
      if (rows === null) {
        this.panelErrors.set(panel.id, `${panel.id}: omitted titulos`);
        continue;
      }
      const parsed = rows.map((row) => this.parseQuote(row, panel.id)).filter((row): row is MarketTickQuote => row !== null);
      this.quotesByPanel.set(panel.id, parsed);
      if (panel.id === 'cauciones') {
        this.caucionesByPanel.set(panel.id, rows.map((row) => this.parseCaucion(row)).filter((row): row is IolCaucionQuote => row !== null));
      }
      this.panelSuccessAtMs.set(panel.id, this.nowMsFn());
      this.panelErrors.delete(panel.id);
      success = true;
    }
    if (success) {
      this.lastSuccessAtMs = this.nowMsFn();
      if (this.panelErrors.size === 0) this.lastError = null;
    }
  }

  private parseQuote(raw: unknown, panel: PanelId): MarketTickQuote | null {
    if (!isRecord(raw)) return null;
    const symbol = nonEmpty(raw['simbolo'])?.toUpperCase();
    const price = positive(raw['ultimoPrecio']);
    if (symbol === undefined || price === null || panel === 'cauciones') return null;
    const previousClose = positive(raw['ultimoCierre']);
    const change = finite(raw['variacionPorcentual']);
    const currencyRaw = nonEmpty(raw['moneda'])?.toLowerCase();
    const currency = currencyRaw?.includes('dolar') || currencyRaw?.includes('usd') ? 'USD' : currencyRaw !== undefined ? 'ARS' : null;
    const kind = panel === 'acciones' || panel === 'accionesPanelGeneral' || panel === 'cedears'
      ? 'stock'
      : panel === 'bonos'
        ? 'bond'
        : panel === 'letras'
          ? 'note'
          : 'corp';
    return {
      market: 'AR',
      symbol,
      kind,
      currency,
      price,
      previousClose,
      changePct: change ?? (previousClose !== null ? ((price - previousClose) / previousClose) * 100 : null),
      dayLow: positive(raw['minimo']),
      dayHigh: positive(raw['maximo']),
      volume: finite(raw['volumen']),
      turnover: finite(raw['montoOperado']),
      asOfUtcSec: parseUtcSec(raw['fecha']) ?? parseUtcSec(raw['fechaHora']),
      source: 'IOL_REST',
    };
  }

  private parseCaucion(raw: unknown): IolCaucionQuote | null {
    if (!isRecord(raw)) return null;
    const symbol = nonEmpty(raw['simbolo'])?.toUpperCase();
    if (symbol === undefined) return null;
    const explicitDays = positive(raw['plazo']) ?? positive(raw['dias']);
    const match = /(\d+)\s*D/i.exec(symbol);
    const termDays = Math.round(explicitDays ?? Number(match?.[1] ?? Number.NaN));
    if (!Number.isInteger(termDays) || termDays <= 0) return null;
    const currency: 'ARS' | 'USD' = symbol.includes('DOLAR') || symbol.includes('USD') ? 'USD' : 'ARS';
    const puntas = isRecord(raw['puntas']) ? raw['puntas'] : {};
    return {
      symbol,
      termDays,
      currency,
      tnaWeighted: finite(raw['ultimoPrecio']),
      bidTna: positive(puntas['precioCompra']),
      askTna: positive(puntas['precioVenta']),
      turnoverArs: finite(raw['montoOperado']),
      asOfUtcSec: parseUtcSec(raw['fecha']) ?? parseUtcSec(raw['fechaHora']),
    };
  }
}
