export type OratsEndpoint = 'cores' | 'strikes' | 'ivrank';
export type OratsError = 'HTTP_5XX' | 'HTTP_4XX' | 'HTTP_429' | 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_SCHEMA' |
  'INVALID_JSON' | 'UNEXPECTED_EMPTY' | 'CIRCUIT_OPEN' | 'HALF_OPEN_PROBE_BUSY' | 'NOT_CONFIGURED';
export type OratsHealthStatus = 'OPERATIONAL' | 'PARTIAL_FAILURE' | 'STALE_CACHE' | 'UNAVAILABLE' | 'RECOVERING';
export const ORATS_CB_FAILURE_THRESHOLD = 3;
export const ORATS_CB_BASE_COOLDOWN_MS = 30_000;
export const ORATS_CB_MAX_COOLDOWN_MS = 240_000;
export const ORATS_CB_HTTP_429_MIN_COOLDOWN_MS = 60_000;
export const ORATS_CB_MAX_RETRIES_PER_CALL = 0;
export const ORATS_CB_HALF_OPEN_MAX_PROBES = 1;

export interface EndpointOutcome {
  readonly httpStatus: number | null;
  readonly errorKind: OratsError | null;
  readonly providerTradeDate: string | null;
  readonly asOf: number | null;
  readonly payloadState: 'VALID_DATA' | 'EMPTY_VALID' | 'ERROR' | 'NEVER_CALLED';
}

export interface OratsEndpointHealth extends EndpointOutcome {
  readonly endpoint: OratsEndpoint;
  readonly ok: boolean | null;
  readonly errorMessage: string | null;
  readonly receivedAtMs: number | null;
  readonly latencyMs: number | null;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  readonly circuitOpenedAtMs: number | null;
  readonly nextRetryAtMs: number | null;
  readonly openCycles: number;
  readonly halfOpenProbeInFlight: boolean;
}

export type OratsEndpoints = Readonly<Record<OratsEndpoint, OratsEndpointHealth>>;
export interface OratsMetadata {
  readonly healthStatus?: OratsHealthStatus;
  readonly dataProvenance?: 'LIVE' | 'LIVE_PARTIAL' | 'STALE_CACHE' | 'UNAVAILABLE';
  readonly endpoints?: OratsEndpoints;
  readonly providerTradeDate?: string | null;
  readonly tradeDateVerified?: boolean;
  readonly providerUpdatedAtUtcSec?: number | null;
  readonly receivedAtUtcSec?: number;
  readonly cachedAtUtcSec?: number;
  readonly cacheAgeMs?: number;
  readonly stale?: boolean;
  readonly surfaceCompleteness?: 'COMPLETE' | 'EMPTY_STRIKES_VALID' | 'INCOMPLETE_STRIKES_ERROR' | 'UNVERIFIED_DATE' | 'STALE_CACHE_SERVED' | 'UNAVAILABLE';
}

export function parseOratsTradeDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day || month > 12) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0) ? value : null;
}

export function parseOratsUpdatedAtUtcSec(value: unknown): number | null {
  if (typeof value !== 'string' || !parseOratsTradeDate(value.slice(0, 10)) || !/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function extractStrictOratsRows(payload: unknown, valid: (row: Record<string, unknown>) => boolean) {
  const object = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item);
  if (object(payload) && ('error' in payload || 'errors' in payload)) return null;
  const raw: unknown = Array.isArray(payload) ? payload : object(payload) ? ('data' in payload ? payload['data'] : [payload]) : null;
  if (!Array.isArray(raw)) return null;
  const rows = raw.filter(object).filter(valid);
  return raw.length > 0 && rows.length === 0 ? null : rows;
}

export function createEndpointHealth(endpoint: OratsEndpoint): OratsEndpointHealth {
  return { endpoint, httpStatus: null, ok: null, errorKind: null, errorMessage: null, payloadState: 'NEVER_CALLED',
    providerTradeDate: null, asOf: null, receivedAtMs: null, latencyMs: null, consecutiveFailures: 0,
    lastSuccessAt: null, lastFailureAt: null, circuitState: 'CLOSED', circuitOpenedAtMs: null, nextRetryAtMs: null,
    openCycles: 0, halfOpenProbeInFlight: false };
}

export function evaluateEndpointCircuitBeforeCall(state: OratsEndpointHealth, nowMs: number) {
  if (state.halfOpenProbeInFlight) return { state, blocked: 'HALF_OPEN_PROBE_BUSY' as const };
  if (state.circuitState === 'OPEN') {
    if (state.nextRetryAtMs !== null && nowMs < state.nextRetryAtMs) return { state, blocked: 'CIRCUIT_OPEN' as const };
    return { state: { ...state, circuitState: 'HALF_OPEN' as const, halfOpenProbeInFlight: true }, blocked: null };
  }
  return { state, blocked: null };
}

export function recordEndpointOutcome(state: OratsEndpointHealth, outcome: EndpointOutcome, started: number, now: number, jitterUnit = 0): OratsEndpointHealth {
  const { errorKind, httpStatus } = outcome;
  const ok = errorKind === null;
  const counts = ![400, 404, 422].includes(httpStatus ?? 0);
  const failures = ok ? 0 : state.consecutiveFailures + Number(counts);
  const open = !ok && (state.halfOpenProbeInFlight || failures >= ORATS_CB_FAILURE_THRESHOLD);
  const cycles = open ? state.openCycles + 1 : 0;
  const backoff = ORATS_CB_BASE_COOLDOWN_MS * 2 ** (cycles - 1) * (1 + 0.2 * Math.min(1, Math.max(0, jitterUnit)));
  const cooldown = Math.min(ORATS_CB_MAX_COOLDOWN_MS, Math.max(errorKind === 'HTTP_429' ? ORATS_CB_HTTP_429_MIN_COOLDOWN_MS : 0, Math.round(backoff)));
  const cause = errorKind?.startsWith('HTTP_') ? `HTTP_${String(httpStatus)}` : errorKind;
  return { ...state, ...outcome, ok, errorMessage: ok ? null : `ORATS_${state.endpoint.toUpperCase()}_${String(cause)}`,
    receivedAtMs: now, latencyMs: Math.max(0, now - started), lastSuccessAt: ok ? now : state.lastSuccessAt,
    lastFailureAt: ok ? state.lastFailureAt : now, consecutiveFailures: failures, circuitState: open ? 'OPEN' : 'CLOSED',
    circuitOpenedAtMs: open ? now : null, nextRetryAtMs: open ? now + cooldown : null, openCycles: cycles, halfOpenProbeInFlight: false };
}

export function aggregateOratsGlobalHealth(endpoints: OratsEndpoints, stale: boolean): OratsHealthStatus {
  const all = Object.values(endpoints);
  if (all.some(e => e.halfOpenProbeInFlight)) return 'RECOVERING';
  if (all.some(e => e.ok === false)) return stale ? 'STALE_CACHE' : all.some(e => e.ok) ? 'PARTIAL_FAILURE' : 'UNAVAILABLE';
  return all.some(e => e.ok) ? 'OPERATIONAL' : 'UNAVAILABLE';
}
