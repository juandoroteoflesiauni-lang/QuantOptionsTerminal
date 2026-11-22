/**
 * Pieza 50.9 (Bloque A) — trazabilidad de exposición US/AR.
 *
 * Funciones puras: resumen verificable de tiempos de cotización, estado de
 * cobertura y metadatos serializables del resumen de exposición. Separación
 * estricta: hora de evaluación (REST) ≠ tiempo de cotización NBBO/IV/OI. Un
 * timestamp faltante, inválido (no entero), no positivo o futuro respecto de la
 * evaluación es desconocido y queda fuera del rango. Las referencias EOD
 * sustituidas no aportan tiempo verificable de cotización y también quedan
 * fuera del rango, aunque su precio coincida.
 */

export interface QuoteTimeEntry {
  /** Hora de cotización verificable (NBBO/IV/OI), segundos UTC. */
  readonly updatedAtSec: number | null | undefined;
  /** Punta sustituida por el overlay Tradier (se registra su procedencia). */
  readonly fromOverlay?: boolean;
  /** Punta sustituida por referencia EOD: sin cotización nueva. */
  readonly eodReference?: boolean;
}

export interface QuoteTimeTrace {
  readonly knownCount: number;
  readonly unknownCount: number;
  readonly minUpdatedAtSec: number | null;
  readonly maxUpdatedAtSec: number | null;
  /** Edad observada de la cotización más nueva/antigua frente a la evaluación. */
  readonly newestAgeSec: number | null;
  readonly oldestAgeSec: number | null;
  readonly overlayQuoteCount: number;
  readonly eodReferenceCount: number;
}

/** Resume los tiempos verificables de cotización de los inputs de exposición. */
export function summarizeQuoteTimes(
  entries: readonly QuoteTimeEntry[],
  asOfUtcSec: number,
): QuoteTimeTrace {
  const evalSec = Number.isFinite(asOfUtcSec) ? Math.floor(asOfUtcSec) : Number.NaN;
  let knownCount = 0;
  let unknownCount = 0;
  let overlayQuoteCount = 0;
  let eodReferenceCount = 0;
  let minUpdatedAtSec: number | null = null;
  let maxUpdatedAtSec: number | null = null;

  for (const entry of entries) {
    if (entry.fromOverlay === true) overlayQuoteCount += 1;
    if (entry.eodReference === true) {
      eodReferenceCount += 1;
      unknownCount += 1;
      continue;
    }
    const updatedAtSec = entry.updatedAtSec;
    const verifiable =
      typeof updatedAtSec === 'number' &&
      Number.isInteger(updatedAtSec) &&
      updatedAtSec > 0 &&
      Number.isFinite(evalSec) &&
      updatedAtSec <= evalSec;
    if (!verifiable) {
      unknownCount += 1;
      continue;
    }
    knownCount += 1;
    if (minUpdatedAtSec === null || updatedAtSec < minUpdatedAtSec) minUpdatedAtSec = updatedAtSec;
    if (maxUpdatedAtSec === null || updatedAtSec > maxUpdatedAtSec) maxUpdatedAtSec = updatedAtSec;
  }

  return {
    knownCount,
    unknownCount,
    minUpdatedAtSec,
    maxUpdatedAtSec,
    newestAgeSec: maxUpdatedAtSec !== null ? evalSec - maxUpdatedAtSec : null,
    oldestAgeSec: minUpdatedAtSec !== null ? evalSec - minUpdatedAtSec : null,
    overlayQuoteCount,
    eodReferenceCount,
  };
}

export interface ChainDateReport {
  readonly dateKey: string;
  readonly stoppedReason: string | null;
  readonly providerError: boolean;
  readonly contractCount: number;
}

export interface ChainCoverageSummary {
  readonly requestedDates: readonly string[];
  readonly deliveredDates: readonly string[];
  readonly missingDates: readonly string[];
  /** Corte comprobable del paginador (`maxPages`). */
  readonly chainTruncated: boolean;
  readonly chainErrors: boolean;
}

/** Evidencia de cobertura de la carga de cadena por fecha (informe real). */
export function summarizeChainCoverage(
  reports: readonly ChainDateReport[],
  requestedDates: readonly string[],
): ChainCoverageSummary {
  const requested = [...new Set(requestedDates)].filter((date) => date !== '');
  const delivered: string[] = [];
  let chainTruncated = false;
  let chainErrors = false;
  for (const report of reports) {
    if (report.stoppedReason === 'maxPages') chainTruncated = true;
    if (report.providerError) chainErrors = true;
    if (report.contractCount > 0 && requested.includes(report.dateKey) && !delivered.includes(report.dateKey)) {
      delivered.push(report.dateKey);
    }
  }
  const missingDates = requested.filter((date) => !delivered.includes(date));
  return {
    requestedDates: requested,
    deliveredDates: delivered.sort((a, b) => a.localeCompare(b)),
    missingDates,
    chainTruncated,
    chainErrors,
  };
}

export interface ExposureCoverageEvidence {
  /** `false` cuando no hay evidencia acreditable (respuesta legacy o AR). */
  readonly evidenced: boolean;
  readonly engineInputs: number;
  readonly skippedContracts: number;
  readonly chainTruncated: boolean;
  /** Corte/error comprobable en la carga de cadena (Pieza 50.9 corrección). */
  readonly chainErrors?: boolean;
  /** Fechas solicitadas sin resultado entregado. */
  readonly missingDatesCount?: number;
}

export type ExposureCoverageStatus = 'complete' | 'partial' | 'unknown';

