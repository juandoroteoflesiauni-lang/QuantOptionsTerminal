/**
 * Enrutador multi-key de Massive (Pieza 32).
 *
 * Separa el tráfico WebSocket del tráfico REST/histórico asignando credenciales
 * especializadas con cadenas de resolución explícitas (cero fallbacks silenciosos:
 * cada slot reporta el nombre de variable de entorno que lo originó):
 *
 *  - `getMassiveStocksWsKey()`: prioriza `MASSIVE_WS_STOCKS_KEY` -> `MASSIVE_API_KEY`.
 *  - `getMassiveRestKey()`: pool REST en round-robin construido con
 *    `MASSIVE_REST_KEY` + `MASSIVE_REST_KEYS` (lista separada por comas) +
 *    `MASSIVE_API_KEY` como último slot garantizado. La rotación reparte la carga
 *    entre slots para duplicar el throughput sin `HTTP 429`.
 *
 * Seguridad: los valores de las claves JAMÁS se exponen en `status()`, errores ni
 * logs; solo se publican los nombres de las variables de entorno y los índices de
 * slot. Las claves también se leen desde `.env` (mismas convenciones que
 * `loadRuntimeAuth`) para entornos de desarrollo donde `process.env` no las carga.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type MassiveKeyRole = 'WS_STOCKS' | 'REST';

/**
 * Slot resuelto del pool. `key` es material secreto: nunca loguear, serializar
 * ni incluir en payloads; usar solo para autenticar peticiones.
 */
export interface MassiveKeySlot {
  readonly key: string;
  readonly envName: string;
  readonly slotIndex: number;
  readonly poolSize: number;
  readonly role: MassiveKeyRole;
}

/** Descripción de un slot segura para exponer por HTTP (sin material secreto). */
export interface MassiveKeySlotStatus {
  readonly envName: string;
  readonly slotIndex: number;
  readonly role: MassiveKeyRole;
}

export interface MassiveKeyPoolStatus {
  readonly configured: boolean;
  readonly wsStocks: {
    readonly configured: boolean;
    readonly envName: string | null;
  };
  readonly rest: {
    readonly configured: boolean;
    readonly poolSize: number;
    readonly slots: readonly MassiveKeySlotStatus[];
    readonly lastSlotIndex: number | null;
    readonly roundRobinRequests: number;
  };
}

export interface MassiveEnvSource {
  readonly env: NodeJS.ProcessEnv;
  readonly fileValues: ReadonlyMap<string, string>;
}

/** Cadena de resolución del socket de stocks (Pieza 32). */
const WS_STOCKS_ENV_CHAIN = ['MASSIVE_WS_STOCKS_KEY', 'MASSIVE_API_KEY'] as const;

/** Slots del pool REST, en orden de prioridad. */
const REST_PRIMARY_ENV_CHAIN = ['MASSIVE_REST_KEY', 'MASSIVE_API_KEY'] as const;

/** Lista opcional de claves REST adicionales separadas por coma. */
const REST_MULTI_KEYS_ENV = 'MASSIVE_REST_KEYS';

/**
 * Lee un archivo `.env` con las mismas convenciones de `marketRuntime.parseEnvFile`
 * (soporta `export `, comillas simples/dobles). Devuelve un mapa clave->valor que
 * solo se usa internamente para resolver claves; jamás se expone.
 */
function parseEnvFile(path: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  let raw = '';
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return values;
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trim();
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (value.length >= 2 && (value.startsWith("'") || value.startsWith('"'))) {
      const quote = value.charAt(0);
      if (value.endsWith(quote)) {
        value = value.slice(1, -1);
      }
    }
    if (key !== '') {
      values.set(key, value);
    }
  }
  return values;
}

/** Fuente de variables combinada: `process.env` primero, luego `.env`. */
export function readMassiveEnvSource(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath: string = resolve(process.cwd(), '.env'),
): MassiveEnvSource {
  return { env, fileValues: parseEnvFile(envFilePath) };
}

/** Resuelve `name` desde `process.env` o `.env`; devuelve '' si no existe. */
export function resolveMassiveEnvValue(source: MassiveEnvSource, name: string): string {
  const fromEnv = source.env[name];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  const fromFile = source.fileValues.get(name);
  return typeof fromFile === 'string' ? fromFile.trim() : '';
}

interface PoolSlot {
  readonly key: string;
  readonly envName: string;
}

/**
 * Router multi-key. Mantiene el contador de round-robin del pool REST y las
 * cadenas de resolución explícitas por rol. Nunca expone material secreto.
 */
export class MassiveKeyRouter {
  private readonly wsStocksSlot: PoolSlot | null;
  private readonly restSlots: readonly PoolSlot[];
  private restCounter = 0;

