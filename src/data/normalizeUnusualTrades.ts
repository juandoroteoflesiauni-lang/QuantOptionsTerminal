/**
 * Normalizador puro e independiente de red para el flujo de actividad inusual
 * en opciones (`GET /options/v1/unusual-trades`) de Massive (Pieza 8).
 *
 * Garantías (AGENTS.md / SPEC.md / docs/massive_plan_reference.md):
 *  - Funciones puras: cero red, cero `Date.now()`, cero mutación de argumentos.
 *  - `sip_timestamp` en **nanosegundos** Unix (número o string entero): se valida
 *    que esté en rango nanosegundos (`>= 1e15`) y se convierte en la entrada a
 *    `time` en segundos UTC enteros + subestructura `subsecond` (`nanoseconds`, `timestampNs`).
 *  - Se conserva `root` explícito para separar semanales y series ajustadas que
 *    Massive agrupa en `underlying_ticker` (ej. `SPXW` vs `SPX`, `GME1` vs `GME`).
 *  - Prohibidos los respaldos ocultos para `NaN`: si `shares_per_contract` no viene
 *    en la fila ni se provee en tablas/opciones (o si la serie es ajustada sin
 *    multiplicador verificado), `sharesPerContract` y `notional` quedan en `Number.NaN`.
 */

import { MAX_TIME_SECONDS } from '../core/sessions.js';
import {
  isFiniteNumber,
  isRecord,
  redact,
  toErrorMessage,
} from './normalizeShared.js';
import type { ProviderError } from './types.js';

export const UNUSUAL_TRADE_FLAGS = [
  'block_premium',
  'block_size',
  'iso',
] as const;

export type UnusualTradeFlag = (typeof UNUSUAL_TRADE_FLAGS)[number];
export type UnusualTradeFlagMatchMode = 'any' | 'all';
export type UnusualTradeRootKind =
  | 'standard'
  | 'weekly_or_different'
  | 'adjusted'
  | 'binary';

export type UnusualTradeDiscardCause =
  | 'malformedRow'
  | 'invalidTicker'
  | 'invalidRoot'
  | 'invalidTimestamp'
  | 'nonFinite'
  | 'invalidPrice'
  | 'invalidSize'
  | 'invalidSharesPerContract'
  | 'invalidFlags'
  | 'duplicate'
  | 'filteredOut';

export type UnusualTradeDiscardCounts = Readonly<Record<UnusualTradeDiscardCause, number>>;

export interface UnusualTradeDiscardRecord {
  readonly cause: UnusualTradeDiscardCause;
  readonly ticker: string | null;
  readonly time: number | null;
}

export interface UnusualTradeSubsecondTimestamp {
  /** Fracción sub-segundo en nanosegundos enteros `[0, 999_999_999]`. */
  readonly nanoseconds: number;
  /** Representación entera textual completa del `sip_timestamp` original en nanosegundos. */
  readonly timestampNs: string;
}

export interface UnusualTradeFlagsSummary {
  readonly blockPremium: boolean;
  readonly blockSize: boolean;
  readonly iso: boolean;
  readonly raw: readonly string[];
}

export interface UnusualTradeRecord {
  /** Instante de recepción SIP en segundos UTC enteros (`floor(ns / 1e9)`). */
  readonly time: number;
  /** Subestructura de precisión nanosegundos sin mezclar unidades en `time`. */
  readonly subsecond: UnusualTradeSubsecondTimestamp;
  readonly ticker: string;
  readonly underlyingTicker: string | null;
  readonly root: string;
  readonly rootKind: UnusualTradeRootKind;
  readonly expirationDate: string | null;
  readonly contractType: 'call' | 'put' | null;
  readonly strikePrice: number;
  readonly price: number;
  readonly size: number;
  /** Multiplicador contractual; `Number.NaN` cuando no fue provisto ni verificado. */
  readonly sharesPerContract: number;
  /** Prima nocional real (`price * size * sharesPerContract`); `Number.NaN` si falta multiplicador. */
  readonly notional: number;
  readonly exchange: number;
  readonly conditions: readonly number[];
  readonly flags: UnusualTradeFlagsSummary;
  readonly sequenceNumber: number;
}