/** Cobertura acreditada del insumo del motor: exacta, parcial o desconocida. */
export function resolveExposureCoverage(evidence: ExposureCoverageEvidence): ExposureCoverageStatus {
  if (!evidence.evidenced) return 'unknown';
  if (
    !Number.isFinite(evidence.engineInputs) ||
    evidence.engineInputs <= 0 ||
    !Number.isFinite(evidence.skippedContracts)
  ) {
    return 'unknown';
  }
  if (
    evidence.skippedContracts > 0 ||
    evidence.chainTruncated ||
    evidence.chainErrors === true ||
    (evidence.missingDatesCount ?? 0) > 0
  ) {
    return 'partial';
  }
  return 'complete';
}

export interface ArOiProvenanceInput {
  /** `true` si el OI del input proviene de OI reportado (BMB), no de volumen nominal. */
  readonly oiFromReported: boolean;
}

export interface ArOiProvenanceSummary {
  readonly directOiInputs: number;
  readonly proxyOiInputs: number;
  /** `true` si algún input usa proxy de volumen; `null` sin inputs acreditables. */
  readonly oiProxy: boolean | null;
}

/** Procedencia del OI de los inputs AR: directo, proxy de volumen o desconocido. */
export function resolveArOiProvenance(
  inputs: readonly ArOiProvenanceInput[],
): ArOiProvenanceSummary {
  let directOiInputs = 0;
  let proxyOiInputs = 0;
  for (const input of inputs) {
    if (input.oiFromReported) {
      directOiInputs += 1;
    } else {
      proxyOiInputs += 1;
    }
  }
  return {
    directOiInputs,
    proxyOiInputs,
    oiProxy: inputs.length === 0 ? null : proxyOiInputs > 0,
  };
}

export interface StrikeRange {
  readonly min: number | null;
  readonly max: number | null;
}

export interface ExposureTraceMetadata {
  readonly evaluationSec: number;
  readonly valuationSpot: number | null;
  readonly valuationSpotSource: string | null;
  readonly headerSpot: number | null;
  readonly spotDivergenceBps: number | null;
  readonly quoteMode: 'LIVE_NBBO' | 'EOD_CLOSE_REF' | null;
  readonly coverage: ExposureCoverageStatus;
  readonly engineExpirationsCount: number;
  /** Fechas concretas entregadas al motor (no catálogo ni payload). */
  readonly engineExpirationDates: readonly string[];
  readonly engineStrikeRange: StrikeRange;
  readonly engineStrikeCount: number;
  readonly byStrikeRange: StrikeRange;
  readonly byStrikeCount: number;
  /** Catálogo completo disponible (vencimientos) frente a lo enviado al motor. */
  readonly catalogExpirationsCount: number | null;
  readonly catalogExpirationDates: readonly string[];
  /** Filas de contrato serializadas en el payload REST. */
  readonly payloadContractCount: number;
  readonly payloadExpirationDates: readonly string[];
  readonly quoteTimes: QuoteTimeTrace | null;
  /** Cobertura de la carga de cadena (fechas pedidas/entregadas/faltantes). */
  readonly chainCoverage: ChainCoverageSummary | null;
}

export interface ExposureTraceMetadataInput {
  readonly evaluationSec: number;
  readonly valuationSpot: number | null;
  readonly valuationSpotSource: string | null;
  readonly headerSpot: number | null;
  readonly spotDivergenceBps: number | null;
  readonly quoteMode: 'LIVE_NBBO' | 'EOD_CLOSE_REF' | null;
  readonly coverage: ExposureCoverageStatus;
  readonly engineStrikes: readonly number[];
  readonly engineExpirationDates: readonly string[];
  readonly byStrike: readonly number[];
  readonly catalogExpirationsCount: number | null;
  readonly catalogExpirationDates: readonly string[];
  readonly payloadContractCount: number;
  readonly payloadExpirationDates: readonly string[];
  readonly quoteTimes: QuoteTimeTrace | null;
  readonly chainCoverage: ChainCoverageSummary | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rangeOf(values: readonly number[]): StrikeRange {
  let min: number | null = null;
  let max: number | null = null;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
  }
  return { min, max };
}

/** Ensambla los metadatos serializables del resumen de exposición. */
export function buildExposureTraceMetadata(
  input: ExposureTraceMetadataInput,
): ExposureTraceMetadata {
  return {
    evaluationSec: Number.isFinite(input.evaluationSec) ? Math.floor(input.evaluationSec) : Number.NaN,
    valuationSpot: finiteOrNull(input.valuationSpot),
    valuationSpotSource: input.valuationSpotSource,
    headerSpot: finiteOrNull(input.headerSpot),
    spotDivergenceBps: finiteOrNull(input.spotDivergenceBps),
    quoteMode: input.quoteMode,
    coverage: input.coverage,
    engineExpirationsCount: input.engineExpirationDates.length,
    engineExpirationDates: [...input.engineExpirationDates],
    engineStrikeRange: rangeOf(input.engineStrikes),
    engineStrikeCount: input.engineStrikes.length,
    byStrikeRange: rangeOf(input.byStrike),
    byStrikeCount: input.byStrike.length,
    catalogExpirationsCount: input.catalogExpirationsCount,
    catalogExpirationDates: [...input.catalogExpirationDates],
    payloadContractCount: input.payloadContractCount,
    payloadExpirationDates: [...input.payloadExpirationDates],
    quoteTimes: input.quoteTimes,
    chainCoverage: input.chainCoverage,
  };
}
