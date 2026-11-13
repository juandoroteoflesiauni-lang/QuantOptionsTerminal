/**
 * Normalizadores puros para Contratos de Referencia (`/v3/reference/options/contracts`)
 * y Snapshots de Cadena de Opciones (`/v3/snapshot/options/{underlyingAsset}`) de Massive.
 *
 * Garantías (AGENTS.md / SPEC.md / Pieza 1):
 *  - Funciones puras: cero red, cero reloj del sistema (`Date.now()`), cero
 *    mutación de los objetos crudos o arreglos recibidos.
 *  - Conversión de unidades en la entrada: `last_updated` y `sip_timestamp`
 *    pasan de nanosegundos o milisegundos Unix a segundos UTC enteros; valores en
 *    unidades ambiguas (p. ej. segundos crudos `< 1e12`), negativos o no finitos
 *    se rechazan a `NaN` y se contabilizan en `invalidTimestamps`.
 *  - Prohibidos los valores de respaldo (`?? 0`, `|| 0`): `greeks: {}` vacío,
 *    `implied_volatility` ausente o `last_trade: {}` vacío mapean a `Number.NaN`.
 *  - Contratos no estándar (`type: 'binary'`, `underlying_type: 'kpi'`,
 *    `additional_underlyings` no vacío o multiplicador distinto del estándar) se
 *    detectan y reportan de forma explícita sin filtrados silenciosos.
 */

import { getMarketParts, MAX_TIME_SECONDS } from '../core/sessions.js';
import { etWallTimeToUtc } from './alignment.js';
import {
  isFiniteNumber,
  isRecord,
  redact,
  toErrorMessage,
} from './normalizeShared.js';
import type {
  AdditionalUnderlying,
  BaseOptionsNormalizeReport,
  NormalizeOptionChainOptions,
  NormalizeOptionContractsOptions,
  OptionChainNormalizeReport,
  OptionChainNormalizeResult,
  OptionContract,
  OptionContractsNormalizeReport,
  OptionContractsNormalizeResult,
  OptionContractType,
  OptionDaySummary,
  OptionDiscardCause,
  OptionDiscardCounts,
  OptionDiscardRecord,
  OptionExerciseStyle,
  OptionFilterOptions,
  OptionGreeks,
  OptionKind,
  OptionLastQuote,
  OptionLastTrade,
  OptionSnapshotContract,
  OptionUnderlyingSnapshot,
  OptionUnderlyingType,
  ProviderTimestampResult,
  StandardOptionContractType,
  UnderlyingSourceSummary,
} from './optionsTypes.js';
import type { ProviderError } from './types.js';

declare module './optionsTypes.js' {
  interface ProviderTimestampResult {
    readonly value: number;
    readonly hadInvalidInput: boolean;
  }
}

const MS_PER_DAY = 86_400_000;
const NANOSECONDS_MIN = 1e15;
const NANOSECONDS_MAX = MAX_TIME_SECONDS * 1_000_000_000;
const MILLISECONDS_MIN = 1e12;
const EXPIRATION_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_SHARES_PER_CONTRACT = 100;

export const OPTION_DISCARD_CAUSES: readonly OptionDiscardCause[] =
  Object.freeze([
    'malformedRow',
    'invalidTicker',
    'invalidExpiration',
    'invalidStrike',
    'invalidContractType',
    'invalidSharesPerContract',
    'duplicate',
    'binaryExcluded',
    'adjustedExcluded',
    'outOfDteRange',
    'outOfStrikeRange',
    'filteredContractType',
  ]);

interface ParsedExpirationDate {
  readonly date: string;
  readonly time: number;
  readonly utcMidnightMs: number;
}

interface ResolvedFilterOptions {
  readonly excludeBinary: boolean;
  readonly excludeAdjusted: boolean;
  readonly standardSharesPerContract: number;
  readonly contractType: StandardOptionContractType | undefined;
  readonly minDte: number | undefined;
  readonly maxDte: number | undefined;
  readonly minStrike: number | undefined;
  readonly maxStrike: number | undefined;
  readonly now: number | undefined;
}

interface MassiveEnvelope {
  readonly rows: readonly unknown[];
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
}

interface DiscardTracker {
  readonly counts: Record<OptionDiscardCause, number>;
  readonly records: OptionDiscardRecord[];
  record: (cause: OptionDiscardCause, ticker: string | null) => void;
  totalDiscarded: () => number;
  buildBaseReport: (params: {
    readonly received: number;
    readonly accepted: number;
    readonly binaryDetected: number;
    readonly adjustedDetected: number;
    readonly reordered: boolean;
    readonly malformedResponse: boolean;
    readonly providerError: ProviderError | null;
  }) => BaseOptionsNormalizeReport;
}

