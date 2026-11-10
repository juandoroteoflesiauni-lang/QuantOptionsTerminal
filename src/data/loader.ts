/**
 * Cargador REST de barras (Paso D).
 *
 * Orquesta las peticiones a Massive (acciones) y BingX spot (cripto), delega
 * la validación en los normalizadores y aplica las reglas del buffer:
 *  - `requestedBars = visibleBars + warmupBars`.
 *  - Se excluye la barra en formación cuando el normalizador puede distinguirla.
 *  - Se conservan las últimas `requestedBars` barras cerradas.
 *  - `visibleStart = max(0, bars.length - visibleBars)`.
 *  - `rthOnly` (solo Massive): el buffer solo contiene barras cuya apertura
 *    está dentro de RTH; el objetivo y el recorte se aplican sobre barras
 *    RTH y el lookback se escala a barras RTH por día. Los huecos se
 *    calculan sobre el buffer cerrado completo, antes del filtro. Con
 *    rthOnly + 1h la 1h nativa no se usa: se piden 30m y se agregan 7
 *    ventanas 09:30-ancladas por día ET (`aggregatedPartialBars` cuenta las
 *    ventanas cerradas con menos mitades que las esperadas).
 *  - `sessionStartCovered` indica si el buffer contiene la primera barra de
 *    la sesión de la primera barra visible (09:30 ET en acciones, 00:00 UTC
 *    en cripto); false anticipa un VWAP de sesión parcial (SPEC punto 8).
 *
 * En el reporte, `gaps` se calcula sobre las barras cerradas ANTES del
 * recorte del buffer; `firstTime`/`lastTime` describen el buffer ya
 * recortado y no acotan el rango de los huecos.
 *
 * No se inventan barras ni se rellenan huecos. La clave de Massive solo se
 * añade a la URL de la petición; nunca se incluye en el reporte. Un
 * `next_url` solo se sigue si pertenece al mismo origen que `baseUrl`:
 * la clave nunca se envía a un host distinto del configurado.
 */

import { URL, URLSearchParams } from 'node:url';
import type { Bar } from '../core/types.js';
import {
  MAX_TIME_SECONDS,
  getMarketParts,
  isRth,
  RTH_START_MINUTES,
} from '../core/sessions.js';
import { alignDown } from './alignment.js';
import { aggregateRth1hFrom30m, RTH_1H_FETCH_BAR_SECONDS } from './aggregateRth1h.js';
import { normalizeBingxKlines } from './normalizeBingx.js';
import { normalizeMassiveAggs } from './normalizeMassive.js';
import {
  AUTH_PARAM_NAMES,
  detectGaps,
  isFiniteNumber,
  isRecord,
  parseBingxCode,
  parseMilliseconds,
  redact,
  toErrorMessage,
} from './normalizeShared.js';
import { isTimeframe, timeframeSeconds } from './timeframes.js';
import type {
  BingxLoadBarsReport,
  BingxNormalizeResult,
  DataProvider,
  FetchResponse,
  FormingBarInfo,
  LoadBarsOptions,
  LoadBarsResult,
  MassiveLoadBarsReport,
  MassiveNormalizeResult,
  ProviderError,
  StopReason,
  Timeframe,
} from './types.js';

const MASSIVE_BASE_URL = 'https://api.polygon.io';
const BINGX_BASE_URL = 'https://open-api.bingx.com';
const MASSIVE_PAGE_LIMIT = 50_000;
const BINGX_PAGE_LIMIT = 1_000;
const DEFAULT_MAX_PAGES = 10;
const SECONDS_PER_DAY = 86_400;

const MASSIVE_TIMEFRAME_PATH: Readonly<
  Record<Timeframe, { readonly multiplier: number; readonly timespan: string }>
> = Object.freeze({
  '1m': { multiplier: 1, timespan: 'minute' },
  '5m': { multiplier: 5, timespan: 'minute' },
  '15m': { multiplier: 15, timespan: 'minute' },
  '1h': { multiplier: 1, timespan: 'hour' },
  '4h': { multiplier: 4, timespan: 'hour' },
  '1D': { multiplier: 1, timespan: 'day' },
});

