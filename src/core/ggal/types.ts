/**
 * Constantes operativas BYMA/NASDAQ 2026, calendario de zonas horarias (ART vs. EST/EDT),
 * modelo paramétrico de fricciones (BYMA + IVA 21 %, SEC Section 31 y FINRA TAF Q4-2026)
 * y utilidades numéricas puras para el módulo GGAL Specialist (Pieza 20).
 *
 * Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 * Estándar temporal único: timestamps en segundos UTC enteros (`asOfUtcSec`).
 */

import { SECONDS_PER_YEAR_365 } from '../options/blackScholes.js';
import { getMarketParts, MAX_TIME_SECONDS } from '../sessions.js';

export const GGAL_BYMA_LOT_SIZE = 100;
export const GGAL_ADR_RATIO = 10;
export const BYMA_VAT_RATE = 0.21;

export const BYMA_RV_NEGOTIATION_RATE = 0.0003; // 3 bps negociación
export const BYMA_RV_POST_TRADE_RATE = 0.0002; // 2 bps post-trade
export const BYMA_RV_DM_RATE = BYMA_RV_NEGOTIATION_RATE + BYMA_RV_POST_TRADE_RATE; // 5 bps
export const BYMA_RV_BLOCK_THRESHOLD_ARS = 15_000_000;
export const BYMA_RV_BLOCK_FIXED_ARS = 10_500;
export const BYMA_RV_BLOCK_EXCESS_RATE = 0.000484; // 0.0484 % sobre excedente de ARS 15M
export const BYMA_SHORT_LOAN_PRORATE_RATE = 0.0002; // 0.02 % prorrateado hasta 90/360 d

// Tarifario oficial BYMA Clearing Ago-2026 (Derechos de Mercado + 21 % IVA) — aditivo Motor 6
export const BYMA_OPTION_PREMIUM_DM_RATE = 0.0020; // 0.20 % sobre prima opciones
export const BYMA_OPTION_PREMIUM_DM_RATE_WITH_IVA = 0.00242; // 0.20 % + 21 % IVA = 0.242 %
export const BYMA_EXERCISE_DM_RATE = 0.0005; // 0.05 % ejercicio opciones
export const BYMA_EXERCISE_DM_RATE_WITH_IVA = 0.000605; // 0.05 % + 21 % IVA = 0.0605 %
export const BYMA_EQUITY_PPT_DM_RATE = 0.0005; // 0.05 % PPT acciones
export const BYMA_EQUITY_PPT_DM_RATE_WITH_IVA = 0.000605; // 0.05 % + 21 % IVA = 0.0605 %
export const BYMA_SHORT_LOAN_DM_RATE_WITH_IVA = 0.000242; // 0.02 % + 21 % IVA = 0.0242 %

export const BYMA_CLEARING_2026_RATES = {
  lotSize: GGAL_BYMA_LOT_SIZE,
  vatRate: BYMA_VAT_RATE,
  optionPremiumDmRate: BYMA_OPTION_PREMIUM_DM_RATE,
  optionPremiumDmRateWithIva: BYMA_OPTION_PREMIUM_DM_RATE_WITH_IVA,
  exerciseDmRate: BYMA_EXERCISE_DM_RATE,
  exerciseDmRateWithIva: BYMA_EXERCISE_DM_RATE_WITH_IVA,
  equityPptDmRate: BYMA_EQUITY_PPT_DM_RATE,
  equityPptDmRateWithIva: BYMA_EQUITY_PPT_DM_RATE_WITH_IVA,
  shortLoanDmRate: BYMA_SHORT_LOAN_PRORATE_RATE,
  shortLoanDmRateWithIva: BYMA_SHORT_LOAN_DM_RATE_WITH_IVA,
  liquidBufferRate: 0.10,
  wrongWayRiskSurchargeRate: 0.15,
  circular3588CutoffArtHour: 15,
  circular3588CutoffArtMinute: 30,
  circular3588WindowMinutes: 60,
  circular3588AtmBandPct: 0.005,
  ccpSpotShocks: [-0.25, -0.15, 0, 0.15, 0.25],
  ccpVolShocks: [-0.10, 0, 0.10],
  minStressVol: 0.05,
} as const;