export interface NormalizeUnusualTradesOptions {
  /** Filtra solo filas que contengan estos flags (`block_premium`, `block_size`, `iso`). */
  readonly requiredFlags?: readonly UnusualTradeFlag[];
  /** Cómo evaluar `requiredFlags` (`'any'` por defecto o `'all'`). */
  readonly flagMatchMode?: UnusualTradeFlagMatchMode;
  /** Filtra exactamente por uno o más `root` (ej. `['SPXW']`). */
  readonly roots?: readonly string[];
  /** Filtra exactamente por `underlying_ticker` (ej. `'SPX'`). */
  readonly underlyingTicker?: string;
  /** Excluye raíces con marca de ajuste o binarias (`GME1`, `AMCR1`, `B1SPY`). */
  readonly excludeAdjustedRoots?: boolean;
  /** Tabla verificada ticker -> `shares_per_contract` (p. ej. cruzada con `/contracts`). */
  readonly sharesPerContractByTicker?:
    | Readonly<Record<string, number>>
    | ReadonlyMap<string, number>;
  /**
   * Multiplicador por defecto explícito para series estándar cuando el endpoint
   * no envía `shares_per_contract`. No se aplica a series ajustadas salvo que
   * `allowDefaultSharesOnAdjusted` sea `true`.
   */
  readonly defaultSharesPerContract?: number;
  /** Permite aplicar `defaultSharesPerContract` también sobre raíces ajustadas/binarias. */
  readonly allowDefaultSharesOnAdjusted?: boolean;
  /** Filtra trades con nocional `< minNotional` (y descarta nocional `NaN`). */
  readonly minNotional?: number;
}

export interface UnusualTradesFlagCounts {
  readonly blockPremium: number;
  readonly blockSize: number;
  readonly iso: number;
}

export interface UnusualTradesNormalizeReport {
  readonly provider: 'massive';
  readonly received: number;
  readonly accepted: number;
  readonly discarded: number;
  readonly filteredOut: number;
  readonly discardCounts: UnusualTradeDiscardCounts;
  readonly discards: readonly UnusualTradeDiscardRecord[];
  readonly distinctRoots: readonly string[];
  readonly distinctUnderlyingTickers: readonly string[];
  /** Suma exacta si todos los trades aceptados tienen nocional finito; `NaN` si falta algún multiplicador. */
  readonly totalNotional: number;
  /** Suma parcial de los trades con nocional finito. */
  readonly knownNotionalSum: number;
  readonly validNotionalCount: number;
  readonly nanNotionalCount: number;
  readonly flagCounts: UnusualTradesFlagCounts;
  readonly reordered: boolean;
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
}

export interface UnusualTradesNormalizeResult {
  readonly trades: readonly UnusualTradeRecord[];
  readonly report: UnusualTradesNormalizeReport;
}

const NANOSECONDS_PER_SECOND_BIG = 1_000_000_000n;
const NANOSECONDS_MIN_BIG = 1_000_000_000_000_000n; // 1e15 ns (1970-01-12; rechaza ms/segundos)
const NANOSECONDS_MAX_BIG = BigInt(MAX_TIME_SECONDS) * NANOSECONDS_PER_SECOND_BIG;
const INT_STRING_RE = /^\d+$/;
const OCC_TICKER_RE = /^O:([A-Z0-9]{1,8})(\d{6})([CP])(\d{8})$/;
const ADJUSTED_ROOT_RE = /\d+$/;
const BINARY_ROOT_RE = /^B\d+[A-Z]/;
const ALLOWED_FLAG_SET = new Set<string>(UNUSUAL_TRADE_FLAGS);
const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function createDiscardCounts(): Record<UnusualTradeDiscardCause, number> {
  return {
    malformedRow: 0,
    invalidTicker: 0,
    invalidRoot: 0,
    invalidTimestamp: 0,
    nonFinite: 0,
    invalidPrice: 0,
    invalidSize: 0,
    invalidSharesPerContract: 0,
    invalidFlags: 0,
    duplicate: 0,
    filteredOut: 0,
  };
}

function readOptionalTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Parsea `sip_timestamp` en nanosegundos Unix (`number` entero o `string` entero)
 * devolviendo `{ time, subsecond }` en segundos UTC enteros + nanosegundos residuales.
 * Rechaza explícitamente valores en segundos/milisegundos (`< 1e15`), negativos o fuera de rango.
 */
export function parseSipNanosecondTimestamp(
  value: unknown,
): { readonly time: number; readonly subsecond: UnusualTradeSubsecondTimestamp } | null {
  let nsBig: bigint;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      return null;
    }
    nsBig = BigInt(Math.trunc(value));
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!INT_STRING_RE.test(trimmed)) {
      return null;
    }
    try {
      nsBig = BigInt(trimmed);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (nsBig < NANOSECONDS_MIN_BIG || nsBig > NANOSECONDS_MAX_BIG) {
    return null;
  }

  const secBig = nsBig / NANOSECONDS_PER_SECOND_BIG;
  const remBig = nsBig % NANOSECONDS_PER_SECOND_BIG;
  const time = Number(secBig);
  const nanoseconds = Number(remBig);

  if (
    !Number.isSafeInteger(time) ||
    time <= 0 ||
    time > MAX_TIME_SECONDS ||
    !Number.isSafeInteger(nanoseconds) ||
    nanoseconds < 0 ||
    nanoseconds >= 1_000_000_000
  ) {
    return null;
  }

  return {
    time,
    subsecond: {
      nanoseconds,
      timestampNs: nsBig.toString(),
    },
  };
}