/** Barras aproximadas por día de sesión extendida (04:00-20:00 ET). */
const MASSIVE_BARS_PER_DAY: Readonly<Record<Timeframe, number>> = Object.freeze({
  '1m': 960,
  '5m': 192,
  '15m': 64,
  '1h': 16,
  '4h': 4,
  '1D': 1,
});

/**
 * Barras RTH por día (apertura dentro de 09:30-16:00 ET). Con `rthOnly` el
 * lookback se escala con esta tabla para que el objetivo de barras RTH sea
 * alcanzable. Sin entrada para 1D: `rthOnly` con 1D se rechaza en
 * `resolveOptions` porque ninguna barra diaria abre dentro de RTH.
 */
const MASSIVE_RTH_BARS_PER_DAY: Readonly<
  Record<Exclude<Timeframe, '1D'>, number>
> = Object.freeze({
  '1m': 390,
  '5m': 78,
  '15m': 26,
  // 7 ventanas 09:30-ancladas por día: en rthOnly la 1h nativa no se usa; se
  // piden 30m y se agregan (la 1h de 09:00 mezclaría premarket con apertura).
  '1h': 7,
  '4h': 1,
});

/**
 * Modo rthOnly + 1h: en lugar de la 1h nativa se piden barras de 30m y se
 * agregan en 7 ventanas 09:30-ancladas por día ET (`aggregateRth1hFrom30m`).
 * La detección de la barra en formación y los huecos se calculan sobre la
 * granularidad pedida (1800 s).
 */
const RTH_1H_FETCH: Readonly<{
  multiplier: number;
  timespan: string;
  barSeconds: number;
}> = Object.freeze({
  multiplier: 30,
  timespan: 'minute',
  barSeconds: RTH_1H_FETCH_BAR_SECONDS,
});

const BINGX_INTERVAL: Readonly<Record<Timeframe, string>> = Object.freeze({
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
});

/**
 * Rangos máximos conservadores observados en la muestra real. El proveedor
 * devuelve `code 100204` si se pide más historia en una sola consulta.
 * La paginación de BingX fija `startTime` en `now - rango` y solo mueve
 * `endTime`, así que el rango es también el techo de historia por carga:
 * para 1D son ~380 días y el warmup por defecto (1000) no es alcanzable;
 * `warmupSatisfied` lo reporta como false.
 */
const BINGX_MAX_RANGE_DAYS: Readonly<Record<Timeframe, number>> = Object.freeze({
  '1m': 2,
  '5m': 8,
  '15m': 22,
  '1h': 90,
  '4h': 350,
  '1D': 380,
});

interface ResolvedLoadOptions {
  readonly provider: DataProvider;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly visibleBars: number;
  readonly warmupBars: number;
  readonly requestedBars: number;
  readonly fetchFn: LoadBarsOptions['fetchFn'];
  readonly explicitNow: number | undefined;
  readonly requestNow: number;
  readonly maxPages: number;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly rthOnly: boolean;
}

interface MassiveRequestWindow {
  readonly from: string | number;
  readonly to: string | number;
}

interface ParsedPage {
  readonly rows: readonly unknown[];
  readonly nextUrl: string | null;
  readonly serverTimestampMs: number | null;
  readonly providerError: ProviderError | null;
  readonly malformed: boolean;
}

/**
 * Carga barras cerradas y devuelve el buffer con su tramo visible.
 *
 * La función es asíncrona porque `fetchFn` puede ser red real; en tests se
 * inyecta una función determinista que devuelve páginas grabadas.
 */
export async function loadBars(
  options: LoadBarsOptions,
): Promise<LoadBarsResult> {
  const resolved = resolveOptions(options);
  if (resolved.provider === 'massive') {
    return loadMassive(resolved);
  }
  return loadBingx(resolved);
}