function createDiscardCounts(): Record<OptionDiscardCause, number> {
  return {
    malformedRow: 0,
    invalidTicker: 0,
    invalidExpiration: 0,
    invalidStrike: 0,
    invalidContractType: 0,
    invalidSharesPerContract: 0,
    duplicate: 0,
    binaryExcluded: 0,
    adjustedExcluded: 0,
    outOfDteRange: 0,
    outOfStrikeRange: 0,
    filteredContractType: 0,
  };
}

function createDiscardTracker(): DiscardTracker {
  const counts = createDiscardCounts();
  const records: OptionDiscardRecord[] = [];

  return {
    counts,
    records,
    record(cause, ticker) {
      counts[cause] += 1;
      records.push({ cause, ticker });
    },
    totalDiscarded() {
      return records.length;
    },
    buildBaseReport(params) {
      const malformedDiscarded =
        counts.malformedRow +
        counts.invalidTicker +
        counts.invalidExpiration +
        counts.invalidStrike +
        counts.invalidContractType +
        counts.invalidSharesPerContract;
      const filterExcluded =
        counts.outOfDteRange +
        counts.outOfStrikeRange +
        counts.filteredContractType;
      const discardCounts: OptionDiscardCounts = { ...counts };

      return {
        provider: 'massive',
        received: params.received,
        accepted: params.accepted,
        discarded: records.length,
        discardCounts,
        discards: records,
        binaryDetected: params.binaryDetected,
        adjustedDetected: params.adjustedDetected,
        binaryExcluded: counts.binaryExcluded,
        adjustedExcluded: counts.adjustedExcluded,
        malformedDiscarded,
        duplicateDiscarded: counts.duplicate,
        filterExcluded,
        reordered: params.reordered,
        malformedResponse: params.malformedResponse,
        providerError: params.providerError,
      };
    },
  };
}

function extractMassiveEnvelope(raw: unknown): MassiveEnvelope {
  if (!isRecord(raw)) {
    return { rows: [], malformedResponse: true, providerError: null };
  }

  let providerError: ProviderError | null = null;
  const status = raw['status'];
  if (typeof status === 'string' && status.toUpperCase() !== 'OK') {
    const message = raw['error'] ?? raw['message'];
    providerError = {
      code: 0,
      message: redact(toErrorMessage(message, status), []),
    };
  }

  const results = raw['results'];
  if (results === undefined || results === null) {
    return { rows: [], malformedResponse: false, providerError };
  }
  if (!Array.isArray(results)) {
    return { rows: [], malformedResponse: true, providerError };
  }

  return { rows: results, malformedResponse: false, providerError };
}

function validateBooleanOption(value: boolean | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean (got ${String(value)})`);
  }
  return value;
}

function validateOptionalInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be a finite integer (got ${String(value)})`);
  }
  return value;
}

function validateOptionalPositiveNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number (got ${String(value)})`);
  }
  return value;
}

function resolveFilterOptions(options: OptionFilterOptions): ResolvedFilterOptions {
  const excludeBinary = validateBooleanOption(options.excludeBinary, 'excludeBinary', true);
  const excludeAdjusted = validateBooleanOption(options.excludeAdjusted, 'excludeAdjusted', true);

  const standardSharesPerContract =
    options.standardSharesPerContract ?? DEFAULT_SHARES_PER_CONTRACT;
  if (!Number.isFinite(standardSharesPerContract) || standardSharesPerContract <= 0) {
    throw new Error(
      `standardSharesPerContract must be a positive finite number (got ${String(standardSharesPerContract)})`,
    );
  }

  const rawContractType: unknown = options.contractType;
  if (
    rawContractType !== undefined &&
    rawContractType !== 'call' &&
    rawContractType !== 'put'
  ) {
    const desc =
      typeof rawContractType === 'string'
        ? rawContractType
        : typeof rawContractType;
    throw new Error(`contractType must be 'call' or 'put' (got ${desc})`);
  }

  const minDte = validateOptionalInteger(options.minDte, 'minDte');
  const maxDte = validateOptionalInteger(options.maxDte, 'maxDte');
  if (minDte !== undefined && maxDte !== undefined && minDte > maxDte) {
    throw new Error(
      `minDte (${String(minDte)}) must be <= maxDte (${String(maxDte)})`,
    );
  }

  const minStrike = validateOptionalPositiveNumber(options.minStrike, 'minStrike');
  const maxStrike = validateOptionalPositiveNumber(options.maxStrike, 'maxStrike');
  if (minStrike !== undefined && maxStrike !== undefined && minStrike > maxStrike) {
    throw new Error(
      `minStrike (${String(minStrike)}) must be <= maxStrike (${String(maxStrike)})`,
    );
  }

  let now: number | undefined;
  if (options.now !== undefined) {
    if (
      !Number.isFinite(options.now) ||
      !Number.isInteger(options.now) ||
      options.now <= 0 ||
      options.now > MAX_TIME_SECONDS
    ) {
      throw new Error(
        `now must be finite integer seconds within supported range (got ${String(options.now)})`,
      );
    }
    now = options.now;
  }

  if ((minDte !== undefined || maxDte !== undefined) && now === undefined) {
    throw new Error('now is required when minDte or maxDte is specified');
  }

  return {
    excludeBinary,
    excludeAdjusted,
    standardSharesPerContract,
    contractType: options.contractType,
    minDte,
    maxDte,
    minStrike,
    maxStrike,
    now,
  };
}

/**
 * Valida una fecha de expiración `YYYY-MM-DD` y devuelve su cierre nominal
 * `16:00 ET` en segundos UTC enteros.
 */
export function parseExpirationDate(value: unknown): ParsedExpirationDate | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = EXPIRATION_DATE_RE.exec(value.trim());
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const utcMidnightMs = Date.UTC(year, month - 1, day);
  const check = new Date(utcMidnightMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  const time = etWallTimeToUtc(year, month, day, 16 * 60);
  if (!Number.isFinite(time) || time <= 0 || time > MAX_TIME_SECONDS) {
    return null;
  }

  return {
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    time,
    utcMidnightMs,
  };
}

/**
 * Calcula los días calendario en zona `America/New_York` hasta la expiración.
 */
export function computeCalendarDte(expirationDate: string, nowSeconds: number): number {
  const parsed = parseExpirationDate(expirationDate);
  if (parsed === null) {
    return Number.NaN;
  }
  const nowParts = getMarketParts(nowSeconds, 'EQUITY');
  const nowMidnightMs = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  return Math.round((parsed.utcMidnightMs - nowMidnightMs) / MS_PER_DAY);
}

/**
 * Convierte un timestamp numérico crudo de Massive (nanosegundos o
 * milisegundos Unix) a segundos UTC enteros.
 *
 * Devuelve `NaN` sin lanzar cuando el campo falta; si viene con formato, signo,
 * finitud o unidad ambigua (p. ej. segundos crudos `< 1e12`), marca
 * `hadInvalidInput: true` para reportarlo sin fallar en silencio.
 */
export function parseProviderTimestampSeconds(value: unknown): ProviderTimestampResult {
  if (value === undefined || value === null) {
    return { value: Number.NaN, hadInvalidInput: false };
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return { value: Number.NaN, hadInvalidInput: true };
  }
  if (!Number.isInteger(value)) {
    return { value: Number.NaN, hadInvalidInput: true };
  }

  if (value >= NANOSECONDS_MIN && value <= NANOSECONDS_MAX) {
    const seconds = Math.floor(value / 1_000_000_000);
    return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_TIME_SECONDS
      ? { value: seconds, hadInvalidInput: false }
      : { value: Number.NaN, hadInvalidInput: true };
  }

  if (value >= MILLISECONDS_MIN && value < NANOSECONDS_MIN) {
    const seconds = Math.floor(value / 1_000);
    return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_TIME_SECONDS
      ? { value: seconds, hadInvalidInput: false }
      : { value: Number.NaN, hadInvalidInput: true };
  }

  return { value: Number.NaN, hadInvalidInput: true };
}

function toFiniteNumberOrNaN(value: unknown): number {
  return isFiniteNumber(value) ? value : Number.NaN;
}

function toNonNegativeFiniteOrNaN(value: unknown): number {
  return isFiniteNumber(value) && value >= 0 ? value : Number.NaN;
}

function toPositiveFiniteOrNaN(value: unknown): number {
  return isFiniteNumber(value) && value > 0 ? value : Number.NaN;
}

function readOptionalTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseContractType(value: unknown): OptionContractType | null {
  if (value === 'call' || value === 'put' || value === 'other') {
    return value;
  }
  return null;
}

function parseExerciseStyle(value: unknown): OptionExerciseStyle | null {
  if (value === 'american' || value === 'european' || value === 'bermudan') {
    return value;
  }
  return null;
}

function parseOptionKind(value: unknown): OptionKind | null {
  if (value === 'standard' || value === 'binary') {
    return value;
  }
  return null;
}

function parseUnderlyingType(value: unknown): OptionUnderlyingType | null {
  if (value === 'equity' || value === 'kpi') {
    return value;
  }
  return null;
}

function parseAdditionalUnderlyings(
  value: unknown,
): { readonly items: readonly AdditionalUnderlying[]; readonly malformed: boolean } {
  if (value === undefined || value === null) {
    return { items: [], malformed: false };
  }
  if (!Array.isArray(value)) {
    return { items: [], malformed: true };
  }

  const items: AdditionalUnderlying[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      items.push({ type: '', underlying: '', amount: Number.NaN });
      continue;
    }
    items.push({
      type: typeof entry['type'] === 'string' ? entry['type'] : '',
      underlying: typeof entry['underlying'] === 'string' ? entry['underlying'] : '',
      amount: toFiniteNumberOrNaN(entry['amount']),
    });
  }
  return { items, malformed: false };
}

function evaluateOptionFilters(params: {
  readonly isBinary: boolean;
  readonly isAdjusted: boolean;
  readonly contractType: OptionContractType;
  readonly strikePrice: number;
  readonly expirationUtcMidnightMs: number;
  readonly resolved: ResolvedFilterOptions;
}): OptionDiscardCause | null {
  const {
    isBinary,
    isAdjusted,
    contractType,
    strikePrice,
    expirationUtcMidnightMs,
    resolved,
  } = params;

  if (isBinary && resolved.excludeBinary) {
    return 'binaryExcluded';
  }
  if (isAdjusted && resolved.excludeAdjusted) {
    return 'adjustedExcluded';
  }
  if (resolved.contractType !== undefined && contractType !== resolved.contractType) {
    return 'filteredContractType';
  }
  if (resolved.minStrike !== undefined && strikePrice < resolved.minStrike) {
    return 'outOfStrikeRange';
  }
  if (resolved.maxStrike !== undefined && strikePrice > resolved.maxStrike) {
    return 'outOfStrikeRange';
  }

  if (
    resolved.now !== undefined &&
    (resolved.minDte !== undefined || resolved.maxDte !== undefined)
  ) {
    const nowParts = getMarketParts(resolved.now, 'EQUITY');
    const nowMidnightMs = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
    const dte = Math.round((expirationUtcMidnightMs - nowMidnightMs) / MS_PER_DAY);
    if (resolved.minDte !== undefined && dte < resolved.minDte) {
      return 'outOfDteRange';
    }
    if (resolved.maxDte !== undefined && dte > resolved.maxDte) {
      return 'outOfDteRange';
    }
  }

  return null;
}

interface SortableOptionItem {
  readonly expirationDate: string;
  readonly strikePrice: number;
  readonly contractType: OptionContractType;
  readonly ticker: string;
}

function compareOptionOrder(a: SortableOptionItem, b: SortableOptionItem): number {
  if (a.expirationDate !== b.expirationDate) {
    return a.expirationDate < b.expirationDate ? -1 : 1;
  }
  if (a.strikePrice !== b.strikePrice) {
    return a.strikePrice - b.strikePrice;
  }
  if (a.contractType !== b.contractType) {
    return a.contractType < b.contractType ? -1 : 1;
  }
  if (a.ticker !== b.ticker) {
    return a.ticker < b.ticker ? -1 : 1;
  }
  return 0;
}

function sortWithReorderedFlag<T extends SortableOptionItem>(
  items: readonly T[],
): { readonly sorted: readonly T[]; readonly reordered: boolean } {
  const inputTickers = items.map((item) => item.ticker);
  const sorted = [...items].sort(compareOptionOrder);
  let reordered = false;
  for (let i = 0; i < sorted.length; i += 1) {
    const sortedItem = sorted[i];
    if (sortedItem === undefined || sortedItem.ticker !== inputTickers[i]) {
      reordered = true;
      break;
    }
  }
  return { sorted, reordered };
}

function buildReferenceMap(
  contracts: NormalizeOptionChainOptions['referenceContracts'],
): ReadonlyMap<string, OptionContract> {
  if (contracts === undefined) {
    return new Map();
  }
  if (contracts instanceof Map) {
    return contracts as ReadonlyMap<string, OptionContract>;
  }
  const map = new Map<string, OptionContract>();
  for (const contract of contracts as readonly OptionContract[]) {
    map.set(contract.ticker, contract);
  }
  return map;
}

/**
 * Normaliza una respuesta cruda de `/v3/reference/options/contracts`.
 */
export function normalizeOptionContracts(
  raw: unknown,
  options: NormalizeOptionContractsOptions = {},
): OptionContractsNormalizeResult {
  const resolved = resolveFilterOptions(options);
  const envelope = extractMassiveEnvelope(raw);
  const tracker = createDiscardTracker();
  const seenTickers = new Set<string>();
  const accepted: OptionContract[] = [];

  let binaryDetected = 0;
  let adjustedDetected = 0;

  for (const row of envelope.rows) {
    if (!isRecord(row)) {
      tracker.record('malformedRow', null);
      continue;
    }

    const ticker = readOptionalTrimmedString(row['ticker']);
    if (ticker === null) {
      tracker.record('invalidTicker', null);
      continue;
    }

    const underlyingTicker = readOptionalTrimmedString(row['underlying_ticker']);
    if (underlyingTicker === null) {
      tracker.record('malformedRow', ticker);
      continue;
    }

    const contractType = parseContractType(row['contract_type']);
    if (contractType === null) {
      tracker.record('invalidContractType', ticker);
      continue;
    }

    const parsedExp = parseExpirationDate(row['expiration_date']);
    if (parsedExp === null) {
      tracker.record('invalidExpiration', ticker);
      continue;
    }

    const kind = parseOptionKind(row['type']);
    const underlyingType = parseUnderlyingType(row['underlying_type']);
    const isBinary = kind === 'binary' || underlyingType === 'kpi';

    const strikeRaw = row['strike_price'];
    if (!isFiniteNumber(strikeRaw) || (!isBinary && strikeRaw <= 0)) {
      tracker.record('invalidStrike', ticker);
      continue;
    }

    const sharesRaw = row['shares_per_contract'];
    if (!isFiniteNumber(sharesRaw) || sharesRaw <= 0) {
      tracker.record('invalidSharesPerContract', ticker);
      continue;
    }

    const additionalParsed = parseAdditionalUnderlyings(row['additional_underlyings']);
    if (additionalParsed.malformed) {
      tracker.record('malformedRow', ticker);
      continue;
    }

    if (seenTickers.has(ticker)) {
      tracker.record('duplicate', ticker);
      continue;
    }
    seenTickers.add(ticker);

    const isAdjusted =
      !isBinary &&
      (additionalParsed.items.length > 0 ||
        sharesRaw !== resolved.standardSharesPerContract);

    if (isBinary) {
      binaryDetected += 1;
    }
    if (isAdjusted) {
      adjustedDetected += 1;
    }

    const filterDiscard = evaluateOptionFilters({
      isBinary,
      isAdjusted,
      contractType,
      strikePrice: strikeRaw,
      expirationUtcMidnightMs: parsedExp.utcMidnightMs,
      resolved,
    });
    if (filterDiscard !== null) {
      tracker.record(filterDiscard, ticker);
      continue;
    }

    const correctionRaw = row['correction'];
    const correction =
      isFiniteNumber(correctionRaw) && Number.isInteger(correctionRaw)
        ? correctionRaw
        : null;

    accepted.push({
      ticker,
      underlyingTicker,
      contractType,
      exerciseStyle: parseExerciseStyle(row['exercise_style']),
      expirationDate: parsedExp.date,
      expirationTime: parsedExp.time,
      strikePrice: strikeRaw,
      sharesPerContract: sharesRaw,
      primaryExchange: readOptionalTrimmedString(row['primary_exchange']),
      cfi: readOptionalTrimmedString(row['cfi']),
      correction,
      kind,
      underlyingType,
      additionalUnderlyings: additionalParsed.items,
      isBinary,
      isAdjusted,
      isNonStandard: isBinary || isAdjusted,
    });
  }

  const { sorted, reordered } = sortWithReorderedFlag(accepted);
  const report: OptionContractsNormalizeReport = tracker.buildBaseReport({
    received: envelope.rows.length,
    accepted: sorted.length,
    binaryDetected,
    adjustedDetected,
    reordered,
    malformedResponse: envelope.malformedResponse,
    providerError: envelope.providerError,
  });

  return { contracts: sorted, report };
}

function parseSnapshotGreeks(raw: unknown): {
  readonly greeks: OptionGreeks;
  readonly missing: boolean;
} {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    return {
      greeks: {
        delta: Number.NaN,
        gamma: Number.NaN,
        theta: Number.NaN,
        vega: Number.NaN,
      },
      missing: true,
    };
  }

  const greeks: OptionGreeks = {
    delta: toFiniteNumberOrNaN(raw['delta']),
    gamma: toFiniteNumberOrNaN(raw['gamma']),
    theta: toFiniteNumberOrNaN(raw['theta']),
    vega: toFiniteNumberOrNaN(raw['vega']),
  };

  const allNaN =
    Number.isNaN(greeks.delta) &&
    Number.isNaN(greeks.gamma) &&
    Number.isNaN(greeks.theta) &&
    Number.isNaN(greeks.vega);

  return { greeks, missing: allNaN };
}

function parseSnapshotDay(raw: unknown): {
  readonly day: OptionDaySummary;
  readonly empty: boolean;
  readonly invalidTimestamps: number;
} {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    return {
      day: {
        open: Number.NaN,
        high: Number.NaN,
        low: Number.NaN,
        close: Number.NaN,
        volume: Number.NaN,
        vwap: Number.NaN,
        previousClose: Number.NaN,
        change: Number.NaN,
        changePercent: Number.NaN,
        updatedAt: Number.NaN,
      },
      empty: true,
      invalidTimestamps: 0,
    };
  }

  const ts = parseProviderTimestampSeconds(raw['last_updated']);
  const day: OptionDaySummary = {
    open: toNonNegativeFiniteOrNaN(raw['open']),
    high: toNonNegativeFiniteOrNaN(raw['high']),
    low: toNonNegativeFiniteOrNaN(raw['low']),
    close: toNonNegativeFiniteOrNaN(raw['close']),
    volume: toNonNegativeFiniteOrNaN(raw['volume']),
    vwap: toNonNegativeFiniteOrNaN(raw['vwap']),
    previousClose: toNonNegativeFiniteOrNaN(raw['previous_close']),
    change: toFiniteNumberOrNaN(raw['change']),
    changePercent: toFiniteNumberOrNaN(raw['change_percent']),
    updatedAt: ts.value,
  };

  const empty =
    Number.isNaN(day.open) &&
    Number.isNaN(day.high) &&
    Number.isNaN(day.low) &&
    Number.isNaN(day.close) &&
    Number.isNaN(day.volume) &&
    Number.isNaN(day.vwap) &&
    Number.isNaN(day.previousClose) &&
    Number.isNaN(day.updatedAt);

  return { day, empty, invalidTimestamps: ts.hadInvalidInput ? 1 : 0 };
}

function parseSnapshotQuote(raw: unknown): {
  readonly quote: OptionLastQuote;
  readonly empty: boolean;
  readonly invalidTimestamps: number;
} {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    return {
      quote: {
        bid: Number.NaN,
        ask: Number.NaN,
        midpoint: Number.NaN,
        bidSize: Number.NaN,
        askSize: Number.NaN,
        bidExchange: null,
        askExchange: null,
        updatedAt: Number.NaN,
        timeframe: null,
      },
      empty: true,
      invalidTimestamps: 0,
    };
  }

  const ts = parseProviderTimestampSeconds(raw['last_updated']);
  const bidExRaw = raw['bid_exchange'];
  const askExRaw = raw['ask_exchange'];
  const quote: OptionLastQuote = {
    bid: toNonNegativeFiniteOrNaN(raw['bid']),
    ask: toNonNegativeFiniteOrNaN(raw['ask']),
    midpoint: toNonNegativeFiniteOrNaN(raw['midpoint']),
    bidSize: toNonNegativeFiniteOrNaN(raw['bid_size']),
    askSize: toNonNegativeFiniteOrNaN(raw['ask_size']),
    bidExchange:
      isFiniteNumber(bidExRaw) && Number.isInteger(bidExRaw) ? bidExRaw : null,
    askExchange:
      isFiniteNumber(askExRaw) && Number.isInteger(askExRaw) ? askExRaw : null,
    updatedAt: ts.value,
    timeframe: readOptionalTrimmedString(raw['timeframe']),
  };

  const empty =
    Number.isNaN(quote.bid) &&
    Number.isNaN(quote.ask) &&
    Number.isNaN(quote.midpoint) &&
    Number.isNaN(quote.updatedAt);

  return { quote, empty, invalidTimestamps: ts.hadInvalidInput ? 1 : 0 };
}

function parseSnapshotTrade(raw: unknown): {
  readonly trade: OptionLastTrade;
  readonly empty: boolean;
  readonly invalidTimestamps: number;
} {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    return {
      trade: {
        price: Number.NaN,
        size: Number.NaN,
        exchange: null,
        conditions: [],
        sipTimestamp: Number.NaN,
        timeframe: null,
      },
      empty: true,
      invalidTimestamps: 0,
    };
  }

  const ts = parseProviderTimestampSeconds(raw['sip_timestamp']);
  const exRaw = raw['exchange'];
  const condRaw = raw['conditions'];
  const conditions: number[] = [];
  if (Array.isArray(condRaw)) {
    for (const c of condRaw) {
      if (isFiniteNumber(c) && Number.isInteger(c)) {
        conditions.push(c);
      }
    }
  }

  const trade: OptionLastTrade = {
    price: toPositiveFiniteOrNaN(raw['price']),
    size: toNonNegativeFiniteOrNaN(raw['size']),
    exchange: isFiniteNumber(exRaw) && Number.isInteger(exRaw) ? exRaw : null,
    conditions,
    sipTimestamp: ts.value,
    timeframe: readOptionalTrimmedString(raw['timeframe']),
  };

  const empty =
    Number.isNaN(trade.price) &&
    Number.isNaN(trade.size) &&
    Number.isNaN(trade.sipTimestamp);

  return { trade, empty, invalidTimestamps: ts.hadInvalidInput ? 1 : 0 };
}

function parseUnderlyingSnapshot(raw: unknown): {
  readonly underlying: OptionUnderlyingSnapshot | null;
  readonly invalidTimestamps: number;
} {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    return { underlying: null, invalidTimestamps: 0 };
  }

  const ticker = readOptionalTrimmedString(raw['ticker']) ?? '';
  let price = Number.NaN;
  let sourceField: 'price' | 'value' | null = null;
  if ('price' in raw && raw['price'] !== undefined) {
    price = toPositiveFiniteOrNaN(raw['price']);
    sourceField = 'price';
  } else if ('value' in raw && raw['value'] !== undefined) {
    price = toPositiveFiniteOrNaN(raw['value']);
    sourceField = 'value';
  }

  if (ticker === '' && Number.isNaN(price)) {
    return { underlying: null, invalidTimestamps: 0 };
  }

  const ts = parseProviderTimestampSeconds(raw['last_updated']);
  return {
    underlying: {
      ticker,
      price,
      sourceField,
      changeToBreakEven: toFiniteNumberOrNaN(raw['change_to_break_even']),
      updatedAt: ts.value,
      timeframe: readOptionalTrimmedString(raw['timeframe']),
    },
    invalidTimestamps: ts.hadInvalidInput ? 1 : 0,
  };
}

function summarizeUnderlyingSource(
  seenPrice: boolean,
  seenValue: boolean,
): UnderlyingSourceSummary {
  if (seenPrice && seenValue) {
    return 'mixed';
  }
  if (seenPrice) {
    return 'price';
  }
  if (seenValue) {
    return 'value';
  }
  return 'missing';
}

function pickCanonicalUnderlying(
  contracts: readonly OptionSnapshotContract[],
): OptionUnderlyingSnapshot | null {
  let best: OptionUnderlyingSnapshot | null = null;
  for (const contract of contracts) {
    const candidate = contract.underlyingAsset;
    if (candidate === null) {
      continue;
    }
    if (best === null) {
      best = candidate;
      continue;
    }
    const bestTs = best.updatedAt;
    const candTs = candidate.updatedAt;
    if (Number.isNaN(bestTs) && !Number.isNaN(candTs)) {
      best = candidate;
    } else if (!Number.isNaN(candTs) && !Number.isNaN(bestTs) && candTs > bestTs) {
      best = candidate;
    } else if (Number.isNaN(best.price) && !Number.isNaN(candidate.price)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Normaliza una respuesta cruda de `/v3/snapshot/options/{underlyingAsset}`.
 */
export function normalizeOptionChainSnapshot(
  raw: unknown,
  options: NormalizeOptionChainOptions = {},
): OptionChainNormalizeResult {
  const resolved = resolveFilterOptions(options);
  const referenceMap = buildReferenceMap(options.referenceContracts);
  const envelope = extractMassiveEnvelope(raw);
  const tracker = createDiscardTracker();
  const seenTickers = new Set<string>();
  const accepted: OptionSnapshotContract[] = [];

  let binaryDetected = 0;
  let adjustedDetected = 0;
  let emptyGreeks = 0;
  let ivMissing = 0;
  let emptyDay = 0;
  let emptyLastQuote = 0;
  let emptyLastTrade = 0;
  let invalidTimestamps = 0;
  let seenPriceSource = false;
  let seenValueSource = false;

  for (const row of envelope.rows) {
    if (!isRecord(row)) {
      tracker.record('malformedRow', null);
      continue;
    }

    const details = row['details'];
    if (!isRecord(details)) {
      tracker.record('malformedRow', null);
      continue;
    }

    const ticker = readOptionalTrimmedString(details['ticker']);
    if (ticker === null) {
      tracker.record('invalidTicker', null);
      continue;
    }

    const rawContractType = parseContractType(details['contract_type']);
    if (rawContractType !== 'call' && rawContractType !== 'put') {
      tracker.record('invalidContractType', ticker);
      continue;
    }

    const parsedExp = parseExpirationDate(details['expiration_date']);
    if (parsedExp === null) {
      tracker.record('invalidExpiration', ticker);
      continue;
    }

    const refContract = referenceMap.get(ticker);
    const detailsKind = parseOptionKind(details['type']);
    const detailsUnderlyingType = parseUnderlyingType(details['underlying_type']);
    const isBinary =
      detailsKind === 'binary' ||
      detailsUnderlyingType === 'kpi' ||
      (refContract?.isBinary ?? false);

    const strikeRaw = details['strike_price'];
    if (!isFiniteNumber(strikeRaw) || (!isBinary && strikeRaw <= 0)) {
      tracker.record('invalidStrike', ticker);
      continue;
    }

    const sharesRaw = details['shares_per_contract'];
    if (!isFiniteNumber(sharesRaw) || sharesRaw <= 0) {
      tracker.record('invalidSharesPerContract', ticker);
      continue;
    }

    const additionalParsed = parseAdditionalUnderlyings(
      details['additional_underlyings'],
    );
    if (additionalParsed.malformed) {
      tracker.record('malformedRow', ticker);
      continue;
    }

    if (seenTickers.has(ticker)) {
      tracker.record('duplicate', ticker);
      continue;
    }
    seenTickers.add(ticker);

    const additionalUnderlyings =
      additionalParsed.items.length > 0
        ? additionalParsed.items
        : (refContract?.additionalUnderlyings ?? []);

    const isAdjusted =
      !isBinary &&
      (additionalUnderlyings.length > 0 ||
        sharesRaw !== resolved.standardSharesPerContract ||
        (refContract?.isAdjusted ?? false));

    if (isBinary) {
      binaryDetected += 1;
    }
    if (isAdjusted) {
      adjustedDetected += 1;
    }

    const filterDiscard = evaluateOptionFilters({
      isBinary,
      isAdjusted,
      contractType: rawContractType,
      strikePrice: strikeRaw,
      expirationUtcMidnightMs: parsedExp.utcMidnightMs,
      resolved,
    });
    if (filterDiscard !== null) {
      tracker.record(filterDiscard, ticker);
      continue;
    }

    const greeksParsed = parseSnapshotGreeks(row['greeks']);
    const dayParsed = parseSnapshotDay(row['day']);
    const quoteParsed = parseSnapshotQuote(row['last_quote']);
    const tradeParsed = parseSnapshotTrade(row['last_trade']);
    const underlyingParsed = parseUnderlyingSnapshot(row['underlying_asset']);

    const impliedVolatility = toNonNegativeFiniteOrNaN(row['implied_volatility']);
    const openInterest = toNonNegativeFiniteOrNaN(row['open_interest']);
    const breakEvenPrice = toFiniteNumberOrNaN(row['break_even_price']);

    if (greeksParsed.missing) {
      emptyGreeks += 1;
    }
    if (Number.isNaN(impliedVolatility)) {
      ivMissing += 1;
    }
    if (dayParsed.empty) {
      emptyDay += 1;
    }
    if (quoteParsed.empty) {
      emptyLastQuote += 1;
    }
    if (tradeParsed.empty) {
      emptyLastTrade += 1;
    }
    invalidTimestamps +=
      dayParsed.invalidTimestamps +
      quoteParsed.invalidTimestamps +
      tradeParsed.invalidTimestamps +
      underlyingParsed.invalidTimestamps;

    if (underlyingParsed.underlying !== null && !Number.isNaN(underlyingParsed.underlying.price)) {
      if (underlyingParsed.underlying.sourceField === 'price') {
        seenPriceSource = true;
      } else if (underlyingParsed.underlying.sourceField === 'value') {
        seenValueSource = true;
      }
    }

    accepted.push({
      ticker,
      contractType: rawContractType,
      exerciseStyle:
        parseExerciseStyle(details['exercise_style']) ??
        refContract?.exerciseStyle ??
        null,
      expirationDate: parsedExp.date,
      expirationTime: parsedExp.time,
      strikePrice: strikeRaw,
      sharesPerContract: sharesRaw,
      breakEvenPrice,
      impliedVolatility,
      openInterest,
      greeks: greeksParsed.greeks,
      greeksMissing: greeksParsed.missing,
      day: dayParsed.day,
      lastQuote: quoteParsed.quote,
      lastTrade: tradeParsed.trade,
      underlyingAsset: underlyingParsed.underlying,
      additionalUnderlyings,
      isBinary,
      isAdjusted,
      isNonStandard: isBinary || isAdjusted,
    });
  }

  const { sorted, reordered } = sortWithReorderedFlag(accepted);
  const underlying = pickCanonicalUnderlying(sorted);

  const base = tracker.buildBaseReport({
    received: envelope.rows.length,
    accepted: sorted.length,
    binaryDetected,
    adjustedDetected,
    reordered,
    malformedResponse: envelope.malformedResponse,
    providerError: envelope.providerError,
  });

  const report: OptionChainNormalizeReport = {
    ...base,
    emptyGreeks,
    ivMissing,
    emptyDay,
    emptyLastQuote,
    emptyLastTrade,
    invalidTimestamps,
    underlyingSource: summarizeUnderlyingSource(seenPriceSource, seenValueSource),
  };

  return {
    contracts: sorted,
    underlying,
    report,
  };
}