  public constructor(source: MassiveEnvSource) {
    let wsSlot: PoolSlot | null = null;
    for (const name of WS_STOCKS_ENV_CHAIN) {
      const value = resolveMassiveEnvValue(source, name);
      if (value !== '') {
        wsSlot = { key: value, envName: name };
        break;
      }
    }
    this.wsStocksSlot = wsSlot;

    const restSlots: PoolSlot[] = [];
    const seen = new Set<string>();
    for (const name of REST_PRIMARY_ENV_CHAIN) {
      const value = resolveMassiveEnvValue(source, name);
      if (value !== '' && !seen.has(value)) {
        seen.add(value);
        restSlots.push({ key: value, envName: name });
      }
    }
    const multiRaw = resolveMassiveEnvValue(source, REST_MULTI_KEYS_ENV);
    if (multiRaw !== '') {
      const multiKeys = multiRaw
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k !== '');
      for (let i = 0; i < multiKeys.length; i += 1) {
        const key = multiKeys[i];
        if (key === undefined || key === '' || seen.has(key)) continue;
        seen.add(key);
        restSlots.push({ key, envName: `${REST_MULTI_KEYS_ENV}[${String(i)}]` });
      }
    }
    this.restSlots = restSlots;
  }

  /** Clave para el socket de stocks: `MASSIVE_WS_STOCKS_KEY` -> `MASSIVE_API_KEY`. */
  public getStocksWsKey(): MassiveKeySlot {
    const slot = this.wsStocksSlot;
    if (slot === null) {
      return { key: '', envName: '', slotIndex: 0, poolSize: 0, role: 'WS_STOCKS' };
    }
    return {
      key: slot.key,
      envName: slot.envName,
      slotIndex: 0,
      poolSize: 1,
      role: 'WS_STOCKS',
    };
  }

  /**
   * Siguiente clave del pool REST (round-robin). Cuando el pool está vacío
   * devuelve un slot con `key: ''` y `envName: ''` (no configurado): el caller
   * decide el error explícito (`MISSING_API_KEY`).
   */
  public getRestKey(): MassiveKeySlot {
    const poolSize = this.restSlots.length;
    if (poolSize === 0) {
      return { key: '', envName: '', slotIndex: 0, poolSize: 0, role: 'REST' };
    }
    const slotIndex = this.restCounter % poolSize;
    this.restCounter += 1;
    const slot = this.restSlots[slotIndex];
    if (slot === undefined) {
      return { key: '', envName: '', slotIndex: 0, poolSize: 0, role: 'REST' };
    }
    return {
      key: slot.key,
      envName: slot.envName,
      slotIndex,
      poolSize,
      role: 'REST',
    };
  }

  /** Estado observable sin material secreto. */
  public status(): MassiveKeyPoolStatus {
    const wsSlot = this.wsStocksSlot;
    const restSlotStatuses: MassiveKeySlotStatus[] = this.restSlots.map((slot, index) => ({
      envName: slot.envName,
      slotIndex: index,
      role: 'REST' as const,
    }));
    const lastRestIndex =
      this.restCounter > 0 && this.restSlots.length > 0
        ? (this.restCounter - 1) % this.restSlots.length
        : null;
    return {
      configured: this.wsStocksSlot !== null || this.restSlots.length > 0,
      wsStocks: {
        configured: wsSlot !== null,
        envName: wsSlot?.envName ?? null,
      },
      rest: {
        configured: this.restSlots.length > 0,
        poolSize: this.restSlots.length,
        slots: restSlotStatuses,
        lastSlotIndex: lastRestIndex,
        roundRobinRequests: this.restCounter,
      },
    };
  }
}

let defaultRouter: MassiveKeyRouter | null = null;

/** Router memoizado con el entorno del proceso (o el provisto explícitamente). */
export function getMassiveKeyRouter(
  env?: NodeJS.ProcessEnv,
  envFilePath?: string,
): MassiveKeyRouter {
  if (env !== undefined || envFilePath !== undefined) {
    return new MassiveKeyRouter(readMassiveEnvSource(env, envFilePath));
  }
  if (defaultRouter === null) {
    defaultRouter = new MassiveKeyRouter(readMassiveEnvSource());
  }
  return defaultRouter;
}

/** Fuerza la re-resolución del router por defecto (harness/tests explícitos). */
export function resetMassiveKeyRouter(): void {
  defaultRouter = null;
}

/** Clave del socket de stocks (cadena explícita documentada). */
export function getMassiveStocksWsKey(
  env?: NodeJS.ProcessEnv,
  envFilePath?: string,
): MassiveKeySlot {
  return getMassiveKeyRouter(env, envFilePath).getStocksWsKey();
}

/** Clave REST siguiente del pool round-robin. */
export function getMassiveRestKey(
  env?: NodeJS.ProcessEnv,
  envFilePath?: string,
): MassiveKeySlot {
  return getMassiveKeyRouter(env, envFilePath).getRestKey();
}

/** Estado del pool seguro para exponer (sin claves). */
export function getMassiveKeyPoolStatus(
  env?: NodeJS.ProcessEnv,
  envFilePath?: string,
): MassiveKeyPoolStatus {
  return getMassiveKeyRouter(env, envFilePath).status();
}