function resolveOptions(options: LoadBarsOptions): ResolvedLoadOptions {
  const provider = options.provider as string;
  if (provider !== 'massive' && provider !== 'bingx') {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const timeframe = options.timeframe as string;
  if (!isTimeframe(timeframe)) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }

  if (typeof options.symbol !== 'string' || options.symbol.trim() === '') {
    throw new Error('symbol must be a non-empty string');
  }

  if (!Number.isInteger(options.visibleBars) || options.visibleBars < 0) {
    throw new Error(
      `visibleBars must be a non-negative integer (got ${String(options.visibleBars)})`,
    );
  }

  const warmupBars = options.warmupBars ?? 1_000;
  if (!Number.isInteger(warmupBars) || warmupBars < 0) {
    throw new Error(
      `warmupBars must be a non-negative integer (got ${String(warmupBars)})`,
    );
  }

  const requestedBars = options.visibleBars + warmupBars;
  if (requestedBars <= 0) {
    throw new Error('visibleBars + warmupBars must be greater than 0');
  }

  if (
    options.now !== undefined &&
    (!Number.isFinite(options.now) || !Number.isInteger(options.now))
  ) {
    throw new Error(
      `now must be finite integer seconds (got ${String(options.now)})`,
    );
  }

  if (
    options.now !== undefined &&
    (options.now <= 0 || options.now > MAX_TIME_SECONDS)
  ) {
    throw new Error(
      `now must be within the supported seconds range (got ${String(options.now)})`,
    );
  }

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(
      `maxPages must be a positive integer (got ${String(maxPages)})`,
    );
  }

  const rthOnly = options.rthOnly ?? false;
  if (typeof rthOnly !== 'boolean') {
    throw new Error(`rthOnly must be a boolean (got ${String(rthOnly)})`);
  }
  if (rthOnly && provider !== 'massive') {
    throw new Error('rthOnly is only supported for massive');
  }
  if (rthOnly && timeframe === '1D') {
    throw new Error('rthOnly does not support the 1D timeframe');
  }

  if (
    provider === 'massive' &&
    (typeof options.apiKey !== 'string' || options.apiKey === '')
  ) {
    throw new Error('apiKey is required for Massive');
  }

  const defaultBaseUrl =
    provider === 'massive' ? MASSIVE_BASE_URL : BINGX_BASE_URL;
  const baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '');
  if (baseUrl === '') {
    throw new Error('baseUrl must be a non-empty URL');
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error(`baseUrl must be an absolute https URL (got ${baseUrl})`);
  }
  if (parsedBaseUrl.protocol !== 'https:') {
    throw new Error(`baseUrl must be an absolute https URL (got ${baseUrl})`);
  }

  return {
    provider,
    symbol: options.symbol,
    timeframe,
    visibleBars: options.visibleBars,
    warmupBars,
    requestedBars,
    fetchFn: options.fetchFn,
    explicitNow: options.now,
    requestNow: options.now ?? Math.floor(Date.now() / 1_000),
    maxPages,
    apiKey: options.apiKey ?? '',
    baseUrl,
    rthOnly,
  };
}

async function loadMassive(
  options: ResolvedLoadOptions,
): Promise<LoadBarsResult> {
  const barSeconds = timeframeSeconds(options.timeframe);
  const rth1hAggregated = options.rthOnly && options.timeframe === '1h';
  const fetchBarSeconds = rth1hAggregated
    ? RTH_1H_FETCH.barSeconds
    : barSeconds;
  const now = options.explicitNow ?? options.requestNow;
  const window = massiveWindow(
    now,
    options.timeframe,
    options.requestedBars,
    options.rthOnly,
    rth1hAggregated ? RTH_1H_FETCH.barSeconds : undefined,
  );
  let url = withApiKey(
    massiveUrl(
      options.baseUrl,
      options.symbol,
      options.timeframe,
      window,
      rth1hAggregated ? RTH_1H_FETCH : undefined,
    ),
    options.apiKey,
    options.baseUrl,
  );

  const rows: unknown[] = [];
  const secrets = [options.apiKey, encodeURIComponent(options.apiKey)];
  let pages = 0;
  let stoppedReason: StopReason = 'noMorePages';
  let pageError: ProviderError | null = null;
  let malformed = false;
  let probe: MassiveNormalizeResult | null = null;

  while (pages < options.maxPages) {
    pages += 1;

    let response: FetchResponse;
    try {
      response = await options.fetchFn(url);
    } catch (error) {
      pageError = {
        code: 0,
        message: redact(errorMessage(error), secrets),
      };
      stoppedReason = 'providerError';
      break;
    }

    const page = parseMassivePage(response, secrets);
    if (page.providerError !== null) {
      pageError = page.providerError;
      stoppedReason = 'providerError';
      break;
    }
    if (page.malformed) {
      malformed = true;
      stoppedReason = 'malformedResponse';
      break;
    }

    rows.push(...page.rows);
    const result = normalizeMassiveAggs(
      { status: 'OK', results: rows },
      { barSeconds: fetchBarSeconds, now },
    );
    probe = result;

    const candidates = candidateBars(
      result.bars,
      result.report.formingBar,
      options.rthOnly,
    );
    // En el modo rthOnly+1h el objetivo se cuenta en VENTANAS cerradas, no
    // en mitades de 30m.
    const targetCount = rth1hAggregated
      ? aggregateRth1hFrom30m(candidates, now).bars.length
      : candidates.length;
    if (targetCount >= options.requestedBars) {
      stoppedReason = 'targetReached';
      break;
    }

    if (page.rows.length === 0 || page.nextUrl === null) {
      stoppedReason = 'noMorePages';
      break;
    }

    if (pages >= options.maxPages) {
      stoppedReason = 'maxPages';
      break;
    }

    try {
      url = withApiKey(
        allowedNextUrl(page.nextUrl, options.baseUrl),
        options.apiKey,
        options.baseUrl,
      );
    } catch {
      malformed = true;
      stoppedReason = 'malformedResponse';
      break;
    }
  }

  const result =
    probe ??
    normalizeMassiveAggs(
      { status: 'OK', results: rows },
      { barSeconds: fetchBarSeconds, now },
    );

  return finalizeMassive(
    result,
    options,
    barSeconds,
    pages,
    stoppedReason,
    pageError,
    malformed,
  );
}