export type {
  AsyncMidTick,
  BookDepthSource,
  BookLevelInput,
  BymaClearingMarginInput,
  BymaClearingStrategyKind,
  BymaCollateralAssetInput,
  BymaMarginLegInput,
  CcpGridNodeResult,
  Circular3588AlertOutput,
  CollateralAssetKind,
  CollateralBreakdownItem,
  ExecutionDecisionKind,
  ExecutionGateEvaluation,
  ExecutionMicrostructureInput,
  ExecutionMicrostructureOutput,
  ExecutionTelemetryMode,
  HayashiYoshidaLagPoint,
  HayashiYoshidaOutput,
  MarginAndRiskOutput,
  OvernightJumpDiffusionParams,
  SizingConstraintBreakdown,
  StrategyMarginBreakdownItem,
  StressOpraLegInput,
  StressScenarioResult,
  StressScenarioSpec,
  StressTestMatrixOutput,
  TailStressAndSizingInput,
} from './marginRiskExecution.js';

export const SEC_SECTION_31_RATE = 20.6 / 1_000_000; // USD 20.60 por USD 1,000,000 vendidos
export const FINRA_TAF_HOLIDAY_START_UTC_SEC = 1_790_812_800; // 2026-10-01T00:00:00Z
export const FINRA_TAF_HOLIDAY_END_EXCLUSIVE_UTC_SEC = 1_798_761_600; // 2027-01-01T00:00:00Z

export const SECONDS_PER_DAY = 86_400;
export const DAYS_PER_YEAR = 365;
export const TRADING_DAYS_PER_YEAR = 252;

export const BUENOS_AIRES_TZ = 'America/Argentina/Buenos_Aires';
export const NEW_YORK_TZ = 'America/New_York';
export const ART_UTC_OFFSET_MINUTES = -180; // ART fijo UTC-3

export interface BymaFeeSchedule {
  /** Comisión pactada con el ALyC para renta variable (decimal, p. ej. 0.001 = 10 bps). */
  readonly equityAlycRate: number;
  /** Derechos de mercado BYMA renta variable (por defecto 5 bps = 3 bps neg. + 2 bps post-trade). */
  readonly equityDmRate: number;
  /** Escala block para renta variable por encima de `equityBlockThresholdArs`. */
  readonly useEquityBlockTier?: boolean;
  readonly equityBlockThresholdArs?: number;
  readonly equityBlockFixedArs?: number;
  readonly equityBlockExcessRate?: number;
  /** Comisión ALyC sobre prima de opciones sobre acciones privadas. */
  readonly optionAlycRate: number;
  /** Derechos de mercado parametrizables sobre prima de opciones sobre acciones privadas. */
  readonly optionDmRate: number;
  /** Comisión ALyC sobre monto ejercido/asignado K * N. */
  readonly exerciseAlycRate: number;
  /** Derechos de mercado parametrizables sobre ejercicio. */
  readonly exerciseDmRate: number;
  /** Comisión ALyC para bonos soberanos en arbitraje CCL. */
  readonly bondAlycRate: number;
  /** Derechos de mercado para bonos soberanos (0 si exento o parametrizable). */
  readonly bondDmRate: number;
  /** Indica si aplica IVA a patas de bonos (por defecto false: títulos públicos exentos). */
  readonly bondVatApplies?: boolean;
  /** Alícuota general IVA sobre aranceles/derechos BYMA (0.21 = 21 %). */
  readonly vatRate: number;
  /** Arancel préstamo de valores para venta en corto (0.02 % prorrateado hasta 90/360 d). */
  readonly shortLoanRate?: number;
}

export const BYMA_FEE_SCHEDULE: BymaFeeSchedule = {
  equityAlycRate: 0.001,
  equityDmRate: BYMA_RV_DM_RATE,
  useEquityBlockTier: false,
  equityBlockThresholdArs: BYMA_RV_BLOCK_THRESHOLD_ARS,
  equityBlockFixedArs: BYMA_RV_BLOCK_FIXED_ARS,
  equityBlockExcessRate: BYMA_RV_BLOCK_EXCESS_RATE,
  optionAlycRate: 0.0025,
  optionDmRate: 0.002,
  exerciseAlycRate: 0.001,
  exerciseDmRate: 0.0005,
  bondAlycRate: 0.001,
  bondDmRate: 0.0001,
  bondVatApplies: false,
  vatRate: BYMA_VAT_RATE,
  shortLoanRate: BYMA_SHORT_LOAN_PRORATE_RATE,
};

