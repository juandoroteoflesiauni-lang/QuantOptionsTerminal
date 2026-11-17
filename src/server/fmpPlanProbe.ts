/**
 * Plan probe de FMP (Pieza 41.4).
 *
 * Verifica el nivel de acceso observado por alias FMP y reporta el plan mínimo
 * documentado por endpoint. Nunca imprime ni serializa la clave: la URL con
 * `apikey` vive solo dentro del request.
 */

import './envBootstrap.js';

import { redactSecrets } from './runtimeCache.js';

export type FmpPlanTier = 'STARTER' | 'PREMIUM' | 'ULTIMATE';
export type FmpPlanProbeAccess = 'ALLOWED' | 'BLOCKED' | 'NOT_CONFIGURED' | 'ERROR';

export interface FmpPlanProbeDefinition {
  readonly alias: string;
  readonly endpoint: string;
  readonly planTierRequired: FmpPlanTier;
  /** Nombre de feature en la tabla de pricing de FMP. */
  readonly planFeature: string;
}

export interface FmpPlanProbeResult {
  readonly alias: string;
  readonly endpoint: string;
  readonly planTierRequired: FmpPlanTier;
  readonly planFeature: string;
  readonly access: FmpPlanProbeAccess;
  readonly httpStatus: number | null;
  readonly rows: number | null;
  readonly latencyMs: number | null;
  readonly error: string | null;
}

export interface FmpPlanProbeSummary {
  readonly totalProbes: number;
  readonly allowedCount: number;
  readonly blockedCount: number;
  readonly notConfiguredCount: number;
  readonly errorCount: number;
}

export interface FmpPlanProbeResponse {
  readonly status: 'OK';
  readonly asOfUtcSec: number;
  readonly planTierSource: 'FMP_PRICING_DOCS';
  readonly summary: FmpPlanProbeSummary;
  readonly probes: readonly FmpPlanProbeResult[];
}

export const FMP_PLAN_PROBE_DEFINITIONS: readonly FmpPlanProbeDefinition[] = Object.freeze([
  {
    alias: 'FMP_API_KEY',
    endpoint: '/stable/profile?symbol=AAPL',
    planTierRequired: 'STARTER',
    planFeature: 'Company Profile Data',
  },
  {
    alias: 'FMP_KEY_13F',
    endpoint: '/stable/institutional-ownership/dates?cik=0001067983',
    planTierRequired: 'ULTIMATE',
    planFeature: 'Form 13F Filings Dates',
  },
  {
    alias: 'FMP_KEY_ANALYST',
    endpoint: '/stable/analyst-estimates?symbol=AAPL&period=annual&page=0&limit=10',
    planTierRequired: 'ULTIMATE',
    planFeature: 'Financial Estimates',
  },
  {
    alias: 'FMP_KEY_CALENDARS',
    endpoint: '/stable/earnings-calendar?from=2026-11-17&to=2026-11-20',
    planTierRequired: 'STARTER',
    planFeature: 'Earnings Calendar',
  },
  {
    alias: 'FMP_KEY_ETF',
    endpoint: '/stable/etf-list',
    planTierRequired: 'STARTER',
    planFeature: 'ETF Symbol Search',
  },
  {
    alias: 'FMP_KEY_FILINGS',
    endpoint: '/stable/sec-filings-search/form-type?formType=8-K&from=2026-11-01&to=2026-11-17&page=0&limit=10',
    planTierRequired: 'STARTER',
    planFeature: 'SEC Filings By Form Type',
  },
  {
    alias: 'FMP_KEY_MACRO',
    endpoint: '/stable/economic-calendar?from=2026-11-17&to=2026-11-20',
    planTierRequired: 'STARTER',
    planFeature: 'Economic Data Releases Calendar',
  },
  {
    alias: 'FMP_KEY_MARKET',
    endpoint: '/stable/historical-chart/5min?symbol=AAPL',
    planTierRequired: 'STARTER',
    planFeature: '5 Min Interval Stock Chart',
  },
  {
    alias: 'FMP_KEY_NEWS',
    endpoint: '/stable/news/stock-latest?page=0&limit=20',
    planTierRequired: 'STARTER',
    planFeature: 'Stock News',
  },
  {
    alias: 'FMP_KEY_PROFILES',
    endpoint: '/stable/profile?symbol=AAPL',
    planTierRequired: 'STARTER',
    planFeature: 'Company Profile Data',
  },
  {
    alias: 'FMP_KEY_QUOTES',
    endpoint: '/stable/quote?symbol=AAPL',
    planTierRequired: 'ULTIMATE',
    planFeature: 'Stock Quote',
  },
  {
    alias: 'FMP_KEY_STATEMENTS',
    endpoint: '/stable/income-statement?symbol=AAPL&limit=1',
    planTierRequired: 'STARTER',
    planFeature: 'Income Statement',
  },
  {
    alias: 'FMP_KEY_TECHNICAL',
    endpoint: '/stable/technical-indicators/sma?symbol=AAPL&periodLength=10&timeframe=1day',
    planTierRequired: 'STARTER',
    planFeature: 'Simple Moving Average',
  },
  {
    alias: 'FMP_KEY_TRANSCRIPTS',
    endpoint: '/stable/earning-call-transcript?symbol=AAPL&year=2020&quarter=3',
    planTierRequired: 'ULTIMATE',
    planFeature: 'Earnings Transcript',
  },
]);

