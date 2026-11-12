/**
 * Prueba de humo del `next_url` real de Massive contra la API en vivo.
 *
 * NO forma parte de `npm run verify` (el include por defecto de vitest
 * solo ejecuta `*.test.ts`). Se ejecuta a mano, cuando el dueño lo
 * confirma, con: `npm run smoke:next-url`.
 *
 * Qué comprueba contra la red real:
 *  1. Con una ventana de 1h larga el proveedor devuelve un `next_url`
 *     real y el cargador lo sigue hasta el objetivo (>= 2 páginas).
 *  2. TODAS las peticiones salen al origen configurado: el mismo origen
 *     se sigue tal cual y un origen espejo de la lista fija se reescribe
 *     al origen configurado conservando path y query. La clave nunca
 *     viaja a un host distinto del configurado.
 *  3. El reporte no contiene la clave ni el parámetro de autenticación.
 *
 * La clave se lee de MASSIVE_API_KEY (entorno o .env, con los alias
 * históricos de tools/capture_samples.py) y NUNCA se imprime: los
 * resúmenes solo muestran origen, path y contadores.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { loadBars } from '../src/data/loader.js';
import type { FetchFn, LoadBarsResult } from '../src/data/types.js';

/** Orígenes configurados: el segundo ejercita la reescritura espejo. */
const BASE_URLS: readonly string[] = [
  'https://api.polygon.io',
  'https://api.massive.com',
];

/** Hosts que el proveedor puede poner en un next_url (lista fija). */
const NEXT_URL_HOSTS: readonly string[] = ['api.polygon.io', 'api.massive.com'];

/** Alias de la clave en .env/entorno, igual que tools/capture_samples.py. */
const KEY_ENV_NAMES: readonly string[] = [
  'MASSIVE_API_KEY',
  'MASSIVE_KEY_OPTIONS',
  'MASSIVE_OPTIONS',
  'MASSIVE_KEY',
];

/** Pausa entre escenarios para respetar las 5 peticiones/minuto del plan gratuito. */
const SCENARIO_PAUSE_MS = 13_001;

interface PageSummary {
  readonly origin: string;
  readonly pathname: string;
  readonly rows: number;
  readonly hasNextUrl: boolean;
  readonly nextUrlHost: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function readEnvFile(path: string): Map<string, string> {
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
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      (value.startsWith("'") || value.startsWith('"'))
    ) {
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

function massiveApiKey(): string {
  const fileValues = readEnvFile(resolve(process.cwd(), '.env'));
  for (const name of KEY_ENV_NAMES) {
    const value = (process.env[name] ?? fileValues.get(name) ?? '').trim();
    if (value !== '') {
      return value;
    }
  }
  return '';
}

function liveFetch(pages: PageSummary[]): FetchFn {
  return async (url: string) => {
    const response = await fetch(url);
    const text = await response.text();
    let rows = 0;
    let hasNextUrl = false;
    let nextUrlHost: string | null = null;
    try {
      const body: unknown = JSON.parse(text) as unknown;
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        const record = body as { results?: unknown; next_url?: unknown };
        if (Array.isArray(record.results)) {
          rows = record.results.length;
        }
        if (typeof record.next_url === 'string' && record.next_url !== '') {
          hasNextUrl = true;
          nextUrlHost = new URL(record.next_url).hostname;
        }
      }
    } catch {
      // Cuerpo no JSON: el cargador lo reportará como error de página.
    }
    const requested = new URL(url);
    pages.push({
      origin: requested.origin,
      pathname: requested.pathname,
      rows,
      hasNextUrl,
      nextUrlHost,
    });
    return { ok: response.ok, status: response.status, text };
  };
}

function summarize(pages: readonly PageSummary[]): string {
  return pages
    .map(
      (page, index) =>
        `${String(index + 1)}: ${page.origin}${page.pathname} filas=${String(page.rows)} next_url=${page.hasNextUrl ? (page.nextUrlHost ?? '?') : '-'}`,
    )
    .join('\n');
}

it('sigue un next_url real de 2+ páginas y mantiene toda la salida en el origen configurado', async () => {
  const apiKey = massiveApiKey();
  expect(
    apiKey,
    'MASSIVE_API_KEY (o alias) no está definida en .env ni en el entorno',
  ).not.toBe('');

  for (const [index, baseUrl] of BASE_URLS.entries()) {
    if (index > 0) {
      await sleep(SCENARIO_PAUSE_MS);
    }

    const pages: PageSummary[] = [];
    const result: LoadBarsResult = await loadBars({
      provider: 'massive',
      symbol: 'SPY',
      timeframe: '1h',
      visibleBars: 3_000,
      warmupBars: 1_000,
      maxPages: 6,
      apiKey,
      baseUrl,
      fetchFn: liveFetch(pages),
    });

    console.log(`[next_url smoke] base=${baseUrl}\n${summarize(pages)}`);

    expect(
      pages.length,
      'el proveedor devolvió un next_url real y el cargador lo siguió (>= 2 páginas)',
    ).toBeGreaterThanOrEqual(2);
    expect(
      pages.filter((page) => page.hasNextUrl).length,
      'al menos una página devolvió un next_url real',
    ).toBeGreaterThanOrEqual(1);

    const baseOrigin = new URL(baseUrl).origin;
    for (const page of pages) {
      expect(
        page.origin,
        'toda petición sale al origen configurado (mismo origen o espejo reescrito)',
      ).toBe(baseOrigin);
      if (page.nextUrlHost !== null) {
        expect(
          NEXT_URL_HOSTS.includes(page.nextUrlHost),
          `next_url del proveedor hacia un host fuera de la lista: ${page.nextUrlHost}`,
        ).toBe(true);
      }
    }

    expect(result.report.stoppedReason).toBe('targetReached');
    expect(result.report.malformedResponse).toBe(false);
    expect(result.report.providerError).toBeNull();

    const reportText = JSON.stringify(result.report);
    expect(reportText).not.toContain(apiKey);
    const authToken = ['api', 'Key='].join('');
    expect(reportText.toLowerCase()).not.toContain(authToken.toLowerCase());
    expect(result.bars.length).toBeGreaterThan(0);
  }
});
