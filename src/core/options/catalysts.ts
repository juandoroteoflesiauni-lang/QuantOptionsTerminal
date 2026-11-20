/**
 * Motor puro de Ventana de Catalizadores (Earnings + FOMC / CPI) en Opciones (Pieza 46).
 *
 * Garantías de diseño (`AGENTS.md` / `SPEC.md`):
 *  - Funciones 100 % puras: cero red, cero E/S, cero UI y cero mutación de argumentos.
 *  - Timestamps siempre en segundos UTC enteros (`|t| <= 1e11`).
 *  - Degradación honesta: ante ausencia de datos devuelve `status: 'NO_DATA'` y `NaN`
 *    en distancias numéricas sin fabricar fechas ni valores por defecto.
 */

import { MAX_TIME_SECONDS } from '../sessions.js';

const SECONDS_PER_DAY = 86_400;
const DEFAULT_POST_EARNINGS_WINDOW_DAYS = 5;

export type MacroCatalystKind = 'FOMC' | 'CPI';

export interface EarningsCatalystEvent {
  readonly date: string;
  readonly utcSec: number;
  readonly timeOfDay?: 'bmo' | 'amc' | 'unknown' | null;
  readonly epsEstimate?: number | null;
  readonly epsActual?: number | null;
}

export interface MacroCatalystEvent {
  readonly kind: MacroCatalystKind;
  readonly label: string;
  readonly date: string;
  readonly utcSec: number;
  readonly impact?: 'HIGH' | 'MEDIUM' | 'LOW';
}

export type CatalystWindowStatus =
  | 'EARNINGS_IN_EXPIRY'
  | 'MACRO_IN_EXPIRY'
  | 'POST_EARNINGS'
  | 'CLEAR_WINDOW'
  | 'NO_DATA';

export type CatalystBadgeSeverity = 'DANGER' | 'WARNING' | 'NEUTRAL';

export interface CatalystWindowInput {
  readonly asOfUtcSec: number;
  readonly activeExpiryUtcSec: number | null;
  readonly nextEarnings: EarningsCatalystEvent | null;
  readonly lastEarnings?: EarningsCatalystEvent | null;
  readonly macroEvents: readonly MacroCatalystEvent[];
  readonly postEarningsWindowDays?: number;
}

export interface EvaluatedMacroEvent extends MacroCatalystEvent {
  readonly daysUntil: number;
  readonly insideExpiry: boolean;
}

export interface CatalystWindowResult {
  readonly status: CatalystWindowStatus;
  readonly severity: CatalystBadgeSeverity;
  readonly badgeLabel: string;
  readonly detailLabel: string;
  readonly daysToExpiry: number;
  readonly daysToEarnings: number;
  readonly daysSinceLastEarnings: number;
  readonly earningsInsideExpiry: boolean;
  readonly isPostEarnings: boolean;
  readonly nextEarnings: EarningsCatalystEvent | null;
  readonly lastEarnings: EarningsCatalystEvent | null;
  readonly nextFomc: EvaluatedMacroEvent | null;
  readonly nextCpi: EvaluatedMacroEvent | null;
  readonly macroEventsInsideExpiry: readonly EvaluatedMacroEvent[];
  readonly upcomingMacroEvents: readonly EvaluatedMacroEvent[];
}

function isValidUtcSec(value: number | null | undefined): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_TIME_SECONDS
  );
}

function sanitizeEarningsEvent(
  event: EarningsCatalystEvent | null | undefined,
): EarningsCatalystEvent | null {
  if (event === null || event === undefined) {
    return null;
  }
  if (typeof event.date !== 'string' || event.date.trim() === '' || !isValidUtcSec(event.utcSec)) {
    return null;
  }
  return {
    date: event.date.trim(),
    utcSec: Math.floor(event.utcSec),
    ...(event.timeOfDay !== undefined ? { timeOfDay: event.timeOfDay } : {}),
    ...(event.epsEstimate !== undefined ? { epsEstimate: event.epsEstimate } : {}),
    ...(event.epsActual !== undefined ? { epsActual: event.epsActual } : {}),
  };
}