export interface UsFeeSchedule {
  readonly secSection31Rate: number;
  readonly finraTafEquityPerShareUsd: number;
  readonly finraTafOptionPerContractUsd: number;
  readonly occFeePerContractUsd: number;
  readonly orfFeePerContractUsd: number;
  readonly exchangeFeePerContractUsd: number;
  readonly brokerEquityPerShareUsd: number;
  readonly brokerOptionPerContractUsd: number;
}

export const DEFAULT_US_FEE_SCHEDULE: UsFeeSchedule = {
  secSection31Rate: SEC_SECTION_31_RATE,
  finraTafEquityPerShareUsd: 0.000166,
  finraTafOptionPerContractUsd: 0.00279,
  occFeePerContractUsd: 0.02,
  orfFeePerContractUsd: 0.02,
  exchangeFeePerContractUsd: 0,
  brokerEquityPerShareUsd: 0,
  brokerOptionPerContractUsd: 0,
};

export type BymaLegCostKind = 'EQUITY' | 'OPTION_PREMIUM' | 'EXERCISE' | 'SOVEREIGN_BOND';

export type OrderSide = 'BUY' | 'SELL';

export type DstMode = 'EST' | 'EDT';

export interface LocalClockParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: number; // 1=Lun .. 7=Dom
  readonly dateKey: string; // YYYY-MM-DD
  readonly minutesOfDay: number;
}

export interface NewYorkClockParts extends LocalClockParts {
  readonly dstMode: DstMode;
  readonly utcOffsetMinutes: number;
}

export interface DiscreteOrdinaryDividend {
  readonly exDivUtcSec: number;
  readonly payDateUtcSec: number;
  readonly amountArs: number;
}

export interface ContinuousRateCurvePoint {
  readonly days: number;
  readonly continuousRateAnnual: number;
}

export interface BidAskQuote {
  readonly bid: number;
  readonly ask: number;
  readonly last?: number;
}

const WEEKDAY_MAP: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const FORMATTER_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
};

const localFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getLocalFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = localFormatterCache.get(timeZone);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Intl.DateTimeFormat('en-US', {
    ...FORMATTER_OPTIONS,
    timeZone,
  });
  localFormatterCache.set(timeZone, created);
  return created;
}

export function isValidUtcSec(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && Math.abs(value) <= MAX_TIME_SECONDS;
}

export function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function formatIsoUtcFromSec(utcSec: number): string {
  if (!Number.isFinite(utcSec) || Math.abs(utcSec) > MAX_TIME_SECONDS) {
    return 'INVALID_UTC';
  }
  return new Date(utcSec * 1_000).toISOString();
}

export function quoteMid(quote: BidAskQuote): number {
  if (
    Number.isFinite(quote.bid) &&
    Number.isFinite(quote.ask) &&
    quote.bid > 0 &&
    quote.ask >= quote.bid
  ) {
    return 0.5 * (quote.bid + quote.ask);
  }
  return Number.NaN;
}

export function quoteRelativeSpread(quote: BidAskQuote): number {
  const mid = quoteMid(quote);
  if (!isPositiveFinite(mid)) {
    return Number.NaN;
  }
  return (quote.ask - quote.bid) / mid;
}

/**
 * Calcula c_{BYMA, j}(M_j) = (tau_{ALyC, j} + tau_{DM, j}(M_j)) * (1 + IVA)
 * siguiendo la Sección 1.2 (con escala block opcional > ARS 15M en RV e IVA 21 % configurable).
 */
