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

export interface ExposureCoverageEvidence {
  /** `false` cuando no hay evidencia acreditable (respuesta legacy o AR). */
  readonly evidenced: boolean;
  readonly engineInputs: number;
  readonly skippedContracts: number;
  readonly chainTruncated: boolean;
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
  if (evidence.skippedContracts > 0 || evidence.chainTruncated) return 'partial';
  return 'complete';
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
  readonly engineStrikeRange: StrikeRange;
  readonly engineStrikeCount: number;
  readonly byStrikeRange: StrikeRange;
  readonly byStrikeCount: number;
  /** Catálogo completo disponible (vencimientos) frente a lo enviado al motor. */
  readonly catalogExpirationsCount: number | null;
  /** Filas de contrato serializadas en el payload REST. */
  readonly payloadContractCount: number;
  readonly quoteTimes: QuoteTimeTrace | null;
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
  readonly engineExpirations: readonly number[];
  readonly byStrike: readonly number[];
  readonly catalogExpirationsCount: number | null;
  readonly payloadContractCount: number;
  readonly quoteTimes: QuoteTimeTrace | null;
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
    engineExpirationsCount: input.engineExpirations.length,
    engineStrikeRange: rangeOf(input.engineStrikes),
    engineStrikeCount: input.engineStrikes.length,
    byStrikeRange: rangeOf(input.byStrike),
    byStrikeCount: input.byStrike.length,
    catalogExpirationsCount: input.catalogExpirationsCount,
    payloadContractCount: input.payloadContractCount,
    quoteTimes: input.quoteTimes,
  };
}