async function loadBingx(
  options: ResolvedLoadOptions,
): Promise<LoadBarsResult> {
  const barSeconds = timeframeSeconds(options.timeframe);
  const { startTime, endTime: initialEndTime } = bingxWindow(
    options.requestNow,
    options.timeframe,
  );
  let endTime = initialEndTime;
  let url = bingxUrl(
    options.baseUrl,
    options.symbol,
    options.timeframe,
    startTime,
    endTime,
  );

  const rows: unknown[] = [];
  const secrets =
    options.apiKey === ''
      ? []
      : [options.apiKey, encodeURIComponent(options.apiKey)];
  let pages = 0;
  let stoppedReason: StopReason = 'noMorePages';
  let pageError: ProviderError | null = null;
  let malformed = false;
  let probe: BingxNormalizeResult | null = null;
  let serverTimestampMs: number | null = null;

  while (pages < options.maxPages) {
    pages += 1;

    let response: FetchResponse;
    try {
      response = await options.fetchFn(url);
    } catch (error) {
      pageError = {
        code: 0,
        message: redact(errorMessage(error), secrets),
      };
      stoppedReason = 'providerError';
      break;
    }

    const page = parseBingxPage(response, secrets);
    if (page.providerError !== null) {
      pageError = page.providerError;
      stoppedReason = 'providerError';
      break;
    }
    if (page.malformed) {
      malformed = true;
      stoppedReason = 'malformedResponse';
      break;
    }

    rows.push(...page.rows);
    if (page.serverTimestampMs !== null) {
      serverTimestampMs =
        serverTimestampMs === null
          ? page.serverTimestampMs
          : Math.max(serverTimestampMs, page.serverTimestampMs);
    }

    const now = resolveBingxNow(options, serverTimestampMs);
    const result = normalizeBingxKlines(
      { code: 0, data: rows },
      { barSeconds, now },
    );
    probe = result;

    if (
      countClosedBars(result.bars, result.report.formingBar) >=
      options.requestedBars
    ) {
      stoppedReason = 'targetReached';
      break;
    }

    if (page.rows.length === 0) {
      stoppedReason = 'noMorePages';
      break;
    }

    const oldestSeconds = oldestOpenTimeSeconds(page.rows);
    if (oldestSeconds === null || oldestSeconds * 1_000 <= startTime) {
      stoppedReason = 'noMorePages';
      break;
    }

    if (pages >= options.maxPages) {
      stoppedReason = 'maxPages';
      break;
    }

    endTime = oldestSeconds * 1_000 - 1;
    url = bingxUrl(
      options.baseUrl,
      options.symbol,
      options.timeframe,
      startTime,
      endTime,
    );
  }

  const now = resolveBingxNow(options, serverTimestampMs);
  const result =
    probe ??
    normalizeBingxKlines({ code: 0, data: rows }, { barSeconds, now });

  return finalizeBingx(
    result,
    options,
    barSeconds,
    pages,
    stoppedReason,
    pageError,
    malformed,
  );
}

