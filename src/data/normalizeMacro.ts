/**
 * Normalizadores puros e interpolador de curva Treasury para los endpoints
 * auxiliares de contexto de Massive (Pieza 4):
 *  - `GET /fed/v1/treasury-yields`
 *  - `GET /fed/v1/funding-conditions`
 *  - `GET /stocks/v1/dividends`
 *  - `GET /options/v1/open-interest`
 *  - `GET /v3/snapshot`
 *
 * Reglas estrictas (AGENTS.md / SPEC.md):
 *  - Funciones puras: sin red, sin `Date.now()`, sin mutar argumentos.
 *  - Timestamps normalizados en la entrada a segundos UTC enteros.
 *  - Tasas de interés (`/fed/v1/*`): Massive entrega porcentajes (`4.31` = 4.31 %),
 *    los normalizadores los convierten explícitamente a decimales (`0.0431`).
 *  - Prohibido enmascarar `NaN` (`?? 0`, `|| 0.05`): todo dato ausente o no
 *    calculable entra como `Number.NaN`.
 */

import { MAX_TIME_SECONDS } from '../core/sessions.js';
import { etWallTimeToUtc } from './alignment.js';
import type {
  DividendDiscardCause,
  DividendDiscardRecord,
  DividendRecord,
  DividendsNormalizeReport,
  DividendsNormalizeResult,
  ExtractTreasuryCurveOptions,
  FundingConditionsDiscardCause,
  FundingConditionsDiscardRecord,
  FundingConditionsNormalizeReport,
  FundingConditionsNormalizeResult,
  FundingConditionsObservation,
  InterpolateTreasuryCurveOptions,
  OpenInterestDiscardCause,
  OpenInterestDiscardRecord,
  OpenInterestNormalizeReport,
  OpenInterestNormalizeResult,
  OptionOpenInterestRecord,
  TreasuryCurvePoint,
  TreasuryTenorSpec,
  TreasuryYieldDiscardCause,
  TreasuryYieldDiscardRecord,
  TreasuryYieldObservation,
  TreasuryYieldsNormalizeReport,
  TreasuryYieldsNormalizeResult,
  UnifiedAssetClass,
  UnifiedIndexSnapshot,
  UnifiedLastMinute,
  UnifiedLastQuote,
  UnifiedLastTrade,
  UnifiedMarketStatus,
  UnifiedOptionDetails,
  UnifiedOptionSnapshot,
  UnifiedOtherAssetSnapshot,
  UnifiedSessionSummary,
  UnifiedSnapshotDiscardCause,
  UnifiedSnapshotDiscardRecord,
  UnifiedSnapshotNormalizeReport,
  UnifiedSnapshotNormalizeResult,
  UnifiedSnapshotTickerError,
  UnifiedStockSnapshot,
} from './macroTypes.js';
import {
  parseExpirationDate,
  parseProviderTimestampSeconds,
} from './normalizeOptions.js';
import {
  isFiniteNumber,
  isRecord,
  redact,
  toErrorMessage,
} from './normalizeShared.js';
import type {
  OptionContractType,
  OptionExerciseStyle,
  OptionGreeks,
  OptionUnderlyingSnapshot,
} from './optionsTypes.js';
import type { ProviderError } from './types.js';

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_PER_YEAR_365 = 365;
const MARKET_OPEN_MINUTES_ET = 9 * 60 + 30;
const DEFAULT_SHARES_PER_CONTRACT = 100;

/**
 * Definición ordenada de los 11 tenores constantes de US Treasury entregados por
 * `/fed/v1/treasury-yields`, expresados en fracciones de año exactas (`1/12` .. `30`).
 */
export const TREASURY_TENORS: readonly TreasuryTenorSpec[] = Object.freeze([
  { field: 'yield_1_month', key: 'yield1Month', label: '1M', years: 1 / 12 },
  { field: 'yield_3_month', key: 'yield3Month', label: '3M', years: 3 / 12 },
  { field: 'yield_6_month', key: 'yield6Month', label: '6M', years: 6 / 12 },
  { field: 'yield_1_year', key: 'yield1Year', label: '1Y', years: 1 },
  { field: 'yield_2_year', key: 'yield2Year', label: '2Y', years: 2 },
  { field: 'yield_3_year', key: 'yield3Year', label: '3Y', years: 3 },
  { field: 'yield_5_year', key: 'yield5Year', label: '5Y', years: 5 },
  { field: 'yield_7_year', key: 'yield7Year', label: '7Y', years: 7 },
  { field: 'yield_10_year', key: 'yield10Year', label: '10Y', years: 10 },
  { field: 'yield_20_year', key: 'yield20Year', label: '20Y', years: 20 },
  { field: 'yield_30_year', key: 'yield30Year', label: '30Y', years: 30 },
]);

interface MassiveEnvelope {
  readonly rows: readonly unknown[];
  readonly malformedResponse: boolean;
  readonly providerError: ProviderError | null;
}

interface ParsedCalendarDate {
  readonly date: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly utcMidnightSeconds: number;
}

function parseMassiveEnvelope(raw: unknown): MassiveEnvelope {
  if (!isRecord(raw)) {
    return { rows: [], malformedResponse: true, providerError: null };
  }

  const status = raw['status'];
  if (typeof status === 'string' && status.toUpperCase() !== 'OK') {
    const errRaw = raw['error'] ?? raw['message'] ?? status;
    return {
      rows: [],
      malformedResponse: false,
      providerError: {
        code: 0,
        message: redact(toErrorMessage(errRaw, status), []),
      },
    };
  }

  const results = raw['results'];
  if (results === undefined || results === null) {
    return { rows: [], malformedResponse: false, providerError: null };
  }
  if (!Array.isArray(results)) {
    return { rows: [], malformedResponse: true, providerError: null };
  }
  return { rows: results, malformedResponse: false, providerError: null };
}

/**
 * Valida una fecha calendario `YYYY-MM-DD` (soporta historia Fed desde `1900`
 * hasta `2200`) y calcula su medianoche UTC en segundos enteros.
 */