interface ParsedOccMeta {
  readonly root: string;
  readonly expirationDate: string;
  readonly contractType: 'call' | 'put';
  readonly strikePrice: number;
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (year < 1970 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function parseOccTicker(ticker: string): ParsedOccMeta | null {
  const match = OCC_TICKER_RE.exec(ticker);
  if (match === null) {
    return null;
  }

  const root = match[1];
  const yymmdd = match[2];
  const cp = match[3];
  const strikeStr = match[4];

  if (
    root === undefined ||
    yymmdd === undefined ||
    cp === undefined ||
    strikeStr === undefined
  ) {
    return null;
  }

  const yy = Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  const year = 2000 + yy;
  if (!isValidYmd(year, month, day)) {
    return null;
  }

  const strikeMilli = Number(strikeStr);
  if (!Number.isSafeInteger(strikeMilli) || strikeMilli <= 0) {
    return null;
  }

  return {
    root,
    expirationDate: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    contractType: cp === 'C' ? 'call' : 'put',
    strikePrice: strikeMilli / 1000,
  };
}

function parseOptionalCalendarDate(value: unknown): string | null {
  const text = readOptionalTrimmedString(value);
  if (text === null) {
    return null;
  }
  const match = CALENDAR_DATE_RE.exec(text);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidYmd(year, month, day)) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function classifyRoot(
  root: string,
  underlyingTicker: string | null,
  explicitType: unknown,
): UnusualTradeRootKind {
  if (
    (typeof explicitType === 'string' && explicitType.trim().toLowerCase() === 'binary') ||
    BINARY_ROOT_RE.test(root)
  ) {
    return 'binary';
  }
  if (ADJUSTED_ROOT_RE.test(root)) {
    return 'adjusted';
  }
  if (underlyingTicker !== null && root !== underlyingTicker) {
    return 'weekly_or_different';
  }
  return 'standard';
}

function parseConditions(value: unknown): readonly number[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed: number[] = [];
  for (const item of value) {
    if (!isFiniteNumber(item) || !Number.isInteger(item) || item < 0) {
      return null;
    }
    parsed.push(item);
  }
  return parsed;
}

function parseFlags(
  value: unknown,
  conditions: readonly number[],
): UnusualTradeFlagsSummary | null {
  if (value === undefined || value === null) {
    const isoFromCond = conditions.includes(219);
    return {
      blockPremium: false,
      blockSize: false,
      iso: isoFromCond,
      raw: isoFromCond ? ['iso'] : [],
    };
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const seen = new Set<string>();
  const rawList: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return null;
    }
    const normalized = entry.trim().toLowerCase();
    if (normalized === '') {
      return null;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      rawList.push(normalized);
    }
  }

  return {
    blockPremium: seen.has('block_premium'),
    blockSize: seen.has('block_size'),
    iso: seen.has('iso'),
    raw: rawList,
  };
}

interface ResolvedNormalizeOptions {
  readonly requiredFlags: readonly UnusualTradeFlag[];
  readonly flagMatchMode: UnusualTradeFlagMatchMode;
  readonly rootsSet: ReadonlySet<string> | null;
  readonly underlyingTicker: string | undefined;
  readonly excludeAdjustedRoots: boolean;
  readonly sharesMap: ReadonlyMap<string, number> | null;
  readonly defaultSharesPerContract: number | undefined;
  readonly allowDefaultSharesOnAdjusted: boolean;
  readonly minNotional: number | undefined;
}

function resolveOptions(options: NormalizeUnusualTradesOptions): ResolvedNormalizeOptions {
  const requiredFlagsRaw = options.requiredFlags ?? [];
  const requiredFlags: UnusualTradeFlag[] = [];
  const flagSeen = new Set<UnusualTradeFlag>();
  for (const flag of requiredFlagsRaw) {
    if (!ALLOWED_FLAG_SET.has(flag)) {
      throw new Error(`Unsupported unusual trade flag filter: ${flag}`);
    }
    if (!flagSeen.has(flag)) {
      flagSeen.add(flag);
      requiredFlags.push(flag);
    }
  }

  const flagMatchModeRaw: string = options.flagMatchMode ?? 'any';
  if (flagMatchModeRaw !== 'any' && flagMatchModeRaw !== 'all') {
    throw new Error(`flagMatchMode must be 'any' or 'all'`);
  }
  const flagMatchMode: UnusualTradeFlagMatchMode = flagMatchModeRaw;

  let rootsSet: Set<string> | null = null;
  if (options.roots !== undefined) {
    rootsSet = new Set<string>();
    for (const root of options.roots) {
      if (typeof root !== 'string' || root.trim() === '') {
        throw new Error('roots filter entries must be non-empty strings');
      }
      rootsSet.add(root.trim());
    }
  }

  let underlyingTicker: string | undefined;
  if (options.underlyingTicker !== undefined) {
    const trimmed = options.underlyingTicker.trim();
    if (trimmed === '') {
      throw new Error('underlyingTicker filter must not be empty');
    }
    underlyingTicker = trimmed;
  }

  const excludeAdjustedRoots = options.excludeAdjustedRoots ?? false;

  let sharesMap: Map<string, number> | null = null;
  if (options.sharesPerContractByTicker !== undefined) {
    sharesMap = new Map<string, number>();
    const entries: Iterable<readonly [string, number]> =
      options.sharesPerContractByTicker instanceof Map
        ? options.sharesPerContractByTicker.entries()
        : Object.entries(options.sharesPerContractByTicker);
    for (const [ticker, mult] of entries) {
      const cleanTicker = ticker.trim();
      if (cleanTicker === '') {
        throw new Error('sharesPerContractByTicker keys must be non-empty');
      }
      if (!isFiniteNumber(mult) || mult <= 0) {
        throw new Error(
          `sharesPerContractByTicker[${cleanTicker}] must be finite > 0 (got ${String(mult)})`,
        );
      }
      sharesMap.set(cleanTicker, mult);
    }
  }

  let defaultSharesPerContract: number | undefined;
  if (options.defaultSharesPerContract !== undefined) {
    if (!isFiniteNumber(options.defaultSharesPerContract) || options.defaultSharesPerContract <= 0) {
      throw new Error(
        `defaultSharesPerContract must be finite > 0 (got ${String(options.defaultSharesPerContract)})`,
      );
    }
    defaultSharesPerContract = options.defaultSharesPerContract;
  }

  let minNotional: number | undefined;
  if (options.minNotional !== undefined) {
    if (!isFiniteNumber(options.minNotional) || options.minNotional < 0) {
      throw new Error(
        `minNotional must be finite >= 0 (got ${String(options.minNotional)})`,
      );
    }
    minNotional = options.minNotional;
  }

  return {
    requiredFlags,
    flagMatchMode,
    rootsSet,
    underlyingTicker,
    excludeAdjustedRoots,
    sharesMap,
    defaultSharesPerContract,
    allowDefaultSharesOnAdjusted: options.allowDefaultSharesOnAdjusted ?? false,
    minNotional,
  };
}

function matchesFlagFilter(
  summary: UnusualTradeFlagsSummary,
  requiredFlags: readonly UnusualTradeFlag[],
  mode: UnusualTradeFlagMatchMode,
): boolean {
  if (requiredFlags.length === 0) {
    return true;
  }
  const hasFlag = (flag: UnusualTradeFlag): boolean => {
    switch (flag) {
      case 'block_premium':
        return summary.blockPremium;
      case 'block_size':
        return summary.blockSize;
      case 'iso':
        return summary.iso;
    }
  };
  return mode === 'all' ? requiredFlags.every(hasFlag) : requiredFlags.some(hasFlag);
}

function extractMassiveEnvelope(raw: unknown): {
  readonly rows: readonly unknown[];
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
} {
  if (!isRecord(raw)) {
    return { rows: [], malformedResponse: true, providerError: null };
  }

  let providerError: ProviderError | null = null;
  const status = raw['status'];
  if (typeof status === 'string' && status.toUpperCase() !== 'OK') {
    const rawMsg = raw['error'] ?? raw['message'];
    providerError = {
      code: 0,
      message: redact(toErrorMessage(rawMsg, status), []),
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

function compareUnusualTrades(a: UnusualTradeRecord, b: UnusualTradeRecord): number {
  if (a.time !== b.time) {
    return a.time - b.time;
  }
  if (a.subsecond.nanoseconds !== b.subsecond.nanoseconds) {
    return a.subsecond.nanoseconds - b.subsecond.nanoseconds;
  }

  const aHasSeq = Number.isFinite(a.sequenceNumber);
  const bHasSeq = Number.isFinite(b.sequenceNumber);
  if (aHasSeq && bHasSeq && a.sequenceNumber !== b.sequenceNumber) {
    return a.sequenceNumber - b.sequenceNumber;
  }
  if (aHasSeq !== bHasSeq) {
    return aHasSeq ? -1 : 1;
  }

  if (a.ticker !== b.ticker) {
    return a.ticker < b.ticker ? -1 : 1;
  }
  if (a.price !== b.price) {
    return a.price - b.price;
  }
  return a.size - b.size;
}

/**
 * Normaliza un payload crudo de `GET /options/v1/unusual-trades` a registros puros,
 * ordenados cronológicamente (segundos + subestructura ns + sequence_number),
 * sin mutar argumentos ni ocultar datos faltantes detrás de respaldos silenciosos.
 */
export function normalizeUnusualTrades(
  raw: unknown,
  options: NormalizeUnusualTradesOptions = {},
): UnusualTradesNormalizeResult {
  const resolved = resolveOptions(options);
  const counts = createDiscardCounts();
  const discards: UnusualTradeDiscardRecord[] = [];
  const recordDiscard = (
    cause: UnusualTradeDiscardCause,
    ticker: string | null,
    time: number | null,
  ): void => {
    counts[cause] += 1;
    discards.push({ cause, ticker, time });
  };

  const envelope = extractMassiveEnvelope(raw);
  if (envelope.providerError !== null || envelope.malformedResponse) {
    return {
      trades: [],
      report: {
        provider: 'massive',
        received: 0,
        accepted: 0,
        discarded: 0,
        filteredOut: 0,
        discardCounts: counts,
        discards,
        distinctRoots: [],
        distinctUnderlyingTickers: [],
        totalNotional: 0,
        knownNotionalSum: 0,
        validNotionalCount: 0,
        nanNotionalCount: 0,
        flagCounts: { blockPremium: 0, blockSize: 0, iso: 0 },
        reordered: false,
        malformedResponse: envelope.malformedResponse,
        providerError: envelope.providerError,
      },
    };
  }

  const accepted: UnusualTradeRecord[] = [];
  const seenKeys = new Set<string>();
  const distinctRootSet = new Set<string>();
  const distinctUnderlyingSet = new Set<string>();

  for (const row of envelope.rows) {
    if (!isRecord(row)) {
      recordDiscard('malformedRow', null, null);
      continue;
    }

    const ticker = readOptionalTrimmedString(row['ticker']);
    if (ticker === null) {
      recordDiscard('invalidTicker', null, null);
      continue;
    }

    const parsedTs = parseSipNanosecondTimestamp(row['sip_timestamp']);
    if (parsedTs === null) {
      recordDiscard('invalidTimestamp', ticker, null);
      continue;
    }

    const occ = parseOccTicker(ticker);
    const hasExplicitRoot = row['root'] !== undefined && row['root'] !== null;
    const rootRaw = readOptionalTrimmedString(row['root']);
    if (hasExplicitRoot && rootRaw === null) {
      recordDiscard('invalidRoot', ticker, parsedTs.time);
      continue;
    }
    const root = rootRaw ?? occ?.root ?? null;
    if (root === null) {
      recordDiscard('invalidRoot', ticker, parsedTs.time);
      continue;
    }

    const priceRaw = row['price'];
    const sizeRaw = row['size'];
    if (
      priceRaw === undefined ||
      priceRaw === null ||
      sizeRaw === undefined ||
      sizeRaw === null ||
      !isFiniteNumber(priceRaw) ||
      !isFiniteNumber(sizeRaw)
    ) {
      recordDiscard('nonFinite', ticker, parsedTs.time);
      continue;
    }
    if (priceRaw <= 0) {
      recordDiscard('invalidPrice', ticker, parsedTs.time);
      continue;
    }
    if (sizeRaw <= 0) {
      recordDiscard('invalidSize', ticker, parsedTs.time);
      continue;
    }

    const conditions = parseConditions(row['conditions']);
    if (conditions === null) {
      recordDiscard('malformedRow', ticker, parsedTs.time);
      continue;
    }

    const flags = parseFlags(row['flags'], conditions);
    if (flags === null) {
      recordDiscard('invalidFlags', ticker, parsedTs.time);
      continue;
    }

    const seqRaw = row['sequence_number'];
    let sequenceNumber: number;
    if (seqRaw === undefined || seqRaw === null) {
      sequenceNumber = Number.NaN;
    } else if (isFiniteNumber(seqRaw) && Number.isInteger(seqRaw) && seqRaw >= 0) {
      sequenceNumber = seqRaw;
    } else {
      recordDiscard('malformedRow', ticker, parsedTs.time);
      continue;
    }

    const exchRaw = row['exchange'];
    let exchange: number;
    if (exchRaw === undefined || exchRaw === null) {
      exchange = Number.NaN;
    } else if (isFiniteNumber(exchRaw) && Number.isInteger(exchRaw) && exchRaw >= 0) {
      exchange = exchRaw;
    } else {
      recordDiscard('malformedRow', ticker, parsedTs.time);
      continue;
    }

    const underlyingTicker = readOptionalTrimmedString(row['underlying_ticker']);
    const rootKind = classifyRoot(root, underlyingTicker, row['type']);

    let sharesPerContract: number;
    const rawShares = row['shares_per_contract'];
    if (rawShares !== undefined && rawShares !== null) {
      if (!isFiniteNumber(rawShares) || rawShares <= 0) {
        recordDiscard('invalidSharesPerContract', ticker, parsedTs.time);
        continue;
      }
      sharesPerContract = rawShares;
    } else if (resolved.sharesMap !== null && resolved.sharesMap.has(ticker)) {
      sharesPerContract = resolved.sharesMap.get(ticker) ?? Number.NaN;
    } else if (
      resolved.defaultSharesPerContract !== undefined &&
      ((rootKind !== 'adjusted' && rootKind !== 'binary') ||
        resolved.allowDefaultSharesOnAdjusted)
    ) {
      sharesPerContract = resolved.defaultSharesPerContract;
    } else {
      sharesPerContract = Number.NaN;
    }

    const notional = Number.isFinite(sharesPerContract)
      ? priceRaw * sizeRaw * sharesPerContract
      : Number.NaN;

    const dedupeKey = Number.isFinite(sequenceNumber)
      ? `${parsedTs.subsecond.timestampNs}|${String(sequenceNumber)}|${ticker}`
      : `${parsedTs.subsecond.timestampNs}|noseq|${ticker}|${String(priceRaw)}|${String(sizeRaw)}|${String(exchange)}`;

    if (seenKeys.has(dedupeKey)) {
      recordDiscard('duplicate', ticker, parsedTs.time);
      continue;
    }
    seenKeys.add(dedupeKey);

    if (
      (resolved.excludeAdjustedRoots && (rootKind === 'adjusted' || rootKind === 'binary')) ||
      (resolved.rootsSet !== null && !resolved.rootsSet.has(root)) ||
      (resolved.underlyingTicker !== undefined &&
        underlyingTicker !== resolved.underlyingTicker) ||
      !matchesFlagFilter(flags, resolved.requiredFlags, resolved.flagMatchMode) ||
      (resolved.minNotional !== undefined &&
        (!Number.isFinite(notional) || notional < resolved.minNotional))
    ) {
      recordDiscard('filteredOut', ticker, parsedTs.time);
      continue;
    }

    let contractType: 'call' | 'put' | null = occ?.contractType ?? null;
    const rawContractType = readOptionalTrimmedString(row['contract_type'])?.toLowerCase();
    if (rawContractType === 'call' || rawContractType === 'put') {
      contractType = rawContractType;
    }

    const expirationDate =
      parseOptionalCalendarDate(row['expiration_date']) ?? occ?.expirationDate ?? null;

    const rawStrike = row['strike_price'];
    const strikePrice =
      isFiniteNumber(rawStrike) && rawStrike > 0
        ? rawStrike
        : occ?.strikePrice ?? Number.NaN;

    distinctRootSet.add(root);
    if (underlyingTicker !== null) {
      distinctUnderlyingSet.add(underlyingTicker);
    }

    accepted.push({
      time: parsedTs.time,
      subsecond: parsedTs.subsecond,
      ticker,
      underlyingTicker,
      root,
      rootKind,
      expirationDate,
      contractType,
      strikePrice,
      price: priceRaw,
      size: sizeRaw,
      sharesPerContract,
      notional,
      exchange,
      conditions,
      flags,
      sequenceNumber,
    });
  }

  let reordered = false;
  for (let i = 1; i < accepted.length; i += 1) {
    const prev = accepted[i - 1];
    const curr = accepted[i];
    if (prev !== undefined && curr !== undefined && compareUnusualTrades(curr, prev) < 0) {
      reordered = true;
      break;
    }
  }
  if (reordered) {
    accepted.sort(compareUnusualTrades);
  }

  let knownNotionalSum = 0;
  let validNotionalCount = 0;
  let nanNotionalCount = 0;
  let blockPremiumCount = 0;
  let blockSizeCount = 0;
  let isoCount = 0;

  for (const trade of accepted) {
    if (Number.isFinite(trade.notional)) {
      knownNotionalSum += trade.notional;
      validNotionalCount += 1;
    } else {
      nanNotionalCount += 1;
    }
    if (trade.flags.blockPremium) {
      blockPremiumCount += 1;
    }
    if (trade.flags.blockSize) {
      blockSizeCount += 1;
    }
    if (trade.flags.iso) {
      isoCount += 1;
    }
  }

  const totalNotional =
    accepted.length === 0
      ? 0
      : nanNotionalCount === 0
        ? knownNotionalSum
        : Number.NaN;

  return {
    trades: accepted,
    report: {
      provider: 'massive',
      received: envelope.rows.length,
      accepted: accepted.length,
      discarded: discards.length,
      filteredOut: counts.filteredOut,
      discardCounts: counts,
      discards,
      distinctRoots: [...distinctRootSet].sort(),
      distinctUnderlyingTickers: [...distinctUnderlyingSet].sort(),
      totalNotional,
      knownNotionalSum,
      validNotionalCount,
      nanNotionalCount,
      flagCounts: {
        blockPremium: blockPremiumCount,
        blockSize: blockSizeCount,
        iso: isoCount,
      },
      reordered,
      malformedResponse: false,
      providerError: null,
    },
  };
}