function resolveBingxNow(
  options: ResolvedLoadOptions,
  serverTimestampMs: number | null,
): number {
  if (options.explicitNow !== undefined) {
    return options.explicitNow;
  }
  if (serverTimestampMs !== null) {
    return Math.floor(serverTimestampMs / 1_000);
  }
  return options.requestNow;
}

function finalizeMassive(
  result: MassiveNormalizeResult,
  options: ResolvedLoadOptions,
  barSeconds: number,
  pages: number,
  stoppedReason: StopReason,
  pageError: ProviderError | null,
  malformed: boolean,
): LoadBarsResult {
  const closedBars = excludeFormingBar(result.bars, result.report.formingBar);
  const rth1hAggregated = options.rthOnly && options.timeframe === '1h';
  let bufferBars: readonly Bar[];
  let formingWindow: FormingBarInfo | null = null;
  let aggregatedPartialBars: number | undefined;
  let aggregatedVwFallbackHalves: number | undefined;
  if (rth1hAggregated) {
    // El buffer son ventanas de 1h 09:30-ancladas agregadas desde 30m: la
    // ventana en formación no se emite y el recorte se aplica sobre ventanas.
    const aggregated = aggregateRth1hFrom30m(
      closedBars.filter((bar) => isRth(bar.time)),
      options.explicitNow ?? options.requestNow,
    );
    bufferBars = aggregated.bars;
    formingWindow = aggregated.formingWindow;
    aggregatedPartialBars = aggregated.partialBars;
    aggregatedVwFallbackHalves = aggregated.vwFallbackHalves;
  } else {
    bufferBars = options.rthOnly
      ? closedBars.filter((bar) => isRth(bar.time))
      : closedBars;
  }
  const normalizedBars = bufferBars.length;
  const bars = trimToBuffer(bufferBars, options.requestedBars);
  const trimmedBars = normalizedBars - bars.length;
  const visibleStart = Math.max(0, bars.length - options.visibleBars);
  // Los huecos se calculan sobre el buffer cerrado completo (las 30m en el
  // modo agregado), antes del filtro RTH y del recorte.
  const { gaps, gapDetection } = detectGaps(
    closedBars,
    rth1hAggregated ? RTH_1H_FETCH.barSeconds : barSeconds,
    'massive',
  );

  const report: MassiveLoadBarsReport = {
    ...result.report,
    gaps,
    gapDetection,
    malformedResponse: malformed || result.report.malformedResponse,
    providerError: pageError ?? result.report.providerError,
    requestedBars: options.requestedBars,
    visibleBars: options.visibleBars,
    warmupBars: options.warmupBars,
    normalizedBars,
    trimmedBars,
    formingExcluded:
      (result.report.formingBar !== null &&
        closedBars.length < result.bars.length) ||
      formingWindow !== null,
    warmupSatisfied: normalizedBars >= options.requestedBars,
    sessionStartCovered: sessionStartCovered(
      bars,
      visibleStart,
      'massive',
    ),
    pages,
    firstTime: bars[0]?.time ?? null,
    lastTime: bars[bars.length - 1]?.time ?? null,
    stoppedReason,
    ...(aggregatedPartialBars === undefined
      ? {}
      : { aggregatedPartialBars }),
    ...(aggregatedVwFallbackHalves === undefined
      ? {}
      : { aggregatedVwFallbackHalves }),
  };

  return { bars, visibleStart, report };
}

