/**
 * Serializador JSON-safe tipado (`NaN` / `±Infinity` -> `null`) para frontera con
 * frontend React / TradingView Lightweight Charts (Pieza 12).
 *
 * Garantías de diseño:
 *  - Funciones puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Convierte recursivamente todo `number` no finito en `null` contabilizando
 *    los campos saneados (`nonFiniteFieldCount`, `nonFinitePaths`).
 *  - Clasifica `envelopeStatus`: `'NO_DATA'` | `'PARTIAL'` | `'OK'`.
 */

import { MAX_TIME_SECONDS } from '../sessions.js';
import type {
  EnvelopeStatus,
  JsonSafe,
  SerializedMetadata,
  TerminalConfluenceSnapshot,
  TerminalSerializedEnvelope,
} from './types.js';

function assertValidUtcSeconds(time: number, label: string): void {
  if (!Number.isFinite(time) || !Number.isInteger(time) || Math.abs(time) > MAX_TIME_SECONDS) {
    throw new Error(`${label} must be finite integer UTC seconds (got ${String(time)})`);
  }
}

function sanitizeRecursive(
  value: unknown,
  path: string,
  nonFinitePaths: string[],
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      nonFinitePaths.push(path);
      return null;
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(
      `Unsupported non-JSON value (${typeof value}) at path "${path}"`,
    );
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const elem: unknown = value[i];
      const sanitizedElem = sanitizeRecursive(elem, `${path}[${String(i)}]`, nonFinitePaths);
      out.push(sanitizedElem === undefined ? null : sanitizedElem);
    }
    return out;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const propPath = path.length > 0 ? `${path}.${key}` : key;
      const sanitizedProp = sanitizeRecursive(record[key], propPath, nonFinitePaths);
      if (sanitizedProp !== undefined) {
        out[key] = sanitizedProp;
      }
    }
    return out;
  }

  throw new Error(`Unsupported value at path "${path}"`);
}

function resolveEnvelopeStatus(
  snapshot: TerminalConfluenceSnapshot,
  serializedSnapshot: JsonSafe<TerminalConfluenceSnapshot>,
): EnvelopeStatus {
  if (snapshot.status === 'NO_DATA') {
    return 'NO_DATA';
  }
  if (snapshot.activePillarsCount < snapshot.totalPillarsCount) {
    return 'PARTIAL';
  }

  const m = serializedSnapshot.metrics;
  const keyAuxiliaryValues: readonly (number | null)[] = [
    m.vrpSpread,
    m.gammaFlipSpot,
    m.callWallStrike,
    m.putWallStrike,
    m.expectedMove,
    m.positionSizeMultiplier,
  ];
  if (keyAuxiliaryValues.some((val) => val === null)) {
    return 'PARTIAL';
  }

  return 'OK';
}

/**
 * Serializa de forma inmutable un `TerminalConfluenceSnapshot` y sus metadatos
 * transformando todo `NaN`, `+Infinity` o `-Infinity` en `null` JSON válido.
 */
export function serializeTerminalSnapshot(
  snapshot: TerminalConfluenceSnapshot,
  metadata: SerializedMetadata,
): TerminalSerializedEnvelope {
  if (typeof metadata.symbol !== 'string' || metadata.symbol.trim().length === 0) {
    throw new Error('metadata.symbol must be a non-empty string');
  }
  assertValidUtcSeconds(metadata.generatedAtUtcSec, 'metadata.generatedAtUtcSec');
  if (metadata.asOfUtcSec !== undefined) {
    assertValidUtcSeconds(metadata.asOfUtcSec, 'metadata.asOfUtcSec');
  }

  const nonFinitePaths: string[] = [];

  const sanitizedMetadata = sanitizeRecursive(
    metadata,
    'metadata',
    nonFinitePaths,
  ) as JsonSafe<SerializedMetadata>;

  const sanitizedSnapshot = sanitizeRecursive(
    snapshot,
    'snapshot',
    nonFinitePaths,
  ) as JsonSafe<TerminalConfluenceSnapshot>;

  const envelopeStatus = resolveEnvelopeStatus(snapshot, sanitizedSnapshot);

  return {
    schemaVersion: '1.0.0',
    envelopeStatus,
    nonFiniteFieldCount: nonFinitePaths.length,
    nonFinitePaths,
    metadata: sanitizedMetadata,
    snapshot: sanitizedSnapshot,
  };
}

function assertStrictlyJsonFiniteTree(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Non-finite number (${String(value)}) found at path "${path}" in serialized payload`,
      );
    }
    return;
  }

  if (
    value === undefined ||
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    throw new Error(
      `Non-JSON value (${typeof value}) found at path "${path}" in serialized payload`,
    );
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertStrictlyJsonFiniteTree(value[i], `${path}[${String(i)}]`);
    }
    return;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const propPath = path.length > 0 ? `${path}.${key}` : key;
      assertStrictlyJsonFiniteTree(record[key], propPath);
    }
    return;
  }

  throw new Error(`Unsupported value at path "${path}" in serialized payload`);
}

/**
 * Verifica estrictamente que un payload serializado no contenga `NaN`, `Infinity`,
 * `-Infinity` ni valores no JSON, produciendo un string JSON válido y verificable.
 */
export function assertJsonSafeSerialized(payload: unknown): string {
  assertStrictlyJsonFiniteTree(payload, 'root');
  const json = JSON.stringify(payload);
  if (typeof json !== 'string') {
    throw new Error('JSON.stringify did not return a string');
  }
  const parsed: unknown = JSON.parse(json);
  assertStrictlyJsonFiniteTree(parsed, 'parsed');
  return json;
}
