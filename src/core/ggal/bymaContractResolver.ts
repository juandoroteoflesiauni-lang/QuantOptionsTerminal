/**
 * Resolver único y determinista para identidad contractual y strike de opciones BYMA (Pieza P1 A5).
 *
 * Invariante fundamental:
 * - El strike contractual jamás depende del precio spot ni de heurísticas de proximidad.
 * - Precedencia estricta:
 *     Nivel 1 (`EXPLICIT_METADATA`): metadata contractual autoritativa validada contra el símbolo y entre fuentes.
 *     Nivel 2 (`CANONICAL_SYMBOL`): decimal explícito o grilla entera estándar BYMA sin ambigüedad de escala.
 *     Nivel 3 (`AMBIGUOUS_SCALE_UNRESOLVED` | `CONFLICTING_METADATA` | `INVALID_SYMBOL`): cuarentena fail-closed con `strike = null`.
 *
 * Funciones 100 % puras: cero red, cero E/S y cero mutación de argumentos.
 */

import { MIN_CONTRACTUAL_EXPIRY_SEC } from '../options/blackScholes.js';
import {
  buildCanonicalOptionKey,
  isIsoContractDate,
  MONTH_CODES,
  OPTION_PREFIX_TO_UNDERLYING,
  resolveBymaContractualExpiry,
  type CanonicalOptionIdentity,
} from './anexoBIdentity.js';

export type BymaStrikeResolutionStatus =
  | 'EXPLICIT_METADATA'
  | 'CANONICAL_SYMBOL'
  | 'AMBIGUOUS_SCALE_UNRESOLVED'
  | 'CONFLICTING_METADATA'
  | 'INVALID_SYMBOL';

export type BymaStrikeSource =
  | 'IAMC_ANEXO_B'
  | 'PRIMARY_INSTRUMENT_DETAIL'
  | 'BMB_OPTION_METADATA'
  | 'OPEN_BYMA_METADATA'
  | 'DATA912_METADATA'
  | 'SYMBOL_EXPLICIT_DECIMAL'
  | 'SYMBOL_CANONICAL_INTEGER'
  | 'NONE';

export type BymaContractMetadataSource = Exclude<
  BymaStrikeSource,
  'SYMBOL_EXPLICIT_DECIMAL' | 'SYMBOL_CANONICAL_INTEGER' | 'NONE'
>;

export interface BymaContractMetadataRecord {
  readonly source: BymaContractMetadataSource;
  readonly nativeSymbol?: string | null;
  readonly underlying?: string | null;
  readonly side?: 'call' | 'put' | null;
  readonly strike?: number | null;
  readonly contractualExpiry?: string | null; // YYYY-MM-DD
  readonly expiryCode?: string | null;
  readonly reportDate?: string | null;        // YYYY-MM-DD (obligatorio para Anexo B)
  readonly unit?: 'ARS' | 'USD' | null;
  readonly contractMultiplier?: number | null;
}

export interface BymaStrikeConflictItem {
  readonly source: string;
  readonly reportedStrike: number | null;
  readonly reportedExpiry: string | null;
  readonly reason: string;
}

export type BymaExpiryResolutionError =
  | 'NONE'
  | 'MISSING_EXPIRY_SUFFIX'
  | 'AMBIGUOUS_EXPIRY_SUFFIX'
  | 'MISSING_EXPIRY_CONTEXT'
  | 'EXPIRY_DATE_MISMATCH'
  | 'AMBIGUOUS_EXPIRY_YEAR'
  | 'EXPIRED_OR_TOO_NEAR';

export interface BymaStrikeNormalizationEvidence {
  readonly rawSymbol: string;
  readonly rawStrikeToken: string | null;
  readonly hasExplicitDecimal: boolean;
  readonly scaleFactorApplied: 1 | 10 | 100 | null;
  readonly metadataSourcesChecked: readonly string[];
  readonly conflicts: readonly BymaStrikeConflictItem[];
  readonly expiryResolutionError: BymaExpiryResolutionError;
  readonly exclusionReason: string | null;
}

