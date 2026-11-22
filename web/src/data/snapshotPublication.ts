/**
 * Pieza 50.9 (Bloque B) — publicación coherente de snapshots US por símbolo y alcance.
 *
 * Funciones puras: orden de publicación por alcance (revisión y hora de
 * evaluación no retroceden), decisión por vencimiento entre un hecho puntual y
 * los datos vigentes (gana el estrictamente más nuevo; sin datos cargados el
 * hecho se conserva/anexa) y fusión de la base con los hechos puntuales de la
 * fecha solicitada. El agregado (exposición, traza, spot de valuación,
 * asOfUtcSec) proviene SIEMPRE de la base; un alcance puntual solo aporta sus
 * hechos de vencimiento.
 */

import type { UsSnapshotResponseDto } from './liveTypes.js';

export interface PublicationStamp {
  /** Revisión creciente de la solicitud dentro de su alcance. */
  readonly revision: number;
  /** Hora de evaluación de la respuesta (asOfUtcSec). */
  readonly evaluationSec: number;
}

export type PublicationDecision = 'accept' | 'stale';

/**
 * Decide si una respuesta debe publicarse. La frescura de datos determina el
 * orden; la revisión local de solicitud desempata evaluaciones iguales. Sin
 * sello previo se acepta; sellos inválidos se descartan.
 */
export function resolvePublicationDecision(
  current: PublicationStamp | null,
  incoming: PublicationStamp,
): PublicationDecision {
  if (!Number.isInteger(incoming.revision) || incoming.revision <= 0) return 'stale';
  if (!Number.isFinite(incoming.evaluationSec)) return 'stale';
  if (current === null) return 'accept';
  if (!Number.isFinite(current.evaluationSec)) return 'accept';
  if (incoming.evaluationSec < current.evaluationSec) return 'stale';
  const currentRevisionValid = Number.isInteger(current.revision) && current.revision > 0;
  if (currentRevisionValid && incoming.revision !== current.revision) {
    return incoming.revision > current.revision ? 'accept' : 'stale';
  }
  return 'accept';
}

export interface ExpiryFactState {
  /** La respuesta trae datos cargados para su fecha. */
  readonly loaded: boolean;
  /** Hora de evaluación de esos datos (asOfUtcSec); null si no es finita. */
  readonly evaluationSec: number | null;
}

export type ExpiryFactDecision = 'publish' | 'keep';

/**
 * Decide si el hecho puntual de UN vencimiento reemplaza los datos vigentes de
 * la MISMA fecha. Sin datos cargados vigentes (la base la omite o trae stub) el
 * hecho se publica/anexa; con datos cargados solo gana el hecho estrictamente
 * más nuevo, de modo que ni la base ni un hecho más reciente retrocedan. Un
 * hecho sin datos o con evaluación inválida nunca publica.
 */
export function resolveExpiryFactDecision(
  fact: ExpiryFactState,
  current: ExpiryFactState | null,
): ExpiryFactDecision {
  if (!fact.loaded) return 'keep';
  if (fact.evaluationSec === null || !Number.isFinite(fact.evaluationSec)) return 'keep';
  if (current === null) return 'publish';
  if (!current.loaded) return 'publish';
  if (current.evaluationSec === null || !Number.isFinite(current.evaluationSec)) return 'publish';
  return fact.evaluationSec > current.evaluationSec ? 'publish' : 'keep';
}

function loadedDates(snap: UsSnapshotResponseDto, onlyDate?: string): ReadonlySet<string> {
  const dates = new Set<string>();
  for (const candidate of snap.optionsChain?.availableExpirations ?? []) {
    if (candidate.loaded !== true) continue;
    if (onlyDate !== undefined && candidate.expirationDate !== onlyDate) continue;
    dates.add(candidate.expirationDate);
  }
  return dates;
}

/**
 * Publica `base` conservando los hechos puntuales cargados de `scope`
 * (el snapshot vigente o la respuesta puntual): las entradas con `loaded: true`
 * y sus `expiriesByCode` vigentes. Con `onlyDate`, una publicación puntual solo
 * puede aportar SU fecha solicitada (la respuesta puede traer anclas o fechas
 * curadas cargadas de más). En conflicto por vencimiento gana la versión
 * vigente de `scope`; el resto del agregado es de `base`.
 */
export function mergeLoadedExpiriesIntoBaseSnapshot(
  base: UsSnapshotResponseDto,
  scope: UsSnapshotResponseDto | null | undefined,
  onlyDate?: string,
): UsSnapshotResponseDto {
  if (scope === null || scope === undefined) return base;
  const loaded = loadedDates(scope, onlyDate);
  if (loaded.size === 0) return base;

  const scopeEntries = new Map(
    (scope.optionsChain?.availableExpirations ?? []).map((entry) => [entry.expirationDate, entry] as const),
  );
  const baseEntries = base.optionsChain?.availableExpirations ?? [];
  const merged = baseEntries.map((entry) =>
    loaded.has(entry.expirationDate) ? (scopeEntries.get(entry.expirationDate) ?? entry) : entry,
  );
  const present = new Set(merged.map((entry) => entry.expirationDate));
  for (const date of [...loaded].sort((a, b) => a.localeCompare(b))) {
    if (present.has(date)) continue;
    const entry = scopeEntries.get(date);
    if (entry !== undefined) merged.push(entry);
  }

  const baseSuite = base.terminalEngines?.volAnalyticsSuite ?? null;
  const scopeSuite = scope.terminalEngines?.volAnalyticsSuite ?? null;
  const baseByCode = baseSuite?.expiriesByCode ?? null;
  const scopeByCode = scopeSuite?.expiriesByCode ?? null;
  let mergedSuite = baseSuite;
  if (baseSuite !== null && scopeByCode !== null) {
    const mergedByCode: Record<string, unknown> = { ...baseByCode };
    for (const date of loaded) {
      if (scopeByCode[date] !== undefined) mergedByCode[date] = scopeByCode[date];
    }
    mergedSuite = { ...baseSuite, expiriesByCode: mergedByCode as typeof baseSuite.expiriesByCode };
  }

  const withChain = base.optionsChain
    ? { ...base, optionsChain: { ...base.optionsChain, availableExpirations: merged } }
    : base;
  if (mergedSuite === baseSuite) return withChain;
  return base.terminalEngines
    ? { ...withChain, terminalEngines: { ...base.terminalEngines, volAnalyticsSuite: mergedSuite } }
    : withChain;
}
