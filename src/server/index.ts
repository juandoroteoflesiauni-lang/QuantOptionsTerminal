/**
 * Punto de entrada CLI del servidor runtime local para QuantOptionsTerminal (Pieza 13).
 *
 * Variables de entorno:
 *  - `PORT` (por defecto `8787`)
 *  - `HOST` (por defecto `127.0.0.1`)
 *  - `SYMBOLS` (lista separada por comas; por defecto `SPY,QQQ,I:SPX`)
 *  - `DISABLE_WS=1` (desactiva conexión WebSocket saliente a Massive si se requiere modo REST-only)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpWsServer } from './httpWsServer.js';
import {
  DEFAULT_TERMINAL_SYMBOLS,
  MarketRuntime,
  loadRuntimeAuth,
} from './marketRuntime.js';

export function parseWatchedSymbols(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') {
    return [...DEFAULT_TERMINAL_SYMBOLS];
  }
  const items = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== '');
  return items.length > 0 ? items : [...DEFAULT_TERMINAL_SYMBOLS];
}

export async function startServerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}> {
  const portRaw = env['PORT'];
  const parsedPort = portRaw !== undefined && portRaw.trim() !== '' ? Number(portRaw) : 8787;
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535 ? parsedPort : 8787;
  const host = env['HOST']?.trim() || '127.0.0.1';
  const watchedSymbols = parseWatchedSymbols(env['SYMBOLS']);
  const enableWs = env['DISABLE_WS'] !== '1';
  const auth = loadRuntimeAuth(env);

  const runtime = new MarketRuntime({
    apiKey: auth.apiKey,
    secrets: auth.secrets,
    watchedSymbols,
    enableWs,
  });

  const handle = createHttpWsServer({
    runtime,
    host,
    port,
    secrets: auth.secrets,
    startRuntimeWs: enableWs,
    enableBackgroundWarmup: env['DISABLE_WARMUP'] !== '1',
  });

  const addr = await handle.start();
  console.info(
    `[QuantOptionsTerminal server] listening on http://${addr.host}:${String(addr.port)} (ws://${addr.host}:${String(addr.port)}/ws) | watched=[${watchedSymbols.join(',')}] | apiKeyConfigured=${String(auth.apiKey !== '')}`,
  );

  return {
    host: addr.host,
    port: addr.port,
    stop: () => handle.stop(),
  };
}

const isEntrypoint = process.argv
  .slice(1)
  .some(
    (arg) =>
      !arg.startsWith('-') &&
      pathToFileURL(resolve(arg)).href.toLowerCase() === import.meta.url.toLowerCase(),
  );

if (isEntrypoint) {
  const withWeb =
    process.argv.includes('--with-web') || process.env['WITH_WEB'] === '1';

  startServerFromEnv()
    .then((serverHandle) => {
      let webProc: ChildProcess | null = null;
      if (withWeb) {
        console.info('[QuantOptionsTerminal] starting Vite UI on http://localhost:5173 ...');
        webProc = spawn('npm', ['--prefix', 'web', 'run', 'dev'], {
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });
      }

      const shutdown = (): void => {
        if (webProc !== null && !webProc.killed) {
          webProc.kill('SIGTERM');
        }
        void serverHandle.stop().finally(() => {
          process.exit(0);
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Fatal startup failure';
      console.error(`[QuantOptionsTerminal server] startup error: ${msg}`);
      process.exit(1);
    });
}