/**
 * Cruza la próxima fecha de Earnings (y el último reporte reciente) con el
 * calendario macro FOMC / CPI contra el vencimiento activo de opciones.
 */
export function evaluateCatalystWindow(input: CatalystWindowInput): CatalystWindowResult {
  const postEarningsWindowDays =
    input.postEarningsWindowDays !== undefined &&
    Number.isFinite(input.postEarningsWindowDays) &&
    input.postEarningsWindowDays > 0
      ? input.postEarningsWindowDays
      : DEFAULT_POST_EARNINGS_WINDOW_DAYS;

  if (!isValidUtcSec(input.asOfUtcSec)) {
    return {
      status: 'NO_DATA',
      severity: 'NEUTRAL',
      badgeLabel: 'Sin evento en ventana',
      detailLabel: 'Timestamp de evaluación inválido',
      daysToExpiry: Number.NaN,
      daysToEarnings: Number.NaN,
      daysSinceLastEarnings: Number.NaN,
      earningsInsideExpiry: false,
      isPostEarnings: false,
      nextEarnings: null,
      lastEarnings: null,
      nextFomc: null,
      nextCpi: null,
      macroEventsInsideExpiry: [],
      upcomingMacroEvents: [],
    };
  }

  const asOfSec = Math.floor(input.asOfUtcSec);
  const expirySec = isValidUtcSec(input.activeExpiryUtcSec)
    ? Math.floor(input.activeExpiryUtcSec)
    : null;
  const daysToExpiry =
    expirySec !== null && expirySec >= asOfSec ? (expirySec - asOfSec) / SECONDS_PER_DAY : Number.NaN;

  const rawNext = sanitizeEarningsEvent(input.nextEarnings);
  const rawLast = sanitizeEarningsEvent(input.lastEarnings);

  const nextEarnings = rawNext !== null && rawNext.utcSec >= asOfSec ? rawNext : null;
  const lastEarnings =
    rawLast !== null && rawLast.utcSec < asOfSec
      ? rawLast
      : rawNext !== null && rawNext.utcSec < asOfSec
        ? rawNext
        : null;

  const daysToEarnings =
    nextEarnings !== null ? (nextEarnings.utcSec - asOfSec) / SECONDS_PER_DAY : Number.NaN;
  const earningsInExpiryEvent =
    nextEarnings !== null && expirySec !== null && nextEarnings.utcSec <= expirySec
      ? nextEarnings
      : null;

  const daysSinceLastEarnings =
    lastEarnings !== null ? (asOfSec - lastEarnings.utcSec) / SECONDS_PER_DAY : Number.NaN;
  const isPostEarnings =
    Number.isFinite(daysSinceLastEarnings) &&
    daysSinceLastEarnings >= 0 &&
    daysSinceLastEarnings <= postEarningsWindowDays;

  const upcomingMacroEvents: EvaluatedMacroEvent[] = [];
  for (const ev of input.macroEvents) {
    const rawKind: unknown = ev.kind;
    if (
      (rawKind !== 'FOMC' && rawKind !== 'CPI') ||
      typeof ev.date !== 'string' ||
      ev.date.trim() === '' ||
      !isValidUtcSec(ev.utcSec)
    ) {
      continue;
    }
    const utcSec = Math.floor(ev.utcSec);
    if (utcSec < asOfSec) {
      continue;
    }
    const daysUntil = (utcSec - asOfSec) / SECONDS_PER_DAY;
    const insideExpiry = expirySec !== null && utcSec <= expirySec;
    upcomingMacroEvents.push({
      kind: rawKind,
      label: ev.label,
      date: ev.date.trim(),
      utcSec,
      ...(ev.impact !== undefined ? { impact: ev.impact } : {}),
      daysUntil,
      insideExpiry,
    });
  }

  upcomingMacroEvents.sort((a, b) => a.utcSec - b.utcSec || a.kind.localeCompare(b.kind));

  const macroEventsInsideExpiry = upcomingMacroEvents.filter((ev) => ev.insideExpiry);
  const nextFomc = upcomingMacroEvents.find((ev) => ev.kind === 'FOMC') ?? null;
  const nextCpi = upcomingMacroEvents.find((ev) => ev.kind === 'CPI') ?? null;

  const details: string[] = [];
  if (nextEarnings !== null) {
    const dEarn = Math.max(0, Math.ceil(daysToEarnings));
    details.push(`Earnings: ${nextEarnings.date} (${String(dEarn)}d)`);
  } else if (lastEarnings !== null) {
    details.push(`Último Earnings: ${lastEarnings.date}`);
  }
  if (nextFomc !== null) {
    details.push(`FOMC: ${nextFomc.date} (${String(Math.max(0, Math.ceil(nextFomc.daysUntil)))}d)`);
  }
  if (nextCpi !== null) {
    details.push(`CPI: ${nextCpi.date} (${String(Math.max(0, Math.ceil(nextCpi.daysUntil)))}d)`);
  }
  const detailLabel =
    details.length > 0 ? details.join(' · ') : 'Sin catalizadores reportados en ventana';

  if (earningsInExpiryEvent !== null) {
    const dEarn = Math.max(0, Math.ceil(daysToEarnings));
    const macroKinds = [...new Set(macroEventsInsideExpiry.map((m) => m.kind))];
    const macroSuffix = macroKinds.length > 0 ? ` + ${macroKinds.join('/')}` : '';
    return {
      status: 'EARNINGS_IN_EXPIRY',
      severity: daysToEarnings <= 5 ? 'DANGER' : 'WARNING',
      badgeLabel: `Earnings en ${String(dEarn)}d · DENTRO DEL VENCIMIENTO${macroSuffix}`,
      detailLabel,
      daysToExpiry,
      daysToEarnings,
      daysSinceLastEarnings,
      earningsInsideExpiry: true,
      isPostEarnings,
      nextEarnings,
      lastEarnings,
      nextFomc,
      nextCpi,
      macroEventsInsideExpiry,
      upcomingMacroEvents,
    };
  }

  const firstMacroInExpiry = macroEventsInsideExpiry[0];
  if (firstMacroInExpiry !== undefined) {
    const dMacro = Math.max(0, Math.ceil(firstMacroInExpiry.daysUntil));
    return {
      status: 'MACRO_IN_EXPIRY',
      severity: firstMacroInExpiry.daysUntil <= 3 ? 'DANGER' : 'WARNING',
      badgeLabel: `${firstMacroInExpiry.kind} en ${String(dMacro)}d · DENTRO DEL VENCIMIENTO`,
      detailLabel,
      daysToExpiry,
      daysToEarnings,
      daysSinceLastEarnings,
      earningsInsideExpiry: false,
      isPostEarnings,
      nextEarnings,
      lastEarnings,
      nextFomc,
      nextCpi,
      macroEventsInsideExpiry,
      upcomingMacroEvents,
    };
  }

  if (isPostEarnings) {
    const dSince = Math.max(0, Math.floor(daysSinceLastEarnings));
    return {
      status: 'POST_EARNINGS',
      severity: 'NEUTRAL',
      badgeLabel: `Post-Earnings (hace ${String(dSince)}d)`,
      detailLabel,
      daysToExpiry,
      daysToEarnings,
      daysSinceLastEarnings,
      earningsInsideExpiry: false,
      isPostEarnings: true,
      nextEarnings,
      lastEarnings,
      nextFomc,
      nextCpi,
      macroEventsInsideExpiry,
      upcomingMacroEvents,
    };
  }

  const hasAnyEvent = nextEarnings !== null || upcomingMacroEvents.length > 0 || lastEarnings !== null;
  return {
    status: hasAnyEvent ? 'CLEAR_WINDOW' : 'NO_DATA',
    severity: 'NEUTRAL',
    badgeLabel: 'Sin evento en ventana',
    detailLabel,
    daysToExpiry,
    daysToEarnings,
    daysSinceLastEarnings,
    earningsInsideExpiry: false,
    isPostEarnings: false,
    nextEarnings,
    lastEarnings,
    nextFomc,
    nextCpi,
    macroEventsInsideExpiry,
    upcomingMacroEvents,
  };
}