export interface ResolvedBymaOptionContract {
  readonly nativeSymbol: string;
  readonly canonicalContractId: string | null;
  readonly underlying: string | null;
  readonly side: 'call' | 'put' | null;
  readonly strike: number | null;
  readonly strikeTicks1e4: number | null;
  readonly strikeResolutionStatus: BymaStrikeResolutionStatus;
  readonly strikeSource: BymaStrikeSource;
  readonly contractualExpiry: string | null;
  readonly expiryCode: string | null;
  readonly expiryLabel: string | null;
  readonly expiryUtcSec: number | null;
  readonly daysToExpiry: number | null;
  readonly normalizationEvidence: BymaStrikeNormalizationEvidence;
}

export interface ResolveBymaOptionContractInput {
  readonly rawSymbol: string;
  readonly metadataRecords?: readonly BymaContractMetadataRecord[];
  readonly asOfUtcSec?: number;
  readonly reportDate?: string;
  readonly knownExpiries?: readonly { readonly expiryCode: string; readonly expirationDate: string }[];
  readonly arHolidays?: readonly string[];
  readonly includeNearExpiry?: boolean;
  readonly enforceNotExpired?: boolean;
  readonly knownUnderlyings?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}

const METADATA_PRECEDENCE: Readonly<Record<BymaContractMetadataSource, number>> = {
  IAMC_ANEXO_B: 0,
  PRIMARY_INSTRUMENT_DETAIL: 1,
  BMB_OPTION_METADATA: 2,
  OPEN_BYMA_METADATA: 3,
  DATA912_METADATA: 4,
};

const MONTHS_ES_SHORT: readonly string[] = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

const DEFAULT_KNOWN_UNDERLYINGS = new Set<string>(Object.values(OPTION_PREFIX_TO_UNDERLYING));

function normalizeSymbolToken(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9.,]/g, '');
}

function isKnownUnderlying(
  prefix: string,
  knownUnderlyings?: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): boolean {
  if (knownUnderlyings !== undefined && knownUnderlyings.has(prefix)) {
    return true;
  }
  return DEFAULT_KNOWN_UNDERLYINGS.has(prefix);
}

function makeInvalidContract(params: {
  readonly rawSymbol: string;
  readonly nativeSymbol: string;
  readonly rawStrikeToken: string | null;
  readonly hasExplicitDecimal: boolean;
  readonly underlying: string | null;
  readonly side: 'call' | 'put' | null;
  readonly expiryResolutionError: BymaExpiryResolutionError;
  readonly exclusionReason: string;
  readonly metadataSourcesChecked?: readonly string[];
  readonly conflicts?: readonly BymaStrikeConflictItem[];
}): ResolvedBymaOptionContract {
  return {
    nativeSymbol: params.nativeSymbol,
    canonicalContractId: null,
    underlying: params.underlying,
    side: params.side,
    strike: null,
    strikeTicks1e4: null,
    strikeResolutionStatus: 'INVALID_SYMBOL',
    strikeSource: 'NONE',
    contractualExpiry: null,
    expiryCode: null,
    expiryLabel: null,
    expiryUtcSec: null,
    daysToExpiry: null,
    normalizationEvidence: {
      rawSymbol: params.rawSymbol,
      rawStrikeToken: params.rawStrikeToken,
      hasExplicitDecimal: params.hasExplicitDecimal,
      scaleFactorApplied: null,
      metadataSourcesChecked: params.metadataSourcesChecked ?? [],
      conflicts: params.conflicts ?? [],
      expiryResolutionError: params.expiryResolutionError,
      exclusionReason: params.exclusionReason,
    },
  };
}

function computeExpiryFields(
  contractualExpiry: string,
  expiryCode: string,
  monthLabel: string,
  asOfUtcSec?: number,
): {
  readonly contractualExpiry: string;
  readonly expiryCode: string;
  readonly expiryLabel: string;
  readonly expiryUtcSec: number;
  readonly daysToExpiry: number | null;
} {
  const yyyy = Number(contractualExpiry.slice(0, 4));
  const mm = Number(contractualExpiry.slice(5, 7));
  const dd = Number(contractualExpiry.slice(8, 10));
  const expiryUtcSec = Math.floor(Date.UTC(yyyy, mm - 1, dd, 18, 30, 0) / 1_000);
  const monShort = MONTHS_ES_SHORT[mm - 1] ?? monthLabel.toLowerCase();
  const expiryLabel = `${String(dd)} ${monShort}`;
  const daysToExpiry =
    asOfUtcSec !== undefined && Number.isFinite(asOfUtcSec)
      ? Math.max(1, Math.round((expiryUtcSec - asOfUtcSec) / 86_400))
      : null;
  return {
    contractualExpiry,
    expiryCode,
    expiryLabel,
    expiryUtcSec,
    daysToExpiry,
  };
}