function finalizeBingx(
  result: BingxNormalizeResult,
  options: ResolvedLoadOptions,
  barSeconds: number,
  pages: number,
  stoppedReason: StopReason,
  pageError: ProviderError | null,
  malformed: boolean,
): LoadBarsResult {
  const closedBars = excludeFormingBar(result.bars, result.report.formingBar);
  const normalizedBars = closedBars.length;
  const bars = trimToBuffer(closedBars, options.requestedBars);
  const trimmedBars = normalizedBars - bars.length;
  const visibleStart = Math.max(0, bars.length - options.visibleBars);
  const { gaps, gapDetection } = detectGaps(closedBars, barSeconds, 'bingx');

  const report: BingxLoadBarsReport = {
    ...result.report,
    gaps,
    gapDetection,
    malformedResponse: malformed || result.report.malformedResponse,
    providerError: pageError ?? result.report.providerError,
    requestedBars: options.requestedBars,
    visibleBars: options.visibleBars,
    warmupBars: options.warmupBars,
    normalizedBars,
    trimmedBars,
    formingExcluded:
      result.report.formingBar !== null &&
      closedBars.length < result.bars.length,
    warmupSatisfied: normalizedBars >= options.requestedBars,
    sessionStartCovered: sessionStartCovered(
      bars,
      visibleStart,
      'bingx',
    ),
    pages,
    firstTime: bars[0]?.time ?? null,
    lastTime: bars[bars.length - 1]?.time ?? null,
    stoppedReason,
  };

  return { bars, visibleStart, report };
}

/**
 * Indica si el buffer contiene la primera barra de la sesión que contiene
 * la primera barra visible.
 *
 * En Massive esa barra es la del mismo día ET que abre a las 09:30 ET (la
 * primera que acumula el VWAP de sesión); en BingX, la que abre a las
 * 00:00 UTC del día UTC. Si la temporalidad no tiene barra en el inicio
 * de sesión (4h/1D en acciones, 1D en cripto) el flag es false: el VWAP de
 * sesión es parcial por construcción (SPEC punto 8). Con rthOnly + 1h la
 * ventana de 09:30 agregada hace de primera barra del día, así que el flag
 * puede ser true.
 */
function sessionStartCovered(
  bars: readonly Bar[],
  visibleStart: number,
  provider: DataProvider,
): boolean {
  const firstVisible = bars[visibleStart];
  if (firstVisible === undefined) {
    return false;
  }

  if (provider === 'massive') {
    const visibleParts = getMarketParts(firstVisible.time, 'EQUITY');
    return bars.some((bar) => {
      const parts = getMarketParts(bar.time, 'EQUITY');
      return (
        parts.dateKey === visibleParts.dateKey &&
        parts.minutesOfDay === RTH_START_MINUTES &&
        isRth(bar.time)
      );
    });
  }

  const visibleDay = Math.floor(firstVisible.time / SECONDS_PER_DAY);
  return bars.some(
    (bar) =>
      bar.time % SECONDS_PER_DAY === 0 &&
      Math.floor(bar.time / SECONDS_PER_DAY) === visibleDay,
  );
}

function excludeFormingBar(
  bars: readonly Bar[],
  formingBar: FormingBarInfo | null,
): readonly Bar[] {
  if (formingBar === null) {
    return bars;
  }
  return bars.filter((bar) => bar.time !== formingBar.time);
}

/**
 * Barras cerradas candidatas a poblar el buffer: sin la barra en formación
 * y, con `rthOnly`, solo las que abren dentro de RTH.
 */
function candidateBars(
  bars: readonly Bar[],
  formingBar: FormingBarInfo | null,
  rthOnly: boolean,
): readonly Bar[] {
  const closed = excludeFormingBar(bars, formingBar);
  return rthOnly ? closed.filter((bar) => isRth(bar.time)) : closed;
}

function trimToBuffer(
  bars: readonly Bar[],
  requestedBars: number,
): readonly Bar[] {
  if (bars.length <= requestedBars) {
    return bars;
  }
  return bars.slice(bars.length - requestedBars);
}

function countClosedBars(
  bars: readonly Bar[],
  formingBar: FormingBarInfo | null,
): number {
  if (formingBar === null) {
    return bars.length;
  }
  return bars.some((bar) => bar.time === formingBar.time)
    ? bars.length - 1
    : bars.length;
}