export function computeBymaFeeRate(
  notionalArs: number,
  legKind: BymaLegCostKind,
  schedule: BymaFeeSchedule = BYMA_FEE_SCHEDULE,
): number {
  if (
    !isPositiveFinite(notionalArs) ||
    !Number.isFinite(schedule.vatRate) ||
    schedule.vatRate < 0
  ) {
    return Number.NaN;
  }

  let alycRate: number;
  let dmRate: number;
  let vatMultiplier = 1 + schedule.vatRate;

  switch (legKind) {
    case 'EQUITY': {
      alycRate = schedule.equityAlycRate;
      const threshold = schedule.equityBlockThresholdArs ?? BYMA_RV_BLOCK_THRESHOLD_ARS;
      const fixed = schedule.equityBlockFixedArs ?? BYMA_RV_BLOCK_FIXED_ARS;
      const excessRate = schedule.equityBlockExcessRate ?? BYMA_RV_BLOCK_EXCESS_RATE;
      if (schedule.useEquityBlockTier === true && notionalArs > threshold && threshold > 0) {
        dmRate = (fixed + (notionalArs - threshold) * excessRate) / notionalArs;
      } else {
        dmRate = schedule.equityDmRate;
      }
      break;
    }
    case 'OPTION_PREMIUM':
      alycRate = schedule.optionAlycRate;
      dmRate = schedule.optionDmRate;
      break;
    case 'EXERCISE':
      alycRate = schedule.exerciseAlycRate;
      dmRate = schedule.exerciseDmRate;
      break;
    case 'SOVEREIGN_BOND':
      alycRate = schedule.bondAlycRate;
      dmRate = schedule.bondDmRate;
      vatMultiplier = schedule.bondVatApplies === true ? 1 + schedule.vatRate : 1;
      break;
    default:
      return Number.NaN;
  }

  if (!Number.isFinite(alycRate) || alycRate < 0 || !Number.isFinite(dmRate) || dmRate < 0) {
    return Number.NaN;
  }

  return (alycRate + dmRate) * vatMultiplier;
}

export function computeBymaFeeAmountArs(
  notionalArs: number,
  legKind: BymaLegCostKind,
  schedule: BymaFeeSchedule = BYMA_FEE_SCHEDULE,
): number {
  const rate = computeBymaFeeRate(notionalArs, legKind, schedule);
  return Number.isFinite(rate) ? notionalArs * rate : Number.NaN;
}

/**
 * Arancel de préstamo de títulos BYMA (0.02 % prorrateado hasta 90/360 días sobre el monto futuro).
 */
export function computeBymaShortLoanRate(
  holdingDays: number,
  schedule: BymaFeeSchedule = BYMA_FEE_SCHEDULE,
): number {
  if (!Number.isFinite(holdingDays) || holdingDays < 0) {
    return Number.NaN;
  }
  const base = schedule.shortLoanRate ?? BYMA_SHORT_LOAN_PRORATE_RATE;
  if (!Number.isFinite(base) || base < 0) {
    return Number.NaN;
  }
  const cappedDays = Math.min(holdingDays, 90);
  const vatMultiplier = 1 + schedule.vatRate;
  return base * (cappedDays / 360) * vatMultiplier;
}

/**
 * SR-FINRA-2026-021: suspensión temporal FINRA TAF en USD 0.00 durante [2026-10-01, 2026-12-31] UTC.
 */
export function isFinraTafSuspendedUtc(utcSec: number): boolean {
  if (!isValidUtcSec(utcSec)) {
    return false;
  }
  return utcSec >= FINRA_TAF_HOLIDAY_START_UTC_SEC && utcSec < FINRA_TAF_HOLIDAY_END_EXCLUSIVE_UTC_SEC;
}

/**
 * Costo proporcional de ejecución en EE. UU. para acciones/ADR:
 * Ventas incluyen SEC Section 31 (USD 20.60 / 10^6) + FINRA TAF (0 en Q4-2026) + broker/sh.
 * Compras excluyen SEC Section 31 y FINRA TAF.
 */
export function computeUsEquityFeeRate(
  utcSec: number,
  adrPriceUsd: number,
  side: OrderSide,
  schedule: UsFeeSchedule = DEFAULT_US_FEE_SCHEDULE,
): number {
  if (!isValidUtcSec(utcSec) || !isPositiveFinite(adrPriceUsd)) {
    return Number.NaN;
  }
  const brokerRate = schedule.brokerEquityPerShareUsd / adrPriceUsd;
  if (!Number.isFinite(brokerRate) || brokerRate < 0) {
    return Number.NaN;
  }
  if (side === 'BUY') {
    return brokerRate;
  }
  const tafPerShare = isFinraTafSuspendedUtc(utcSec) ? 0 : schedule.finraTafEquityPerShareUsd;
  const secRate = schedule.secSection31Rate;
  if (!Number.isFinite(secRate) || secRate < 0 || !Number.isFinite(tafPerShare) || tafPerShare < 0) {
    return Number.NaN;
  }
  return secRate + tafPerShare / adrPriceUsd + brokerRate;
}