function matchBase10Scale(
  rawStrikeToken: string,
  hasExplicitDecimal: boolean,
  metaTicks: number,
): 1 | 10 | 100 | null {
  if (hasExplicitDecimal) {
    const parsedSymbol = Number(rawStrikeToken.replace(',', '.'));
    if (!Number.isFinite(parsedSymbol) || parsedSymbol <= 0) {
      return null;
    }
    return metaTicks === Math.round(parsedSymbol * 10_000) ? 1 : null;
  }
  const rawInt = Number(rawStrikeToken);
  if (!Number.isSafeInteger(rawInt) || rawInt <= 0) {
    return null;
  }
  const targetTicks = rawInt * 10_000;
  for (const factor of [1, 10, 100] as const) {
    if (metaTicks * factor === targetTicks) {
      return factor;
    }
  }
  return null;
}

/**
 * Resuelve determinísticamente un contrato de opción BYMA siguiendo la jerarquía estricta:
 * Nivel 1 (metadata explícita validada) -> Nivel 2 (símbolo canónico inequívoco) -> Nivel 3 (cuarentena).
 */
export function resolveBymaOptionContract(input: ResolveBymaOptionContractInput): ResolvedBymaOptionContract {
  const rawSymbol = input.rawSymbol;
  const cleanedRaw = normalizeSymbolToken(rawSymbol);
  const nativeSymbol = cleanedRaw.replace(/,/g, '.');

  if (cleanedRaw.length < 6) {
    return makeInvalidContract({
      rawSymbol,
      nativeSymbol,
      rawStrikeToken: null,
      hasExplicitDecimal: false,
      underlying: null,
      side: null,
      expiryResolutionError: 'NONE',
      exclusionReason: 'INVALID_OPTION_SYMBOL_SYNTAX',
    });
  }

  const match = /^([A-Z]{3,5})([CV])(\d+(?:[.,]\d+)?)([A-Z]*)$/.exec(cleanedRaw);
  if (match === null) {
    return makeInvalidContract({
      rawSymbol,
      nativeSymbol,
      rawStrikeToken: null,
      hasExplicitDecimal: false,
      underlying: null,
      side: null,
      expiryResolutionError: 'NONE',
      exclusionReason: 'INVALID_OPTION_SYMBOL_SYNTAX',
    });
  }

  const rawPrefix = match[1] ?? '';
  const optChar = match[2] ?? '';
  const rawStrikeToken = match[3] ?? '';
  const rawSuffix = match[4] ?? '';
  const hasExplicitDecimal = rawStrikeToken.includes('.') || rawStrikeToken.includes(',');
  const side: 'call' | 'put' = optChar === 'C' ? 'call' : 'put';

  const underlying =
    OPTION_PREFIX_TO_UNDERLYING[rawPrefix] ??
    (isKnownUnderlying(rawPrefix, input.knownUnderlyings) ? rawPrefix : null);
  if (underlying === null) {
    return makeInvalidContract({
      rawSymbol,
      nativeSymbol,
      rawStrikeToken,
      hasExplicitDecimal,
      underlying: null,
      side,
      expiryResolutionError: 'NONE',
      exclusionReason: 'UNKNOWN_UNDERLYING_PREFIX',
    });
  }

  if (rawSuffix === '') {
    return makeInvalidContract({
      rawSymbol,
      nativeSymbol,
      rawStrikeToken,
      hasExplicitDecimal,
      underlying,
      side,
      expiryResolutionError: 'MISSING_EXPIRY_SUFFIX',
      exclusionReason: 'MISSING_EXPIRY_SUFFIX',
    });
  }

  const monthInfo = MONTH_CODES[rawSuffix];
  if (monthInfo === undefined) {
    return makeInvalidContract({
      rawSymbol,
      nativeSymbol,
      rawStrikeToken,
      hasExplicitDecimal,
      underlying,
      side,
      expiryResolutionError: 'AMBIGUOUS_EXPIRY_SUFFIX',
      exclusionReason: 'AMBIGUOUS_EXPIRY_SUFFIX',
    });
  }

  // Nivel 1 — Inspeccionar toda la metadata contractual explícita aplicable al contrato
  const matchingRecords = (input.metadataRecords ?? []).filter((rec) => {
    if (rec.nativeSymbol !== undefined && rec.nativeSymbol !== null) {
      const normalizedRec = normalizeSymbolToken(rec.nativeSymbol).replace(/,/g, '.');
      if (normalizedRec !== nativeSymbol) {
        return false;
      }
    }
    if (rec.unit !== undefined && rec.unit !== null && rec.unit !== 'ARS') {
      return false;
    }
    return rec.strike !== undefined && rec.strike !== null && Number.isFinite(rec.strike) && rec.strike > 0;
  });

  const metadataSourcesChecked = [...new Set(matchingRecords.map((rec) => rec.source))];
  const conflicts: BymaStrikeConflictItem[] = [];
  const validCandidates: {
    readonly record: BymaContractMetadataRecord;
    readonly metaTicks: number;
    readonly scaleFactor: 1 | 10 | 100;
    readonly contractualExpiry: string | null;
  }[] = [];

  for (const rec of matchingRecords) {
    const reportedStrike =
      rec.strike !== undefined && rec.strike !== null && Number.isFinite(rec.strike) && rec.strike > 0
        ? rec.strike
        : null;
    const reportedExpiry =
      rec.contractualExpiry !== undefined && rec.contractualExpiry !== null
        ? rec.contractualExpiry.trim()
        : null;

    if (rec.underlying !== undefined && rec.underlying !== null) {
      const recUnderlying = rec.underlying.trim().toUpperCase();
      if (recUnderlying !== underlying) {
        conflicts.push({
          source: rec.source,
          reportedStrike,
          reportedExpiry,
          reason: `UNDERLYING_MISMATCH:${recUnderlying}!=${underlying}`,
        });
        continue;
      }
    }

    if (rec.side !== undefined && rec.side !== null && rec.side !== side) {
      conflicts.push({
        source: rec.source,
        reportedStrike,
        reportedExpiry,
        reason: `SIDE_MISMATCH:${rec.side}!=${side}`,
      });
      continue;
    }

    if (rec.expiryCode !== undefined && rec.expiryCode !== null && rec.expiryCode.trim() !== '') {
      const code = MONTH_CODES[rec.expiryCode.trim().toUpperCase()]?.code;
      if (code !== monthInfo.code) {
        conflicts.push({
          source: rec.source,
          reportedStrike,
          reportedExpiry,
          reason: 'EXPIRY_CODE_MISMATCH',
        });
        continue;
      }
    }

    let validatedExpiry: string | null = null;
    if (reportedExpiry !== null && reportedExpiry !== '') {
      const expiryMonth = Number(reportedExpiry.slice(5, 7));
      if (!isIsoContractDate(reportedExpiry) || expiryMonth !== monthInfo.month) {
        conflicts.push({
          source: rec.source,
          reportedStrike,
          reportedExpiry,
          reason: 'EXPIRY_DATE_MISMATCH',
        });
        continue;
      }
      validatedExpiry = reportedExpiry;
    }

    if (reportedStrike === null) {
      continue;
    }
    const metaTicks = Math.round(reportedStrike * 10_000);
    if (!Number.isSafeInteger(metaTicks) || metaTicks <= 0) {
      conflicts.push({
        source: rec.source,
        reportedStrike,
        reportedExpiry: validatedExpiry,
        reason: 'INVALID_STRIKE',
      });
      continue;
    }

    const scaleFactor = matchBase10Scale(rawStrikeToken, hasExplicitDecimal, metaTicks);
    if (scaleFactor === null) {
      conflicts.push({
        source: rec.source,
        reportedStrike,
        reportedExpiry: validatedExpiry,
        reason: 'STRIKE_MISMATCH',
      });
      continue;
    }

    validCandidates.push({
      record: rec,
      metaTicks,
      scaleFactor,
      contractualExpiry: validatedExpiry,
    });
  }

  // Verificar desacuerdos entre fuentes autoritativas Level-1
  const distinctTicks = new Set(validCandidates.map((c) => c.metaTicks));
  const explicitExpiries = validCandidates
    .map((c) => c.contractualExpiry)
    .filter((v): v is string => v !== null);
  const distinctExpiries = new Set(explicitExpiries);

  if (distinctTicks.size > 1 || distinctExpiries.size > 1) {
    for (const c of validCandidates) {
      const reasons: string[] = [];
      if (distinctTicks.size > 1) reasons.push('STRIKE_DISAGREEMENT');
      if (distinctExpiries.size > 1) reasons.push('EXPIRY_DISAGREEMENT');
      conflicts.push({
        source: c.record.source,
        reportedStrike: c.metaTicks / 10_000,
        reportedExpiry: c.contractualExpiry,
        reason: reasons.join('+'),
      });
    }
  }

  const agreedExpiry = distinctExpiries.size === 1 ? explicitExpiries[0] : undefined;
  const candidateReportDates = validCandidates
    .map((c) => c.record.reportDate?.trim())
    .filter((d): d is string => d !== undefined && d !== '' && isIsoContractDate(d));
  const fallbackAsOfDate =
    input.asOfUtcSec !== undefined && Number.isFinite(input.asOfUtcSec)
      ? new Date(input.asOfUtcSec * 1_000).toISOString().slice(0, 10)
      : undefined;
  const effectiveReportDate = input.reportDate ?? candidateReportDates[0] ?? fallbackAsOfDate ?? agreedExpiry;

  // Resolver vencimiento contractual cuando no exista conflicto de vencimiento
  let resolvedExpiry: ReturnType<typeof computeExpiryFields> | null = null;
  if (distinctExpiries.size <= 1) {
    if (effectiveReportDate === undefined) {
      return makeInvalidContract({
        rawSymbol,
        nativeSymbol,
        rawStrikeToken,
        hasExplicitDecimal,
        underlying,
        side,
        expiryResolutionError: 'MISSING_EXPIRY_CONTEXT',
        exclusionReason: 'MISSING_EXPIRY_CONTEXT',
        metadataSourcesChecked,
        conflicts,
      });
    }
    const expRes = resolveBymaContractualExpiry({
      reportDate: effectiveReportDate,
      expiryCode: monthInfo.code,
      ...(agreedExpiry !== undefined ? { contractualExpiry: agreedExpiry } : {}),
      ...(input.knownExpiries !== undefined ? { knownExpiries: input.knownExpiries } : {}),
      ...(input.arHolidays !== undefined ? { arHolidays: input.arHolidays } : {}),
    });
    if ('code' in expRes) {
      return makeInvalidContract({
        rawSymbol,
        nativeSymbol,
        rawStrikeToken,
        hasExplicitDecimal,
        underlying,
        side,
        expiryResolutionError: expRes.code,
        exclusionReason: expRes.code,
        metadataSourcesChecked,
        conflicts,
      });
    }
    const fields = computeExpiryFields(
      expRes.contractualExpiry,
      expRes.expiryCode,
      monthInfo.label,
      input.asOfUtcSec,
    );
    if (
      input.asOfUtcSec !== undefined &&
      input.enforceNotExpired !== false &&
      (fields.expiryUtcSec <= input.asOfUtcSec ||
        (input.includeNearExpiry !== true &&
          fields.expiryUtcSec - input.asOfUtcSec <= MIN_CONTRACTUAL_EXPIRY_SEC))
    ) {
      return makeInvalidContract({
        rawSymbol,
        nativeSymbol,
        rawStrikeToken,
        hasExplicitDecimal,
        underlying,
        side,
        expiryResolutionError: 'EXPIRED_OR_TOO_NEAR',
        exclusionReason: 'EXPIRED_OR_TOO_NEAR',
        metadataSourcesChecked,
        conflicts,
      });
    }
    resolvedExpiry = fields;
  }

  // Cualquier conflicto o mismatch Level-1 entra fail-closed a CONFLICTING_METADATA
  if (conflicts.length > 0) {
    return {
      nativeSymbol,
      canonicalContractId: null,
      underlying,
      side,
      strike: null,
      strikeTicks1e4: null,
      strikeResolutionStatus: 'CONFLICTING_METADATA',
      strikeSource: 'NONE',
      contractualExpiry: resolvedExpiry?.contractualExpiry ?? null,
      expiryCode: resolvedExpiry?.expiryCode ?? null,
      expiryLabel: resolvedExpiry?.expiryLabel ?? null,
      expiryUtcSec: resolvedExpiry?.expiryUtcSec ?? null,
      daysToExpiry: resolvedExpiry?.daysToExpiry ?? null,
      normalizationEvidence: {
        rawSymbol,
        rawStrikeToken,
        hasExplicitDecimal,
        scaleFactorApplied: null,
        metadataSourcesChecked,
        conflicts,
        expiryResolutionError: 'NONE',
        exclusionReason: 'CONFLICTING_AUTHORITATIVE_STRIKE_METADATA',
      },
    };
  }

  const expiryFields = resolvedExpiry;
  if (expiryFields === null) {
    return makeInvalidContract({
      rawSymbol,
      nativeSymbol,
      rawStrikeToken,
      hasExplicitDecimal,
      underlying,
      side,
      expiryResolutionError: 'EXPIRY_DATE_MISMATCH',
      exclusionReason: 'EXPIRY_DATE_MISMATCH',
      metadataSourcesChecked,
      conflicts,
    });
  }

  const buildIdentityId = (strikeNum: number, ticks: number): string | null => {
    if (effectiveReportDate === undefined || !isIsoContractDate(effectiveReportDate)) {
      return null;
    }
    const identity: CanonicalOptionIdentity = {
      market: 'BYMA_AR',
      underlying,
      nativeSeries: nativeSymbol,
      side,
      contractualExpiry: expiryFields.contractualExpiry,
      expiryCode: expiryFields.expiryCode,
      strike: strikeNum,
      strikeTicks1e4: ticks,
      reportDate: effectiveReportDate,
    };
    return buildCanonicalOptionKey(identity);
  };

  // Nivel 1 exitoso: todas las fuentes autoritativas coinciden
  if (validCandidates.length > 0) {
    const ordered = [...validCandidates].sort(
      (a, b) => METADATA_PRECEDENCE[a.record.source] - METADATA_PRECEDENCE[b.record.source],
    );
    const chosen = ordered[0];
    if (chosen !== undefined) {
      const strikeValue = chosen.metaTicks / 10_000;
      return {
        nativeSymbol,
        canonicalContractId: buildIdentityId(strikeValue, chosen.metaTicks),
        underlying,
        side,
        strike: strikeValue,
        strikeTicks1e4: chosen.metaTicks,
        strikeResolutionStatus: 'EXPLICIT_METADATA',
        strikeSource: chosen.record.source,
        contractualExpiry: expiryFields.contractualExpiry,
        expiryCode: expiryFields.expiryCode,
        expiryLabel: expiryFields.expiryLabel,
        expiryUtcSec: expiryFields.expiryUtcSec,
        daysToExpiry: expiryFields.daysToExpiry,
        normalizationEvidence: {
          rawSymbol,
          rawStrikeToken,
          hasExplicitDecimal,
          scaleFactorApplied: chosen.scaleFactor,
          metadataSourcesChecked,
          conflicts: [],
          expiryResolutionError: 'NONE',
          exclusionReason: null,
        },
      };
    }
  }

  // Nivel 2 — Decodificación sintáctica inequívoca sin dependencia del spot
  if (hasExplicitDecimal) {
    const parsed = Number(rawStrikeToken.replace(',', '.'));
    const ticks = Math.round(parsed * 10_000);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(ticks) || ticks <= 0) {
      return makeInvalidContract({
        rawSymbol,
        nativeSymbol,
        rawStrikeToken,
        hasExplicitDecimal,
        underlying,
        side,
        expiryResolutionError: 'NONE',
        exclusionReason: 'INVALID_STRIKE',
        metadataSourcesChecked,
      });
    }
    const strikeValue = ticks / 10_000;
    return {
      nativeSymbol,
      canonicalContractId: buildIdentityId(strikeValue, ticks),
      underlying,
      side,
      strike: strikeValue,
      strikeTicks1e4: ticks,
      strikeResolutionStatus: 'CANONICAL_SYMBOL',
      strikeSource: 'SYMBOL_EXPLICIT_DECIMAL',
      contractualExpiry: expiryFields.contractualExpiry,
      expiryCode: expiryFields.expiryCode,
      expiryLabel: expiryFields.expiryLabel,
      expiryUtcSec: expiryFields.expiryUtcSec,
      daysToExpiry: expiryFields.daysToExpiry,
      normalizationEvidence: {
        rawSymbol,
        rawStrikeToken,
        hasExplicitDecimal: true,
        scaleFactorApplied: 1,
        metadataSourcesChecked,
        conflicts: [],
        expiryResolutionError: 'NONE',
        exclusionReason: null,
      },
    };
  }

  // Entero sin separador decimal explícito
  const isLeadingZero = rawStrikeToken.startsWith('0');
  const rawInt = Number(rawStrikeToken);
  if (!Number.isSafeInteger(rawInt) || rawInt <= 0) {
    return makeInvalidContract({
      rawSymbol,
      nativeSymbol,
      rawStrikeToken,
      hasExplicitDecimal: false,
      underlying,
      side,
      expiryResolutionError: 'NONE',
      exclusionReason: 'INVALID_STRIKE',
      metadataSourcesChecked,
    });
  }

  const len = rawStrikeToken.length;
  const isCanonicalIntegerGrid =
    !isLeadingZero &&
    (len <= 2 ||
      ((len === 3 || len === 4) && rawInt % 10 === 0) ||
      (len === 5 && rawInt % 100 === 0) ||
      (len >= 6 && rawInt % 1000 === 0));

  if (isCanonicalIntegerGrid) {
    const ticks = rawInt * 10_000;
    return {
      nativeSymbol,
      canonicalContractId: buildIdentityId(rawInt, ticks),
      underlying,
      side,
      strike: rawInt,
      strikeTicks1e4: ticks,
      strikeResolutionStatus: 'CANONICAL_SYMBOL',
      strikeSource: 'SYMBOL_CANONICAL_INTEGER',
      contractualExpiry: expiryFields.contractualExpiry,
      expiryCode: expiryFields.expiryCode,
      expiryLabel: expiryFields.expiryLabel,
      expiryUtcSec: expiryFields.expiryUtcSec,
      daysToExpiry: expiryFields.daysToExpiry,
      normalizationEvidence: {
        rawSymbol,
        rawStrikeToken,
        hasExplicitDecimal: false,
        scaleFactorApplied: 1,
        metadataSourcesChecked,
        conflicts: [],
        expiryResolutionError: 'NONE',
        exclusionReason: null,
      },
    };
  }

  // Nivel 3 — Cuarentena explícita: escala ambigua sin metadata contractual
  return {
    nativeSymbol,
    canonicalContractId: null,
    underlying,
    side,
    strike: null,
    strikeTicks1e4: null,
    strikeResolutionStatus: 'AMBIGUOUS_SCALE_UNRESOLVED',
    strikeSource: 'NONE',
    contractualExpiry: expiryFields.contractualExpiry,
    expiryCode: expiryFields.expiryCode,
    expiryLabel: expiryFields.expiryLabel,
    expiryUtcSec: expiryFields.expiryUtcSec,
    daysToExpiry: expiryFields.daysToExpiry,
    normalizationEvidence: {
      rawSymbol,
      rawStrikeToken,
      hasExplicitDecimal: false,
      scaleFactorApplied: null,
      metadataSourcesChecked,
      conflicts: [],
      expiryResolutionError: 'NONE',
      exclusionReason: 'AMBIGUOUS_STRIKE_SCALE_REQUIRES_METADATA',
    },
  };
}
