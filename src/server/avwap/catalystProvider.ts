import { normalizeOratsVolToDecimal } from '../../core/options/zeroDteFixes.js';
import { getMarketParts, sessionKey } from '../../core/sessions.js';
import type { AvwapDegradationFlag } from '../../core/avwap/types.js';
import type { Bar } from '../../core/types.js';
import type { FetchFn, FetchResponse } from '../../data/types.js';
import { redactSecrets } from '../runtimeCache.js';

export type OratsKeySlotId = 'ORATS_KEY_1' | 'ORATS_KEY_2';

export interface CatalystHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}

export type CatalystHttpFn = (
  url: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  },
) => Promise<CatalystHttpResponse>;

export interface InstitutionalCatalystProviderDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** Only keys #1/#2 are permitted; any key #3 is hard-excluded. */
  readonly oratsApiKeys?: readonly string[];
  readonly excludedOratsKeys?: readonly string[];
  readonly oratsBaseUrl?: string;
  readonly oratsFetchFn?: CatalystHttpFn;
  readonly stocksMassiveFetchFn?: FetchFn;
  readonly optionsMassiveFetchFn?: FetchFn;
  readonly massiveBaseUrl?: string;
  readonly fmpApiKey?: string | null;
  readonly fmpBaseUrl?: string;
  readonly fmpFetchFn?: CatalystHttpFn;
  readonly nowMsFn?: () => number;
  readonly secrets?: readonly string[];
  readonly eodTtlMs?: number;
  readonly globalTtlMs?: number;
  readonly liveOratsTtlMs?: number;
}

export interface NormalizedOratsCoresRow {
  readonly ticker: string;
  readonly tradeDate: string | null;
  readonly orIvXern20dDec: number;
  readonly iv30dDec: number;
  readonly orHv5dDec: number;
  readonly impErnMvDec: number;
  readonly contango: number;
  readonly slope: number;
  readonly ivPct1y: number;
  readonly ivRank1y: number;
  readonly blockedReferencePriceFields: readonly ('stockPrice' | 'pxAtmIv')[];
}

export interface NormalizedOratsSummaryRow {
  readonly ticker: string;
  readonly tradeDate: string | null;
  readonly impliedEarningsMoveDec: number;
  readonly iv30dDec: number;
  readonly exErnIv30dDec: number;
  readonly riskFree30Dec: number;
  readonly contango: number;
  readonly slope: number;
  readonly blockedReferencePriceFields: readonly ('stockPrice' | 'pxAtmIv')[];
}

export interface NormalizedOratsStrikeOiRow {
  readonly strike: number;
  readonly expirDate: string;
  readonly dte: number;
  readonly callOpenInterest: number;
  readonly putOpenInterest: number;
  readonly delta: number;
  readonly gamma: number;
  readonly smvVolDec: number;
}

export type EarningsTimingLabel = 'BMO' | 'AMC' | 'UNKNOWN';
export type EarningsTimingSource = 'ORATS_ANNC_TOD' | 'MASSIVE_ETH_INFERRED' | 'UNKNOWN';

export interface ReconciledEarningsEvent {
  readonly reportDate: string;
  readonly timing: EarningsTimingLabel;
  readonly timingSource: EarningsTimingSource;
  readonly realizedReturn: number | null;
  readonly impliedEarningsMoveDec: number | null;
  readonly ratioToImplied: number | null;
  readonly classification:
    | 'EARNINGS_BLOWOUT'
    | 'EARNINGS_INLINE'
    | 'NEUTRAL_ZONE'
    | 'UNCLASSIFIED';
}

export interface RawSplitCandidate {
  readonly effectiveDate: string;
  readonly splitFrom: number;
  readonly splitTo: number;
}

export interface RawDividendCandidate {
  readonly exDate: string;
  readonly cashAmount: number;
  readonly dividendType?: string;
}

export interface ReconciledSplitAction {
  readonly effectiveDate: string;
  readonly splitFrom: number;
  readonly splitTo: number;
  readonly safeToApply: boolean;
  readonly quarantined: boolean;
  readonly quarantineReason: string | null;
}

export interface ReconciledDividendAction {
  readonly exDate: string;
  readonly cashAmount: number;
  readonly prevClose: number | null;
  readonly isSpecialCandidate: boolean;
  readonly safeToApply: boolean;
  readonly quarantined: boolean;
  readonly quarantineReason: string | null;
}

export interface CorporateActionsReconciliation {
  readonly splits: readonly ReconciledSplitAction[];
  readonly dividends: readonly ReconciledDividendAction[];
  readonly conflictQuarantined: boolean;
}

export interface OiReconciliationResult {
  readonly effectiveTotalOi: number | null;
  readonly oratsTotalOiRaw: number;
  readonly massiveTotalOiRaw: number | null;
  readonly source: 'ORATS' | 'MASSIVE_FALLBACK' | 'UNAVAILABLE';
  readonly usedMassiveFallback: boolean;
}

export interface GlobalCatalystCalendars {
  readonly sp500Symbols: ReadonlySet<string>;
  readonly nasdaqSymbols: ReadonlySet<string>;
  readonly macroEvents: readonly Record<string, unknown>[];
  readonly fetchedAtMs: number;
}

export interface WhamSnapshot {
  readonly supported: boolean;
  readonly status: 'OK' | 'UNSUPPORTED_INSTRUMENT' | 'UNAVAILABLE';
  readonly rows: readonly Record<string, unknown>[];
}

export interface SymbolCatalystBundle {
  readonly symbol: string;
  readonly fetchedAtMs: number;
  readonly tradeDateEt: string;
  readonly oratsCovered: boolean;
  readonly cores: NormalizedOratsCoresRow | null;
  readonly summary: NormalizedOratsSummaryRow | null;
  readonly strikes: readonly NormalizedOratsStrikeOiRow[];
  readonly oiReconciliation: OiReconciliationResult;
  readonly earnings: readonly ReconciledEarningsEvent[];
  readonly corporateActions: CorporateActionsReconciliation;
  readonly wham: WhamSnapshot;
  readonly globalCalendars: GlobalCatalystCalendars | null;
  readonly nonPitFloatShares: number | null;
  readonly degradationFlags: readonly AvwapDegradationFlag[];
  readonly providerWarnings: readonly string[];
}

