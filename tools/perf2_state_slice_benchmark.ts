import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import * as bridge from '../web/src/data/liveRuntimeBridge';

const require = createRequire(new URL('../web/package.json', import.meta.url));
const react = require('react') as {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
};
const dispatcher = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const subscribe = Reflect.get(bridge, 'subscribeBridgeChannel') as
  | ((channel: string, listener: () => void) => () => void)
  | undefined;
const channels = ['usSnapshot:QQQ', 'usSnapshot:SPY', 'macro', 'status', 'options:AR:GGAL'];
let asOfUtcSec = 1_790_000_000;

globalThis.fetch = async (input) => {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname === '/api/health') return Response.json({ ok: true, warmupStatus: 'READY' });
  const symbol = url.searchParams.get('symbol');
  return Response.json({
    symbol, asOfUtcSec: ++asOfUtcSec, feedMode: 'LIVE', marketContext: { unifiedQuotes: [] },
  });
};

function watch(channel: string, listener: () => void): () => void {
  if (subscribe !== undefined) return subscribe(channel, listener);
  const previous = dispatcher.H;
  let unsubscribe: (() => void) | undefined;
  dispatcher.H = {
    useSyncExternalStore(connect: (fn: () => void) => () => void, read: () => unknown) {
      unsubscribe = connect(listener);
      return read();
    },
  };
  try {
    if (channel === 'status') bridge.useLiveMarketStatus();
    else bridge.useLiveMarketState();
  } finally {
    dispatcher.H = previous;
  }
  if (unsubscribe === undefined) throw new Error(`Subscription unavailable for ${channel}`);
  return unsubscribe;
}

await bridge.refreshBackendHealth();
await bridge.requestUsSnapshot('SPY');
const runs = [];
for (const hz of [10, 20]) {
  for (let run = 0; run < 5; run += 1) {
    for (let event = 0; event < hz * 2; event += 1) await bridge.requestUsSnapshot('QQQ');
    const callbacks = Object.fromEntries(channels.map((channel) => [channel, 0]));
    const cleanup = channels.map((channel) => watch(channel, () => { callbacks[channel] += 1; }));
    const startedAt = performance.now();
    let accepted = 0;
    try {
      for (let event = 0; event < hz * 10; event += 1) {
        if (await bridge.requestUsSnapshot('QQQ')) accepted += 1;
      }
    } finally {
      cleanup.forEach((off) => off());
    }
    runs.push({ hz, run, accepted, callbacks, cpuMs: performance.now() - startedAt });
  }
}
process.stdout.write(`${JSON.stringify({ runs }, null, 2)}\n`);
