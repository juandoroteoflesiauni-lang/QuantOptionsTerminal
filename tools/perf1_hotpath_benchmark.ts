/**
 * Determinista benchmark harness for Perf-1 (Node perf_hooks + real ephemeral httpWsServer).
 * Usage:
 *   node node_modules/vite-node/vite-node.mjs --script tools/perf1_hotpath_benchmark.ts --mode baseline --out .cache/perf1-baseline-metrics.json
 *   node node_modules/vite-node/vite-node.mjs --script tools/perf1_hotpath_benchmark.ts --mode after --out .cache/perf1-after-metrics.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import {
  computeAnchoredVwapSeries,
  computeEmaSeries,
  computeSessionVwapSeries,
  computeVolumeProfile,
} from '../src/core/ggal/technicalIndicators.js';
import type { GgalChartBarPoint } from '../src/core/ggal/institutionalContracts.js';
import * as realtimeProp from '../src/core/realtimePropagation.js';
import type { LiveChartBar } from '../src/core/realtimePropagation.js';
import type { Bar } from '../src/core/types.js';
import { ArgentinaMarketRuntime } from '../src/server/argentinaMarketLoader.js';
import { FmpEnterpriseClient } from '../src/server/fmpClient.js';
import { GgalTickStreamEngine } from '../src/server/ggalTickStream.js';
import { createHttpWsServer } from '../src/server/httpWsServer.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';

interface LatencyStats {
  readonly samples: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

function summarize(values: readonly number[]): LatencyStats {
  if (values.length === 0) {
    return { samples: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return Number((sorted[idx] ?? 0).toFixed(4));
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    samples: sorted.length,
    minMs: Number((sorted[0] ?? 0).toFixed(4)),
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(4)),
    meanMs: Number((sum / sorted.length).toFixed(4)),
  };
}

function buildDeterministicSessionBars(count: number, stepSec = 300): LiveChartBar[] {
  // 2025-05-05 13:30:00Z = 09:30 ET (RTH open); 78 5-min bars per US session
  const startUtcSec = Date.UTC(2025, 4, 5, 13, 30, 0) / 1_000;
  const barsPerDay = stepSec === 300 ? 78 : 26;
  const bars: LiveChartBar[] = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const dayIdx = Math.floor(i / barsPerDay);
    const barInDay = i % barsPerDay;
    const t = startUtcSec + dayIdx * 86_400 + barInDay * stepSec;
    const wave = ((i % 17) - 8) * 0.05;
    const open = Number((price + wave).toFixed(4));
    const close = Number((open + ((i % 5) - 2) * 0.08).toFixed(4));
    const high = Number((Math.max(open, close) + 0.15).toFixed(4));
    const low = Number((Math.min(open, close) - 0.14).toFixed(4));
    price = Math.max(20, close);
    bars.push({
      timeSec: t,
      open,
      high,
      low,
      close,
      volume: 1_000 + (i % 50) * 120,
    });
  }
  return bars;
}

function httpGetRaw(
  port: number,
  path: string,
  acceptEncoding?: string,
): Promise<{
  readonly status: number;
  readonly contentEncoding: string | null;
  readonly vary: string | null;
  readonly wireBytes: number;
  readonly decodedBytes: number;
  readonly ttfbMs: number;
  readonly totalMs: number;
  readonly parsedJson: unknown;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = performance.now();
    let ttfbMs = 0;
    const headers: Record<string, string> = {};
    if (acceptEncoding !== undefined) {
      headers['Accept-Encoding'] = acceptEncoding;
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          if (chunks.length === 0) {
            ttfbMs = performance.now() - started;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const totalMs = performance.now() - started;
          const wireBuf = Buffer.concat(chunks);
          const encoding = typeof res.headers['content-encoding'] === 'string'
            ? res.headers['content-encoding']
            : null;
          const decodedBuf = encoding === 'gzip' ? gunzipSync(wireBuf) : wireBuf;
          resolvePromise({
            status: res.statusCode ?? 0,
            contentEncoding: encoding,
            vary: typeof res.headers['vary'] === 'string' ? res.headers['vary'] : null,
            wireBytes: wireBuf.length,
            decodedBytes: decodedBuf.length,
            ttfbMs: Number(ttfbMs.toFixed(4)),
            totalMs: Number(totalMs.toFixed(4)),
            parsedJson: JSON.parse(decodedBuf.toString('utf8')) as unknown,
          });
        });
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

async function runSessionVwapScenario(barCount: number, mode: 'baseline' | 'after') {
  const closed = buildDeterministicSessionBars(barCount, 300);
  const lastClosed = closed[closed.length - 1]!;
  const formingBase: LiveChartBar = {
    timeSec: lastClosed.timeSec + 300,
    open: lastClosed.close,
    high: lastClosed.close + 0.1,
    low: lastClosed.close - 0.1,
    close: lastClosed.close,
    volume: 1_500,
  };

  type CheckpointFns = {
    readonly buildSessionVwapCheckpoint?: (bars: readonly LiveChartBar[], tz: string) => unknown;
    readonly projectLiveSessionVwapFromCheckpoint?: (ckpt: unknown, forming: LiveChartBar, tz: string) => { timeSec: number; value: number } | null;
  };
  const propAny = realtimeProp as unknown as CheckpointFns;
  const useCheckpoint =
    mode === 'after' &&
    typeof propAny.buildSessionVwapCheckpoint === 'function' &&
    typeof propAny.projectLiveSessionVwapFromCheckpoint === 'function';

  const runs = 5;
  const warmup = 2;
  const ticksPerRun = 200;
  const runTotals: number[] = [];
  const perTick: number[] = [];
  let maxDiffVsFull = 0;

  for (let r = 0; r < warmup + runs; r += 1) {
    const ckpt = useCheckpoint ? propAny.buildSessionVwapCheckpoint!(closed, 'America/New_York') : null;
    const t0Run = performance.now();
    for (let k = 0; k < ticksPerRun; k += 1) {
      const tickBar: LiveChartBar = {
        timeSec: formingBase.timeSec,
        open: formingBase.open,
        high: formingBase.high + k * 0.01,
        low: formingBase.low,
        close: formingBase.close + (k % 7) * 0.03,
        volume: formingBase.volume + (k + 1) * 50,
      };
      const t0 = performance.now();
      const pt = useCheckpoint
        ? propAny.projectLiveSessionVwapFromCheckpoint!(ckpt, tickBar, 'America/New_York')
        : realtimeProp.projectLiveSessionVwap(closed, tickBar, 'America/New_York');
      const dt = performance.now() - t0;
      if (r >= warmup) {
        perTick.push(dt);
      }
      if (r === warmup && k === ticksPerRun - 1 && useCheckpoint) {
        const ref = realtimeProp.projectLiveSessionVwap(closed, tickBar, 'America/New_York');
        if (ref !== null && pt !== null) {
          maxDiffVsFull = Math.max(maxDiffVsFull, Math.abs(ref.value - pt.value));
        }
      }
      if (k % 25 === 24) {
        await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
      }
    }
    const dtRun = performance.now() - t0Run;
    if (r >= warmup) {
      runTotals.push(dtRun);
    }
  }

  return {
    algorithm: useCheckpoint ? 'checkpoint_O1' : 'full_scan_ON',
    barCount,
    ticksPerRun,
    maxDiffVsFull,
    perTick: summarize(perTick),
    run200Ticks: summarize(runTotals),
  };
}

async function runGgalTickStreamScenario() {
  const step = 300;
  const seedBaseSec = Math.floor(Date.UTC(2025, 4, 5, 14, 0, 0) / 1_000);
  const nowSec = seedBaseSec + 50 * step;
  const seedBars = Array.from({ length: 50 }, (_, idx) => ({
    timeSec: seedBaseSec + idx * step,
    open: 7000 + idx,
    high: 7010 + idx,
    low: 6995 + idx,
    close: 7005 + idx,
    volume: 500 + idx,
  }));

  const runTotals: number[] = [];
  const perTrade: number[] = [];
  const warmup = 2;
  const runs = 5;
  const tradesPerRun = 300;

  for (let r = 0; r < warmup + runs; r += 1) {
    let curMs = nowSec * 1_000;
    const engine = new GgalTickStreamEngine({
      nowMsFn: () => curMs,
      minEmitIntervalMs: 0,
      emit: () => undefined,
    });
    for (const tf of ['1m', '5m', '15m', '1h', '4h', '1D'] as const) {
      engine.seedHistory('ARS', tf, seedBars);
      engine.seedHistory('ADR', tf, seedBars.map((b) => ({ ...b, close: b.close / 120, open: b.open / 120, high: b.high / 120, low: b.low / 120 })));
    }
    const t0Run = performance.now();
    for (let i = 0; i < tradesPerRun; i += 1) {
      const ts = nowSec + Math.floor(i / 100);
      curMs = ts * 1_000 + (i % 100) * 5;
      const t0 = performance.now();
      engine.applyArsTick({
        price: 7050 + (i % 20) * 0.5,
        size: 100,
        timeSec: ts,
        eventTimeMs: curMs,
        sequence: i + 1,
      });
      const dt = performance.now() - t0;
      if (r >= warmup) perTrade.push(dt);
    }
    // Also inject 5 late revisions to verify late path still works
    for (let j = 0; j < 5; j += 1) {
      engine.applyArsTick({
        price: 7049 + j * 0.25,
        size: 25,
        timeSec: nowSec - 10,
        eventTimeMs: (nowSec - 10) * 1_000 + j,
        sequence: 10_000 + j,
      });
    }
    const dtRun = performance.now() - t0Run;
    if (r >= warmup) runTotals.push(dtRun);
  }

  return {
    tradesPerRun,
    perTrade: summarize(perTrade),
    runTotal: summarize(runTotals),
  };
}

function runTechnicalIndicatorsScenario() {
  const bars: GgalChartBarPoint[] = buildDeterministicSessionBars(5_000, 300);
  const runTotals: number[] = [];
  const warmup = 2;
  const runs = 5;

  for (let r = 0; r < warmup + runs; r += 1) {
    const t0 = performance.now();
    computeEmaSeries(bars, 9);
    computeEmaSeries(bars, 21);
    computeEmaSeries(bars, 50);
    computeEmaSeries(bars, 200);
    computeSessionVwapSeries(bars, 'America/Argentina/Buenos_Aires');
    computeAnchoredVwapSeries(bars, bars[1_000]!.timeSec);
    computeVolumeProfile(bars, 32, 'America/Argentina/Buenos_Aires');
    const dt = performance.now() - t0;
    if (r >= warmup) runTotals.push(dt);
  }
  return { barCount: bars.length, runTotal: summarize(runTotals) };
}

async function runHttpAndWsScenario(mode: 'baseline' | 'after') {
  const barCount = 1_400;
  const deterministicBars: readonly Bar[] = buildDeterministicSessionBars(barCount, 300).map((b) => ({
    time: b.timeSec,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    vw: b.close,
  }));
  const fixedNowMs = (deterministicBars[deterministicBars.length - 1]!.time + 300) * 1_000;

  const runtime = new MarketRuntime({
    apiKey: 'BENCH_KEY',
    secrets: ['BENCH_KEY'],
    nowMsFn: () => fixedNowMs,
    enableWs: false,
    watchedSymbols: ['SPY', 'GGAL'],
    fetchFn: () => Promise.reject(new Error('offline benchmark')),
    loadBarsFn: async () => ({
      bars: deterministicBars,
      visibleStart: 0,
      report: {
        provider: 'massive',
        symbol: 'SPY',
        timeframe: '5m',
        requestedAtUtcSec: Math.floor(fixedNowMs / 1_000),
        pagesFetched: 1,
        rawCount: deterministicBars.length,
        dedupCount: deterministicBars.length,
        providerError: null,
        warnings: [],
        urlList: [],
      },
    }),
  });

  const arRuntime = new ArgentinaMarketRuntime({
    nowMsFn: () => fixedNowMs,
    minData912IntervalMs: 0,
    fetchFn: () => Promise.resolve({ ok: true, status: 200, text: '[]', headers: {} }),
  });

  const server = createHttpWsServer({
    runtime,
    arRuntime,
    host: '127.0.0.1',
    port: 0,
    startRuntimeWs: false,
    enableBackgroundWarmup: false,
  });

  const { port } = await server.start();
  try {
    // Warm the cache once outside measurement
    await httpGetRaw(port, '/api/bars?symbol=SPY&timeframe=5m&visibleBars=1000');

    const gzipRuns: number[] = [];
    const plainRuns: number[] = [];
    let gzipSample: { wireBytes: number; decodedBytes: number; contentEncoding: string | null; vary: string | null } | null = null;
    let plainSample: { wireBytes: number; decodedBytes: number; contentEncoding: string | null; vary: string | null } | null = null;
    const queryPath =
      mode === 'after'
        ? '/api/bars?symbol=SPY&timeframe=5m&visibleBars=1000&overlays=0'
        : '/api/bars?symbol=SPY&timeframe=5m&visibleBars=1000';

    for (let i = 0; i < 6; i += 1) {
      const p = await httpGetRaw(port, queryPath);
      if (i >= 1) plainRuns.push(p.totalMs);
      plainSample = {
        wireBytes: p.wireBytes,
        decodedBytes: p.decodedBytes,
        contentEncoding: p.contentEncoding,
        vary: p.vary,
      };
      const g = await httpGetRaw(port, queryPath, 'gzip, deflate');
      if (i >= 1) gzipRuns.push(g.totalMs);
      gzipSample = {
        wireBytes: g.wireBytes,
        decodedBytes: g.decodedBytes,
        contentEncoding: g.contentEncoding,
        vary: g.vary,
      };
    }

    // Idle WS test: attach message listener BEFORE open so initial frames are never missed
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    const idleBatches: number[] = [];
    ws.on('message', (raw) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      const parsed = JSON.parse(buf.toString('utf8')) as { type?: string };
      if (parsed.type === 'market_batch') {
        idleBatches.push(buf.length);
      }
    });
    await new Promise<void>((resolveOpen, rejectOpen) => {
      ws.once('open', () => resolveOpen());
      ws.once('error', rejectOpen);
    });
    await new Promise<void>((r) => setTimeout(r, 650));
    ws.close();

    return {
      queryPath,
      plainSample,
      gzipSample,
      plainLatency: summarize(plainRuns),
      gzipLatency: summarize(gzipRuns),
      wsIdle650msMarketBatches: idleBatches.length,
      wsIdle650msBytes: idleBatches.reduce((a, b) => a + b, 0),
    };
  } finally {
    await server.stop();
  }
}

async function runFmpPaginationScenario() {
  const toUtcSec = Math.floor(Date.UTC(2025, 6, 1, 18, 0, 0) / 1_000);
  const fromUtcSec = toUtcSec - 300 * 86_400; // ~9+ intraday windows for 1h
  let inFlight = 0;
  let maxInFlight = 0;
  const fmp = new FmpEnterpriseClient({
    config: {
      apiKey: 'TEST_FMP_BENCH_KEY',
      quotesApiKey: null,
      marketApiKey: null,
      etfApiKey: null,
      macroApiKey: null,
      calendarsApiKey: null,
      configured: true,
      baseUrl: 'https://financialmodelingprep.com/stable',
    },
    nowMsFn: () => toUtcSec * 1_000,
    secrets: ['TEST_FMP_BENCH_KEY'],
    fetchFn: async (url) => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        const parsedUrl = new URL(url);
        const fromStr = parsedUrl.searchParams.get('from') ?? '2025-01-01';
        await new Promise<void>((r) => setTimeout(r, 12));
        const body = JSON.stringify([
          {
            date: `${fromStr} 10:00:00`,
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 10_000,
          },
        ]);
        return { ok: true, status: 200, text: body };
      } finally {
        inFlight -= 1;
      }
    },
  });

  const times: number[] = [];
  let rowCount = 0;
  for (let r = 0; r < 4; r += 1) {
    const t0 = performance.now();
    const res = await fmp.fetchHistoricalPaginated({
      symbol: 'SPY',
      timeframe: '1h',
      fromUtcSec,
      toUtcSec,
      includeExtended: false,
      maxEmptyWindows: 20,
    });
    const dt = performance.now() - t0;
    if (r >= 1) times.push(dt);
    rowCount = res.rows;
  }
  return {
    rowsMerged: rowCount,
    maxConcurrentRequests: maxInFlight,
    latency: summarize(times),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modeIdx = args.indexOf('--mode');
  const outIdx = args.indexOf('--out');
  const mode = modeIdx >= 0 && args[modeIdx + 1] === 'after' ? 'after' : 'baseline';
  const outPath =
    outIdx >= 0 && args[outIdx + 1] !== undefined
      ? resolve(process.cwd(), args[outIdx + 1]!)
      : null;

  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();

  const vwap5k = await runSessionVwapScenario(5_000, mode);
  const vwap20k = await runSessionVwapScenario(20_000, mode);
  const tickStream = await runGgalTickStreamScenario();
  const indicators5k = runTechnicalIndicatorsScenario();

  eld.disable();
  const elDelayMs = {
    count: eld.count,
    minMs: eld.count > 0 ? Number((eld.min / 1e6).toFixed(4)) : 0,
    p50Ms: eld.count > 0 ? Number((eld.percentile(50) / 1e6).toFixed(4)) : 0,
    p95Ms: eld.count > 0 ? Number((eld.percentile(95) / 1e6).toFixed(4)) : 0,
    p99Ms: eld.count > 0 ? Number((eld.percentile(99) / 1e6).toFixed(4)) : 0,
    maxMs: eld.count > 0 ? Number((eld.max / 1e6).toFixed(4)) : 0,
  };

  const httpWs = await runHttpAndWsScenario(mode);
  const fmpPaginated = await runFmpPaginationScenario();

  const report = {
    mode,
    nodeVersion: process.version,
    recordedAtIso: new Date().toISOString(),
    scenarios: {
      sessionVwap5k: vwap5k,
      sessionVwap20k: vwap20k,
      ggalTickStreamMonotonic: tickStream,
      technicalIndicators5k: indicators5k,
      httpAndWs: httpWs,
      fmpPaginated9Windows: fmpPaginated,
      eventLoopDelayCpuSuite: elDelayMs,
    },
  };

  if (outPath !== null) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