export const WHAM_SUPPORTED_ETFS: ReadonlySet<string> = new Set(['SPY', 'QQQ', 'IWM']);
export const DEFAULT_EOD_TTL_MS = 6 * 3_600 * 1_000;
export const DEFAULT_GLOBAL_TTL_MS = 12 * 3_600 * 1_000;
export const DEFAULT_LIVE_ORATS_TTL_MS = 90_000;

const ALLOWED_ORATS_ENV_NAMES = [
  'ORATS_API_KEY',
  'ORATS_API_KEY_1',
  'ORATS_KEY_1',
  'ORATS_API_KEY_2',
  'ORATS_KEY_2',
] as const;

const EXCLUDED_ORATS_KEY_3_ENV_NAMES = ['ORATS_API_KEY_3', 'ORATS_KEY_3'] as const;
const BLOCKED_ORATS_REF_FIELDS = ['stockPrice', 'pxAtmIv'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNum(row: Record<string, unknown>, key: string): number {
  const raw = row[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function readStr(row: Record<string, unknown>, key: string): string | null {
  const raw = row[key];
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractRowsArray(raw: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter(isRecord);
  }
  if (isRecord(raw) && Array.isArray(raw['data'])) {
    return raw['data'].filter(isRecord);
  }
  return [];
}

function collectBlockedRefFields(row: Record<string, unknown>): readonly ('stockPrice' | 'pxAtmIv')[] {
  const blocked: ('stockPrice' | 'pxAtmIv')[] = [];
  for (const field of BLOCKED_ORATS_REF_FIELDS) {
    if (field in row && row[field] !== undefined && row[field] !== null) {
      blocked.push(field);
    }
  }
  return blocked;
}

/**
 * Enforces hard ban on `/live/cores` (HTTP 403 in active tier).
 */
export function assertOratsUrlAllowed(url: string): void {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  if (/\/live\/cores(?:\/|$)/i.test(pathname)) {
    throw new Error('ORATS_FORBIDDEN_ENDPOINT:/live/cores is permanently disabled (HTTP 403)');
  }
}

/**
 * Resolves permitted ORATS keys (#1/#2), strictly excluding Key #3 (`ORATS_API_KEY_3` / `ORATS_KEY_3`).
 */
export function resolveAllowedOratsKeys(
  env: NodeJS.ProcessEnv,
  explicitKeys?: readonly string[],
  explicitExcluded?: readonly string[],
): { readonly allowedKeys: readonly string[]; readonly key3ValuesForRedaction: readonly string[] } {
  const forbiddenSet = new Set<string>();
  for (const envName of EXCLUDED_ORATS_KEY_3_ENV_NAMES) {
    const v = env[envName]?.trim();
    if (v !== undefined && v.length > 0) {
      forbiddenSet.add(v);
    }
  }
  for (const ex of explicitExcluded ?? []) {
    const v = ex.trim();
    if (v.length > 0) {
      forbiddenSet.add(v);
    }
  }

  const candidates: string[] = [];
  if (explicitKeys !== undefined) {
    candidates.push(...explicitKeys);
  } else {
    for (const envName of ALLOWED_ORATS_ENV_NAMES) {
      const v = env[envName]?.trim();
      if (v !== undefined && v.length > 0) {
        candidates.push(v);
      }
    }
  }

  const seen = new Set<string>();
  const allowedKeys: string[] = [];
  for (const raw of candidates) {
    const k = raw.trim();
    if (k.length === 0 || forbiddenSet.has(k) || seen.has(k)) {
      continue;
    }
    seen.add(k);
    allowedKeys.push(k);
  }

  return {
    allowedKeys,
    key3ValuesForRedaction: [...forbiddenSet],
  };
}

/**
 * Field-by-field ORATS `/datav2/cores` normalizer:
 * - Converts % -> decimal explicitly on `orIvXern20d`, `iv30d`, `orHv5d`, and `impErnMv`.
 * - Preserves `contango`, `slope`, `ivPct1y`, `ivRank1y` in their original raw scale.
 * - Strictly blocks `stockPrice` and `pxAtmIv` (Massive/Tradier remain price authority).
 */
export function normalizeOratsCoresRow(raw: Record<string, unknown>): NormalizedOratsCoresRow | null {
  const ticker = (readStr(raw, 'ticker') ?? '').toUpperCase();
  if (ticker === '') {
    return null;
  }
  const impErnMvRaw = readNum(raw, 'impErnMv');
  const impErnMvDec = !Number.isFinite(impErnMvRaw) || impErnMvRaw < 0
    ? Number.NaN
    : impErnMvRaw > 1.0
      ? impErnMvRaw / 100
      : impErnMvRaw;

  return {
    ticker,
    tradeDate: readStr(raw, 'tradeDate'),
    orIvXern20dDec: normalizeOratsVolToDecimal(readNum(raw, 'orIvXern20d')),
    iv30dDec: normalizeOratsVolToDecimal(readNum(raw, 'iv30d')),
    orHv5dDec: normalizeOratsVolToDecimal(readNum(raw, 'orHv5d')),
    impErnMvDec,
    contango: readNum(raw, 'contango'),
    slope: readNum(raw, 'slope'),
    ivPct1y: readNum(raw, 'ivPct1y'),
    ivRank1y: readNum(raw, 'ivRank1y'),
    blockedReferencePriceFields: collectBlockedRefFields(raw),
  };
}

/**
 * Field-by-field ORATS `/live/summaries` or `/hist/summaries` normalizer.
 * Keeps `impliedEarningsMove`, `iv30d`, `exErnIv30d`, `riskFree30` as decimal while leaving
 * `contango` and `slope` in native scale and blocking `stockPrice`/`pxAtmIv`.
 */
export function normalizeOratsSummaryRow(raw: Record<string, unknown>): NormalizedOratsSummaryRow | null {
  const ticker = (readStr(raw, 'ticker') ?? '').toUpperCase();
  if (ticker === '') {
    return null;
  }
  return {
    ticker,
    tradeDate: readStr(raw, 'tradeDate'),
    impliedEarningsMoveDec: normalizeOratsVolToDecimal(readNum(raw, 'impliedEarningsMove')),
    iv30dDec: normalizeOratsVolToDecimal(readNum(raw, 'iv30d')),
    exErnIv30dDec: normalizeOratsVolToDecimal(readNum(raw, 'exErnIv30d')),
    riskFree30Dec: readNum(raw, 'riskFree30'),
    contango: readNum(raw, 'contango'),
    slope: readNum(raw, 'slope'),
    blockedReferencePriceFields: collectBlockedRefFields(raw),
  };
}

/**
 * Strictly extracts ONLY isolated 1-day `impliedEarningsMove` from ORATS summaries.
 * NEVER falls back or fuses multi-day `cores.impErnMv`.
 */
export function resolveEarningsImpliedMoveDec(
  summary: Pick<NormalizedOratsSummaryRow, 'impliedEarningsMoveDec'> | null | undefined,
): number | null {
  if (summary === null || summary === undefined) {
    return null;
  }
  const val = summary.impliedEarningsMoveDec;
  return Number.isFinite(val) && val > 0 ? val : null;
}

export function classifyEarningsReaction(
  realizedReturn: number | null,
  impliedEarningsMoveDec: number | null,
): ReconciledEarningsEvent['classification'] {
  if (
    realizedReturn === null ||
    !Number.isFinite(realizedReturn) ||
    impliedEarningsMoveDec === null ||
    !Number.isFinite(impliedEarningsMoveDec) ||
    impliedEarningsMoveDec <= 0
  ) {
    return 'UNCLASSIFIED';
  }
  const ratio = Math.abs(realizedReturn) / impliedEarningsMoveDec;
  if (ratio >= 1.25) {
    return 'EARNINGS_BLOWOUT';
  }
  if (ratio < 0.75) {
    return 'EARNINGS_INLINE';
  }
  return 'NEUTRAL_ZONE';
}

/**
 * Causal BMO/AMC resolution cascade:
 * 1. ORATS `anncTod` (`0900`/`BMO` -> `BMO`, `1630`/`AMC` -> `AMC`).
 * 2. Causal ETH volume/return shock over 1m bars on `eventDateEt`.
 * 3. `UNKNOWN` (never trust retrospective FMP `time`).
 */
export function resolveEarningsTimingCascade(params: {
  readonly oratsAnncTod?: string | null;
  readonly ethBars1m?: readonly Bar[];
  readonly eventDateEt: string;
}): { readonly timing: EarningsTimingLabel; readonly source: EarningsTimingSource } {
  const todRaw = (params.oratsAnncTod ?? '').trim().toUpperCase();
  if (todRaw !== '') {
    if (
      todRaw === 'BMO' ||
      todRaw === 'BEFORE_OPEN' ||
      todRaw === 'PRE' ||
      todRaw.startsWith('08') ||
      todRaw.startsWith('09') ||
      todRaw.startsWith('07')
    ) {
      return { timing: 'BMO', source: 'ORATS_ANNC_TOD' };
    }
    if (
      todRaw === 'AMC' ||
      todRaw === 'AFTER_CLOSE' ||
      todRaw === 'POST' ||
      todRaw.startsWith('16') ||
      todRaw.startsWith('17') ||
      todRaw.startsWith('18') ||
      todRaw.startsWith('19') ||
      todRaw.startsWith('20')
    ) {
      return { timing: 'AMC', source: 'ORATS_ANNC_TOD' };
    }
  }

  let preMarketVol = 0;
  let afterHoursVol = 0;
  let preFirst = Number.NaN;
  let preLast = Number.NaN;
  let postFirst = Number.NaN;
  let postLast = Number.NaN;

  for (const bar of params.ethBars1m ?? []) {
    if (!Number.isSafeInteger(bar.time) || bar.time <= 0) {
      continue;
    }
    const parts = getMarketParts(bar.time, 'EQUITY');
    if (parts.dateKey !== params.eventDateEt) {
      continue;
    }
    const vol = Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : 0;
    if (parts.minutesOfDay >= 4 * 60 && parts.minutesOfDay < 9 * 60 + 30) {
      preMarketVol += vol;
      if (!Number.isFinite(preFirst)) preFirst = bar.open;
      preLast = bar.close;
    } else if (parts.minutesOfDay >= 16 * 60 && parts.minutesOfDay < 20 * 60) {
      afterHoursVol += vol;
      if (!Number.isFinite(postFirst)) postFirst = bar.open;
      postLast = bar.close;
    }
  }

  const preAbsMove =
    Number.isFinite(preFirst) && preFirst > 0 && Number.isFinite(preLast)
      ? Math.abs(preLast - preFirst) / preFirst
      : 0;
  const postAbsMove =
    Number.isFinite(postFirst) && postFirst > 0 && Number.isFinite(postLast)
      ? Math.abs(postLast - postFirst) / postFirst
      : 0;

  if (preMarketVol > 0 || afterHoursVol > 0) {
    if (afterHoursVol > preMarketVol * 1.5 || (postAbsMove >= 0.02 && postAbsMove > preAbsMove * 1.5)) {
      return { timing: 'AMC', source: 'MASSIVE_ETH_INFERRED' };
    }
    if (preMarketVol > afterHoursVol * 1.5 || (preAbsMove >= 0.02 && preAbsMove > postAbsMove * 1.5)) {
      return { timing: 'BMO', source: 'MASSIVE_ETH_INFERRED' };
    }
  }

  return { timing: 'UNKNOWN', source: 'UNKNOWN' };
}

/**
 * Cross-checks Massive and FMP splits & special dividends (>= 1.5%).
 * Discrepancies quarantine the event (`safeToApply: false`) rather than corrupting AWVAP history.
 */
export function reconcileCorporateActions(params: {
  readonly massiveSplits: readonly RawSplitCandidate[];
  readonly fmpSplits: readonly RawSplitCandidate[];
  readonly massiveDividends: readonly RawDividendCandidate[];
  readonly fmpDividends: readonly RawDividendCandidate[];
  readonly prevCloseByDate?: ReadonlyMap<string, number>;
  readonly minSpecialDivPct?: number;
}): CorporateActionsReconciliation {
  const minSpecialPct = params.minSpecialDivPct ?? 0.015;
  let conflictQuarantined = false;

  const massiveSplitMap = new Map<string, RawSplitCandidate>();
  for (const sp of params.massiveSplits) {
    massiveSplitMap.set(sp.effectiveDate, sp);
  }
  const fmpSplitMap = new Map<string, RawSplitCandidate>();
  for (const sp of params.fmpSplits) {
    fmpSplitMap.set(sp.effectiveDate, sp);
  }
  const allSplitDates = [...new Set([...massiveSplitMap.keys(), ...fmpSplitMap.keys()])].sort();
  const splits: ReconciledSplitAction[] = [];

  for (const dt of allSplitDates) {
    const m = massiveSplitMap.get(dt);
    const f = fmpSplitMap.get(dt);
    if (m !== undefined && f !== undefined) {
      const km = m.splitFrom / m.splitTo;
      const kf = f.splitFrom / f.splitTo;
      const relDiff = Math.abs(km - kf) / Math.max(1e-12, Math.abs(km));
      if (relDiff > 1e-6) {
        conflictQuarantined = true;
        splits.push({
          effectiveDate: dt,
          splitFrom: m.splitFrom,
          splitTo: m.splitTo,
          safeToApply: false,
          quarantined: true,
          quarantineReason: `SPLIT_RATIO_MISMATCH:massive=${String(km)}:fmp=${String(kf)}`,
        });
      } else {
        splits.push({
          effectiveDate: dt,
          splitFrom: m.splitFrom,
          splitTo: m.splitTo,
          safeToApply: true,
          quarantined: false,
          quarantineReason: null,
        });
      }
    } else {
      const single = m ?? f;
      if (single !== undefined) {
        splits.push({
          effectiveDate: dt,
          splitFrom: single.splitFrom,
          splitTo: single.splitTo,
          safeToApply: true,
          quarantined: false,
          quarantineReason: null,
        });
      }
    }
  }

  const massiveDivMap = new Map<string, RawDividendCandidate>();
  for (const dv of params.massiveDividends) {
    massiveDivMap.set(dv.exDate, dv);
  }
  const fmpDivMap = new Map<string, RawDividendCandidate>();
  for (const dv of params.fmpDividends) {
    fmpDivMap.set(dv.exDate, dv);
  }
  const allDivDates = [...new Set([...massiveDivMap.keys(), ...fmpDivMap.keys()])].sort();
  const dividends: ReconciledDividendAction[] = [];

  for (const exDate of allDivDates) {
    const m = massiveDivMap.get(exDate);
    const f = fmpDivMap.get(exDate);
    const prevClose = params.prevCloseByDate?.get(exDate) ?? null;

    if (m !== undefined && f !== undefined) {
      const maxCash = Math.max(Math.abs(m.cashAmount), Math.abs(f.cashAmount), 1e-12);
      const relDiff = Math.abs(m.cashAmount - f.cashAmount) / maxCash;
      const pctOfClose =
        prevClose !== null && Number.isFinite(prevClose) && prevClose > 0
          ? m.cashAmount / prevClose
          : null;
      const isSpecialCandidate =
        (pctOfClose !== null && pctOfClose >= minSpecialPct) ||
        m.dividendType?.toLowerCase().includes('special') === true;

      if (relDiff > 1e-3 && (isSpecialCandidate || Math.abs(m.cashAmount - f.cashAmount) >= 0.05)) {
        conflictQuarantined = true;
        dividends.push({
          exDate,
          cashAmount: m.cashAmount,
          prevClose,
          isSpecialCandidate,
          safeToApply: false,
          quarantined: true,
          quarantineReason: `DIVIDEND_CASH_MISMATCH:massive=${String(m.cashAmount)}:fmp=${String(f.cashAmount)}`,
        });
        continue;
      }

      dividends.push({
        exDate,
        cashAmount: m.cashAmount,
        prevClose,
        isSpecialCandidate,
        safeToApply: true,
        quarantined: false,
        quarantineReason: null,
      });
    } else {
      const single = m ?? f;
      if (single !== undefined) {
        const pctOfClose =
          prevClose !== null && Number.isFinite(prevClose) && prevClose > 0
            ? single.cashAmount / prevClose
            : null;
        const isSpecialCandidate =
          (pctOfClose !== null && pctOfClose >= minSpecialPct) ||
          single.dividendType?.toLowerCase().includes('special') === true;
        dividends.push({
          exDate,
          cashAmount: single.cashAmount,
          prevClose,
          isSpecialCandidate,
          safeToApply: true,
          quarantined: false,
          quarantineReason: null,
        });
      }
    }
  }

  return { splits, dividends, conflictQuarantined };
}

async function defaultHttpFn(
  url: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  },
): Promise<CatalystHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, init?.timeoutMs ?? 10_000);
  try {
    const reqInit: RequestInit = {
      method: init?.method ?? 'GET',
      signal: controller.signal,
    };
    if (init?.headers !== undefined) {
      reqInit.headers = init.headers;
    }
    const resp = await fetch(url, reqInit);
    const textBody = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      text: () => Promise.resolve(textBody),
      json: () => Promise.resolve(JSON.parse(textBody) as unknown),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultMassiveFetch(url: string): Promise<FetchResponse> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return {
    ok: resp.ok,
    status: resp.status,
    text: await resp.text(),
    headers: Object.fromEntries(resp.headers.entries()),
  };
}

interface TtlCacheRecord<T> {
  readonly value: T;
  readonly fetchedAtMs: number;
  readonly expiresAtMs: number;
  readonly tradeDateEt: string;
}

/**
 * Fail-open hybrid catalyst, derivatives, and corporate-action reconciler with in-memory TTL
 * and single-flight request deduplication.
 */
export class InstitutionalCatalystProvider {
  private readonly nowMsFn: () => number;
  private readonly allowedOratsKeys: readonly string[];
  private readonly oratsBaseUrl: string;
  private readonly oratsFetchFn: CatalystHttpFn;
  private readonly stocksMassiveFetchFn: FetchFn;
  private readonly optionsMassiveFetchFn: FetchFn;
  private readonly massiveBaseUrl: string;
  private readonly fmpApiKey: string | null;
  private readonly fmpBaseUrl: string;
  private readonly fmpFetchFn: CatalystHttpFn;
  private readonly secrets: readonly string[];
  private readonly eodTtlMs: number;
  private readonly globalTtlMs: number;
  private readonly liveOratsTtlMs: number;

  private oratsCursor = 0;
  private readonly cache = new Map<string, TtlCacheRecord<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  public constructor(deps: InstitutionalCatalystProviderDeps = {}) {
    const env = deps.env ?? {};
    this.nowMsFn = deps.nowMsFn ?? ((): number => Date.now());
    const { allowedKeys, key3ValuesForRedaction } = resolveAllowedOratsKeys(
      env,
      deps.oratsApiKeys,
      deps.excludedOratsKeys,
    );
    this.allowedOratsKeys = allowedKeys;
    this.oratsBaseUrl = (deps.oratsBaseUrl ?? 'https://api.orats.io/datav2').replace(/\/+$/, '');
    this.oratsFetchFn = deps.oratsFetchFn ?? defaultHttpFn;
    this.stocksMassiveFetchFn = deps.stocksMassiveFetchFn ?? defaultMassiveFetch;
    this.optionsMassiveFetchFn = deps.optionsMassiveFetchFn ?? defaultMassiveFetch;
    this.massiveBaseUrl = (deps.massiveBaseUrl ?? 'https://api.massive.com').replace(/\/+$/, '');
    const fmpKey =
      deps.fmpApiKey !== undefined
        ? deps.fmpApiKey
        : env['FMP_API_KEY']?.trim() ?? null;
    this.fmpApiKey = fmpKey !== null && fmpKey.length > 0 ? fmpKey : null;
    this.fmpBaseUrl = (deps.fmpBaseUrl ?? 'https://financialmodelingprep.com').replace(/\/+$/, '');
    this.fmpFetchFn = deps.fmpFetchFn ?? defaultHttpFn;

    const secretSet = new Set<string>(deps.secrets ?? []);
    for (const k of this.allowedOratsKeys) secretSet.add(k);
    for (const k3 of key3ValuesForRedaction) secretSet.add(k3);
    if (this.fmpApiKey !== null) secretSet.add(this.fmpApiKey);
    this.secrets = [...secretSet];

    this.eodTtlMs = deps.eodTtlMs ?? DEFAULT_EOD_TTL_MS;
    this.globalTtlMs = deps.globalTtlMs ?? DEFAULT_GLOBAL_TTL_MS;
    this.liveOratsTtlMs = deps.liveOratsTtlMs ?? DEFAULT_LIVE_ORATS_TTL_MS;
  }

  public getAllowedOratsKeyCount(): number {
    return this.allowedOratsKeys.length;
  }

  private currentEtDate(): string {
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    if (nowSec <= 0 || !Number.isSafeInteger(nowSec)) {
      return '1970-01-01';
    }
    return sessionKey(nowSec, 'EQUITY');
  }

  private async getOrLoad<T>(
    key: string,
    ttlMs: number,
    scopeByEtDate: boolean,
    loader: () => Promise<T>,
  ): Promise<T> {
    const nowMs = this.nowMsFn();
    const tradeDateEt = this.currentEtDate();
    const cached = this.cache.get(key) as TtlCacheRecord<T> | undefined;
    if (
      cached !== undefined &&
      nowMs < cached.expiresAtMs &&
      (!scopeByEtDate || cached.tradeDateEt === tradeDateEt)
    ) {
      return cached.value;
    }

    const active = this.inFlight.get(key) as Promise<T> | undefined;
    if (active !== undefined) {
      return active;
    }

    const promise = (async (): Promise<T> => {
      const value = await loader();
      const doneMs = this.nowMsFn();
      this.cache.set(key, {
        value,
        fetchedAtMs: doneMs,
        expiresAtMs: doneMs + ttlMs,
        tradeDateEt: this.currentEtDate(),
      });
      return value;
    })();

    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key);
      }
    }
  }

  private nextOratsKey(): string | null {
    if (this.allowedOratsKeys.length === 0) {
      return null;
    }
    const idx = this.oratsCursor % this.allowedOratsKeys.length;
    this.oratsCursor += 1;
    return this.allowedOratsKeys[idx] ?? null;
  }

  private async fetchOratsJson(pathWithQuery: string): Promise<unknown> {
    const token = this.nextOratsKey();
    if (token === null) {
      throw new Error('ORATS_NO_ALLOWED_KEYS_CONFIGURED');
    }
    const baseHref = `${this.oratsBaseUrl}${pathWithQuery.startsWith('/') ? '' : '/'}${pathWithQuery}`;
    assertOratsUrlAllowed(baseHref);
    const url = new URL(baseHref);
    url.searchParams.set('token', token);
    const resp = await this.oratsFetchFn(url.href, { method: 'GET', timeoutMs: 10_000 });
    if (!resp.ok) {
      throw new Error(`ORATS_HTTP_${String(resp.status)}`);
    }
    return resp.json();
  }

  private async fetchFmpJson(pathWithQuery: string): Promise<unknown> {
    if (this.fmpApiKey === null) {
      return [];
    }
    const baseHref = `${this.fmpBaseUrl}${pathWithQuery.startsWith('/') ? '' : '/'}${pathWithQuery}`;
    const url = new URL(baseHref);
    url.searchParams.set('apikey', this.fmpApiKey);
    const resp = await this.fmpFetchFn(url.href, { method: 'GET', timeoutMs: 10_000 });
    if (!resp.ok) {
      throw new Error(`FMP_HTTP_${String(resp.status)}`);
    }
    return resp.json();
  }

  private async fetchMassiveJson(domain: 'STOCKS_REST' | 'OPTIONS_REST', pathWithQuery: string): Promise<unknown> {
    const baseHref = `${this.massiveBaseUrl}${pathWithQuery.startsWith('/') ? '' : '/'}${pathWithQuery}`;
    const fetchFn = domain === 'OPTIONS_REST' ? this.optionsMassiveFetchFn : this.stocksMassiveFetchFn;
    const resp = await fetchFn(baseHref);
    if (!resp.ok) {
      throw new Error(`MASSIVE_${domain}_HTTP_${String(resp.status)}`);
    }
    return JSON.parse(resp.text) as unknown;
  }

  public async fetchGlobalCalendars(): Promise<GlobalCatalystCalendars> {
    return this.getOrLoad('global:calendars', this.globalTtlMs, false, async () => {
      const [spRes, ndxRes, econRes] = await Promise.allSettled([
        this.fetchFmpJson('/stable/sp500-constituent'),
        this.fetchFmpJson('/stable/nasdaq-constituent'),
        this.fetchFmpJson('/stable/economic-calendar'),
      ]);

      const extractSymSet = (res: PromiseSettledResult<unknown>): ReadonlySet<string> => {
        if (res.status !== 'fulfilled') {
          return new Set();
        }
        const out = new Set<string>();
        for (const row of extractRowsArray(res.value)) {
          const sym = readStr(row, 'symbol')?.toUpperCase();
          if (sym !== undefined) {
            out.add(sym);
          }
        }
        return out;
      };

      const macroEvents =
        econRes.status === 'fulfilled' ? extractRowsArray(econRes.value) : [];

      return {
        sp500Symbols: extractSymSet(spRes),
        nasdaqSymbols: extractSymSet(ndxRes),
        macroEvents,
        fetchedAtMs: this.nowMsFn(),
      };
    });
  }

  public async reconcileOpenInterest(
    ticker: string,
    oratsStrikes: readonly NormalizedOratsStrikeOiRow[],
  ): Promise<OiReconciliationResult> {
    let oratsTotalOi = 0;
    for (const row of oratsStrikes) {
      if (Number.isFinite(row.callOpenInterest) && row.callOpenInterest > 0) {
        oratsTotalOi += row.callOpenInterest;
      }
      if (Number.isFinite(row.putOpenInterest) && row.putOpenInterest > 0) {
        oratsTotalOi += row.putOpenInterest;
      }
    }
    if (oratsTotalOi > 0) {
      return {
        effectiveTotalOi: oratsTotalOi,
        oratsTotalOiRaw: oratsTotalOi,
        massiveTotalOiRaw: null,
        source: 'ORATS',
        usedMassiveFallback: false,
      };
    }

    try {
      const raw = await this.getOrLoad(
        `massive:options_oi:${ticker}`,
        this.liveOratsTtlMs,
        false,
        () =>
          this.fetchMassiveJson(
            'OPTIONS_REST',
            `/options/v1/open-interest/underlying/${encodeURIComponent(ticker)}`,
          ),
      );
      let massiveTotalOi = 0;
      if (isRecord(raw)) {
        const direct = readNum(raw, 'total_oi');
        if (Number.isFinite(direct) && direct > 0) {
          massiveTotalOi = direct;
        } else if (isRecord(raw['results'])) {
          const nested = readNum(raw['results'], 'total_open_interest');
          if (Number.isFinite(nested) && nested > 0) {
            massiveTotalOi = nested;
          }
        } else {
          for (const row of extractRowsArray(raw['results'] ?? raw)) {
            const oi = readNum(row, 'open_interest');
            if (Number.isFinite(oi) && oi > 0) {
              massiveTotalOi += oi;
            }
          }
        }
      }
      if (massiveTotalOi > 0) {
        return {
          effectiveTotalOi: massiveTotalOi,
          oratsTotalOiRaw: 0,
          massiveTotalOiRaw: massiveTotalOi,
          source: 'MASSIVE_FALLBACK',
          usedMassiveFallback: true,
        };
      }
    } catch {
      // Fail-open when Massive OPTIONS_REST is unavailable
    }

    return {
      effectiveTotalOi: null,
      oratsTotalOiRaw: oratsTotalOi,
      massiveTotalOiRaw: null,
      source: 'UNAVAILABLE',
      usedMassiveFallback: false,
    };
  }

  public async fetchSymbolCatalystBundle(
    rawSymbol: string,
    options?: {
      readonly ethBars1m?: readonly Bar[];
      readonly realizedReturnByDate?: ReadonlyMap<string, number>;
      readonly prevCloseByDate?: ReadonlyMap<string, number>;
      readonly isEtf?: boolean;
      readonly usesNoNbboFlow?: boolean;
    },
  ): Promise<SymbolCatalystBundle> {
    const symbol = rawSymbol.trim().toUpperCase();
    const fetchedAtMs = this.nowMsFn();
    const tradeDateEt = this.currentEtDate();
    const flags = new Set<AvwapDegradationFlag>(['NO_NOI_IMBALANCE_FEED']);
    const warnings: string[] = [];

    if (options?.usesNoNbboFlow === true) {
      flags.add('NO_NBBO_AGGRESSOR_SIDE');
    }

    const [
      summaryRes,
      strikesRes,
      coresRes,
      oratsEarnRes,
      fmpEarnRes,
      mSplitsRes,
      fSplitsRes,
      mDivsRes,
      fDivsRes,
      floatRes,
      whamRes,
      globalRes,
    ] = await Promise.allSettled([
      this.getOrLoad(`orats:live_summary:${symbol}`, this.liveOratsTtlMs, false, () =>
        this.fetchOratsJson(`/live/summaries?ticker=${encodeURIComponent(symbol)}`),
      ),
      this.getOrLoad(`orats:live_strikes:${symbol}`, this.liveOratsTtlMs, false, () =>
        this.fetchOratsJson(`/live/strikes?ticker=${encodeURIComponent(symbol)}`),
      ),
      this.getOrLoad(`orats:eod_cores:${symbol}`, this.eodTtlMs, true, () =>
        this.fetchOratsJson(`/cores?ticker=${encodeURIComponent(symbol)}`),
      ),
      this.getOrLoad(`orats:hist_earnings:${symbol}`, this.eodTtlMs, true, () =>
        this.fetchOratsJson(`/hist/earnings?ticker=${encodeURIComponent(symbol)}`),
      ),
      this.getOrLoad(`fmp:earnings:${symbol}`, this.eodTtlMs, true, () =>
        this.fetchFmpJson(`/stable/earnings?symbol=${encodeURIComponent(symbol)}`),
      ),
      this.getOrLoad(`massive:splits:${symbol}`, this.eodTtlMs, true, () =>
        this.fetchMassiveJson('STOCKS_REST', `/stocks/v1/splits?ticker=${encodeURIComponent(symbol)}`),
      ),
      this.getOrLoad(`fmp:splits:${symbol}`, this.eodTtlMs, true, () =>
        this.fetchFmpJson(`/stable/splits?symbol=${encodeURIComponent(symbol)}`),
      ),
      this.getOrLoad(`massive:dividends:${symbol}`, this.eodTtlMs, true, () =>
        this.fetchMassiveJson('STOCKS_REST', `/stocks/v1/dividends?ticker=${encodeURIComponent(symbol)}`),
      ),
      this.getOrLoad(`fmp:dividends:${symbol}`, this.eodTtlMs, true, () =>
        this.fetchFmpJson(`/stable/dividends?symbol=${encodeURIComponent(symbol)}`),
      ),
      this.getOrLoad(`massive:float:${symbol}`, this.eodTtlMs, true, () =>
        this.fetchMassiveJson('STOCKS_REST', `/stocks/vX/float?ticker=${encodeURIComponent(symbol)}`),
      ),
      WHAM_SUPPORTED_ETFS.has(symbol)
        ? this.getOrLoad(`orats:wham:${symbol}`, this.liveOratsTtlMs, false, () =>
            this.fetchOratsJson(`/hist/wham?ticker=${encodeURIComponent(symbol)}`),
          )
        : Promise.resolve(null),
      this.fetchGlobalCalendars(),
    ]);

    const recordWarning = (label: string, res: PromiseSettledResult<unknown>): void => {
      if (res.status === 'rejected') {
        const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
        warnings.push(redactSecrets(`${label}:${msg}`, this.secrets));
      }
    };
    recordWarning('orats_summary', summaryRes);
    recordWarning('orats_strikes', strikesRes);
    recordWarning('orats_cores', coresRes);
    recordWarning('orats_earnings', oratsEarnRes);
    recordWarning('fmp_earnings', fmpEarnRes);
    recordWarning('massive_splits', mSplitsRes);
    recordWarning('fmp_splits', fSplitsRes);
    recordWarning('massive_dividends', mDivsRes);
    recordWarning('fmp_dividends', fDivsRes);
    recordWarning('massive_float', floatRes);
    recordWarning('orats_wham', whamRes);

    const summaryRows =
      summaryRes.status === 'fulfilled' ? extractRowsArray(summaryRes.value) : [];
    const summary =
      summaryRows[0] !== undefined ? normalizeOratsSummaryRow(summaryRows[0]) : null;

    const coresRows =
      coresRes.status === 'fulfilled' ? extractRowsArray(coresRes.value) : [];
    const cores =
      coresRows[0] !== undefined ? normalizeOratsCoresRow(coresRows[0]) : null;

    const strikeRowsRaw =
      strikesRes.status === 'fulfilled' ? extractRowsArray(strikesRes.value) : [];
    const strikes: NormalizedOratsStrikeOiRow[] = [];
    for (const row of strikeRowsRaw) {
      const strike = readNum(row, 'strike');
      const expirDate = readStr(row, 'expirDate');
      const dte = readNum(row, 'dte');
      if (!Number.isFinite(strike) || strike <= 0 || expirDate === null || !Number.isFinite(dte)) {
        continue;
      }
      strikes.push({
        strike,
        expirDate,
        dte,
        callOpenInterest: Math.max(0, readNum(row, 'cOi') || 0),
        putOpenInterest: Math.max(0, readNum(row, 'pOi') || 0),
        delta: readNum(row, 'delta'),
        gamma: readNum(row, 'gamma'),
        smvVolDec: normalizeOratsVolToDecimal(readNum(row, 'smvVol')),
      });
    }

    const oratsCovered = summary !== null || cores !== null || strikes.length > 0;
    if (!oratsCovered) {
      flags.add('NO_ORATS_COVERAGE');
    }

    const oiReconciliation = await this.reconcileOpenInterest(symbol, strikes);
    if (oiReconciliation.usedMassiveFallback) {
      flags.add('ORATS_OI_FALLBACK_MASSIVE');
    }

    // WHAM gating: strictly SPY, QQQ, IWM
    let wham: WhamSnapshot;
    if (!WHAM_SUPPORTED_ETFS.has(symbol)) {
      flags.add('MISSING_WHAM_COVERAGE');
      wham = { supported: false, status: 'UNSUPPORTED_INSTRUMENT', rows: [] };
    } else if (whamRes.status === 'fulfilled' && whamRes.value !== null) {
      const wRows = extractRowsArray(whamRes.value);
      wham = {
        supported: true,
        status: wRows.length > 0 ? 'OK' : 'UNAVAILABLE',
        rows: wRows,
      };
    } else {
      flags.add('MISSING_WHAM_COVERAGE');
      wham = { supported: true, status: 'UNAVAILABLE', rows: [] };
    }

    // Non-PIT float handling
    let nonPitFloatShares: number | null = null;
    if (floatRes.status === 'fulfilled' && isRecord(floatRes.value)) {
      const floatRows = extractRowsArray(floatRes.value['results'] ?? floatRes.value);
      const firstFloat = floatRows[0];
      if (firstFloat !== undefined) {
        const freeFloat = readNum(firstFloat, 'free_float');
        if (Number.isFinite(freeFloat) && freeFloat > 0) {
          nonPitFloatShares = freeFloat;
          flags.add('FLOAT_NON_PIT_SNAPSHOT');
        }
      }
    }

    // Earnings reconciliation + isolated impliedEarningsMove
    const oratsAnncByDate = new Map<string, string>();
    const oratsEarnDates = new Set<string>();
    if (oratsEarnRes.status === 'fulfilled') {
      for (const row of extractRowsArray(oratsEarnRes.value)) {
        const dt = readStr(row, 'earnDate') ?? readStr(row, 'tradeDate');
        if (dt === null) continue;
        const iso = dt.slice(0, 10);
        oratsEarnDates.add(iso);
        const annc = readStr(row, 'anncTod');
        if (annc !== null) {
          oratsAnncByDate.set(iso, annc);
        }
      }
    }
    const fmpEarnDates = new Set<string>();
    if (fmpEarnRes.status === 'fulfilled') {
      for (const row of extractRowsArray(fmpEarnRes.value)) {
        const dt = readStr(row, 'date');
        if (dt !== null) {
          fmpEarnDates.add(dt.slice(0, 10));
        }
      }
    }
    const allEarnDates = [...new Set([...oratsEarnDates, ...fmpEarnDates])].sort();
    const isolatedImpliedMove = resolveEarningsImpliedMoveDec(summary);
    const earnings: ReconciledEarningsEvent[] = allEarnDates.map((reportDate) => {
      const { timing, source } = resolveEarningsTimingCascade({
        oratsAnncTod: oratsAnncByDate.get(reportDate) ?? null,
        ...(options?.ethBars1m !== undefined ? { ethBars1m: options.ethBars1m } : {}),
        eventDateEt: reportDate,
      });
      const realizedReturn = options?.realizedReturnByDate?.get(reportDate) ?? null;
      const ratioToImplied =
        realizedReturn !== null && isolatedImpliedMove !== null
          ? Math.abs(realizedReturn) / isolatedImpliedMove
          : null;
      return {
        reportDate,
        timing,
        timingSource: source,
        realizedReturn,
        impliedEarningsMoveDec: isolatedImpliedMove,
        ratioToImplied,
        classification: classifyEarningsReaction(realizedReturn, isolatedImpliedMove),
      };
    });

    // Split & Dividend cross-check quarantine
    const parseMassiveSplits = (val: unknown): RawSplitCandidate[] => {
      if (!isRecord(val)) return [];
      return extractRowsArray(val['results'] ?? val)
        .map((r) => {
          const dt = readStr(r, 'execution_date') ?? readStr(r, 'effective_date');
          const sf = readNum(r, 'split_from');
          const st = readNum(r, 'split_to');
          if (dt === null || !Number.isFinite(sf) || sf <= 0 || !Number.isFinite(st) || st <= 0) {
            return null;
          }
          return { effectiveDate: dt.slice(0, 10), splitFrom: sf, splitTo: st };
        })
        .filter((x): x is RawSplitCandidate => x !== null);
    };
    const parseFmpSplits = (val: unknown): RawSplitCandidate[] =>
      extractRowsArray(val)
        .map((r) => {
          const dt = readStr(r, 'date');
          const sf = readNum(r, 'denominator');
          const st = readNum(r, 'numerator');
          if (dt === null || !Number.isFinite(sf) || sf <= 0 || !Number.isFinite(st) || st <= 0) {
            return null;
          }
          return { effectiveDate: dt.slice(0, 10), splitFrom: sf, splitTo: st };
        })
        .filter((x): x is RawSplitCandidate => x !== null);
    const parseMassiveDivs = (val: unknown): RawDividendCandidate[] => {
      if (!isRecord(val)) return [];
      return extractRowsArray(val['results'] ?? val)
        .map((r) => {
          const dt = readStr(r, 'ex_dividend_date');
          const cash = readNum(r, 'cash_amount');
          const dtype = readStr(r, 'dividend_type') ?? undefined;
          if (dt === null || !Number.isFinite(cash) || cash <= 0) {
            return null;
          }
          return dtype !== undefined
            ? { exDate: dt.slice(0, 10), cashAmount: cash, dividendType: dtype }
            : { exDate: dt.slice(0, 10), cashAmount: cash };
        })
        .filter((x): x is RawDividendCandidate => x !== null);
    };
    const parseFmpDivs = (val: unknown): RawDividendCandidate[] =>
      extractRowsArray(val)
        .map((r) => {
          const dt = readStr(r, 'date');
          const cash = readNum(r, 'dividend');
          const adjCash = Number.isFinite(cash) ? cash : readNum(r, 'adjDividend');
          if (dt === null || !Number.isFinite(adjCash) || adjCash <= 0) {
            return null;
          }
          return { exDate: dt.slice(0, 10), cashAmount: adjCash };
        })
        .filter((x): x is RawDividendCandidate => x !== null);

    const corporateActions = reconcileCorporateActions({
      massiveSplits: mSplitsRes.status === 'fulfilled' ? parseMassiveSplits(mSplitsRes.value) : [],
      fmpSplits: fSplitsRes.status === 'fulfilled' ? parseFmpSplits(fSplitsRes.value) : [],
      massiveDividends: mDivsRes.status === 'fulfilled' ? parseMassiveDivs(mDivsRes.value) : [],
      fmpDividends: fDivsRes.status === 'fulfilled' ? parseFmpDivs(fDivsRes.value) : [],
      ...(options?.prevCloseByDate !== undefined ? { prevCloseByDate: options.prevCloseByDate } : {}),
    });
    if (corporateActions.conflictQuarantined) {
      flags.add('CORP_ACTION_CONFLICT_QUARANTINED');
    }

    return {
      symbol,
      fetchedAtMs,
      tradeDateEt,
      oratsCovered,
      cores,
      summary,
      strikes,
      oiReconciliation,
      earnings,
      corporateActions,
      wham,
      globalCalendars: globalRes.status === 'fulfilled' ? globalRes.value : null,
      nonPitFloatShares,
      degradationFlags: [...flags].sort(),
      providerWarnings: warnings,
    };
  }
}