function parseMassivePage(
  response: FetchResponse,
  secrets: readonly string[],
): ParsedPage {
  if (!response.ok || response.status < 200 || response.status >= 300) {
    return providerErrorPage(
      response.status,
      extractHttpMessage(
        response.text,
        `HTTP ${String(response.status)}`,
      ),
      secrets,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(response.text) as unknown;
  } catch {
    return malformedPage();
  }

  if (!isRecord(body)) {
    return malformedPage();
  }

  const status = body['status'];
  if (typeof status === 'string' && status.toUpperCase() !== 'OK') {
    const message = body['error'] ?? body['message'] ?? status;
    return providerErrorPage(0, toErrorMessage(message, status), secrets);
  }

  const results = body['results'];
  if (results === undefined || results === null) {
    return emptyPage();
  }
  if (!Array.isArray(results)) {
    return malformedPage();
  }

  const next = body['next_url'];
  const nextUrl = typeof next === 'string' && next !== '' ? next : null;

  return {
    rows: results,
    nextUrl,
    serverTimestampMs: null,
    providerError: null,
    malformed: false,
  };
}

function parseBingxPage(
  response: FetchResponse,
  secrets: readonly string[],
): ParsedPage {
  if (!response.ok || response.status < 200 || response.status >= 300) {
    return providerErrorPage(
      response.status,
      extractHttpMessage(
        response.text,
        `HTTP ${String(response.status)}`,
      ),
      secrets,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(response.text) as unknown;
  } catch {
    return malformedPage();
  }

  if (!isRecord(body)) {
    return malformedPage();
  }

  const parsedCode = parseBingxCode(body['code']);
  if (parsedCode.kind === 'malformed') {
    return malformedPage();
  }
  if (parsedCode.kind === 'number' && parsedCode.code !== 0) {
    const message = body['msg'] ?? body['message'];
    return providerErrorPage(
      parsedCode.code,
      toErrorMessage(message, ''),
      secrets,
    );
  }

  const data = body['data'];
  let rows: readonly unknown[];
  if (data === undefined || data === null) {
    rows = [];
  } else if (Array.isArray(data)) {
    rows = data;
  } else {
    return malformedPage();
  }

  const timestamp = body['timestamp'];
  const serverTimestampMs = isPlausibleServerTimestampMs(timestamp)
    ? timestamp
    : null;

  return {
    rows,
    nextUrl: null,
    serverTimestampMs,
    providerError: null,
    malformed: false,
  };
}

function emptyPage(): ParsedPage {
  return {
    rows: [],
    nextUrl: null,
    serverTimestampMs: null,
    providerError: null,
    malformed: false,
  };
}

function malformedPage(): ParsedPage {
  return {
    rows: [],
    nextUrl: null,
    serverTimestampMs: null,
    providerError: null,
    malformed: true,
  };
}

function providerErrorPage(
  code: number,
  message: string,
  secrets: readonly string[],
): ParsedPage {
  return {
    rows: [],
    nextUrl: null,
    serverTimestampMs: null,
    providerError: { code, message: redact(message, secrets) },
    malformed: false,
  };
}

function extractHttpMessage(text: string, fallback: string): string {
  try {
    const body: unknown = JSON.parse(text) as unknown;
    if (isRecord(body)) {
      const message = body['error'] ?? body['message'] ?? body['msg'];
      if (typeof message === 'string' && message !== '') {
        return message;
      }
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function oldestOpenTimeSeconds(rows: readonly unknown[]): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0) {
      continue;
    }
    // Solo un openTime en milisegundos válidos participa en la paginación:
    // un valor en segundos o fuera de rango no debe mover la ventana.
    const seconds = parseMilliseconds(row[0]);
    if (seconds !== null && (oldest === null || seconds < oldest)) {
      oldest = seconds;
    }
  }
  return oldest;
}

function massiveWindow(
  now: number,
  timeframe: Timeframe,
  requestedBars: number,
  rthOnly: boolean,
  alignBarSeconds?: number,
): MassiveRequestWindow {
  const lookbackDays = massiveLookbackDays(
    requestedBars,
    timeframe,
    rthOnly,
  );

  if (timeframe === '1D') {
    const to = getMarketParts(now, 'EQUITY').dateKey;
    return { from: shiftDateKey(to, -lookbackDays), to };
  }

  const rawFrom = now - lookbackDays * SECONDS_PER_DAY;
  // En el modo rthOnly+1h la petición pide 30m: el ancla se baja a la rejilla
  // de 30 min en UTC. Los desfases ET son horas enteras, así que coincide con
  // la rejilla :00/:30 ET y la barra de 09:30 existe.
  const from =
    alignBarSeconds === undefined
      ? alignDown(rawFrom, timeframe, 'massive')
      : rawFrom - (rawFrom % alignBarSeconds);
  return { from: from * 1_000, to: now * 1_000 };
}

function massiveLookbackDays(
  requestedBars: number,
  timeframe: Timeframe,
  rthOnly: boolean,
): number {
  const barsPerDay = rthOnly
    ? MASSIVE_RTH_BARS_PER_DAY[timeframe as Exclude<Timeframe, '1D'>]
    : MASSIVE_BARS_PER_DAY[timeframe];
  return (
    Math.ceil((requestedBars / barsPerDay) * (7 / 5)) + 10
  );
}

function shiftDateKey(dateKey: string, deltaDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (match === null) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function massiveUrl(
  baseUrl: string,
  symbol: string,
  timeframe: Timeframe,
  window: MassiveRequestWindow,
  pathOverride?: Readonly<{
    multiplier: number;
    timespan: string;
  }>,
): string {
  const path = pathOverride ?? MASSIVE_TIMEFRAME_PATH[timeframe];
  const urlPath =
    `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/` +
    `${String(path.multiplier)}/${path.timespan}/` +
    `${String(window.from)}/${String(window.to)}`;
  const params = new URLSearchParams({
    adjusted: 'true',
    sort: 'desc',
    limit: String(MASSIVE_PAGE_LIMIT),
  });
  return `${baseUrl}${urlPath}?${params.toString()}`;
}

function bingxWindow(
  now: number,
  timeframe: Timeframe,
): { readonly startTime: number; readonly endTime: number } {
  const endTime = now * 1_000;
  return {
    startTime:
      endTime - BINGX_MAX_RANGE_DAYS[timeframe] * SECONDS_PER_DAY * 1_000,
    endTime,
  };
}

function bingxUrl(
  baseUrl: string,
  symbol: string,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
): string {
  const params = new URLSearchParams({
    symbol,
    interval: BINGX_INTERVAL[timeframe],
    limit: String(BINGX_PAGE_LIMIT),
    startTime: String(startTime),
    endTime: String(endTime),
  });
  return `${baseUrl}/openApi/spot/v2/market/kline?${params.toString()}`;
}

/**
 * Resuelve y valida el `next_url` del proveedor.
 *
 * Solo se acepta una URL del MISMO origen que `baseUrl` (esquema, host y
 * puerto), con esquema http/https y sin credenciales en la propia URL.
 * Cualquier otra URL se rechaza: la clave nunca se envía a un host distinto
 * del configurado por el llamador.
 */
function allowedNextUrl(nextUrl: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  const next = new URL(nextUrl, base);
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    throw new Error(`Unsupported next_url protocol: ${next.protocol}`);
  }
  if (next.username !== '' || next.password !== '') {
    throw new Error('next_url must not include credentials');
  }
  if (next.origin !== base.origin) {
    throw new Error(`next_url origin mismatch: ${next.origin}`);
  }
  return next.toString();
}

function authParamForUrl(url: string): 'apiKey' | 'apikey' {
  try {
    return new URL(url).hostname.toLowerCase() === 'api.massive.com'
      ? 'apikey'
      : 'apiKey';
  } catch {
    return 'apiKey';
  }
}

function withApiKey(url: string, apiKey: string, baseUrl: string): string {
  const parsed = new URL(url, baseUrl);
  for (const key of [...parsed.searchParams.keys()]) {
    if (AUTH_PARAM_NAMES.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.set(authParamForUrl(parsed.toString()), apiKey);
  return parsed.toString();
}

/**
 * `timestamp` del servidor de BingX en milisegundos.
 *
 * Debe ser un entero dentro del rango plausible: en ms equivale a una fecha
 * posterior a septiembre de 2001 (1e12) y dentro del umbral de sesiones
 * (MAX_TIME_SECONDS * 1000). Un valor en segundos (~1.8e9) no pasa el mínimo
 * y se ignora: `now` cae al reloj de la petición en lugar de a 1970.
 */
function isPlausibleServerTimestampMs(value: unknown): value is number {
  return (
    isFiniteNumber(value) &&
    Number.isInteger(value) &&
    value >= 1e12 &&
    value <= MAX_TIME_SECONDS * 1_000
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'fetch failed';
}
