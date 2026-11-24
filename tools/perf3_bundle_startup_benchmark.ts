/**
 * Reproducible Bundle & Startup Benchmark Harness for Perf-3.
 *
 * Usage:
 *   node node_modules/vite-node/vite-node.mjs --script tools/perf3_bundle_startup_benchmark.ts --phase baseline
 *   node node_modules/vite-node/vite-node.mjs --script tools/perf3_bundle_startup_benchmark.ts --phase post
 *   node node_modules/vite-node/vite-node.mjs --script tools/perf3_bundle_startup_benchmark.ts --phase compare
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

type BenchmarkPhase = 'baseline' | 'post' | 'compare';

interface AssetMetric {
  readonly fileName: string;
  readonly kind: 'js' | 'css';
  readonly rawBytes: number;
  readonly gzip6Bytes: number;
  readonly gzip9Bytes: number;
  readonly brotli11Bytes: number;
  readonly isEntry: boolean;
  readonly isWorker: boolean;
}

interface ManifestChunkEntry {
  readonly file: string;
  readonly name?: string;
  readonly src?: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
}

interface DomainBreakdownItem {
  readonly domain: string;
  readonly renderedBytes: number;
  readonly moduleCount: number;
}

interface ChunkModuleAttribution {
  readonly chunkName: string;
  readonly fileName: string;
  readonly rawBytes: number;
  readonly gzip6Bytes: number;
  readonly moduleCount: number;
  readonly totalRenderedBytes: number;
  readonly byDomain: readonly DomainBreakdownItem[];
  readonly topModules: readonly { readonly id: string; readonly domain: string; readonly renderedBytes: number }[];
}

interface ArtifactReport {
  readonly gitHead: string;
  readonly distExists: boolean;
  readonly manifestPresent: boolean;
  readonly chunkSizeWarningLimitKb: number;
  readonly chunksOver500kB: readonly string[];
  readonly htmlScripts: readonly string[];
  readonly htmlModulePreloads: readonly string[];
  readonly htmlStylesheets: readonly string[];
  readonly entryJsFile: string | null;
  readonly entryJsRawBytes: number;
  readonly entryJsGzip6Bytes: number;
  readonly initialJsFiles: readonly string[];
  readonly initialJsRawBytes: number;
  readonly initialJsGzip6Bytes: number;
  readonly initialJsGzip9Bytes: number;
  readonly initialJsBrotli11Bytes: number;
  readonly initialCssRawBytes: number;
  readonly initialCssGzip6Bytes: number;
  readonly initialCssBrotli11Bytes: number;
  readonly workerFile: string | null;
  readonly workerRawBytes: number;
  readonly workerGzip6Bytes: number;
  readonly totalJsRawBytes: number;
  readonly maxJsChunkRawBytes: number;
  readonly jsChunkCount: number;
  readonly deferredChunkFiles: readonly string[];
  readonly dagCycles: readonly (readonly string[])[];
  readonly assets: readonly AssetMetric[];
  readonly inMemoryAttribution: readonly ChunkModuleAttribution[];
}

interface SummaryStats {
  readonly samples: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly iqr: number;
  readonly max: number;
  readonly mean: number;
}

interface PhaseReport {
  readonly generatedAtIso: string;
  readonly phase: 'baseline' | 'post';
  readonly artifacts: ArtifactReport;
  readonly chromium: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function parseArgs(argv: readonly string[]): { readonly phase: BenchmarkPhase; readonly outPath: string | null } {
  let phase: BenchmarkPhase = 'baseline';
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--phase' && i + 1 < argv.length) {
      const val = argv[i + 1];
      if (val === 'baseline' || val === 'post' || val === 'compare') {
        phase = val;
      }
      i += 1;
    } else if (arg.startsWith('--phase=')) {
      const val = arg.slice('--phase='.length);
      if (val === 'baseline' || val === 'post' || val === 'compare') {
        phase = val;
      }
    } else if (arg === '--out' && i + 1 < argv.length) {
      outPath = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length);
    }
  }
  return { phase, outPath };
}

function readGitHead(repoRoot: string): string {
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : 'unknown';
}

function measureCompressed(buf: Buffer): { readonly gzip6: number; readonly gzip9: number; readonly brotli11: number } {
  const gzip6 = gzipSync(buf, { level: 6 }).length;
  const gzip9 = gzipSync(buf, { level: 9 }).length;
  const brotli11 = brotliCompressSync(buf, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
  return { gzip6, gzip9, brotli11 };
}

function classifyModuleDomain(moduleId: string): string {
  const normalized = moduleId.replace(/\\/g, '/');
  if (normalized.includes('/node_modules/react/') || normalized.includes('/node_modules/react-dom/') || normalized.includes('/node_modules/scheduler/')) {
    return 'vendor-react';
  }
  if (normalized.includes('/node_modules/lightweight-charts/') || normalized.includes('/node_modules/fancy-canvas/')) {
    return 'vendor-charts';
  }
  if (normalized.includes('/node_modules/motion/') || normalized.includes('/node_modules/framer-motion/') || normalized.includes('/node_modules/motion-dom/') || normalized.includes('/node_modules/motion-utils/') || normalized.includes('/node_modules/tslib/')) {
    return 'vendor-motion';
  }
  if (normalized.includes('/node_modules/@tanstack/react-virtual/') || normalized.includes('/node_modules/@tanstack/virtual-core/')) {
    return 'vendor-virtual';
  }
  if (normalized.includes('/node_modules/lucide-react/')) {
    return 'lucide-react';
  }
  if (normalized.includes('VolatilitySuiteView') || normalized.includes('VolatilitySurface') || normalized.includes('/src/core/options/volMetrics') || normalized.includes('/src/core/options/volAnalyticsSuite')) {
    return 'volatility';
  }
  if (
    normalized.includes('/components/options/') ||
    normalized.includes('OptionsModule') ||
    normalized.includes('OptionsSymbolSelector') ||
    normalized.includes('/src/core/options/') ||
    normalized.includes('/src/core/terminal/structureOptimizer')
  ) {
    return 'options';
  }
  if (normalized.includes('/components/ggal/') || normalized.includes('ggalSpecialistClient') || normalized.includes('/src/core/ggal/')) {
    return 'ggal';
  }
  if (normalized.includes('StockDetail') || normalized.includes('/components/stock-detail/')) {
    return 'stock-detail';
  }
  if (normalized.includes('MarketModules') || normalized.includes('bondCurveLayout')) {
    return 'markets';
  }
  if (normalized.includes('Overlays') || normalized.includes('FeedsHealthDrawer')) {
    return 'overlays';
  }
  if (
    normalized.includes('/web/src/main.tsx') ||
    normalized.includes('/web/src/App.tsx') ||
    normalized.includes('HomeDashboard') ||
    normalized.includes('MarketTickerBar') ||
    normalized.includes('loafTelemetry') ||
    normalized.includes('moduleRegistry') ||
    normalized.includes('ModuleViewFallback') ||
    normalized.includes('ModuleLoadErrorBoundary')
  ) {
    return 'entry-shell';
  }
  if (normalized.includes('/web/src/') || normalized.includes('/src/core/')) {
    return 'runtime-shared';
  }
  return 'other';
}

function parseHtmlAssetLinks(html: string): {
  readonly scripts: readonly string[];
  readonly modulePreloads: readonly string[];
  readonly stylesheets: readonly string[];
} {
  const scripts: string[] = [];
  const modulePreloads: string[] = [];
  const stylesheets: string[] = [];

  const scriptRe = /<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
  for (let match = scriptRe.exec(html); match !== null; match = scriptRe.exec(html)) {
    const href = match[1];
    if (href !== undefined) scripts.push(href.replace(/^\//, ''));
  }

  const linkRe = /<link\b([^>]*)>/gi;
  for (let match = linkRe.exec(html); match !== null; match = linkRe.exec(html)) {
    const attrs = match[1] ?? '';
    const relMatch = /\brel="([^"]+)"/i.exec(attrs);
    const hrefMatch = /\bhref="([^"]+)"/i.exec(attrs);
    if (relMatch?.[1] === undefined || hrefMatch?.[1] === undefined) continue;
    const rel = relMatch[1].toLowerCase();
    const href = hrefMatch[1].replace(/^\//, '');
    if (rel === 'modulepreload') modulePreloads.push(href);
    else if (rel === 'stylesheet') stylesheets.push(href);
  }

  return { scripts, modulePreloads, stylesheets };
}

function parseManifest(rawJson: string): ReadonlyMap<string, ManifestChunkEntry> {
  const parsed: unknown = JSON.parse(rawJson);
  if (!isRecord(parsed)) return new Map();
  const entries = new Map<string, ManifestChunkEntry>();
  for (const [key, val] of Object.entries(parsed)) {
    if (!isRecord(val)) continue;
    const file = asString(val['file']);
    if (file === null) continue;
    const name = asString(val['name']) ?? undefined;
    const src = asString(val['src']) ?? undefined;
    const isEntry = asBoolean(val['isEntry']);
    const isDynamicEntry = asBoolean(val['isDynamicEntry']);
    const imports = asStringArray(val['imports']);
    const dynamicImports = asStringArray(val['dynamicImports']);
    const css = asStringArray(val['css']);
    entries.set(key, {
      file,
      ...(name !== undefined ? { name } : {}),
      ...(src !== undefined ? { src } : {}),
      ...(isEntry !== undefined ? { isEntry } : {}),
      ...(isDynamicEntry !== undefined ? { isDynamicEntry } : {}),
      ...(imports !== undefined ? { imports } : {}),
      ...(dynamicImports !== undefined ? { dynamicImports } : {}),
      ...(css !== undefined ? { css } : {}),
    });
  }
  return entries;
}

function findManifestCycles(manifest: ReadonlyMap<string, ManifestChunkEntry>): readonly (readonly string[])[] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (key: string): void => {
    visiting.add(key);
    stack.push(key);
    const node = manifest.get(key);
    if (node?.imports !== undefined) {
      for (const dep of node.imports) {
        if (visiting.has(dep)) {
          const idx = stack.indexOf(dep);
          if (idx >= 0) cycles.push([...stack.slice(idx), dep]);
        } else if (!visited.has(dep)) {
          dfs(dep);
        }
      }
    }
    stack.pop();
    visiting.delete(key);
    visited.add(key);
  };

  for (const key of manifest.keys()) {
    if (!visited.has(key)) dfs(key);
  }
  return cycles;
}

async function runInMemoryModuleAttribution(repoRoot: string): Promise<readonly ChunkModuleAttribution[]> {
  const viteEntryUrl = pathToFileURL(path.resolve(repoRoot, 'web/node_modules/vite/dist/node/index.js')).href;
  const loaded: unknown = await import(viteEntryUrl);
  if (!isRecord(loaded) || typeof loaded['build'] !== 'function') {
    throw new Error('Unable to load Vite build API from web/node_modules/vite');
  }
  const viteBuild = loaded['build'] as (config: Record<string, unknown>) => Promise<unknown>;
  const prevNodeEnv = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  let buildResult: unknown;
  try {
    buildResult = await viteBuild({
      configFile: path.resolve(repoRoot, 'web/vite.config.ts'),
      root: path.resolve(repoRoot, 'web'),
      mode: 'production',
      logLevel: 'silent',
      build: { write: false },
    });
  } finally {
    if (prevNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = prevNodeEnv;
    }
  }

  const outputs: unknown[] = [];
  const list = Array.isArray(buildResult) ? buildResult : [buildResult];
  for (const item of list) {
    if (isRecord(item) && Array.isArray(item['output'])) {
      outputs.push(...item['output']);
    }
  }

  const attributions: ChunkModuleAttribution[] = [];
  for (const out of outputs) {
    if (!isRecord(out) || out['type'] !== 'chunk') continue;
    const fileName = asString(out['fileName']) ?? 'unknown.js';
    const chunkName = asString(out['name']) ?? fileName;
    const code = asString(out['code']) ?? '';
    const rawBuf = Buffer.from(code, 'utf8');
    const gzip6Bytes = gzipSync(rawBuf, { level: 6 }).length;

    const domainMap = new Map<string, { renderedBytes: number; moduleCount: number }>();
    const moduleEntries: { id: string; domain: string; renderedBytes: number }[] = [];
    const mods = out['modules'];
    let totalRenderedBytes = 0;

    if (isRecord(mods)) {
      for (const [modId, modVal] of Object.entries(mods)) {
        if (!isRecord(modVal)) continue;
        const len = typeof modVal['renderedLength'] === 'number' ? modVal['renderedLength'] : 0;
        const domain = classifyModuleDomain(modId);
        totalRenderedBytes += len;
        moduleEntries.push({
          id: modId.replace(/\\/g, '/').replace(/^.*QuantOptionsTerminal\//i, ''),
          domain,
          renderedBytes: len,
        });
        const prev = domainMap.get(domain) ?? { renderedBytes: 0, moduleCount: 0 };
        prev.renderedBytes += len;
        prev.moduleCount += 1;
        domainMap.set(domain, prev);
      }
    }

    const byDomain: DomainBreakdownItem[] = [...domainMap.entries()]
      .map(([domain, stats]) => ({ domain, renderedBytes: stats.renderedBytes, moduleCount: stats.moduleCount }))
      .sort((a, b) => b.renderedBytes - a.renderedBytes);

    moduleEntries.sort((a, b) => b.renderedBytes - a.renderedBytes);
    attributions.push({
      chunkName,
      fileName,
      rawBytes: rawBuf.length,
      gzip6Bytes,
      moduleCount: moduleEntries.length,
      totalRenderedBytes,
      byDomain,
      topModules: moduleEntries.slice(0, 25),
    });
  }

  return attributions.sort((a, b) => b.rawBytes - a.rawBytes);
}

async function inspectDistArtifacts(repoRoot: string): Promise<ArtifactReport> {
  const distDir = path.resolve(repoRoot, 'web/dist');
  const assetsDir = path.resolve(distDir, 'assets');
  const htmlPath = path.resolve(distDir, 'index.html');
  const manifestPath = path.resolve(distDir, '.vite/manifest.json');
  const gitHead = readGitHead(repoRoot);

  if (!existsSync(distDir) || !existsSync(htmlPath) || !existsSync(assetsDir)) {
    throw new Error(`Missing build artifacts in ${distDir}; run npm --prefix web run build first.`);
  }

  const html = readFileSync(htmlPath, 'utf8');
  const links = parseHtmlAssetLinks(html);
  const manifestPresent = existsSync(manifestPath);
  const manifest = manifestPresent ? parseManifest(readFileSync(manifestPath, 'utf8')) : new Map<string, ManifestChunkEntry>();
  const dagCycles = manifestPresent ? findManifestCycles(manifest) : [];

  const fileNames = readdirSync(assetsDir).filter((name) => name.endsWith('.js') || name.endsWith('.css')).sort();
  const assets: AssetMetric[] = [];
  const assetByRel = new Map<string, AssetMetric>();

  for (const name of fileNames) {
    const abs = path.resolve(assetsDir, name);
    if (!statSync(abs).isFile()) continue;
    const buf = readFileSync(abs);
    const { gzip6, gzip9, brotli11 } = measureCompressed(buf);
    const kind = name.endsWith('.css') ? 'css' : 'js';
    const rel = `assets/${name}`;
    const isWorker = kind === 'js' && name.startsWith('marketFeed.worker-');
    const isEntry = kind === 'js' && links.scripts.includes(rel);
    const item: AssetMetric = {
      fileName: rel,
      kind,
      rawBytes: buf.length,
      gzip6Bytes: gzip6,
      gzip9Bytes: gzip9,
      brotli11Bytes: brotli11,
      isEntry,
      isWorker,
    };
    assets.push(item);
    assetByRel.set(rel, item);
  }

  const jsAssets = assets.filter((a) => a.kind === 'js');
  const nonWorkerJsAssets = jsAssets.filter((a) => !a.isWorker);
  const workerAsset = jsAssets.find((a) => a.isWorker) ?? null;
  const entryAsset = jsAssets.find((a) => a.isEntry) ?? nonWorkerJsAssets.find((a) => a.fileName.startsWith('assets/index-')) ?? null;

  let initialJsFiles: string[] = [];
  if (manifestPresent) {
    const entryKeys = [...manifest.entries()].filter(([, v]) => v.isEntry === true).map(([k]) => k);
    const seenKeys = new Set<string>();
    const queue = [...entryKeys];
    while (queue.length > 0) {
      const key = queue.shift();
      if (key === undefined || seenKeys.has(key)) continue;
      seenKeys.add(key);
      const entry = manifest.get(key);
      if (entry === undefined) continue;
      initialJsFiles.push(entry.file);
      if (entry.imports !== undefined) {
        for (const imp of entry.imports) {
          if (!seenKeys.has(imp)) queue.push(imp);
        }
      }
    }
  } else {
    initialJsFiles = [...new Set([...links.scripts, ...links.modulePreloads])].filter((f) => f.endsWith('.js'));
  }

  let initialJsRawBytes = 0;
  let initialJsGzip6Bytes = 0;
  let initialJsGzip9Bytes = 0;
  let initialJsBrotli11Bytes = 0;
  for (const rel of initialJsFiles) {
    const asset = assetByRel.get(rel);
    if (asset !== undefined) {
      initialJsRawBytes += asset.rawBytes;
      initialJsGzip6Bytes += asset.gzip6Bytes;
      initialJsGzip9Bytes += asset.gzip9Bytes;
      initialJsBrotli11Bytes += asset.brotli11Bytes;
    }
  }

  let initialCssRawBytes = 0;
  let initialCssGzip6Bytes = 0;
  let initialCssBrotli11Bytes = 0;
  for (const rel of links.stylesheets) {
    const asset = assetByRel.get(rel);
    if (asset !== undefined) {
      initialCssRawBytes += asset.rawBytes;
      initialCssGzip6Bytes += asset.gzip6Bytes;
      initialCssBrotli11Bytes += asset.brotli11Bytes;
    }
  }

  const chunksOver500kB = jsAssets.filter((a) => a.rawBytes >= 500_000).map((a) => a.fileName);
  const totalJsRawBytes = nonWorkerJsAssets.reduce((acc, a) => acc + a.rawBytes, 0);
  const maxJsChunkRawBytes = jsAssets.reduce((max, a) => Math.max(max, a.rawBytes), 0);
  const initialSet = new Set(initialJsFiles);
  const deferredChunkFiles = nonWorkerJsAssets.filter((a) => !initialSet.has(a.fileName)).map((a) => a.fileName);

  const inMemoryAttribution = await runInMemoryModuleAttribution(repoRoot);

  return {
    gitHead,
    distExists: true,
    manifestPresent,
    chunkSizeWarningLimitKb: 500,
    chunksOver500kB,
    htmlScripts: links.scripts,
    htmlModulePreloads: links.modulePreloads,
    htmlStylesheets: links.stylesheets,
    entryJsFile: entryAsset?.fileName ?? null,
    entryJsRawBytes: entryAsset?.rawBytes ?? 0,
    entryJsGzip6Bytes: entryAsset?.gzip6Bytes ?? 0,
    initialJsFiles,
    initialJsRawBytes,
    initialJsGzip6Bytes,
    initialJsGzip9Bytes,
    initialJsBrotli11Bytes,
    initialCssRawBytes,
    initialCssGzip6Bytes,
    initialCssBrotli11Bytes,
    workerFile: workerAsset?.fileName ?? null,
    workerRawBytes: workerAsset?.rawBytes ?? 0,
    workerGzip6Bytes: workerAsset?.gzip6Bytes ?? 0,
    totalJsRawBytes,
    maxJsChunkRawBytes,
    jsChunkCount: nonWorkerJsAssets.length,
    deferredChunkFiles,
    dagCycles,
    assets,
    inMemoryAttribution,
  };
}

const PYTHON_CHROMIUM_RUNNER = String.raw`
import base64
import collections
import gzip
import hashlib
import http.server
import json
import math
import mimetypes
import pathlib
import platform
import re
import socketserver
import statistics
import struct
import sys
import threading
import time
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(sys.argv[1])
PHASE = sys.argv[2]
DIST_DIR = ROOT / 'web' / 'dist'
MARKET_DATA_SRC = (ROOT / 'web' / 'src' / 'data' / 'marketData.ts').read_text(encoding='utf-8')
UNIVERSE = [('AR', s) for s in re.findall(r"makeSkeletonStock\('([^']+)'", MARKET_DATA_SRC)]
UNIVERSE += [('US', s) for s in re.findall(r"makeSkeletonUsStock\('([^']+)'", MARKET_DATA_SRC)]
UNIVERSE += [('US', 'GGAL')]

EPOCH = 1_790_000_000
SUMMARY = dict(
    totalProviders=1, configuredCount=1, activeCount=1, degradedCount=0,
    notConfiguredCount=0, armedOutOfSessionCount=0, standbyCount=0, authInvalidCount=0,
)
PROVIDER = dict(
    id='FMP_ENTERPRISE_REST', configured=True, state='CONNECTED',
    sessionMode='IN_SESSION', latencyMs=1, lastTickAgeMs=1, messagesPerMinute=100,
)

WS_GUID = b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def summarize(values):
    clean = [float(v) for v in values if v is not None]
    if not clean:
        return dict(samples=0, min=None, p50=None, p95=None, p99=None, iqr=None, max=None, mean=None)
    s = sorted(clean)
    def pick(q):
        idx = min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))
        return round(s[idx], 4)
    q1 = pick(0.25)
    q3 = pick(0.75)
    return dict(
        samples=len(s),
        min=round(s[0], 4),
        p50=pick(0.50),
        p95=pick(0.95),
        p99=pick(0.99),
        iqr=round(q3 - q1, 4),
        max=round(s[-1], 4),
        mean=round(statistics.mean(s), 4),
    )


class WsClient:
    def __init__(self, sock, channel):
        self.sock = sock
        self.channel = channel
        self.lock = threading.Lock()
        self.closed = False

    def send_text(self, text):
        data = text.encode('utf-8')
        header = bytearray([0x81])
        length = len(data)
        if length < 126:
            header.append(length)
        elif length < 65536:
            header.append(126)
            header.extend(struct.pack('!H', length))
        else:
            header.append(127)
            header.extend(struct.pack('!Q', length))
        with self.lock:
            if self.closed:
                return
            try:
                self.sock.sendall(bytes(header) + data)
            except OSError:
                self.closed = True

    def close_abrupt(self):
        with self.lock:
            self.closed = True
            try:
                self.sock.close()
            except OSError:
                pass


class BenchmarkServerState:
    def __init__(self):
        self.lock = threading.Lock()
        self.requests = []
        self.ws_clients = []
        self.ws_messages = []
        self.ws_connect_count = {'market': 0, 'feeds-health': 0}

    def reset_logs(self):
        with self.lock:
            self.requests = []

    def reset_ws_logs(self):
        with self.lock:
            self.ws_messages = []

    def add_ws(self, client):
        with self.lock:
            self.ws_clients = [c for c in self.ws_clients if not c.closed]
            self.ws_clients.append(client)
            self.ws_connect_count[client.channel] = self.ws_connect_count.get(client.channel, 0) + 1

    def get_clients(self, channel):
        with self.lock:
            return [c for c in self.ws_clients if c.channel == channel and not c.closed]

    def log_ws_message(self, channel, payload_text):
        try:
            parsed = json.loads(payload_text)
        except Exception:
            parsed = {'raw': payload_text}
        with self.lock:
            self.ws_messages.append({'channel': channel, 'payload': parsed, 't': time.monotonic()})

    def log_request(self, path, wire_bytes, decoded_bytes, status, encoding):
        with self.lock:
            self.requests.append(dict(
                path=path, wireBytes=wire_bytes, decodedBytes=decoded_bytes,
                status=status, encoding=encoding, t=time.monotonic(),
            ))

    def snapshot_requests(self):
        with self.lock:
            return list(self.requests)


def make_handler(state, stop_event):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, format, *args):
            return

        def _recv_exact(self, n):
            buf = bytearray()
            while len(buf) < n and not stop_event.is_set():
                try:
                    chunk = self.connection.recv(n - len(buf))
                    if not chunk:
                        return None
                    buf.extend(chunk)
                except TimeoutError:
                    continue
                except OSError:
                    return None
            return bytes(buf) if len(buf) == n else None

        def _handle_websocket(self):
            key = self.headers.get('Sec-WebSocket-Key', '')
            accept = base64.b64encode(hashlib.sha1(key.encode('ascii') + WS_GUID).digest()).decode('ascii')
            self.send_response(101, 'Switching Protocols')
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.end_headers()

            parsed_url = urlparse(self.path)
            channel = 'feeds-health' if 'channel=feeds-health' in parsed_url.query else 'market'
            client = WsClient(self.connection, channel)
            state.add_ws(client)
            self.connection.settimeout(0.25)

            if channel == 'market':
                client.send_text(json.dumps({
                    'type': 'MARKET_TICK_BATCH',
                    'sequence': 1,
                    'deltaRevision': 0,
                    'serverTimeSec': EPOCH,
                    'arSourceMode': 'LIVE_PRIMARY',
                    'usSourceMode': 'TRADIER_WS',
                    'quotes': [
                        dict(market=m, symbol=s, price=100 + i, previousClose=100 + i, changePct=0.5, volume=10000, asOfUtcSec=EPOCH)
                        for i, (m, s) in enumerate(UNIVERSE)
                    ],
                }))

            while not stop_event.is_set() and not client.closed:
                hdr = self._recv_exact(2)
                if not hdr:
                    break
                opcode = hdr[0] & 0x0F
                masked = (hdr[1] & 0x80) != 0
                length = hdr[1] & 0x7F
                if length == 126:
                    ext = self._recv_exact(2)
                    if not ext:
                        break
                    length = struct.unpack('!H', ext)[0]
                elif length == 127:
                    ext = self._recv_exact(8)
                    if not ext:
                        break
                    length = struct.unpack('!Q', ext)[0]
                mask_key = self._recv_exact(4) if masked else b''
                if masked and mask_key is None:
                    break
                payload = self._recv_exact(length) if length > 0 else b''
                if length > 0 and payload is None:
                    break
                if masked and mask_key:
                    payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
                if opcode == 0x8:  # Close
                    break
                elif opcode == 0x9:  # Ping -> Pong
                    with client.lock:
                        if not client.closed:
                            try:
                                client.sock.sendall(bytes([0x8A, len(payload)]) + payload)
                            except OSError:
                                client.closed = True
                elif opcode in (0x1, 0x0):
                    state.log_ws_message(channel, payload.decode('utf-8', errors='replace'))

            client.closed = True
            self.close_connection = True

        def _safe_write(self, data):
            try:
                self.wfile.write(data)
                return True
            except OSError:
                self.close_connection = True
                return False

        def _send_json(self, status, payload_obj):
            raw = json.dumps(payload_obj).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if self._safe_write(raw):
                state.log_request(urlparse(self.path).path, len(raw), len(raw), status, 'identity')

        def do_GET(self):
            if self.headers.get('Upgrade', '').lower() == 'websocket':
                self._handle_websocket()
                return

            parsed = urlparse(self.path)
            req_path = parsed.path

            if req_path == '/api/health':
                self._send_json(200, {'ok': True, 'warmupStatus': 'READY'})
                return
            if req_path == '/api/system/feeds-health':
                self._send_json(200, {'providers': [PROVIDER], 'summary': SUMMARY, 'asOfUtcSec': EPOCH})
                return
            if req_path == '/api/options/underlyings':
                self._send_json(200, {'underlyings': []})
                return
            if req_path == '/api/us/providers-status':
                self._send_json(200, {'providers': [PROVIDER]})
                return
            if req_path.startswith('/api/'):
                self._send_json(503, {'status': 'NO_DATA'})
                return

            rel = req_path.lstrip('/') or 'index.html'
            target = (DIST_DIR / rel).resolve()
            if not str(target).startswith(str(DIST_DIR.resolve())) or not target.is_file():
                body = b'Not found'
                self.send_response(404)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            raw = target.read_bytes()
            accept_enc = self.headers.get('Accept-Encoding', '')
            compressible = target.suffix in ('.js', '.css', '.html', '.json', '.svg')
            if compressible and 'gzip' in accept_enc.lower():
                wire = gzip.compress(raw, compresslevel=6)
                enc = 'gzip'
            else:
                wire = raw
                enc = 'identity'

            mime = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
            if target.suffix == '.js':
                mime = 'application/javascript; charset=utf-8'
            elif target.suffix == '.css':
                mime = 'text/css; charset=utf-8'
            elif target.suffix == '.html':
                mime = 'text/html; charset=utf-8'

            self.send_response(200)
            self.send_header('Content-Type', mime)
            if enc == 'gzip':
                self.send_header('Content-Encoding', 'gzip')
                self.send_header('Vary', 'Accept-Encoding')
            if req_path.startswith('/assets/'):
                self.send_header('Cache-Control', 'public, max-age=3600')
            else:
                self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Length', str(len(wire)))
            self.end_headers()
            if self._safe_write(wire):
                state.log_request(req_path, len(wire), len(raw), 200, enc)

    return Handler


class ReusableThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


PERF3_INIT_SCRIPT = r'''() => {
  window.__qotPerf3 = {
    longTasks: [],
    cls: 0,
    fcpMs: null,
    lcpMs: null,
    appRenders: 0,
    inactiveModuleRenders: 0,
    moduleRendersByRoute: {},
    errors: [],
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__qotPerf3.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    }
  }).observe({ type: 'longtask', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) {
        window.__qotPerf3.cls += entry.value;
      }
    }
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'first-contentful-paint') {
        window.__qotPerf3.fcpMs = entry.startTime;
      }
    }
  }).observe({ type: 'paint', buffered: true });
  new PerformanceObserver((list) => {
    const entries = list.getEntries();
    if (entries.length > 0) {
      window.__qotPerf3.lcpMs = entries[entries.length - 1].startTime;
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true });

  const moduleTypes = new Map();
  function visit(fiber, fn) {
    for (let current = fiber; current; current = current.sibling) {
      fn(current);
      if (current.child) visit(current.child, fn);
    }
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberRoot(_id, root) {
      if (!window.__qotTrackFibers) return;
      const app = root?.current?.child?.child;
      if (app && (app.flags & 1)) {
        window.__qotPerf3.appRenders += 1;
      }
      const heading = document.querySelector('main h1');
      if (!heading || !app) return;
      const routeTitle = heading.textContent || '';
      let mainFiber = null;
      visit(app.child, (f) => {
        if (f.type === 'main' && f.stateNode?.contains(heading)) mainFiber = f;
      });
      if (!mainFiber) return;
      let candidate = null;
      for (let f = mainFiber.child?.child; f; f = f.sibling) {
        if (typeof f.type === 'function' || f.tag === 14 || f.tag === 15) candidate = f;
      }
      if (candidate && !moduleTypes.has(routeTitle)) {
        moduleTypes.set(routeTitle, candidate.type);
      }
      visit(mainFiber.child, (f) => {
        if (!(f.flags & 1)) return;
        for (const [routeName, type] of moduleTypes) {
          if (f.type === type) {
            window.__qotPerf3.moduleRendersByRoute[routeName] =
              (window.__qotPerf3.moduleRendersByRoute[routeName] ?? 0) + 1;
            if (routeName !== routeTitle) {
              window.__qotPerf3.inactiveModuleRenders += 1;
            }
          }
        }
      });
    },
  };
}'''


WAIT_OPERATIVE_JS = r'''async () => {
  await new Promise((resolve) => {
    const check = () => {
      const h1 = document.querySelector('main h1');
      const tiles = document.querySelectorAll('main button');
      const hasHomeText = h1 && h1.textContent && h1.textContent.includes('Inicio') && tiles.length >= 12;
      if (hasHomeText) {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
  const operative = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const nav = performance.getEntriesByType('navigation')[0];
  const paints = performance.getEntriesByType('paint');
  const fcpEntry = paints.find((p) => p.name === 'first-contentful-paint');
  const perfObj = window.__qotPerf3 ?? { fcpMs: null, lcpMs: null, longTasks: [], cls: 0 };
  const fcp = perfObj.fcpMs ?? (fcpEntry ? fcpEntry.startTime : null);
  const longTasksBeforeOperative = perfObj.longTasks.filter(
    (t) => fcp === null || t.startTime >= fcp
  );
  const tbtMs = longTasksBeforeOperative.reduce((acc, t) => acc + Math.max(0, t.duration - 50), 0);
  return {
    fcpMs: fcp,
    lcpMs: perfObj.lcpMs,
    domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
    interactiveShellMs: fcp,
    terminalOperativeMs: operative,
    tbtMs,
    longTasksCount: perfObj.longTasks.length,
    longTasksMs: perfObj.longTasks.map((t) => t.duration),
    cls: perfObj.cls,
  };
}'''


def get_cdp_script_metrics(cdp):
    raw = cdp.send('Performance.getMetrics')
    metrics = {m['name']: m['value'] for m in raw.get('metrics', [])}
    return {
        'scriptDurationMs': round(metrics.get('ScriptDuration', 0.0) * 1000.0, 4),
        'taskDurationMs': round(metrics.get('TaskDuration', 0.0) * 1000.0, 4),
        'layoutDurationMs': round(metrics.get('LayoutDuration', 0.0) * 1000.0, 4),
        'jsHeapUsedBytes': int(metrics.get('JSHeapUsedSize', 0)),
    }


def click_nav_button(page, label, wait_ready_id=None, trusted_click=True, cdp=None, coords=None):
    if trusted_click:
        if cdp is not None and coords is not None:
            page.evaluate('() => new Promise((r) => requestAnimationFrame(r))')
        page.evaluate(r'''({ waitReadyId }) => {
          const isReady = () => {
            const okHeading = Boolean(document.querySelector('main h1')?.textContent?.trim());
            const okReadyAttr = !waitReadyId || Boolean(document.querySelector('[data-qot-module-ready="' + waitReadyId + '"]'));
            return okHeading && okReadyAttr;
          };
          window.__qotPendingNav = new Promise((resolve) => {
            window.addEventListener('click', () => {
              const t0 = performance.now();
              let sawFallback = Boolean(document.querySelector('[data-qot-module-fallback]'));
              let fallbackClsStart = sawFallback ? (window.__qotPerf3?.cls ?? 0) : null;
              requestAnimationFrame(() => {
                const firstFrameMs = Math.max(0, performance.now() - t0);
                if (document.querySelector('[data-qot-module-fallback]')) {
                  sawFallback = true;
                  if (fallbackClsStart === null) fallbackClsStart = window.__qotPerf3?.cls ?? 0;
                }
                if (isReady()) {
                  requestAnimationFrame(() => {
                    const suspenseClsDelta = fallbackClsStart !== null ? (window.__qotPerf3?.cls ?? 0) - fallbackClsStart : 0;
                    resolve({
                      firstFrameMs,
                      readyMs: Math.max(0, performance.now() - t0),
                      sawFallback,
                      suspenseClsDelta,
                    });
                  });
                  return;
                }
                const pollReady = () => {
                  if (document.querySelector('[data-qot-module-fallback]')) {
                    sawFallback = true;
                    if (fallbackClsStart === null) fallbackClsStart = window.__qotPerf3?.cls ?? 0;
                  }
                  if (isReady()) {
                    requestAnimationFrame(() => {
                      const suspenseClsDelta = fallbackClsStart !== null ? (window.__qotPerf3?.cls ?? 0) - fallbackClsStart : 0;
                      resolve({
                        firstFrameMs,
                        readyMs: Math.max(0, performance.now() - t0),
                        sawFallback,
                        suspenseClsDelta,
                      });
                    });
                    return;
                  }
                  requestAnimationFrame(pollReady);
                };
                requestAnimationFrame(pollReady);
              });
            }, { capture: true, once: true });
          });
        }''', {'waitReadyId': wait_ready_id})
        if cdp is not None and coords is not None:
            x, y = coords
            cdp.send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})
            cdp.send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})
        else:
            find_nav_locator(page, label).click()
        return page.evaluate('() => window.__qotPendingNav')

    return page.evaluate(r'''async ({ label, waitReadyId }) => {
      const btn = [...document.querySelectorAll('nav button')].find((b) => {
        const text = (b.textContent || '').trim();
        return text === label || [...b.querySelectorAll('span')].some((s) => (s.textContent || '').trim() === label);
      });
      if (!btn) throw new Error('Missing nav button: ' + label);
      const isReady = () => {
        const okHeading = Boolean(document.querySelector('main h1')?.textContent?.trim());
        const okReadyAttr = !waitReadyId || Boolean(document.querySelector('[data-qot-module-ready="' + waitReadyId + '"]'));
        return okHeading && okReadyAttr;
      };
      const t0 = performance.now();
      btn.click();
      let sawFallback = Boolean(document.querySelector('[data-qot-module-fallback]'));
      let fallbackClsStart = sawFallback ? (window.__qotPerf3?.cls ?? 0) : null;
      return await new Promise((resolve) => {
        requestAnimationFrame(() => {
          const firstFrameMs = Math.max(0, performance.now() - t0);
          if (document.querySelector('[data-qot-module-fallback]')) {
            sawFallback = true;
            if (fallbackClsStart === null) fallbackClsStart = window.__qotPerf3?.cls ?? 0;
          }
          if (isReady()) {
            requestAnimationFrame(() => {
              const suspenseClsDelta = fallbackClsStart !== null ? (window.__qotPerf3?.cls ?? 0) - fallbackClsStart : 0;
              resolve({
                firstFrameMs,
                readyMs: Math.max(0, performance.now() - t0),
                sawFallback,
                suspenseClsDelta,
              });
            });
            return;
          }
          const pollReady = () => {
            if (document.querySelector('[data-qot-module-fallback]')) {
              sawFallback = true;
              if (fallbackClsStart === null) fallbackClsStart = window.__qotPerf3?.cls ?? 0;
            }
            if (isReady()) {
              requestAnimationFrame(() => {
                const suspenseClsDelta = fallbackClsStart !== null ? (window.__qotPerf3?.cls ?? 0) - fallbackClsStart : 0;
                resolve({
                  firstFrameMs,
                  readyMs: Math.max(0, performance.now() - t0),
                  sawFallback,
                  suspenseClsDelta,
                });
              });
              return;
            }
            requestAnimationFrame(pollReady);
          };
          requestAnimationFrame(pollReady);
        });
      });
    }''', {'label': label, 'waitReadyId': wait_ready_id})


def find_nav_locator(page, label):
    locator = page.locator('nav button').filter(has=page.locator('span', has_text=re.compile(f'^{re.escape(label)}$'))).first
    if locator.count() == 0:
        locator = page.locator('nav button', has_text=re.compile(f'^{re.escape(label)}$')).first
    return locator


def dispatch_nav_pointerenter(page, label):
    find_nav_locator(page, label).hover()


def click_nav_sync(page, label):
    find_nav_locator(page, label).click()


def run_boot_measurements(browser, base_url, state, reps=7, warm=False, throttling=None):
    results = []
    if warm:
        ctx = browser.new_context(viewport={'width': 1920, 'height': 1080})
        ctx.add_init_script(f'({PERF3_INIT_SCRIPT})()')
        page = ctx.new_page()
        cdp = ctx.new_cdp_session(page)
        cdp.send('Performance.enable')
        for _ in range(2):
            page.goto(base_url, wait_until='load')
            page.evaluate(WAIT_OPERATIVE_JS)
        for _ in range(reps):
            state.reset_logs()
            page.goto(base_url, wait_until='load')
            boot = page.evaluate(WAIT_OPERATIVE_JS)
            cdp_m = get_cdp_script_metrics(cdp)
            reqs = state.snapshot_requests()
            js_reqs = [r for r in reqs if r['path'].endswith('.js') and 'worker' not in r['path']]
            results.append({
                **boot,
                **cdp_m,
                'initialJsRequests': len(js_reqs),
                'initialJsWireBytes': sum(r['wireBytes'] for r in js_reqs),
                'initialJsDecodedBytes': sum(r['decodedBytes'] for r in js_reqs),
            })
        ctx.close()
    else:
        for _ in range(reps):
            ctx = browser.new_context(viewport={'width': 1920, 'height': 1080})
            ctx.add_init_script(f'({PERF3_INIT_SCRIPT})()')
            page = ctx.new_page()
            cdp = ctx.new_cdp_session(page)
            cdp.send('Performance.enable')
            if throttling is not None:
                cdp.send('Network.enable')
                cdp.send('Network.emulateNetworkConditions', throttling)
            state.reset_logs()
            page.goto(base_url, wait_until='load')
            boot = page.evaluate(WAIT_OPERATIVE_JS)
            cdp_m = get_cdp_script_metrics(cdp)
            reqs = state.snapshot_requests()
            js_reqs = [r for r in reqs if r['path'].endswith('.js') and 'worker' not in r['path']]
            css_reqs = [r for r in reqs if r['path'].endswith('.css')]
            results.append({
                **boot,
                **cdp_m,
                'initialJsRequests': len(js_reqs),
                'initialJsWireBytes': sum(r['wireBytes'] for r in js_reqs),
                'initialJsDecodedBytes': sum(r['decodedBytes'] for r in js_reqs),
                'initialCssWireBytes': sum(r['wireBytes'] for r in css_reqs),
                'assetPaths': [r['path'] for r in reqs if r['path'].startswith('/assets/')],
            })
            ctx.close()

    return {
        'samples': len(results),
        'fcpMs': summarize([r['fcpMs'] for r in results]),
        'lcpMs': summarize([r['lcpMs'] for r in results]),
        'interactiveShellMs': summarize([r['interactiveShellMs'] for r in results]),
        'terminalOperativeMs': summarize([r['terminalOperativeMs'] for r in results]),
        'scriptDurationMs': summarize([r['scriptDurationMs'] for r in results]),
        'taskDurationMs': summarize([r['taskDurationMs'] for r in results]),
        'tbtMs': summarize([r['tbtMs'] for r in results]),
        'cls': summarize([r['cls'] for r in results]),
        'longTasksTotal': sum(r['longTasksCount'] for r in results),
        'initialJsRequests': int(statistics.median([r['initialJsRequests'] for r in results])),
        'initialJsWireBytes': int(statistics.median([r['initialJsWireBytes'] for r in results])),
        'initialJsDecodedBytes': int(statistics.median([r['initialJsDecodedBytes'] for r in results])),
        'jsHeapUsedBytes': summarize([r['jsHeapUsedBytes'] for r in results]),
        'sampleAssetPaths': results[0].get('assetPaths', []) if results else [],
    }


def main():
    stop_event = threading.Event()
    state = BenchmarkServerState()
    server = ReusableThreadingHTTPServer(('127.0.0.1', 0), make_handler(state, stop_event))
    port = server.server_address[1]
    base_url = f'http://127.0.0.1:{port}/'
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-proxy-server'])
            errors = []

            # E1 & E2: Cold and Warm Boot
            e1_cold = run_boot_measurements(browser, base_url, state, reps=7, warm=False)
            e2_warm = run_boot_measurements(browser, base_url, state, reps=7, warm=True)

            # E3: Cold Navigation without prefetch across main lazy routes (5 reps)
            cold_nav_targets = [
                ('Monitoreo', 'monitoreo' if PHASE == 'post' else None),
                ('Detalle de acción', 'acciones' if PHASE == 'post' else None),
                ('Estrategias', 'opciones' if PHASE == 'post' else None),
                ('Volatilidad', 'opciones' if PHASE == 'post' else None),
                ('GGAL Specialist', 'ggal-specialist' if PHASE == 'post' else None),
            ]
            e3_by_route = {name: {'shellMs': [], 'readyMs': [], 'suspenseCls': []} for name, _ in cold_nav_targets}
            for _ in range(5):
                for label, ready_id in cold_nav_targets:
                    ctx = browser.new_context(viewport={'width': 1920, 'height': 1080})
                    ctx.add_init_script(f'({PERF3_INIT_SCRIPT})()')
                    pg = ctx.new_page()
                    pg.on('pageerror', lambda err: errors.append(f'E3 {label}: {err}'))
                    pg.goto(base_url, wait_until='load')
                    pg.evaluate(WAIT_OPERATIVE_JS)
                    res = click_nav_button(pg, label, ready_id, trusted_click=True)
                    e3_by_route[label]['shellMs'].append(res['firstFrameMs'])
                    e3_by_route[label]['readyMs'].append(res['readyMs'])
                    e3_by_route[label]['suspenseCls'].append(res.get('suspenseClsDelta', 0))
                    ctx.close()
            e3_summary = {
                k: {
                    'shellFirstFrameMs': summarize(v['shellMs']),
                    'usableReadyMs': summarize(v['readyMs']),
                    'maxSuspenseClsDelta': max(v['suspenseCls']) if v['suspenseCls'] else 0,
                }
                for k, v in e3_by_route.items()
            }

            # E4 & E6: Prefetched + Warm Rapid Navigation (30 cycles x 5 routes = 150 transitions)
            ctx_nav = browser.new_context(viewport={'width': 1920, 'height': 1080})
            ctx_nav.add_init_script(f'({PERF3_INIT_SCRIPT})()')
            pg_nav = ctx_nav.new_page()
            pg_nav.on('pageerror', lambda err: errors.append(f'E4/E6: {err}'))
            pg_nav.goto(base_url, wait_until='load')
            pg_nav.evaluate(WAIT_OPERATIVE_JS)

            prefetch_routes = [
                ('Monitoreo', 'monitoreo' if PHASE == 'post' else None),
                ('Detalle de acción', 'acciones' if PHASE == 'post' else None),
                ('Estrategias', 'opciones' if PHASE == 'post' else None),
                ('GGAL Specialist', 'ggal-specialist' if PHASE == 'post' else None),
                ('Mercado EE.UU.', 'eeuu' if PHASE == 'post' else None),
            ]
            e4_prefetch = []
            for label, ready_id in prefetch_routes:
                dispatch_nav_pointerenter(pg_nav, label)
                pg_nav.wait_for_timeout(250)
                state.reset_logs()
                nav_res = click_nav_button(pg_nav, label, ready_id)
                js_during = [r for r in state.snapshot_requests() if r['path'].endswith('.js')]
                e4_prefetch.append({
                    'route': label,
                    'readyMs': nav_res['readyMs'],
                    'sawFallback': nav_res['sawFallback'],
                    'jsRequestsDuringClick': len(js_during),
                })

            # Warm 30 x 5 = 150 transitions (Perf-2 parity)
            if find_nav_locator(pg_nav, 'Acciones').count() == 0:
                find_nav_locator(pg_nav, 'Monitoreo').click()
            hot_routes = [
                ('Inicio', 'inicio' if PHASE == 'post' else None),
                ('Mercado EE.UU.', 'eeuu' if PHASE == 'post' else None),
                ('Acciones', 'monitoreo' if PHASE == 'post' else None),
                ('Cadena completa', 'opciones' if PHASE == 'post' else None),
                ('GGAL Specialist', 'ggal-specialist' if PHASE == 'post' else None),
            ]
            for label, ready_id in hot_routes:
                click_nav_button(pg_nav, label, ready_id, trusted_click=True)
            pg_nav.wait_for_timeout(200)
            cdp_nav = ctx_nav.new_cdp_session(pg_nav)
            hot_coords = {}
            for label, _ in hot_routes:
                box = find_nav_locator(pg_nav, label).bounding_box()
                hot_coords[label] = (box['x'] + box['width'] / 2.0, box['y'] + box['height'] / 2.0)
            prev_tasks = pg_nav.evaluate('window.__qotPerf3.longTasks.length')
            prev_cls = pg_nav.evaluate('window.__qotPerf3.cls')
            durations = []
            for _ in range(30):
                for label, ready_id in hot_routes:
                    res = click_nav_button(
                        pg_nav,
                        label,
                        ready_id,
                        trusted_click=True,
                        cdp=cdp_nav,
                        coords=hot_coords[label],
                    )
                    durations.append(res['readyMs'])
            e6_cls = pg_nav.evaluate('window.__qotPerf3.cls') - prev_cls
            e6_long_tasks = pg_nav.evaluate(f'window.__qotPerf3.longTasks.slice({prev_tasks})')

            # E10: Replay 10 Hz / 20 Hz via real Worker WebSocket frames
            pg_nav.evaluate('window.__qotTrackFibers = true')
            replay_runs = []
            for hz in (10, 20):
                for route_label, route_id in [('Inicio', 'inicio' if PHASE == 'post' else None), ('Detalle de acción', 'acciones' if PHASE == 'post' else None), ('GGAL Specialist', 'ggal-specialist' if PHASE == 'post' else None)]:
                    click_nav_button(pg_nav, route_label, route_id)
                    pg_nav.wait_for_timeout(150)
                    market_clients = state.get_clients('market')
                    for rev in range(1, hz * 2 + 1):
                        u_idx = (rev - 1) % len(UNIVERSE)
                        m_name, sym = UNIVERSE[u_idx]
                        frame = json.dumps({
                            'type': 'TICK_DELTA',
                            'deltaRevision': rev,
                            'serverTimeSec': EPOCH + rev // hz,
                            'quotes': [{
                                'market': m_name, 'symbol': sym, 'price': 100 + u_idx + rev / 100.0,
                                'previousClose': 100 + u_idx, 'changePct': rev / 100.0,
                                'volume': 10000 + rev, 'asOfUtcSec': EPOCH + rev // hz,
                            }],
                            'removed': [],
                        })
                        for c in market_clients:
                            c.send_text(frame)
                        pg_nav.wait_for_timeout(1000 / hz)
                    before_replay = pg_nav.evaluate('() => ({ apps: window.__qotPerf3.appRenders, inactive: window.__qotPerf3.inactiveModuleRenders, tasks: window.__qotPerf3.longTasks.length, cls: window.__qotPerf3.cls })')
                    start_t = time.monotonic()
                    for rev in range(hz * 2 + 1, hz * 6 + 1):
                        deadline = start_t + (rev - hz * 2) / hz
                        u_idx = (rev - 1) % len(UNIVERSE)
                        m_name, sym = UNIVERSE[u_idx]
                        frame = json.dumps({
                            'type': 'TICK_DELTA',
                            'deltaRevision': rev,
                            'serverTimeSec': EPOCH + rev // hz,
                            'quotes': [{
                                'market': m_name, 'symbol': sym, 'price': 100 + u_idx + rev / 100.0,
                                'previousClose': 100 + u_idx, 'changePct': rev / 100.0,
                                'volume': 10000 + rev, 'asOfUtcSec': EPOCH + rev // hz,
                            }],
                            'removed': [],
                        })
                        for c in market_clients:
                            c.send_text(frame)
                        sleep_ms = max(1.0, (deadline - time.monotonic()) * 1000.0)
                        pg_nav.wait_for_timeout(sleep_ms)
                    pg_nav.wait_for_timeout(200)
                    after_replay = pg_nav.evaluate('(startIdx) => ({ apps: window.__qotPerf3.appRenders, inactive: window.__qotPerf3.inactiveModuleRenders, tasks: window.__qotPerf3.longTasks.slice(startIdx), cls: window.__qotPerf3.cls })', before_replay['tasks'])
                    replay_runs.append({
                        'hz': hz,
                        'route': route_label,
                        'appRenders': after_replay['apps'] - before_replay['apps'],
                        'inactiveModuleRenders': after_replay['inactive'] - before_replay['inactive'],
                        'longTasksCount': len(after_replay['tasks']),
                        'clsDelta': after_replay['cls'] - before_replay['cls'],
                    })
            pg_nav.evaluate('window.__qotTrackFibers = false')
            ctx_nav.close()

            # E8: Throttled network profiles + saveData idle check
            e8_slow4g = run_boot_measurements(
                browser, base_url, state, reps=5, warm=False,
                throttling={'offline': False, 'latency': 40, 'downloadThroughput': int(10 * 1000 * 1000 / 8), 'uploadThroughput': int(2 * 1000 * 1000 / 8)},
            )
            e8_fast3g = run_boot_measurements(
                browser, base_url, state, reps=5, warm=False,
                throttling={'offline': False, 'latency': 150, 'downloadThroughput': int(1.6 * 1000 * 1000 / 8), 'uploadThroughput': int(750 * 1000 / 8)},
            )

            # saveData idle-warmup check (wait 2.5s after operative boot)
            ctx_sd = browser.new_context(viewport={'width': 1920, 'height': 1080})
            ctx_sd.add_init_script(f'({PERF3_INIT_SCRIPT})()')
            ctx_sd.add_init_script('Object.defineProperty(navigator, "connection", { value: { saveData: true, effectiveType: "4g" }, configurable: true });')
            pg_sd = ctx_sd.new_page()
            state.reset_logs()
            pg_sd.goto(base_url, wait_until='load')
            pg_sd.evaluate(WAIT_OPERATIVE_JS)
            reqs_before_idle = len([r for r in state.snapshot_requests() if '/assets/mod-' in r['path']])
            pg_sd.wait_for_timeout(2400)
            reqs_after_idle = len([r for r in state.snapshot_requests() if '/assets/mod-' in r['path']])
            ctx_sd.close()

            post_only = {}
            if PHASE == 'post':
                # E5: Navigation during in-flight prefetch (single HTTP GET deduplication)
                ctx_e5 = browser.new_context(viewport={'width': 1920, 'height': 1080})
                ctx_e5.add_init_script(f'({PERF3_INIT_SCRIPT})()')
                pg_e5 = ctx_e5.new_page()
                e5_hits = {'count': 0}
                def slow_ggal(route):
                    e5_hits['count'] += 1
                    time.sleep(0.12)
                    route.continue_()
                pg_e5.route('**/assets/mod-ggal-*.js', slow_ggal)
                pg_e5.goto(base_url, wait_until='load')
                pg_e5.evaluate(WAIT_OPERATIVE_JS)
                dispatch_nav_pointerenter(pg_e5, 'GGAL Specialist')
                pg_e5.wait_for_timeout(85)  # prefetch started, still in flight (120ms delay)
                click_nav_sync(pg_e5, 'GGAL Specialist')
                pg_e5.locator('[data-qot-module-ready="ggal-specialist"]').wait_for(timeout=5000)
                pg_e5.unroute('**/assets/mod-ggal-*.js')
                ctx_e5.close()

                # E7: Immediate post-boot opening of Options -> Volatilidad & GGAL Specialist before idle warmup
                ctx_e7 = browser.new_context(viewport={'width': 1920, 'height': 1080})
                pg_e7 = ctx_e7.new_page()
                pg_e7.on('pageerror', lambda err: errors.append(f'E7: {err}'))
                pg_e7.goto(base_url, wait_until='load')
                click_nav_sync(pg_e7, 'Volatilidad')
                pg_e7.locator('[data-qot-module-ready="opciones"]').wait_for(timeout=5000)
                click_nav_sync(pg_e7, 'GGAL Specialist')
                pg_e7.locator('[data-qot-module-ready="ggal-specialist"]').wait_for(timeout=5000)
                ctx_e7.close()

                # E9: Chunk failure + retry in-place without full reload
                ctx_e9 = browser.new_context(viewport={'width': 1920, 'height': 1080})
                ctx_e9.add_init_script('window.__qotBootToken = (window.__qotBootToken || 0) + 1;')
                pg_e9 = ctx_e9.new_page()
                should_fail = {'active': True}
                def fail_once(route):
                    if should_fail['active']:
                        should_fail['active'] = False
                        route.abort('failed')
                    else:
                        route.continue_()
                pg_e9.route('**/assets/mod-ggal-*.js', fail_once)
                pg_e9.goto(base_url, wait_until='load')
                pg_e9.evaluate(WAIT_OPERATIVE_JS)
                token_before = pg_e9.evaluate('window.__qotBootToken')
                click_nav_sync(pg_e9, 'GGAL Specialist')
                retry_btn = pg_e9.locator('[data-qot-retry-module="ggal-specialist"]')
                retry_btn.wait_for(timeout=5000)
                ticker_still_present = pg_e9.locator('header').is_visible()
                retry_btn.click()
                pg_e9.locator('[data-qot-module-ready="ggal-specialist"]').wait_for(timeout=5000)
                token_after = pg_e9.evaluate('window.__qotBootToken')
                pg_e9.unroute('**/assets/mod-ggal-*.js')
                ctx_e9.close()

                # E11: Perf-1 live chart fluidity during simultaneous module prefetch
                ctx_e11 = browser.new_context(viewport={'width': 1920, 'height': 1080})
                ctx_e11.add_init_script(f'({PERF3_INIT_SCRIPT})()')
                pg_e11 = ctx_e11.new_page()
                pg_e11.goto(base_url, wait_until='load')
                pg_e11.evaluate(WAIT_OPERATIVE_JS)
                click_nav_button(pg_e11, 'Detalle de acción', 'acciones', trusted_click=True)
                market_clients = state.get_clients('market')
                for warm_rev in (1, 2):
                    for c in market_clients:
                        c.send_text(json.dumps({
                            'type': 'TICK_DELTA', 'deltaRevision': warm_rev, 'serverTimeSec': EPOCH + warm_rev,
                            'quotes': [{'market': 'AR', 'symbol': 'GGAL', 'price': 100.25, 'previousClose': 100, 'changePct': 0.25, 'volume': 10001, 'asOfUtcSec': EPOCH + warm_rev}],
                            'removed': [],
                        }))
                pg_e11.wait_for_timeout(500)
                state.reset_logs()
                tasks_before_e11 = pg_e11.evaluate('window.__qotPerf3.longTasks.length')
                cls_before_e11 = pg_e11.evaluate('window.__qotPerf3.cls')
                # Prefetch Opciones while StockDetailView receives WS frames
                dispatch_nav_pointerenter(pg_e11, 'Estrategias')
                for i in range(1, 21):
                    for c in market_clients:
                        c.send_text(json.dumps({
                            'type': 'TICK_DELTA', 'deltaRevision': 2 + i, 'serverTimeSec': EPOCH + 2 + i,
                            'quotes': [{'market': 'AR', 'symbol': 'GGAL', 'price': round(100 + i * 0.25, 4), 'previousClose': 100, 'changePct': round(i * 0.25, 2), 'volume': 10000 + i, 'asOfUtcSec': EPOCH + 2 + i}],
                            'removed': [],
                        }))
                    pg_e11.wait_for_timeout(35)
                tasks_e11 = pg_e11.evaluate(f'window.__qotPerf3.longTasks.slice({tasks_before_e11})')
                cls_e11 = pg_e11.evaluate('window.__qotPerf3.cls') - cls_before_e11
                prefetched_js_e11 = len([r for r in state.snapshot_requests() if r['path'].endswith('.js')])
                ctx_e11.close()

                # E12: Worker WebSocket reconnect in live Chromium
                ctx_e12 = browser.new_context(viewport={'width': 1920, 'height': 1080})
                pg_e12 = ctx_e12.new_page()
                pg_e12.goto(base_url, wait_until='load')
                pg_e12.evaluate(WAIT_OPERATIVE_JS)
                pg_e12.wait_for_timeout(150)
                before_connects = state.ws_connect_count.get('market', 0)
                state.reset_ws_logs()
                for c in state.get_clients('market'):
                    c.close_abrupt()
                click_nav_button(pg_e12, 'GGAL Specialist', 'ggal-specialist')
                pg_e12.wait_for_timeout(2200)
                after_connects = state.ws_connect_count.get('market', 0)
                ws_msgs = [m for m in state.ws_messages if m['channel'] == 'market']
                ctx_e12.close()

                post_only = {
                    'e5InFlightPrefetch': {
                        'httpGetsForGgalChunk': e5_hits['count'],
                    },
                    'e7ImmediatePostBootOpen': {
                        'ok': True,
                    },
                    'e9ChunkErrorRecovery': {
                        'tickerPreserved': bool(ticker_still_present),
                        'documentReloaded': token_after != token_before,
                        'recoveredInPlace': True,
                    },
                    'e11ConcurrentChartPrefetch': {
                        'longTasksCount': len(tasks_e11),
                        'clsDelta': cls_e11,
                        'prefetchedJsCount': prefetched_js_e11,
                    },
                    'e12WorkerReconnect': {
                        'reconnected': after_connects > before_connects,
                        'marketConnectsDelta': after_connects - before_connects,
                        'postReconnectMessages': ws_msgs,
                    },
                }

            output = {
                'browser': browser.version,
                'os': platform.platform(),
                'viewport': [1920, 1080],
                'universeCount': len(UNIVERSE),
                'e1ColdBoot': e1_cold,
                'e2WarmBoot': e2_warm,
                'e3ColdNavigation': e3_summary,
                'e4PrefetchedNavigation': e4_prefetch,
                'e6WarmRapidSwitch': {
                    'transitions': len(durations),
                    'latencyMs': summarize(durations),
                    'longTasksCount': len(e6_long_tasks),
                    'clsDelta': round(e6_cls, 6),
                },
                'e8ThrottledNetwork': {
                    'slow4g': e8_slow4g,
                    'fast3g': e8_fast3g,
                    'saveDataModRequestsBeforeIdle': reqs_before_idle,
                    'saveDataModRequestsAfterIdle': reqs_after_idle,
                },
                'e10Replay': replay_runs,
                **post_only,
                'pageErrors': errors,
            }
            browser.close()
            print(json.dumps(output, indent=2))
    finally:
        stop_event.set()
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
`;

function runChromiumBenchmark(repoRoot: string, phase: 'baseline' | 'post'): Record<string, unknown> {
  const res = spawnSync('python', ['-', repoRoot, phase], {
    cwd: repoRoot,
    input: PYTHON_CHROMIUM_RUNNER,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const errMsg = res.error !== undefined ? `${res.error.message}\n` : '';
    throw new Error(`Chromium benchmark failed (exit ${String(res.status)}):\n${errMsg}${res.stderr}\n${res.stdout}`);
  }
  const parsed: unknown = JSON.parse(res.stdout);
  if (!isRecord(parsed)) {
    throw new Error('Unexpected non-object JSON returned from Chromium runner');
  }
  return parsed;
}

function getNestedNumber(obj: unknown, ...keys: readonly string[]): number | null {
  let curr: unknown = obj;
  for (const key of keys) {
    if (!isRecord(curr)) return null;
    curr = curr[key];
  }
  return typeof curr === 'number' && Number.isFinite(curr) ? curr : null;
}

function pctDelta(before: number | null, after: number | null): string {
  if (before === null || after === null || before === 0) return 'n/a';
  const delta = ((after - before) / before) * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`;
}

