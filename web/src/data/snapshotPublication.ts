/**
 * Pieza 50.9 (Bloque B) — publicación coherente de snapshots US por símbolo y alcance.
 *
 * Funciones puras: orden de publicación por revisión de solicitud y hora de
 * evaluación, y fusión de la base nueva con los vencimientos puntuales ya
 * cargados. El agregado (exposición, traza, spot de valuación, asOfUtcSec)
 * proviene SIEMPRE de la base; un alcance puntual solo aporta sus hechos de
 * vencimiento (`availableExpirations[*].loaded` y `expiriesByCode[D]`).
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
 * Decide si una respuesta debe publicarse. Una revisión mayor siempre manda;
 * con la misma revisión solo se acepta evaluación no anterior. Sin sello previo
 * (primer resultado del alcance) se acepta. Revisión o evaluación no válidas se
 * descartan.
 */
export function resolvePublicationDecision(
  current: PublicationStamp | null,
  incoming: PublicationStamp,
): PublicationDecision {
  if (!Number.isInteger(incoming.revision) || incoming.revision <= 0) return 'stale';
  if (!Number.isFinite(incoming.evaluationSec)) return 'stale';
  if (current === null) return 'accept';
  if (!Number.isFinite(current.evaluationSec)) return 'accept';
  if (incoming.revision > current.revision) return 'accept';
  if (incoming.revision === current.revision && incoming.evaluationSec >= current.evaluationSec) {
    return 'accept';
  }
  return 'stale';
}

function loadedDates(snap: UsSnapshotResponseDto): ReadonlySet<string> {
  const dates = new Set<string>();
  for (const candidate of snap.optionsChain?.availableExpirations ?? []) {
    if (candidate.loaded === true) dates.add(candidate.expirationDate);
  }
  return dates;
}

/**
 * Publica `base` conservando los vencimientos puntuales ya cargados de
 * `scope` (el snapshot vigente o la respuesta puntual): las entradas con
 * `loaded: true` y sus `expiriesByCode` vigentes. En conflicto por vencimiento
 * gana la versión vigente de `scope`; el resto del agregado es de `base`.
 */
export function mergeLoadedExpiriesIntoBaseSnapshot(
  base: UsSnapshotResponseDto,
  scope: UsSnapshotResponseDto | null | undefined,
): UsSnapshotResponseDto {
  if (scope === null || scope === undefined) return base;
  const loaded = loadedDates(scope);
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