export function parseCalendarDate(value: unknown): ParsedCalendarDate | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = CALENDAR_DATE_RE.exec(value.trim());
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
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

  const utcMidnightSeconds = Math.trunc(utcMidnightMs / 1_000);
  if (!Number.isSafeInteger(utcMidnightSeconds) || Math.abs(utcMidnightSeconds) > MAX_TIME_SECONDS) {
    return null;
  }

  return {
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year,
    month,
    day,
    utcMidnightSeconds,
  };
}

/**
 * Convierte explícitamente un rendimiento porcentual del proveedor (`4.31` = 4.31 %)
 * a tasa anualizada decimal (`0.0431`). Devuelve `NaN` si falta o no es finito.
 */
export function percentToDecimalRate(value: unknown): number {
  return isFiniteNumber(value) ? value / 100 : Number.NaN;
}

function toFiniteOrNaN(value: unknown): number {
  return isFiniteNumber(value) ? value : Number.NaN;
}

function toNonNegativeOrNaN(value: unknown): number {
  return isFiniteNumber(value) && value >= 0 ? value : Number.NaN;
}

function toPositiveOrNaN(value: unknown): number {
  return isFiniteNumber(value) && value > 0 ? value : Number.NaN;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseOptionalDateString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return parseCalendarDate(value)?.date ?? null;
}