/**
 * Costo proporcional de ejecución en opciones OPRA:
 * Ventas incluyen SEC Section 31 + FINRA TAF (0 en Q4-2026) + (OCC + ORF + exch + broker) / (100 * P_opt).
 * Compras excluyen SEC Section 31 y FINRA TAF.
 */
export function computeUsOptionFeeRate(
  utcSec: number,
  optionPriceUsd: number,
  side: OrderSide,
  schedule: UsFeeSchedule = DEFAULT_US_FEE_SCHEDULE,
): number {
  if (!isValidUtcSec(utcSec) || !isPositiveFinite(optionPriceUsd)) {
    return Number.NaN;
  }
  const notionalPerContract = GGAL_BYMA_LOT_SIZE * optionPriceUsd;
  const fixedPerContract =
    schedule.occFeePerContractUsd +
    schedule.orfFeePerContractUsd +
    schedule.exchangeFeePerContractUsd +
    schedule.brokerOptionPerContractUsd;
  if (!Number.isFinite(fixedPerContract) || fixedPerContract < 0) {
    return Number.NaN;
  }
  if (side === 'BUY') {
    return fixedPerContract / notionalPerContract;
  }
  const tafPerContract = isFinraTafSuspendedUtc(utcSec) ? 0 : schedule.finraTafOptionPerContractUsd;
  return (
    schedule.secSection31Rate +
    (tafPerContract + fixedPerContract) / notionalPerContract
  );
}

function readDateParts(formatter: Intl.DateTimeFormat, utcSec: number): LocalClockParts {
  const parts = formatter.formatToParts(new Date(utcSec * 1_000));
  let year = Number.NaN;
  let month = Number.NaN;
  let day = Number.NaN;
  let hour = Number.NaN;
  let minute = Number.NaN;
  let second = Number.NaN;
  let weekdayStr = '';

  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      case 'weekday':
        weekdayStr = part.value;
        break;
      default:
        break;
    }
  }
  const normalizedHour = hour === 24 ? 0 : hour;
  const weekday = WEEKDAY_MAP[weekdayStr] ?? Number.NaN;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const dateKey = `${String(year)}-${mm}-${dd}`;
  return {
    year,
    month,
    day,
    hour: normalizedHour,
    minute,
    second,
    weekday,
    dateKey,
    minutesOfDay: normalizedHour * 60 + minute,
  };
}

export function getBuenosAiresParts(utcSec: number): LocalClockParts {
  if (!isValidUtcSec(utcSec)) {
    throw new Error(`utcSec must be valid integer seconds (got ${String(utcSec)})`);
  }
  return readDateParts(getLocalFormatter(BUENOS_AIRES_TZ), utcSec);
}

export function getNewYorkPartsAndDst(utcSec: number): NewYorkClockParts {
  if (!isValidUtcSec(utcSec)) {
    throw new Error(`utcSec must be valid integer seconds (got ${String(utcSec)})`);
  }
  const marketParts = getMarketParts(utcSec, 'EQUITY');
  const detailed = readDateParts(getLocalFormatter(NEW_YORK_TZ), utcSec);
  const nyLocalAsUtcMin = Math.floor(
    Date.UTC(
      marketParts.year,
      marketParts.month - 1,
      marketParts.day,
      marketParts.hour,
      marketParts.minute,
    ) / 60_000,
  );
  const actualUtcMin = Math.floor(utcSec / 60);
  const utcOffsetMinutes = nyLocalAsUtcMin - actualUtcMin;
  const dstMode: DstMode = utcOffsetMinutes === -240 ? 'EDT' : 'EST';
  return {
    ...detailed,
    year: marketParts.year,
    month: marketParts.month,
    day: marketParts.day,
    hour: marketParts.hour,
    minute: marketParts.minute,
    weekday: marketParts.weekday,
    dateKey: marketParts.dateKey,
    minutesOfDay: marketParts.minutesOfDay,
    dstMode,
    utcOffsetMinutes,
  };
}