export interface FmpPlanProbeHttpResult {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

export type FmpPlanProbeHttpFn = (url: string) => Promise<FmpPlanProbeHttpResult>;

export interface FmpPlanProbeInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchFn?: FmpPlanProbeHttpFn;
  readonly nowMsFn?: () => number;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countRows(body: unknown): number | null {
  if (Array.isArray(body)) return body.length;
  if (!isRecord(body)) return null;
  for (const key of ['data', 'results', 'filings', 'quotes']) {
    const value = body[key];
    if (Array.isArray(value)) return value.length;
  }
  return 1;
}

function readKey(env: NodeJS.ProcessEnv, alias: string): string | null {
  const value = (env[alias] ?? '').trim();
  return value === '' ? null : value;
}

export function classifyFmpPlanProbe(input: {
  readonly httpStatus: number | null;
  readonly rows: number | null;
  readonly error: string | null;
}): FmpPlanProbeAccess {
  if (input.error !== null && input.httpStatus === null) return 'ERROR';
  if (input.httpStatus === null) return 'ERROR';
  if (input.httpStatus === 401 || input.httpStatus === 402 || input.httpStatus === 403) {
    return 'BLOCKED';
  }
  if (input.httpStatus === 200 && input.rows !== null && input.rows > 0) return 'ALLOWED';
  return 'ERROR';
}

function summarize(probes: readonly FmpPlanProbeResult[]): FmpPlanProbeSummary {
  let allowedCount = 0;
  let blockedCount = 0;
  let notConfiguredCount = 0;
  let errorCount = 0;
  for (const probe of probes) {
    if (probe.access === 'ALLOWED') allowedCount += 1;
    else if (probe.access === 'BLOCKED') blockedCount += 1;
    else if (probe.access === 'NOT_CONFIGURED') notConfiguredCount += 1;
    else errorCount += 1;
  }
  return {
    totalProbes: probes.length,
    allowedCount,
    blockedCount,
    notConfiguredCount,
    errorCount,
  };
}

export async function probeFmpPlans(input: FmpPlanProbeInput = {}): Promise<FmpPlanProbeResponse> {
  const env = input.env ?? process.env;
  const nowMsFn = input.nowMsFn ?? ((): number => Date.now());
  const fetchFn =
    input.fetchFn ??
    (async (url: string): Promise<FmpPlanProbeHttpResult> => {
      const response = await fetch(url, { signal: AbortSignal.timeout(input.timeoutMs ?? 15_000) });
      return { ok: response.ok, status: response.status, text: await response.text() };
    });

  const probes: FmpPlanProbeResult[] = [];
  for (const definition of FMP_PLAN_PROBE_DEFINITIONS) {
    const startedAtMs = nowMsFn();
    const apiKey = readKey(env, definition.alias);
    if (apiKey === null) {
      probes.push({
        alias: definition.alias,
        endpoint: definition.endpoint,
        planTierRequired: definition.planTierRequired,
        planFeature: definition.planFeature,
        access: 'NOT_CONFIGURED',
        httpStatus: null,
        rows: null,
        latencyMs: 0,
        error: null,
      });
      continue;
    }

    try {
      const url = new URL(`https://financialmodelingprep.com${definition.endpoint}`);
      url.searchParams.set('apikey', apiKey);
      const response = await fetchFn(url.toString());
      const latencyMs = Math.max(0, nowMsFn() - startedAtMs);
      let body: unknown = null;
      let error: string | null = null;
      try {
        body = JSON.parse(response.text) as unknown;
      } catch {
        error = 'INVALID_JSON';
      }
      const rows = countRows(body);
      probes.push({
        alias: definition.alias,
        endpoint: definition.endpoint,
        planTierRequired: definition.planTierRequired,
        planFeature: definition.planFeature,
        access: classifyFmpPlanProbe({ httpStatus: response.status, rows, error }),
        httpStatus: response.status,
        rows,
        latencyMs,
        error: response.ok ? error : redactSecrets(`HTTP_${String(response.status)}`, []),
      });
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      probes.push({
        alias: definition.alias,
        endpoint: definition.endpoint,
        planTierRequired: definition.planTierRequired,
        planFeature: definition.planFeature,
        access: 'ERROR',
        httpStatus: null,
        rows: null,
        latencyMs: Math.max(0, nowMsFn() - startedAtMs),
        error: raw === '' ? 'NETWORK_ERROR' : redactSecrets(raw, []),
      });
    }
  }

  return {
    status: 'OK',
    asOfUtcSec: Math.floor(nowMsFn() / 1_000),
    planTierSource: 'FMP_PRICING_DOCS',
    summary: summarize(probes),
    probes,
  };
}