function countFinite(values: readonly number[]): number {
  let count = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// 1) Curva US Treasury (`/fed/v1/treasury-yields`) + Interpolación
// ---------------------------------------------------------------------------

/** Normaliza la respuesta cruda de `GET /fed/v1/treasury-yields`. */
export function normalizeTreasuryYields(raw: unknown): TreasuryYieldsNormalizeResult {
  const counts: Record<TreasuryYieldDiscardCause, number> = {
    malformedRow: 0,
    invalidDate: 0,
    missingRates: 0,
    duplicate: 0,
  };
  const discards: TreasuryYieldDiscardRecord[] = [];
  const recordDiscard = (cause: TreasuryYieldDiscardCause, date: string | null): void => {
    counts[cause] += 1;
    discards.push({ cause, date });
  };

  const envelope = parseMassiveEnvelope(raw);
  if (envelope.providerError !== null || envelope.malformedResponse) {
    return {
      observations: [],
      report: {
        provider: 'massive',
        received: 0,
        accepted: 0,
        discarded: 0,
        discardCounts: counts,
        discards,
        reordered: false,
        malformedResponse: envelope.malformedResponse,
        providerError: envelope.providerError,
      },
    };
  }

  const seenDates = new Set<string>();
  const accepted: TreasuryYieldObservation[] = [];

  for (const row of envelope.rows) {
    if (!isRecord(row)) {
      recordDiscard('malformedRow', null);
      continue;
    }

    const parsedDate = parseCalendarDate(row['date']);
    if (parsedDate === null) {
      recordDiscard('invalidDate', readOptionalString(row['date']));
      continue;
    }

    const yield1Month = percentToDecimalRate(row['yield_1_month']);
    const yield3Month = percentToDecimalRate(row['yield_3_month']);
    const yield6Month = percentToDecimalRate(row['yield_6_month']);
    const yield1Year = percentToDecimalRate(row['yield_1_year']);
    const yield2Year = percentToDecimalRate(row['yield_2_year']);
    const yield3Year = percentToDecimalRate(row['yield_3_year']);
    const yield5Year = percentToDecimalRate(row['yield_5_year']);
    const yield7Year = percentToDecimalRate(row['yield_7_year']);
    const yield10Year = percentToDecimalRate(row['yield_10_year']);
    const yield20Year = percentToDecimalRate(row['yield_20_year']);
    const yield30Year = percentToDecimalRate(row['yield_30_year']);

    const finiteTenors = countFinite([
      yield1Month,
      yield3Month,
      yield6Month,
      yield1Year,
      yield2Year,
      yield3Year,
      yield5Year,
      yield7Year,
      yield10Year,
      yield20Year,
      yield30Year,
    ]);

    if (finiteTenors === 0) {
      recordDiscard('missingRates', parsedDate.date);
      continue;
    }

    if (seenDates.has(parsedDate.date)) {
      recordDiscard('duplicate', parsedDate.date);
      continue;
    }
    seenDates.add(parsedDate.date);

    accepted.push({
      date: parsedDate.date,
      dateTime: parsedDate.utcMidnightSeconds,
      yield1Month,
      yield3Month,
      yield6Month,
      yield1Year,
      yield2Year,
      yield3Year,
      yield5Year,
      yield7Year,
      yield10Year,
      yield20Year,
      yield30Year,
      finiteTenors,
    });
  }

  let reordered = false;
  for (let i = 1; i < accepted.length; i += 1) {
    const prev = accepted[i - 1];
    const curr = accepted[i];
    if (prev !== undefined && curr !== undefined && curr.date < prev.date) {
      reordered = true;
      break;
    }
  }
  if (reordered) {
    accepted.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  const report: TreasuryYieldsNormalizeReport = {
    provider: 'massive',
    received: envelope.rows.length,
    accepted: accepted.length,
    discarded: discards.length,
    discardCounts: counts,
    discards,
    reordered,
    malformedResponse: false,
    providerError: null,
  };

  return { observations: accepted, report };
}

/**
 * Extrae los nodos `(tenorYears, rate)` ordenados de una observación Treasury
 * (más una tasa overnight opcional como SOFR en `1/365` año).
 *
 * Con `allowMissingTenors = false` (por defecto), los tenores ausentes/`NaN`
 * permanecen en la salida para que el interpolador rechace curvas incompletas en
 * lugar de interpolar en silencio; con `allowMissingTenors = true`, se filtran
 * solo los tenores finitos.
 */
export function extractTreasuryCurvePoints(
  observation: TreasuryYieldObservation,
  options?: ExtractTreasuryCurveOptions,
): readonly TreasuryCurvePoint[] {
  const allowMissing = options?.allowMissingTenors ?? false;
  const points: TreasuryCurvePoint[] = [];

  if (options?.overnightRate !== undefined) {
    points.push({
      tenorYears: 1 / DAYS_PER_YEAR_365,
      tenorLabel: 'ON',
      rate: options.overnightRate,
      sourceField: 'overnightRate',
    });
  }

  for (const spec of TREASURY_TENORS) {
    const rate = observation[spec.key];
    if (allowMissing && !Number.isFinite(rate)) {
      continue;
    }
    points.push({
      tenorYears: spec.years,
      tenorLabel: spec.label,
      rate,
      sourceField: spec.field,
    });
  }

  return points;
}

/**
 * Interpola de forma pura la tasa libre de riesgo decimal `r(T)` para un plazo
 * `tenorYears >= 0` dado sobre una curva Treasury (observación normalizada o
 * arreglo de nodos `{ tenorYears, rate }`).
 *
 * Modos soportados:
 *  - `'linear'` (por defecto): interpolación lineal sobre `r(T)`:
 *    `r(T) = r0 + ((T - T0) / (T1 - T0)) * (r1 - r0)`.
 *  - `'logLinear'`: interpolación log-lineal sobre factores de descuento
 *    `P(T) = exp(-r(T) * T)` (equivalente a tasa integrada `r(T) * T` lineal a tramos
 *    con tasa forward instantánea constante entre tenores, definida también en tasas `<= 0`):
 *    `r(T) = (r0 * T0 + ((T - T0) / (T1 - T0)) * (r1 * T1 - r0 * T0)) / T`.
 *
 * Devuelve `Number.NaN` explícitamente (sin valores de respaldo) cuando:
 *  - la curva está vacía;
 *  - algún punto tiene `tenorYears <= 0`, no finito, duplicado, o `rate` no finito;
 *  - `tenorYears < 0` o no es finito;
 *  - `extrapolation === 'nan'` y `tenorYears` cae fuera de `[T_min, T_max]`.
 */
const VALID_INTERP_METHODS = new Set<string>(['linear', 'logLinear']);
const VALID_EXTRAP_MODES = new Set<string>(['clamp', 'nan']);

function isCurvePointArray(
  value: TreasuryYieldObservation | readonly TreasuryCurvePoint[],
): value is readonly TreasuryCurvePoint[] {
  return Array.isArray(value);
}

export function interpolateTreasuryYield(
  curveOrObservation: TreasuryYieldObservation | readonly TreasuryCurvePoint[],
  tenorYears: number,
  options?: InterpolateTreasuryCurveOptions,
): number {
  if (!Number.isFinite(tenorYears) || tenorYears < 0) {
    return Number.NaN;
  }

  const method = options?.method ?? 'linear';
  const extrapolation = options?.extrapolation ?? 'clamp';
  if (!VALID_INTERP_METHODS.has(method) || !VALID_EXTRAP_MODES.has(extrapolation)) {
    return Number.NaN;
  }

  const rawPoints = isCurvePointArray(curveOrObservation)
    ? curveOrObservation
    : extractTreasuryCurvePoints(curveOrObservation, options);

  if (rawPoints.length === 0) {
    return Number.NaN;
  }

  const sortedPoints: TreasuryCurvePoint[] = [];
  for (const point of rawPoints) {
    if (!Number.isFinite(point.tenorYears) || point.tenorYears <= 0 || !Number.isFinite(point.rate)) {
      return Number.NaN;
    }
    sortedPoints.push(point);
  }

  sortedPoints.sort((a, b) => a.tenorYears - b.tenorYears);

  for (let i = 1; i < sortedPoints.length; i += 1) {
    const prev = sortedPoints[i - 1];
    const curr = sortedPoints[i];
    if (prev !== undefined && curr !== undefined && curr.tenorYears === prev.tenorYears) {
      return Number.NaN;
    }
  }

  const first = sortedPoints[0];
  const last = sortedPoints[sortedPoints.length - 1];
  if (first === undefined || last === undefined) {
    return Number.NaN;
  }

  if (tenorYears < first.tenorYears) {
    return extrapolation === 'nan' ? Number.NaN : first.rate;
  }
  if (tenorYears === first.tenorYears) {
    return first.rate;
  }
  if (tenorYears > last.tenorYears) {
    return extrapolation === 'nan' ? Number.NaN : last.rate;
  }
  if (tenorYears === last.tenorYears) {
    return last.rate;
  }

  for (let i = 0; i < sortedPoints.length - 1; i += 1) {
    const left = sortedPoints[i];
    const right = sortedPoints[i + 1];
    if (left === undefined || right === undefined) {
      return Number.NaN;
    }
    if (tenorYears === left.tenorYears) {
      return left.rate;
    }
    if (tenorYears === right.tenorYears) {
      return right.rate;
    }
    if (tenorYears > left.tenorYears && tenorYears < right.tenorYears) {
      const span = right.tenorYears - left.tenorYears;
      if (span <= 0) {
        return Number.NaN;
      }
      const weight = (tenorYears - left.tenorYears) / span;
      if (method === 'linear') {
        return left.rate + weight * (right.rate - left.rate);
      }
      // Log-lineal en factor de descuento P(T) = exp(-r(T) * T)
      const integratedLeft = left.rate * left.tenorYears;
      const integratedRight = right.rate * right.tenorYears;
      return (integratedLeft + weight * (integratedRight - integratedLeft)) / tenorYears;
    }
  }

  return Number.NaN;
}

// ---------------------------------------------------------------------------
// 2) Condiciones de Fondeo / SOFR (`/fed/v1/funding-conditions`)
// ---------------------------------------------------------------------------

/** Normaliza la respuesta cruda de `GET /fed/v1/funding-conditions`. */
export function normalizeFundingConditions(raw: unknown): FundingConditionsNormalizeResult {
  const counts: Record<FundingConditionsDiscardCause, number> = {
    malformedRow: 0,
    invalidDate: 0,
    missingRates: 0,
    duplicate: 0,
  };
  const discards: FundingConditionsDiscardRecord[] = [];
  const recordDiscard = (cause: FundingConditionsDiscardCause, date: string | null): void => {
    counts[cause] += 1;
    discards.push({ cause, date });
  };

  const envelope = parseMassiveEnvelope(raw);
  if (envelope.providerError !== null || envelope.malformedResponse) {
    return {
      observations: [],
      report: {
        provider: 'massive',
        received: 0,
        accepted: 0,
        discarded: 0,
        discardCounts: counts,
        discards,
        reordered: false,
        malformedResponse: envelope.malformedResponse,
        providerError: envelope.providerError,
      },
    };
  }

  const seenDates = new Set<string>();
  const accepted: FundingConditionsObservation[] = [];

  for (const row of envelope.rows) {
    if (!isRecord(row)) {
      recordDiscard('malformedRow', null);
      continue;
    }

    const parsedDate = parseCalendarDate(row['date']);
    if (parsedDate === null) {
      recordDiscard('invalidDate', readOptionalString(row['date']));
      continue;
    }

    const effectiveFedFundsRate = percentToDecimalRate(row['effective_fed_funds_rate']);
    const interestOnReserveBalances = percentToDecimalRate(row['interest_on_reserve_balances']);
    const targetRangeLower = percentToDecimalRate(row['target_range_lower']);
    const targetRangeUpper = percentToDecimalRate(row['target_range_upper']);
    const sofr = percentToDecimalRate(row['secured_overnight_financing_rate']);
    const sofrPercentile1 = percentToDecimalRate(row['sofr_percentile_1']);
    const sofrPercentile25 = percentToDecimalRate(row['sofr_percentile_25']);
    const sofrPercentile75 = percentToDecimalRate(row['sofr_percentile_75']);
    const sofrPercentile99 = percentToDecimalRate(row['sofr_percentile_99']);
    const overnightBankFundingRate = percentToDecimalRate(row['overnight_bank_funding_rate']);

    const finiteRateCount = countFinite([
      effectiveFedFundsRate,
      interestOnReserveBalances,
      targetRangeLower,
      targetRangeUpper,
      sofr,
      sofrPercentile1,
      sofrPercentile25,
      sofrPercentile75,
      sofrPercentile99,
      overnightBankFundingRate,
    ]);

    if (finiteRateCount === 0) {
      recordDiscard('missingRates', parsedDate.date);
      continue;
    }

    if (seenDates.has(parsedDate.date)) {
      recordDiscard('duplicate', parsedDate.date);
      continue;
    }
    seenDates.add(parsedDate.date);

    accepted.push({
      date: parsedDate.date,
      dateTime: parsedDate.utcMidnightSeconds,
      effectiveFedFundsRate,
      effectiveFedFundsVolume: toNonNegativeOrNaN(row['effective_fed_funds_volume']),
      interestOnReserveBalances,
      targetRangeLower,
      targetRangeUpper,
      sofr,
      sofrVolume: toNonNegativeOrNaN(row['sofr_volume']),
      sofrPercentile1,
      sofrPercentile25,
      sofrPercentile75,
      sofrPercentile99,
      overnightBankFundingRate,
      obfrVolume: toNonNegativeOrNaN(row['obfr_volume']),
      overnightRepoOperationAmount: toNonNegativeOrNaN(row['overnight_repo_operation_amount']),
      overnightReverseRepoOperationAmount: toNonNegativeOrNaN(
        row['overnight_reverse_repo_operation_amount'],
      ),
    });
  }

  let reordered = false;
  for (let i = 1; i < accepted.length; i += 1) {
    const prev = accepted[i - 1];
    const curr = accepted[i];
    if (prev !== undefined && curr !== undefined && curr.date < prev.date) {
      reordered = true;
      break;
    }
  }
  if (reordered) {
    accepted.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  const report: FundingConditionsNormalizeReport = {
    provider: 'massive',
    received: envelope.rows.length,
    accepted: accepted.length,
    discarded: discards.length,
    discardCounts: counts,
    discards,
    reordered,
    malformedResponse: false,
    providerError: null,
  };

  return { observations: accepted, report };
}

// ---------------------------------------------------------------------------
// 3) Dividendos corporativos (`/stocks/v1/dividends`)
// ---------------------------------------------------------------------------

/** Normaliza la respuesta cruda de `GET /stocks/v1/dividends`. */
export function normalizeDividends(raw: unknown): DividendsNormalizeResult {
  const counts: Record<DividendDiscardCause, number> = {
    malformedRow: 0,
    invalidTicker: 0,
    invalidExDividendDate: 0,
    invalidCashAmount: 0,
    duplicate: 0,
  };
  const discards: DividendDiscardRecord[] = [];
  const recordDiscard = (
    cause: DividendDiscardCause,
    ticker: string | null,
    exDividendDate: string | null,
  ): void => {
    counts[cause] += 1;
    discards.push({ cause, ticker, exDividendDate });
  };

  const envelope = parseMassiveEnvelope(raw);
  if (envelope.providerError !== null || envelope.malformedResponse) {
    return {
      dividends: [],
      report: {
        provider: 'massive',
        received: 0,
        accepted: 0,
        discarded: 0,
        discardCounts: counts,
        discards,
        reordered: false,
        malformedResponse: envelope.malformedResponse,
        providerError: envelope.providerError,
      },
    };
  }

  const seenKeys = new Set<string>();
  const accepted: DividendRecord[] = [];

  for (const row of envelope.rows) {
    if (!isRecord(row)) {
      recordDiscard('malformedRow', null, null);
      continue;
    }

    const tickerRaw = readOptionalString(row['ticker']);
    const ticker = tickerRaw === null ? null : tickerRaw.toUpperCase();
    const rawExDiv = readOptionalString(row['ex_dividend_date']);

    if (ticker === null) {
      recordDiscard('invalidTicker', null, rawExDiv);
      continue;
    }

    const parsedExDiv = parseCalendarDate(row['ex_dividend_date']);
    if (parsedExDiv === null) {
      recordDiscard('invalidExDividendDate', ticker, rawExDiv);
      continue;
    }

    const exDividendTime = etWallTimeToUtc(
      parsedExDiv.year,
      parsedExDiv.month,
      parsedExDiv.day,
      MARKET_OPEN_MINUTES_ET,
    );
    if (!Number.isFinite(exDividendTime) || Math.abs(exDividendTime) > MAX_TIME_SECONDS) {
      recordDiscard('invalidExDividendDate', ticker, parsedExDiv.date);
      continue;
    }

    const cashAmount = toNonNegativeOrNaN(row['cash_amount']);
    if (!Number.isFinite(cashAmount)) {
      recordDiscard('invalidCashAmount', ticker, parsedExDiv.date);
      continue;
    }

    const id = readOptionalString(row['id']);
    const distributionType = readOptionalString(row['distribution_type']);
    const dedupeKey =
      id !== null
        ? `id:${id}`
        : `k:${ticker}|${parsedExDiv.date}|${distributionType ?? ''}|${String(cashAmount)}`;
    if (seenKeys.has(dedupeKey)) {
      recordDiscard('duplicate', ticker, parsedExDiv.date);
      continue;
    }
    seenKeys.add(dedupeKey);

    const frequencyRaw = row['frequency'];
    const frequency =
      isFiniteNumber(frequencyRaw) && Number.isInteger(frequencyRaw) && frequencyRaw >= 0
        ? frequencyRaw
        : Number.NaN;

    accepted.push({
      id,
      ticker,
      declarationDate: parseOptionalDateString(row['declaration_date']),
      exDividendDate: parsedExDiv.date,
      exDividendTime,
      recordDate: parseOptionalDateString(row['record_date']),
      payDate: parseOptionalDateString(row['pay_date']),
      cashAmount,
      splitAdjustedCashAmount: toNonNegativeOrNaN(row['split_adjusted_cash_amount']),
      historicalAdjustmentFactor: toPositiveOrNaN(
        row['historical_adjustment_factor'] ?? row['adjustment_factor'],
      ),
      frequency,
      currency: readOptionalString(row['currency']),
      distributionType,
    });
  }

  let reordered = false;
  const compareDivs = (a: DividendRecord, b: DividendRecord): number => {
    if (a.exDividendDate !== b.exDividendDate) {
      return a.exDividendDate < b.exDividendDate ? -1 : 1;
    }
    if (a.ticker !== b.ticker) {
      return a.ticker < b.ticker ? -1 : 1;
    }
    if (a.cashAmount !== b.cashAmount) {
      return a.cashAmount - b.cashAmount;
    }
    const ida = a.id ?? '';
    const idb = b.id ?? '';
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  };
  for (let i = 1; i < accepted.length; i += 1) {
    const prev = accepted[i - 1];
    const curr = accepted[i];
    if (prev !== undefined && curr !== undefined && compareDivs(curr, prev) < 0) {
      reordered = true;
      break;
    }
  }
  if (reordered) {
    accepted.sort(compareDivs);
  }

  const report: DividendsNormalizeReport = {
    provider: 'massive',
    received: envelope.rows.length,
    accepted: accepted.length,
    discarded: discards.length,
    discardCounts: counts,
    discards,
    reordered,
    malformedResponse: false,
    providerError: null,
  };

  return { dividends: accepted, report };
}

// ---------------------------------------------------------------------------
// 4) Open Interest histórico (`/options/v1/open-interest`)
// ---------------------------------------------------------------------------

function parseContractTypeField(value: unknown): OptionContractType | null {
  if (typeof value !== 'string') {
    return null;
  }
  const lower = value.trim().toLowerCase();
  if (lower === 'call' || lower === 'put' || lower === 'other') {
    return lower;
  }
  return null;
}

/** Normaliza la respuesta cruda de `GET /options/v1/open-interest`. */
export function normalizeOptionOpenInterest(raw: unknown): OpenInterestNormalizeResult {
  const counts: Record<OpenInterestDiscardCause, number> = {
    malformedRow: 0,
    invalidTicker: 0,
    invalidDate: 0,
    invalidExpiration: 0,
    invalidStrike: 0,
    invalidContractType: 0,
    invalidOpenInterest: 0,
    duplicate: 0,
  };
  const discards: OpenInterestDiscardRecord[] = [];
  const recordDiscard = (
    cause: OpenInterestDiscardCause,
    ticker: string | null,
    date: string | null,
  ): void => {
    counts[cause] += 1;
    discards.push({ cause, ticker, date });
  };

  const envelope = parseMassiveEnvelope(raw);
  if (envelope.providerError !== null || envelope.malformedResponse) {
    return {
      records: [],
      report: {
        provider: 'massive',
        received: 0,
        accepted: 0,
        discarded: 0,
        discardCounts: counts,
        discards,
        reordered: false,
        malformedResponse: envelope.malformedResponse,
        providerError: envelope.providerError,
      },
    };
  }

  const seenKeys = new Set<string>();
  const accepted: OptionOpenInterestRecord[] = [];

  for (const row of envelope.rows) {
    if (!isRecord(row)) {
      recordDiscard('malformedRow', null, null);
      continue;
    }

    const ticker = readOptionalString(row['ticker']);
    const rawDate = readOptionalString(row['date']);
    if (ticker === null) {
      recordDiscard('invalidTicker', null, rawDate);
      continue;
    }

    const parsedDate = parseCalendarDate(row['date']);
    if (parsedDate === null) {
      recordDiscard('invalidDate', ticker, rawDate);
      continue;
    }

    const parsedExp = parseExpirationDate(row['expiration_date']);
    if (parsedExp === null) {
      recordDiscard('invalidExpiration', ticker, parsedDate.date);
      continue;
    }

    const strikePrice = toPositiveOrNaN(row['strike_price']);
    if (!Number.isFinite(strikePrice)) {
      recordDiscard('invalidStrike', ticker, parsedDate.date);
      continue;
    }

    const contractType = parseContractTypeField(row['contract_type']);
    if (contractType === null) {
      recordDiscard('invalidContractType', ticker, parsedDate.date);
      continue;
    }

    const oiRaw = row['open_interest'];
    if (!isFiniteNumber(oiRaw) || !Number.isInteger(oiRaw) || oiRaw < 0) {
      recordDiscard('invalidOpenInterest', ticker, parsedDate.date);
      continue;
    }

    const dedupeKey = `${parsedDate.date}|${ticker}`;
    if (seenKeys.has(dedupeKey)) {
      recordDiscard('duplicate', ticker, parsedDate.date);
      continue;
    }
    seenKeys.add(dedupeKey);

    const rootRaw = readOptionalString(row['root']);
    const underlyingRaw = readOptionalString(row['underlying_ticker'] ?? row['underlying']);

    accepted.push({
      ticker,
      root: rootRaw === null ? null : rootRaw.toUpperCase(),
      underlyingTicker: underlyingRaw === null ? null : underlyingRaw.toUpperCase(),
      date: parsedDate.date,
      dateTime: parsedDate.utcMidnightSeconds,
      expirationDate: parsedExp.date,
      expirationTime: parsedExp.time,
      strikePrice,
      contractType,
      openInterest: oiRaw,
    });
  }

  let reordered = false;
  const compareOi = (a: OptionOpenInterestRecord, b: OptionOpenInterestRecord): number => {
    if (a.date !== b.date) {
      return a.date < b.date ? -1 : 1;
    }
    return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
  };
  for (let i = 1; i < accepted.length; i += 1) {
    const prev = accepted[i - 1];
    const curr = accepted[i];
    if (prev !== undefined && curr !== undefined && compareOi(curr, prev) < 0) {
      reordered = true;
      break;
    }
  }
  if (reordered) {
    accepted.sort(compareOi);
  }

  const report: OpenInterestNormalizeReport = {
    provider: 'massive',
    received: envelope.rows.length,
    accepted: accepted.length,
    discarded: discards.length,
    discardCounts: counts,
    discards,
    reordered,
    malformedResponse: false,
    providerError: null,
  };

  return { records: accepted, report };
}

// ---------------------------------------------------------------------------
// 5) Unified Multi-Asset Snapshot (`/v3/snapshot`)
// ---------------------------------------------------------------------------

function classifyUnifiedAssetType(rawType: string | null): UnifiedAssetClass | null {
  if (rawType === null) {
    return null;
  }
  const normalized = rawType.toLowerCase();
  if (normalized === 'stocks' || normalized === 'stock') {
    return 'stocks';
  }
  if (normalized === 'indices' || normalized === 'index') {
    return 'indices';
  }
  if (normalized === 'options' || normalized === 'option') {
    return 'options';
  }
  if (normalized === 'fx' || normalized === 'forex') {
    return 'fx';
  }
  if (normalized === 'crypto') {
    return 'crypto';
  }
  return null;
}

function parseExerciseStyleField(value: unknown): OptionExerciseStyle | null {
  if (value === 'american' || value === 'european' || value === 'bermudan') {
    return value;
  }
  return null;
}

function parseIntegerConditions(value: unknown): readonly number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const conditions: number[] = [];
  for (const item of value) {
    if (isFiniteNumber(item) && Number.isInteger(item)) {
      conditions.push(item);
    }
  }
  return conditions;
}

/**
 * Normaliza la respuesta cruda de `GET /v3/snapshot` separando `stocks`,
 * `indices`, `options` y `other`, preservando errores parciales por ticker
 * (`NOT_ENTITLED`, `NOT_FOUND`, etc.) sin abortar el lote y soportando `NaN`
 * cuando `early_trading` omite OHLC de sesión o `overnight_trading` está activo.
 */
export function normalizeUnifiedSnapshot(raw: unknown): UnifiedSnapshotNormalizeResult {
  const counts: Record<UnifiedSnapshotDiscardCause, number> = {
    malformedRow: 0,
    missingTicker: 0,
    unknownAssetType: 0,
    duplicate: 0,
  };
  const discards: UnifiedSnapshotDiscardRecord[] = [];
  let invalidTimestamps = 0;

  const parseTimestamp = (value: unknown): number => {
    const res = parseProviderTimestampSeconds(value);
    if (res.hadInvalidInput) {
      invalidTimestamps += 1;
    }
    return res.value;
  };

  const recordDiscard = (cause: UnifiedSnapshotDiscardCause, ticker: string | null): void => {
    counts[cause] += 1;
    discards.push({ cause, ticker });
  };

  const envelope = parseMassiveEnvelope(raw);
  if (envelope.providerError !== null || envelope.malformedResponse) {
    return {
      stocks: [],
      indices: [],
      options: [],
      other: [],
      tickerErrors: [],
      report: {
        provider: 'massive',
        received: 0,
        accepted: 0,
        errorCount: 0,
        discarded: 0,
        discardCounts: counts,
        discards,
        stocksCount: 0,
        indicesCount: 0,
        optionsCount: 0,
        otherCount: 0,
        earlyTradingWithoutOhlc: 0,
        overnightTradingCount: 0,
        invalidTimestamps: 0,
        reordered: false,
        malformedResponse: envelope.malformedResponse,
        providerError: envelope.providerError,
      },
    };
  }

  const parseSession = (rawSession: unknown): UnifiedSessionSummary => {
    if (!isRecord(rawSession)) {
      return {
        open: Number.NaN,
        high: Number.NaN,
        low: Number.NaN,
        close: Number.NaN,
        volume: Number.NaN,
        vwap: Number.NaN,
        price: Number.NaN,
        previousClose: Number.NaN,
        change: Number.NaN,
        changePercent: Number.NaN,
        earlyTradingChange: Number.NaN,
        earlyTradingChangePercent: Number.NaN,
        lateTradingChange: Number.NaN,
        lateTradingChangePercent: Number.NaN,
        lastUpdated: Number.NaN,
        hasOhlc: false,
      };
    }

    const open = toFiniteOrNaN(rawSession['open']);
    const high = toFiniteOrNaN(rawSession['high']);
    const low = toFiniteOrNaN(rawSession['low']);
    const close = toFiniteOrNaN(rawSession['close']);
    return {
      open,
      high,
      low,
      close,
      volume: toNonNegativeOrNaN(rawSession['volume']),
      vwap: toFiniteOrNaN(rawSession['vwap']),
      price: toFiniteOrNaN(rawSession['price']),
      previousClose: toFiniteOrNaN(rawSession['previous_close']),
      change: toFiniteOrNaN(rawSession['change'] ?? rawSession['todays_change']),
      changePercent: toFiniteOrNaN(
        rawSession['change_percent'] ?? rawSession['todays_change_percent'],
      ),
      earlyTradingChange: toFiniteOrNaN(rawSession['early_trading_change']),
      earlyTradingChangePercent: toFiniteOrNaN(rawSession['early_trading_change_percent']),
      lateTradingChange: toFiniteOrNaN(rawSession['late_trading_change']),
      lateTradingChangePercent: toFiniteOrNaN(rawSession['late_trading_change_percent']),
      lastUpdated: parseTimestamp(rawSession['last_updated']),
      hasOhlc:
        Number.isFinite(open) &&
        Number.isFinite(high) &&
        Number.isFinite(low) &&
        Number.isFinite(close),
    };
  };

  const parseLastQuote = (rawQuote: unknown): UnifiedLastQuote | null => {
    if (!isRecord(rawQuote)) {
      return null;
    }
    const bid = toNonNegativeOrNaN(rawQuote['bid'] ?? rawQuote['p'] ?? rawQuote['b']);
    const ask = toNonNegativeOrNaN(rawQuote['ask'] ?? rawQuote['P'] ?? rawQuote['a']);
    const midpoint = toNonNegativeOrNaN(rawQuote['midpoint']);
    const bidSize = toNonNegativeOrNaN(rawQuote['bid_size'] ?? rawQuote['s']);
    const askSize = toNonNegativeOrNaN(rawQuote['ask_size'] ?? rawQuote['S']);
    const updatedAt = parseTimestamp(
      rawQuote['last_updated'] ?? rawQuote['sip_timestamp'] ?? rawQuote['t'],
    );
    const timeframe = readOptionalString(rawQuote['timeframe']);

    return {
      bid,
      ask,
      midpoint,
      bidSize,
      askSize,
      updatedAt,
      timeframe,
    };
  };

  const parseLastTrade = (rawTrade: unknown): UnifiedLastTrade | null => {
    if (!isRecord(rawTrade)) {
      return null;
    }
    const price = toPositiveOrNaN(rawTrade['price'] ?? rawTrade['p']);
    const size = toNonNegativeOrNaN(rawTrade['size'] ?? rawTrade['s']);
    const exchangeRaw = rawTrade['exchange'] ?? rawTrade['x'];
    const exchange =
      isFiniteNumber(exchangeRaw) && Number.isInteger(exchangeRaw) ? exchangeRaw : null;
    const conditions = parseIntegerConditions(rawTrade['conditions'] ?? rawTrade['c']);
    const timestamp = parseTimestamp(
      rawTrade['sip_timestamp'] ?? rawTrade['last_updated'] ?? rawTrade['t'],
    );
    const timeframe = readOptionalString(rawTrade['timeframe']);

    return {
      price,
      size,
      exchange,
      conditions,
      timestamp,
      timeframe,
    };
  };

  const parseLastMinute = (rawMinute: unknown): UnifiedLastMinute | null => {
    if (!isRecord(rawMinute)) {
      return null;
    }
    return {
      open: toFiniteOrNaN(rawMinute['open'] ?? rawMinute['o']),
      high: toFiniteOrNaN(rawMinute['high'] ?? rawMinute['h']),
      low: toFiniteOrNaN(rawMinute['low'] ?? rawMinute['l']),
      close: toFiniteOrNaN(rawMinute['close'] ?? rawMinute['c']),
      volume: toNonNegativeOrNaN(rawMinute['volume'] ?? rawMinute['v']),
      vwap: toFiniteOrNaN(rawMinute['vwap'] ?? rawMinute['vw']),
      transactions: toNonNegativeOrNaN(rawMinute['transactions'] ?? rawMinute['n']),
      lastUpdated: parseTimestamp(rawMinute['last_updated'] ?? rawMinute['t']),
    };
  };

  const parseOptionGreeks = (rawGreeks: unknown): { greeks: OptionGreeks; missing: boolean } => {
    if (!isRecord(rawGreeks)) {
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
    const delta = toFiniteOrNaN(rawGreeks['delta']);
    const gamma = toFiniteOrNaN(rawGreeks['gamma']);
    const theta = toFiniteOrNaN(rawGreeks['theta']);
    const vega = toFiniteOrNaN(rawGreeks['vega']);
    const missing =
      !Number.isFinite(delta) &&
      !Number.isFinite(gamma) &&
      !Number.isFinite(theta) &&
      !Number.isFinite(vega);
    return { greeks: { delta, gamma, theta, vega }, missing };
  };

  const parseUnderlying = (rawUnderlying: unknown): OptionUnderlyingSnapshot | null => {
    if (!isRecord(rawUnderlying)) {
      return null;
    }
    const ticker = readOptionalString(rawUnderlying['ticker']);
    if (ticker === null) {
      return null;
    }
    const priceDirect = toFiniteOrNaN(rawUnderlying['price']);
    const valueDirect = toFiniteOrNaN(rawUnderlying['value']);
    const hasPrice = Number.isFinite(priceDirect);
    const hasValue = Number.isFinite(valueDirect);
    return {
      ticker,
      price: hasPrice ? priceDirect : hasValue ? valueDirect : Number.NaN,
      sourceField: hasPrice ? 'price' : hasValue ? 'value' : null,
      changeToBreakEven: toFiniteOrNaN(rawUnderlying['change_to_break_even']),
      updatedAt: parseTimestamp(rawUnderlying['last_updated']),
      timeframe: readOptionalString(rawUnderlying['timeframe']),
    };
  };

  const stocks: UnifiedStockSnapshot[] = [];
  const indices: UnifiedIndexSnapshot[] = [];
  const options: UnifiedOptionSnapshot[] = [];
  const other: UnifiedOtherAssetSnapshot[] = [];
  const tickerErrors: UnifiedSnapshotTickerError[] = [];

  const seenTickers = new Set<string>();
  const acceptedTickersInOrder: string[] = [];
  let earlyTradingWithoutOhlc = 0;
  let overnightTradingCount = 0;

  for (const row of envelope.rows) {
    if (!isRecord(row)) {
      recordDiscard('malformedRow', null);
      continue;
    }

    const rawError = readOptionalString(row['error']);
    const rawTicker = readOptionalString(row['ticker']);
    const rawType = readOptionalString(row['type']);

    if (rawError !== null) {
      tickerErrors.push({
        ticker: rawTicker ?? '',
        type: rawType,
        error: rawError,
        message: redact(toErrorMessage(row['message'], rawError), []),
      });
      continue;
    }

    if (rawTicker === null) {
      recordDiscard('missingTicker', null);
      continue;
    }

    const assetClass = classifyUnifiedAssetType(rawType);
    if (assetClass === null) {
      recordDiscard('unknownAssetType', rawTicker);
      continue;
    }

    if (seenTickers.has(rawTicker)) {
      recordDiscard('duplicate', rawTicker);
      continue;
    }
    seenTickers.add(rawTicker);
    acceptedTickersInOrder.push(rawTicker);

    const name = readOptionalString(row['name']);
    const marketStatusRaw = readOptionalString(row['market_status']);
    const marketStatus: UnifiedMarketStatus | null = marketStatusRaw;
    const timeframe = readOptionalString(row['timeframe']);
    const session = parseSession(row['session']);

    if (marketStatus === 'early_trading' && !session.hasOhlc) {
      earlyTradingWithoutOhlc += 1;
    }
    if (marketStatus === 'overnight_trading') {
      overnightTradingCount += 1;
    }

    if (assetClass === 'indices') {
      indices.push({
        assetClass: 'indices',
        ticker: rawTicker,
        name,
        marketStatus,
        timeframe,
        value: toFiniteOrNaN(row['value']),
        session,
        lastUpdated: parseTimestamp(row['last_updated']),
      });
      continue;
    }

    const lastQuote = parseLastQuote(row['last_quote']);
    const lastTrade = parseLastTrade(row['last_trade']);
    const lastMinute = parseLastMinute(row['last_minute']);

    if (assetClass === 'stocks') {
      stocks.push({
        assetClass: 'stocks',
        ticker: rawTicker,
        name,
        marketStatus,
        timeframe,
        session,
        lastQuote,
        lastTrade,
        lastMinute,
      });
      continue;
    }

    if (assetClass === 'options') {
      const detailsRaw = isRecord(row['details']) ? row['details'] : null;
      const expParsed = parseExpirationDate(detailsRaw?.['expiration_date']);
      const spcRaw = detailsRaw?.['shares_per_contract'];
      const details: UnifiedOptionDetails = {
        contractType: parseContractTypeField(detailsRaw?.['contract_type']) ?? 'other',
        exerciseStyle: parseExerciseStyleField(detailsRaw?.['exercise_style']),
        expirationDate: expParsed?.date ?? null,
        expirationTime: expParsed?.time ?? Number.NaN,
        sharesPerContract:
          detailsRaw === null
            ? Number.NaN
            : isFiniteNumber(spcRaw) && spcRaw > 0
              ? spcRaw
              : spcRaw === undefined
                ? DEFAULT_SHARES_PER_CONTRACT
                : Number.NaN,
        strikePrice: toPositiveOrNaN(detailsRaw?.['strike_price']),
      };
      const parsedGreeks = parseOptionGreeks(row['greeks']);

      options.push({
        assetClass: 'options',
        ticker: rawTicker,
        name,
        marketStatus,
        timeframe,
        breakEvenPrice: toFiniteOrNaN(row['break_even_price']),
        impliedVolatility: toPositiveOrNaN(row['implied_volatility']),
        openInterest: toNonNegativeOrNaN(row['open_interest']),
        greeks: parsedGreeks.greeks,
        greeksMissing: parsedGreeks.missing,
        details,
        session,
        lastQuote,
        lastTrade,
        lastMinute,
        underlyingAsset: parseUnderlying(row['underlying_asset']),
      });
      continue;
    }

    other.push({
      assetClass,
      rawType,
      ticker: rawTicker,
      name,
      marketStatus,
      timeframe,
      session,
      lastQuote,
      lastTrade,
      lastMinute,
    });
  }

  let reordered = false;
  for (let i = 1; i < acceptedTickersInOrder.length; i += 1) {
    const prev = acceptedTickersInOrder[i - 1];
    const curr = acceptedTickersInOrder[i];
    if (prev !== undefined && curr !== undefined && curr < prev) {
      reordered = true;
      break;
    }
  }
  if (reordered) {
    const byTicker = (a: { readonly ticker: string }, b: { readonly ticker: string }): number =>
      a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
    stocks.sort(byTicker);
    indices.sort(byTicker);
    options.sort(byTicker);
    other.sort(byTicker);
  }

  const acceptedTotal = stocks.length + indices.length + options.length + other.length;

  const report: UnifiedSnapshotNormalizeReport = {
    provider: 'massive',
    received: envelope.rows.length,
    accepted: acceptedTotal,
    errorCount: tickerErrors.length,
    discarded: discards.length,
    discardCounts: counts,
    discards,
    stocksCount: stocks.length,
    indicesCount: indices.length,
    optionsCount: options.length,
    otherCount: other.length,
    earlyTradingWithoutOhlc,
    overnightTradingCount,
    invalidTimestamps,
    reordered,
    malformedResponse: false,
    providerError: null,
  };

  return {
    stocks,
    indices,
    options,
    other,
    tickerErrors,
    report,
  };
}
