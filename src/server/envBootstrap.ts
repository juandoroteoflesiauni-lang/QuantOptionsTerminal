/**
 * Bootstrap explícito del `.env` raíz (Pieza 41.2).
 *
 * Los clientes de feeds pueden ser evaluados antes del entrypoint del servidor.
 * Este módulo garantiza que el `.env` del repo esté cargado antes de resolver
 * `FMP_*`, `TRADIER_*`, `MASSIVE_*` u `ORATS_*`.
 *
 * Seguridad: este módulo nunca imprime, serializa ni devuelve valores cargados.
 * Solo expone rutas y contadores de archivos aplicados.
 */

import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT_ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url));
const CWD_ROOT_ENV_PATH = resolve(process.cwd(), '.env');

export const ROOT_ENV_PATH = existsSync(MODULE_ROOT_ENV_PATH) ? MODULE_ROOT_ENV_PATH : CWD_ROOT_ENV_PATH;
export const ROOT_ENV_LOCAL_PATH = `${ROOT_ENV_PATH}.local`;

/** Quita espacios de borde y una sola capa de comillas envolventes. */
export function cleanEnvValue(value: string): string {
  let cleaned = value.trim();
  if (
    cleaned.length >= 2 &&
    ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'")))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

export interface BootstrapRootEnvOptions {
  /** Solo para tests; producción usa `ROOT_ENV_PATH`. */
  readonly envFilePath?: string;
  /** Solo para tests; producción usa `.env.local` junto al `.env` raíz. */
  readonly localEnvFilePath?: string;
}

function loadEnvFile(path: string): boolean {
  if (path === '' || !existsSync(path)) return false;
  const parsed = dotenv.config({ path, override: true }).parsed ?? {};
  for (const [key, rawValue] of Object.entries(parsed)) {
    process.env[key] = cleanEnvValue(rawValue);
  }
  return true;
}

/**
 * Carga `.env` y luego `.env.local`, ambos con `override: true`. Devuelve solo
 * las rutas efectivamente aplicadas (sin valores).
 */
export function bootstrapRootEnv(options: BootstrapRootEnvOptions = {}): readonly string[] {
  const envFilePath = options.envFilePath ?? ROOT_ENV_PATH;
  const localEnvFilePath = options.localEnvFilePath ?? `${envFilePath}.local`;
  const applied: string[] = [];
  if (loadEnvFile(envFilePath)) applied.push(envFilePath);
  if (loadEnvFile(localEnvFilePath)) applied.push(localEnvFilePath);
  return applied;
}

bootstrapRootEnv();