export function parseCivilDateKey(dateKey: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (match === null) {
    return Number.NaN;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return Number.NaN;
  }
  return Math.floor(ms / 86_400_000);
}

export function formatCivilDayIndex(dayIdx: number): string {
  const d = new Date(dayIdx * 86_400_000);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function isTradingDayCivilIndex(dayIdx: number, holidays: ReadonlySet<string>): boolean {
  const d = new Date(dayIdx * 86_400_000);
  const utcDay = d.getUTCDay(); // 0=Sun .. 6=Sat
  if (utcDay === 0 || utcDay === 6) {
    return false;
  }
  return !holidays.has(formatCivilDayIndex(dayIdx));
}

/**
 * Días calendario exactos necesarios para liquidar `settlementBusinessDays` días hábiles
 * desde `tradeDateKey` (p. ej. 24hs local = 1 hábil, considerando fines de semana y feriados).
 */
export function computeSettlementCalendarDays(
  tradeDateKey: string,
  settlementBusinessDays: number,
  holidays: ReadonlySet<string> = new Set<string>(),
): number {
  const startDayIdx = parseCivilDateKey(tradeDateKey);
  if (
    !Number.isFinite(startDayIdx) ||
    !Number.isInteger(settlementBusinessDays) ||
    settlementBusinessDays < 0
  ) {
    return Number.NaN;
  }
  if (settlementBusinessDays === 0) {
    return 0;
  }
  let cur = startDayIdx;
  let remaining = settlementBusinessDays;
  let guard = 0;
  while (remaining > 0 && guard < 366) {
    cur += 1;
    guard += 1;
    if (isTradingDayCivilIndex(cur, holidays)) {
      remaining -= 1;
    }
  }
  return remaining === 0 ? cur - startDayIdx : Number.NaN;
}

export function countTradingDaysBetween(
  fromDateKey: string,
  toDateKey: string,
  holidays: ReadonlySet<string> = new Set<string>(),
): number {
  const fromIdx = parseCivilDateKey(fromDateKey);
  const toIdx = parseCivilDayOrNaN(toDateKey);
  if (!Number.isFinite(fromIdx) || !Number.isFinite(toIdx)) {
    return Number.NaN;
  }
  if (toIdx === fromIdx) {
    return 0;
  }
  const step = toIdx > fromIdx ? 1 : -1;
  let count = 0;
  let cur = fromIdx;
  let guard = 0;
  while (cur !== toIdx && guard < 10_000) {
    cur += step;
    guard += 1;
    if (isTradingDayCivilIndex(cur, holidays)) {
      count += step;
    }
  }
  return count;
}

function parseCivilDayOrNaN(dateKey: string): number {
  return parseCivilDateKey(dateKey);
}

/**
 * Timestamp UTC entero correspondiente al cierre operativo de las 15:30 ART (18:30 UTC)
 * en la fecha de vencimiento `expiryDateKey` (`YYYY-MM-DD`).
 */
export function computeExpiration1530ArtUtcSec(expiryDateKey: string): number {
  const dayIdx = parseCivilDateKey(expiryDateKey);
  if (!Number.isFinite(dayIdx)) {
    return Number.NaN;
  }
  // 15:30 ART = 18:30 UTC
  return dayIdx * SECONDS_PER_DAY + 18 * 3600 + 30 * 60;
}

/**
 * Convierte TNA nominal (capitalización cada `compoundingDays` días) en tasa continua anualizada.
 */
export function tnaToContinuousRate(tnaDecimal: number, compoundingDays: number): number {
  if (!Number.isFinite(tnaDecimal) || !isPositiveFinite(compoundingDays)) {
    return Number.NaN;
  }
  const factor = 1 + tnaDecimal * (compoundingDays / DAYS_PER_YEAR);
  if (factor <= 0) {
    return Number.NaN;
  }
  return (DAYS_PER_YEAR / compoundingDays) * Math.log(factor);
}

/**
 * Interpolación lineal de tasa continua anualizada `r(T)` sobre nodos ordenados por `days`.
 */
export function interpolateContinuousRate(
  curve: readonly ContinuousRateCurvePoint[],
  horizonDays: number,
): number {
  if (!Number.isFinite(horizonDays) || horizonDays < 0 || curve.length === 0) {
    return Number.NaN;
  }
  const clean = curve
    .filter((pt) => isPositiveFinite(pt.days) && Number.isFinite(pt.continuousRateAnnual))
    .slice()
    .sort((a, b) => a.days - b.days);
  const first = clean[0];
  const last = clean[clean.length - 1];
  if (first === undefined || last === undefined) {
    return Number.NaN;
  }
  if (horizonDays <= first.days) {
    return first.continuousRateAnnual;
  }
  if (horizonDays >= last.days) {
    return last.continuousRateAnnual;
  }
  for (let i = 1; i < clean.length; i += 1) {
    const left = clean[i - 1];
    const right = clean[i];
    if (left === undefined || right === undefined) {
      continue;
    }
    if (horizonDays <= right.days) {
      const span = right.days - left.days;
      if (span <= 0) {
        return left.continuousRateAnnual;
      }
      const alpha = (horizonDays - left.days) / span;
      return left.continuousRateAnnual * (1 - alpha) + right.continuousRateAnnual * alpha;
    }
  }
  return Number.NaN;
}

/**
 * Buscador de raíces por método de Brent (Numerical Recipes zbrent) en `[lower, upper]`.
 */
export function brentRoot(
  fn: (x: number) => number,
  lower: number,
  upper: number,
  tolerance = 1e-9,
  maxIterations = 120,
): number {
  if (
    !Number.isFinite(lower) ||
    !Number.isFinite(upper) ||
    lower >= upper ||
    !isPositiveFinite(tolerance) ||
    !Number.isInteger(maxIterations) ||
    maxIterations <= 0
  ) {
    return Number.NaN;
  }

  let a = lower;
  let b = upper;
  let c = upper;
  let fa = fn(a);
  let fb = fn(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
    return Number.NaN;
  }
  if (Math.abs(fa) <= tolerance) {
    return a;
  }
  if (Math.abs(fb) <= tolerance) {
    return b;
  }
  if ((fa > 0 && fb > 0) || (fa < 0 && fb < 0)) {
    return Number.NaN;
  }

  let fc = fb;
  let d = b - a;
  let e = d;
  const eps = Number.EPSILON;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    if ((fb > 0 && fc > 0) || (fb < 0 && fc < 0)) {
      c = a;
      fc = fa;
      d = b - a;
      e = d;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }

    const tol1 = 2 * eps * Math.abs(b) + 0.5 * tolerance;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || Math.abs(fb) <= tolerance) {
      return b;
    }

    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p: number;
      let q: number;
      if (a === c) {
        p = 2 * xm * s;
        q = 1 - s;
      } else {
        const q1 = fa / fc;
        const r = fb / fc;
        p = s * (2 * xm * q1 * (q1 - r) - (b - a) * (r - 1));
        q = (q1 - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) {
        q = -q;
      }
      p = Math.abs(p);
      const min1 = 3 * xm * q - Math.abs(tol1 * q);
      const min2 = Math.abs(e * q);
      if (2 * p < (min1 < min2 ? min1 : min2)) {
        e = d;
        d = p / q;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }

    a = b;
    fa = fb;
    b += Math.abs(d) > tol1 ? d : xm >= 0 ? tol1 : -tol1;
    fb = fn(b);
    if (!Number.isFinite(fb)) {
      return Number.NaN;
    }
  }

  return b;
}

export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) {
    return Number.NaN;
  }
  return x < lo ? lo : x > hi ? hi : x;
}

export function timeToExpirySec365(startUtcSec: number, endUtcSec: number): number {
  if (!isValidUtcSec(startUtcSec) || !isValidUtcSec(endUtcSec) || endUtcSec <= startUtcSec) {
    return Number.NaN;
  }
  return (endUtcSec - startUtcSec) / SECONDS_PER_YEAR_365;
}

export * from './institutionalContracts.js';
export type {
  AsyncPriceTick,
  BestQuoteSnapshot,
  CrossBankTickSeriesMap,
  DlrCurvePointInput,
  ElectoralMarkovInput,
  IcebergDetectionInput,
  L2MicrostructureEngineInput,
  L2WeightedPinScoreInput,
  OtmWingCclIvInput,
  OtmWingStrikeInput,
  VpinComputationInput,
  VpinSignedTradeInput,
  YangZhangOhlcBar,
} from './l2AndRegimeEngines.js';