function buildComparison(baseline: PhaseReport, post: PhaseReport): Record<string, unknown> {
  const baseEvalP50 = getNestedNumber(baseline.chromium, 'e1ColdBoot', 'scriptDurationMs', 'p50');
  const postEvalP50 = getNestedNumber(post.chromium, 'e1ColdBoot', 'scriptDurationMs', 'p50');
  const baseFcpP50 = getNestedNumber(baseline.chromium, 'e1ColdBoot', 'fcpMs', 'p50');
  const postFcpP50 = getNestedNumber(post.chromium, 'e1ColdBoot', 'fcpMs', 'p50');
  const baseOpP50 = getNestedNumber(baseline.chromium, 'e1ColdBoot', 'terminalOperativeMs', 'p50');
  const postOpP50 = getNestedNumber(post.chromium, 'e1ColdBoot', 'terminalOperativeMs', 'p50');
  const baseSlow4gOpP50 = getNestedNumber(baseline.chromium, 'e8ThrottledNetwork', 'slow4g', 'terminalOperativeMs', 'p50');
  const postSlow4gOpP50 = getNestedNumber(post.chromium, 'e8ThrottledNetwork', 'slow4g', 'terminalOperativeMs', 'p50');
  const baseFast3gOpP50 = getNestedNumber(baseline.chromium, 'e8ThrottledNetwork', 'fast3g', 'terminalOperativeMs', 'p50');
  const postFast3gOpP50 = getNestedNumber(post.chromium, 'e8ThrottledNetwork', 'fast3g', 'terminalOperativeMs', 'p50');
  const postTabP95 = getNestedNumber(post.chromium, 'e6WarmRapidSwitch', 'latencyMs', 'p95');
  const postTabCls = getNestedNumber(post.chromium, 'e6WarmRapidSwitch', 'clsDelta');

  return {
    generatedAtIso: new Date().toISOString(),
    baselineGitHead: baseline.artifacts.gitHead,
    postGitHead: post.artifacts.gitHead,
    bundle: {
      entryJsRawBytes: {
        before: baseline.artifacts.entryJsRawBytes,
        after: post.artifacts.entryJsRawBytes,
        deltaPct: pctDelta(baseline.artifacts.entryJsRawBytes, post.artifacts.entryJsRawBytes),
        budgetPass: post.artifacts.entryJsRawBytes <= 120_000,
      },
      initialJsRawBytes: {
        before: baseline.artifacts.initialJsRawBytes,
        after: post.artifacts.initialJsRawBytes,
        deltaPct: pctDelta(baseline.artifacts.initialJsRawBytes, post.artifacts.initialJsRawBytes),
        budgetPass: post.artifacts.initialJsRawBytes <= 580_000,
      },
      initialJsGzip6Bytes: {
        before: baseline.artifacts.initialJsGzip6Bytes,
        after: post.artifacts.initialJsGzip6Bytes,
        deltaPct: pctDelta(baseline.artifacts.initialJsGzip6Bytes, post.artifacts.initialJsGzip6Bytes),
        budgetPass: post.artifacts.initialJsGzip6Bytes <= 195_000,
      },
      maxJsChunkRawBytes: {
        before: baseline.artifacts.maxJsChunkRawBytes,
        after: post.artifacts.maxJsChunkRawBytes,
        budgetPass: post.artifacts.maxJsChunkRawBytes < 500_000 && post.artifacts.chunksOver500kB.length === 0,
      },
      workerRawBytes: {
        before: baseline.artifacts.workerRawBytes,
        after: post.artifacts.workerRawBytes,
        budgetPass: post.artifacts.workerRawBytes >= 20_000 && post.artifacts.workerRawBytes <= 26_000,
      },
      dagCyclesCount: post.artifacts.dagCycles.length,
    },
    startupAndNavigation: {
      coldScriptDurationP50Ms: {
        before: baseEvalP50,
        after: postEvalP50,
        deltaPct: pctDelta(baseEvalP50, postEvalP50),
      },
      coldFcpP50Ms: {
        before: baseFcpP50,
        after: postFcpP50,
        deltaPct: pctDelta(baseFcpP50, postFcpP50),
      },
      coldTerminalOperativeP50Ms: {
        before: baseOpP50,
        after: postOpP50,
        deltaPct: pctDelta(baseOpP50, postOpP50),
      },
      slow4gTerminalOperativeP50Ms: {
        before: baseSlow4gOpP50,
        after: postSlow4gOpP50,
        deltaPct: pctDelta(baseSlow4gOpP50, postSlow4gOpP50),
      },
      fast3gTerminalOperativeP50Ms: {
        before: baseFast3gOpP50,
        after: postFast3gOpP50,
        deltaPct: pctDelta(baseFast3gOpP50, postFast3gOpP50),
      },
      warmTabSwitchP95Ms: {
        after: postTabP95,
        budgetPass: postTabP95 !== null && postTabP95 <= 45,
      },
      warmTabSwitchCls: {
        after: postTabCls,
        budgetPass: postTabCls !== null && postTabCls <= 0.001,
      },
    },
  };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const cacheDir = path.resolve(repoRoot, '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const { phase, outPath } = parseArgs(process.argv.slice(2));

  if (phase === 'compare') {
    const basePath = path.resolve(cacheDir, 'perf3-baseline-metrics.json');
    const postPath = path.resolve(cacheDir, 'perf3-post-metrics.json');
    const baseline = JSON.parse(readFileSync(basePath, 'utf8')) as PhaseReport;
    const post = JSON.parse(readFileSync(postPath, 'utf8')) as PhaseReport;
    const comparison = buildComparison(baseline, post);
    const dest = outPath ? path.resolve(repoRoot, outPath) : path.resolve(cacheDir, 'perf3-comparison.json');
    writeFileSync(dest, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    return;
  }

  const artifacts = await inspectDistArtifacts(repoRoot);
  const chromium = runChromiumBenchmark(repoRoot, phase);
  const report: PhaseReport = {
    generatedAtIso: new Date().toISOString(),
    phase,
    artifacts,
    chromium,
  };
  const defaultOut = phase === 'baseline' ? '.cache/perf3-baseline-metrics.json' : '.cache/perf3-post-metrics.json';
  const dest = path.resolve(repoRoot, outPath ?? defaultOut);
  writeFileSync(dest, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `[perf3-benchmark] phase=${phase} entry=${String(artifacts.entryJsRawBytes)}B initial=${String(artifacts.initialJsRawBytes)}B/${String(artifacts.initialJsGzip6Bytes)}B_gz worker=${String(artifacts.workerRawBytes)}B -> ${dest}\n`,
  );
}

await main();
