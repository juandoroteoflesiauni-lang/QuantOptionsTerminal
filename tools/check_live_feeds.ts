/**
 * Pieza 33 — CLI de auditoría en vivo para QuantOptionsTerminal.
 *
 * Security / Zero Silent Fallbacks:
 * - does not read, load, print or log `.env`;
 * - only queries the local terminal endpoints and prints redacted, provider-safe fields;
 * - missing values are rendered as "—", never substituted by fake numbers.
 *
 * Usage: npm run feeds:check
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const FEEDS_HEALTH_URL = 'http://127.0.0.1:8787/api/system/feeds-health';
const DUAL_CHART_URL =
  'http://127.0.0.1:8787/api/ar/ggal-specialist/dual-chart?coord=ARS_BYMA&timeframe=1D&avwapAnchor=MONTH_START';

interface FeedProviderAuditRow {
  readonly id: string;
  readonly state: string;
  readonly session: string;
  readonly latency: string;
  readonly lastTick: string;
  readonly messagesPerMinute: string;
  readonly symbols: string;
  readonly role: string;
}

interface FeedsHealthAudit {
  readonly asOfUtcSec: number;
  readonly activeCount: number;
  readonly configuredCount: number;
  readonly degradedCount: number;
  readonly notConfiguredCount: number;
  readonly armedOutOfSessionCount: number;
  readonly rows: readonly FeedProviderAuditRow[];
}

interface GgalDualChartAudit {
  readonly status: string;
  readonly reason: string | null;
  readonly barsCount: number;
  readonly ema200Count: number;
  readonly ema200Ready: boolean;
  readonly ema200Last: number | null;
  readonly l2Available: boolean;
  readonly l2BidLevels: number;
  readonly l2AskLevels: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function dash(value: number | null, suffix = ''): string {
  return value === null ? '—' : `${String(Math.round(value))}${suffix}`;
}

function dashAge(value: number | null): string {
  if (value === null) return '—';
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)} min`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${String(Math.round(value))} ms`;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid feeds payload: ${label} must be an array`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid feeds payload: ${label} must be an object`);
  return value;
}

export function parseFeedsHealth(raw: unknown): FeedsHealthAudit {
  const root = requireRecord(raw, 'root');
  const summary = requireRecord(root['summary'], 'summary');
  const providersRaw = requireArray(root['providers'], 'providers');
  const rows: FeedProviderAuditRow[] = [];
  for (const providerRaw of providersRaw) {
    const provider = requireRecord(providerRaw, 'provider');
    const id = nullableString(provider['id']);
    if (id === null) throw new Error('Invalid feeds payload: provider.id missing');
    const activeSymbolCount = nonNegativeInteger(provider['activeSymbolCount']);
    const subscribedSymbols = Array.isArray(provider['subscribedSymbols'])
      ? provider['subscribedSymbols'].length
      : null;
    rows.push({
      id,
      state: nullableString(provider['state']) ?? 'UNKNOWN',
      session: nullableString(provider['sessionMode']) ?? 'UNKNOWN',
      latency: dash(finiteNumber(provider['latencyMs']), ' ms'),
      lastTick: dashAge(finiteNumber(provider['lastTickAgeMs'])),
      messagesPerMinute: dash(finiteNumber(provider['messagesPerMinute']), '/min'),
      symbols:
        activeSymbolCount === null && subscribedSymbols === null
          ? '—'
          : `${activeSymbolCount === null ? '—' : String(activeSymbolCount)} activos / ${
              subscribedSymbols === null ? '—' : String(subscribedSymbols)
            } suscriptos`,
      role: nullableString(provider['role']) ?? '—',
    });
  }
  return {
    asOfUtcSec: nonNegativeInteger(root['asOfUtcSec']) ?? 0,
    activeCount: nonNegativeInteger(summary['activeCount']) ?? 0,
    configuredCount: nonNegativeInteger(summary['configuredCount']) ?? 0,
    degradedCount: nonNegativeInteger(summary['degradedCount']) ?? 0,
    notConfiguredCount: nonNegativeInteger(summary['notConfiguredCount']) ?? 0,
    armedOutOfSessionCount: nonNegativeInteger(summary['armedOutOfSessionCount']) ?? 0,
    rows,
  };
}

export function parseGgalDualChart(raw: unknown): GgalDualChartAudit {
  const root = requireRecord(raw, 'root');
  const dualChart = requireRecord(root['dualChart'], 'dualChart');
  const status = nullableString(dualChart['status']) ?? 'UNKNOWN';
  const bars = Array.isArray(dualChart['bars']) ? dualChart['bars'] : [];
  const ema200 = Array.isArray(dualChart['ema200']) ? dualChart['ema200'] : [];
  const lastEmaRaw = ema200.length > 0 ? ema200[ema200.length - 1] : null;
  const lastEmaPoint = isRecord(lastEmaRaw) ? finiteNumber(lastEmaRaw['value']) : null;
  const ladder = isRecord(dualChart['l2Ladder']) ? dualChart['l2Ladder'] : null;
  const bids = ladder !== null && Array.isArray(ladder['bids']) ? ladder['bids'] : [];
  const asks = ladder !== null && Array.isArray(ladder['asks']) ? ladder['asks'] : [];
  return {
    status,
    reason: nullableString(dualChart['reason']),
    barsCount: bars.length,
    ema200Count: ema200.length,
    ema200Ready: status === 'OPERATIONAL' && bars.length >= 200 && lastEmaPoint !== null,
    ema200Last: lastEmaPoint,
    l2Available: ladder !== null && ladder['available'] === true,
    l2BidLevels: bids.length,
    l2AskLevels: asks.length,
  };
}

export function renderFeedsHealthTable(audit: FeedsHealthAudit): string {
  const headers: readonly (keyof FeedProviderAuditRow)[] = [
    'id',
    'state',
    'session',
    'latency',
    'lastTick',
    'messagesPerMinute',
    'symbols',
    'role',
  ];
  const title: Readonly<Record<keyof FeedProviderAuditRow, string>> = {
    id: 'PROVEEDOR',
    state: 'ESTADO',
    session: 'SESION',
    latency: 'LATENCIA',
    lastTick: 'ULT. TICK',
    messagesPerMinute: 'MSG/MIN',
    symbols: 'SIMBOLOS',
    role: 'ROL',
  };
  const widths: Record<keyof FeedProviderAuditRow, number> = {
    id: 0,
    state: 0,
    session: 0,
    latency: 0,
    lastTick: 0,
    messagesPerMinute: 0,
    symbols: 0,
    role: 0,
  };
  for (const key of headers) {
    widths[key] = title[key].length;
    for (const row of audit.rows) {
      widths[key] = Math.max(widths[key] ?? 0, row[key].length);
    }
  }
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[headers[index] ?? 'id'] ?? 0, ' ')).join('  ');
  const output: string[] = [];
  output.push(line(headers.map((key) => title[key])));
  output.push(headers.map((key) => '-'.repeat(widths[key] ?? 1)).join('  '));
  for (const row of audit.rows) {
    output.push(line(headers.map((key) => row[key])));
  }
  return output.join('\n');
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    let detail = `HTTP ${String(response.status)}`;
    try {
      const raw: unknown = await response.json();
      if (isRecord(raw) && typeof raw['detail'] === 'string') detail = `${detail}: ${raw['detail']}`;
    } catch {
      // Keep the safe HTTP status as the diagnostic detail.
    }
    throw new Error(`${url} -> ${detail}`);
  }
  return (await response.json()) as unknown;
}

export async function runFeedsCheck(): Promise<void> {
  const startedAtMs = performance.now();
  const [feedsRaw, dualChartRaw] = await Promise.all([fetchJson(FEEDS_HEALTH_URL), fetchJson(DUAL_CHART_URL)]);
  const totalMs = performance.now() - startedAtMs;
  const feeds = parseFeedsHealth(feedsRaw);
  const dualChart = parseGgalDualChart(dualChartRaw);

  console.log('PIEZA 33 — AUDITORIA EN VIVO DE FEEDS');
  console.log(`Servidor: http://127.0.0.1:8787  ·  asOfUtcSec=${String(feeds.asOfUtcSec)}`);
  console.log(
    `Resumen: ${String(feeds.activeCount)}/8 activos · ${String(feeds.configuredCount)}/8 armados · ` +
      `${String(feeds.degradedCount)} degradados · ${String(feeds.armedOutOfSessionCount)} fuera de sesión · ` +
      `${String(feeds.notConfiguredCount)} no configurados`,
  );
  console.log('');
  console.log(renderFeedsHealthTable(feeds));
  console.log('');
  console.log('GGAL SPECIALIST · DUAL CHART (ARS_BYMA · 1D · MONTH_START)');
  console.log(`Estado: ${dualChart.status}${dualChart.reason === null ? '' : ` (${dualChart.reason})`}`);
  console.log(`Velas cargadas: ${String(dualChart.barsCount)}`);
  console.log(
    `EMA 200: ${dualChart.ema200Ready ? 'LISTO' : 'NO LISTO'} · puntos=${String(dualChart.ema200Count)} · ultimo=${
      dualChart.ema200Last === null ? '—' : String(dualChart.ema200Last)
    }`,
  );
  console.log(
    `L2 5 puntas: ${dualChart.l2Available ? 'DISPONIBLE' : 'NO DISPONIBLE'} · bids=${String(dualChart.l2BidLevels)} · asks=${String(dualChart.l2AskLevels)}`,
  );
  console.log(`Latencia total de auditoría: ${totalMs.toFixed(1)} ms`);
}

async function main(): Promise<void> {
  try {
    await runFeedsCheck();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`feeds:check failed: ${message}`);
    process.exitCode = 1;
  }
}

const currentEntryPoint = process.argv[1] !== undefined ? resolve(process.argv[1]) : '';
const isDirectRun =
  currentEntryPoint !== '' && import.meta.url === pathToFileURL(currentEntryPoint).href;

if (isDirectRun) {
  await main();
}
