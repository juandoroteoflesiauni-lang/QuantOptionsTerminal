import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = () => void;
type Stop = () => void;
type Body = Readonly<Record<string, unknown>>;
type Snapshot = {
  readonly usSnapshotsBySymbol: Readonly<Record<string, Body>>;
  readonly optionsByUnderlying: Readonly<Record<string, Body>>;
  readonly loadingOptionExpiries: Readonly<Record<string, boolean>>;
  readonly macro: unknown;
  readonly monitoring: unknown;
};
interface Bridge {
  subscribeBridgeChannel(channel: string, listener: Listener): Stop;
  subscribeBridgeChannels(channels: readonly string[], listener: Listener): Stop;
  subscribeUsProvidersStatus(listener: Listener): Stop;
  getBridgeListenerStats(): { totalListeners: number; totalChannels: number };
  getLiveMarketStateSnapshot(): Snapshot;
  getLiveOptionsSlice(key: string): unknown;
  useLiveUsSnapshot(symbol: string): unknown;
  useLiveBridgeSelector<T>(channels: readonly string[], selector: (state: Snapshot) => T): T;
  refreshBackendHealth(): Promise<boolean>;
  refreshOverview(): Promise<void>;
  requestUsSnapshot(symbol: string, options?: { signal?: AbortSignal }): Promise<Body | null>;
  requestOptionsChain(symbol: string, force?: boolean, expiration?: string): Promise<void>;
  requestUsOptionExpiry(symbol: string, expiration: string): Promise<void>;
}
interface MarketStream {
  setMarketViewScope(scope: { view: string; focusSymbol: string | null; focusMarket: 'AR' | 'US' }): void;
  __testApplyMarketStreamFrame(frame: Body): boolean;
  __testGetMarketStreamStateSnapshot(): { liveOrderBook: unknown };
  __testResetMarketStreamState(): void;
  useMarketStreamConnection(): void;
  useAtomicOptionQuote(symbol: string): unknown;
  subscribeMarketScopedQuotes(market: 'AR' | 'US', throttle: number, listener: Listener): Stop;
  subscribeMarketLiveFx(listener: Listener): Stop;
  subscribeMarketLiveFutures(listener: Listener): Stop;
  subscribeMarketLiveCauciones(listener: Listener): Stop;
}
interface Visibility {
  createVisibilityAwareInterval(run: (signal: AbortSignal) => void | Promise<void>, ms: number, options?: {
    runImmediately?: boolean;
    reconcileAfterMs?: number;
    repeat?: boolean;
  }): Stop;
  subscribeDocumentVisibility(listener: (visible: boolean) => void): Stop;
}
interface Feeds {
  acquireFeedsHealthConnection(): Stop;
  subscribeFeedsHealth(channel: 'full' | 'badge' | 'connectivity', listener: Listener): Stop;
}

const bridgeSpecifier = '../web/src/data/liveRuntimeBridge';
const streamSpecifier = '../web/src/api/useMarketLiveStream';
const visibilitySpecifier = '../web/src/data/visibilityLifecycle';
const feedsSpecifier = '../web/src/components/FeedsHealthDrawer.tsx';
const react = createRequire(new URL('../web/package.json', import.meta.url))('react') as {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
};
const dispatcher = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const reference = JSON.parse(readFileSync(
  new URL('../fixtures/perf2_state_slices_reference.json', import.meta.url), 'utf8',
)) as {
  notifications: Record<'qqq' | 'health' | 'healthUnchanged' | 'spyChain' | 'spyExpiry', Record<string, number>>;
  waiters: { canceled: readonly number[]; received: readonly number[]; fetchAborted: boolean }[];
};
const expiry = '2026-08-21';
const makeSnapshot = (symbol: string, asOfUtcSec: number, loaded = false): Body => ({
  symbol, asOfUtcSec, feedMode: 'LIVE', status: 'OK', quoteMode: 'LIVE_NBBO',
  envelope: { snapshot: { metrics: { spot: 100 } } },
  marketContext: { unifiedQuotes: [] },
  optionsChain: {
    availableExpirations: [{
      expirationDate: expiry, daysToExpiry: 21, loaded, validCallCount: loaded ? 100 : 0, validPutCount: 0,
    }],
  },
});
const makeExpiry = (asOfUtcSec: number): Body => ({
  symbol: 'SPY', status: 'OK', feedMode: 'LIVE', quoteMode: 'LIVE_NBBO',
  expirationDate: expiry, asOfUtcSec, spot: 100, daysToExpiry: 21,
  expiryMeta: { expirationDate: expiry, daysToExpiry: 21, loaded: true, validCallCount: 150, validPutCount: 140 },
  contracts: [], slice: null, exposureSummary: null, syntheticRates: null, volAnalyticsExpiry: null,
});
const makeOverview = (price: number): Body => ({
  feedStatus: 'LIVE', marketState: 'ABIERTO', marketStateLabel: 'Abierto', providerErrors: [],
  asOfUtcSec: 2000 + price, mervalStocks: [{ ticker: 'GGAL', last: price }],
  globalIndicators: [], generalPanelStocks: [], cedears: [], bonds: [], cauciones: [],
});

class VisibilityDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';

  change(next: 'visible' | 'hidden'): void {
    this.visibilityState = next;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

class ReplaySocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly instances: ReplaySocket[] = [];
  readonly messages: Body[] = [];
  readyState = 0;

  constructor() {
    super();
    ReplaySocket.instances.push(this);
  }

  open(): void {
    this.readyState = ReplaySocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  send(data: string): void {
    this.messages.push(JSON.parse(data) as Body);
  }

  receive(body: Body): void {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(body) }));
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

function withDispatcher<T>(hooks: object, callback: () => T): T {
  const previous = dispatcher.H;
  dispatcher.H = hooks;
  try {
    return callback();
  } finally {
    dispatcher.H = previous;
  }
}

function observe(bridge: Bridge) {
  const channels = {
    spy: ['usSnapshot:SPY'],
    qqq: ['usSnapshot:QQQ'],
    macro: ['macro'],
    status: ['status'],
    ggal: ['options:AR:GGAL'],
    spyOptions: ['options:US:SPY'],
    spyLoading: ['optionLoading:US:SPY'],
    combined: ['options:US:SPY', 'usSnapshot:SPY'],
  };
  const callbacks = Object.fromEntries(Object.keys(channels).map((name) => [name, 0]));
  const subscriptions = Object.entries(channels).map(([name, keys]) =>
    bridge.subscribeBridgeChannels(keys, () => { callbacks[name] = (callbacks[name] ?? 0) + 1; }),
  );
  return {
    take() {
      const result = { ...callbacks };
      for (const name of Object.keys(callbacks)) callbacks[name] = 0;
      return result;
    },
    stop() {
      for (const unsubscribe of subscriptions) unsubscribe();
    },
  };
}

async function loadBridge(): Promise<Bridge> {
  const module: unknown = await import(/* @vite-ignore */ bridgeSpecifier);
  return module as Bridge;
}

beforeEach(() => {
  vi.resetModules();
  ReplaySocket.instances.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Perf-2: canales de estado y desacople', () => {
  it('publica solo a canales sucios y deduplica listeners después del intercambio de estado', async () => {
    const bridge = await loadBridge();
    let health = true;
    vi.stubGlobal('fetch', async (input: unknown) => {
      await Promise.resolve();
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/health') return Response.json({ ok: health, warmupStatus: 'READY' });
      if (url.pathname === '/api/options/expiry') return Response.json(makeExpiry(3000));
      return Response.json(makeSnapshot(url.searchParams.get('symbol') ?? 'SPY', 2000));
    });
    await bridge.refreshBackendHealth();
    await bridge.requestUsSnapshot('SPY');
    const previous = bridge.getLiveMarketStateSnapshot();
    const beforeOptions = bridge.getLiveOptionsSlice('US:SPY');
    const counts = observe(bridge);

    await bridge.requestUsSnapshot('QQQ');
    expect(counts.take()).toEqual(reference.notifications.qqq);
    const afterQqq = bridge.getLiveMarketStateSnapshot();
    expect(afterQqq.usSnapshotsBySymbol['SPY']).toBe(previous.usSnapshotsBySymbol['SPY']);
    expect(afterQqq.optionsByUnderlying).toBe(previous.optionsByUnderlying);
    expect(afterQqq.macro).toBe(previous.macro);
    expect(afterQqq.monitoring).toBe(previous.monitoring);
    expect(bridge.getLiveOptionsSlice('spy')).toBe(beforeOptions);

    health = false;
    await bridge.refreshBackendHealth();
    expect(counts.take()).toEqual(reference.notifications.health);
    await bridge.refreshBackendHealth();
    expect(counts.take()).toEqual(reference.notifications.healthUnchanged);
    health = true;
    await bridge.refreshBackendHealth();
    counts.take();

    const consistent: boolean[] = [];
    const onPublication = () => {
      const state = bridge.getLiveMarketStateSnapshot();
      consistent.push(state.optionsByUnderlying['US:SPY'] !== undefined && state.usSnapshotsBySymbol['SPY'] !== previous.usSnapshotsBySymbol['SPY']);
    };
    const offOptions = bridge.subscribeBridgeChannel('options:US:SPY', onPublication);
    const offSnapshot = bridge.subscribeBridgeChannel('usSnapshot:SPY', onPublication);
    await bridge.requestOptionsChain('US:SPY');
    expect(counts.take()).toEqual(reference.notifications.spyChain);
    expect(consistent).toEqual([true]);
    offOptions();
    offSnapshot();

    const loadingStates: (boolean | undefined)[] = [];
    const offLoading = bridge.subscribeBridgeChannel('optionLoading:US:SPY', () => {
      loadingStates.push(bridge.getLiveMarketStateSnapshot().loadingOptionExpiries['SPY:' + expiry]);
    });
    await Promise.all([
      bridge.requestUsOptionExpiry('US:SPY', expiry),
      bridge.requestUsOptionExpiry('US:SPY', expiry),
    ]);
    expect(counts.take()).toEqual(reference.notifications.spyExpiry);
    expect(loadingStates).toEqual([true, false]);
    expect(bridge.getLiveOptionsSlice('SPY')).toBe(bridge.getLiveOptionsSlice('US:SPY'));
    offLoading();
    counts.stop();
    expect(bridge.getBridgeListenerStats()).toMatchObject({ totalChannels: 0, totalListeners: 0 });
  });

  it('mantiene referencias de getSnapshot aunque el selector construya una proyección', async () => {
    const bridge = await loadBridge();
    const hooks = {
      useCallback: (fn: unknown) => fn,
      useMemo: (create: () => unknown) => create(),
      useRef: (value: unknown) => ({ current: value }),
      useEffect: () => undefined,
      useSyncExternalStore(_subscribe: unknown, read: () => unknown) {
        const first = read();
        expect(read()).toBe(first);
        return first;
      },
    };
    withDispatcher(hooks, () => {
      expect(bridge.useLiveUsSnapshot('SPY')).toBeUndefined();
      expect(bridge.useLiveBridgeSelector(['macro'], (current) => ({ macro: current.macro }))).toEqual({ macro: null });
    });
  });

  it('mantiene el hecho puntual ante respuestas viejas y elimina el segundo aviso de flashes', async () => {
    vi.useFakeTimers();
    const bridge = await loadBridge();
    let revision = 1500;
    let price = 100;
    vi.stubGlobal('fetch', async (input: unknown) => {
      await Promise.resolve();
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/ar/overview') return Response.json(makeOverview(price));
      if (url.pathname === '/api/options/expiry') return Response.json(makeExpiry(2500));
      return Response.json(makeSnapshot('SPY', revision, url.searchParams.has('expiration')));
    });
    await bridge.requestUsOptionExpiry('US:SPY', expiry);
    const pointOptions = bridge.getLiveMarketStateSnapshot().optionsByUnderlying['US:SPY'];
    await bridge.requestOptionsChain('US:SPY', false, expiry);
    expect(bridge.getLiveMarketStateSnapshot().optionsByUnderlying['US:SPY']).toBe(pointOptions);
    revision = 2000;
    await bridge.requestUsSnapshot('SPY');
    const published = bridge.getLiveMarketStateSnapshot().usSnapshotsBySymbol['SPY'];
    expect(published?.['optionsChain']).toMatchObject({
      availableExpirations: [{ expirationDate: expiry, loaded: true, validCallCount: 150 }],
    });

    await bridge.refreshOverview();
    const overview = vi.fn();
    const stop = bridge.subscribeBridgeChannel('overview', overview);
    price = 101;
    await bridge.refreshOverview();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(overview).toHaveBeenCalledTimes(1);
    stop();
  });

  it.each(reference.waiters)('cancela por consumidor y aborta la red al agotar waiters %#', async (scenario) => {
    const bridge = await loadBridge();
    const controllers = [new AbortController(), new AbortController()];
    let complete: ((response: Response) => void) | undefined;
    let fetchSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_input: unknown, request?: RequestInit) => new Promise<Response>((resolve) => {
      fetchSignal = request?.signal;
      complete = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);
    const requests = controllers.map((controller) => bridge.requestUsSnapshot('SPY', { signal: controller.signal }));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const index of scenario.canceled) controllers[index - 1]?.abort();
    for (const index of scenario.canceled) await expect(requests[index - 1]).resolves.toBeNull();
    expect(fetchSignal?.aborted).toBe(scenario.fetchAborted);
    complete?.(Response.json(makeSnapshot('SPY', 2000)));
    for (const index of scenario.received) await expect(requests[index - 1]).resolves.toMatchObject({ symbol: 'SPY' });
  });

  it('pausa intervalos y pollers al ocultarse y reconcilia una vez al volver', async () => {
    vi.useFakeTimers();
    const doc = new VisibilityDocument();
    doc.visibilityState = 'hidden';
    vi.stubGlobal('document', doc);
    const bridge = (await loadBridge()) as Bridge & { startLiveRuntimePolling(enabled: boolean): Stop };
    const lifecycle = (await import(/* @vite-ignore */ visibilitySpecifier)) as unknown as Visibility;
    const fetchMock = vi.fn(async (input: unknown) => {
      await Promise.resolve();
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/health') return Response.json({ ok: true, warmupStatus: 'READY' });
      if (path === '/api/ar/overview') return Response.json(makeOverview(100));
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const run = vi.fn((signal: AbortSignal) => { expect(signal.aborted).toBe(false); });
    const stopInterval = lifecycle.createVisibilityAwareInterval(run, 30_000, { runImmediately: true });
    const stopPolling = bridge.startLiveRuntimePolling(true);
    const stopProvider = bridge.subscribeUsProvidersStatus(() => undefined);
    const stopSecondProvider = bridge.subscribeUsProvidersStatus(() => undefined);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    doc.change('visible');
    await vi.advanceTimersByTimeAsync(0);
    for (const path of ['/api/health', '/api/ar/overview', '/api/us/providers-status']) {
      expect(fetchMock.mock.calls.filter(([url]) => url === path)).toHaveLength(1);
    }
    expect(run).toHaveBeenCalledTimes(1);
    doc.change('hidden');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(1);
    stopSecondProvider();
    stopProvider();
    stopPolling();
    stopInterval();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recupera una carga inicial abortada y conserva la cadencia del poll de proveedores', async () => {
    vi.useFakeTimers();
    const doc = new VisibilityDocument();
    vi.stubGlobal('document', doc);
    const bridge = await loadBridge();
    const lifecycle = (await import(/* @vite-ignore */ visibilitySpecifier)) as unknown as Visibility;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      setTimeout(() => { resolve(Response.json({ status: 'OK' })); }, 250);
    }));
    vi.stubGlobal('fetch', fetchMock);
    const stopProvider = bridge.subscribeUsProvidersStatus(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    stopProvider();

    const signals: AbortSignal[] = [];
    const stop = lifecycle.createVisibilityAwareInterval((signal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve(); }, { once: true });
      });
    }, 30_000, { runImmediately: true, repeat: false, reconcileAfterMs: Infinity });
    await vi.advanceTimersByTimeAsync(0);
    doc.change('hidden');
    doc.change('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesce scopes rápidos y descarta quotes de opciones y L2 del scope saliente', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost' } });
    vi.stubGlobal('WebSocket', ReplaySocket);
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ ok: true, warmupStatus: 'READY' })));
    const stream = (await import(/* @vite-ignore */ streamSpecifier)) as unknown as MarketStream;
    stream.setMarketViewScope({ view: 'home', focusSymbol: null, focusMarket: 'AR' });
    let release: Stop | undefined;
    withDispatcher({ useEffect(effect: () => Stop) { release = effect(); } }, () => {
      stream.useMarketStreamConnection();
    });
    const socket = ReplaySocket.instances[0];
    if (socket === undefined) throw new Error('Expected market socket');
    socket.open();
    await vi.advanceTimersByTimeAsync(24);
    socket.messages.length = 0;
    stream.setMarketViewScope({ view: 'stock_detail', focusSymbol: 'SPY', focusMarket: 'US' });
    stream.setMarketViewScope({ view: 'options', focusSymbol: 'QQQ', focusMarket: 'US' });
    stream.setMarketViewScope({ view: 'monitoring', focusSymbol: null, focusMarket: 'AR' });
    await vi.advanceTimersByTimeAsync(24);
    expect(socket.messages.filter((message) => message['type'] === 'set_view_scope')).toEqual([
      { type: 'set_view_scope', view: 'monitoring', focusSymbol: null, focusMarket: 'AR' },
    ]);
    stream.__testApplyMarketStreamFrame({
      type: 'option_quotes_batch', underlying: 'QQQ',
      quotes: [{ symbol: 'QQQ260821C00500000', bid: 1, ask: 2, asOfUtcSec: 1_760_000_000 }],
    });
    const staleOption = withDispatcher({
      useCallback: (fn: unknown) => fn,
      useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
    }, () => stream.useAtomicOptionQuote('QQQ260821C00500000'));
    expect(staleOption).toBeNull();
    stream.__testApplyMarketStreamFrame({
      type: 'MARKET_TICK_BATCH', quotes: [], liveOrderBook: { symbol: 'SPY', bids: [], asks: [] },
    });
    expect(stream.__testGetMarketStreamStateSnapshot().liveOrderBook).toBeNull();
    release?.();
    await vi.advanceTimersByTimeAsync(150);
    stream.__testResetMarketStreamState();
  });

  it('aísla la versión US de AR, futuros, cauciones y FX', async () => {
    vi.useFakeTimers();
    const stream = (await import(/* @vite-ignore */ streamSpecifier)) as unknown as MarketStream;
    const frame = { arSourceMode: 'LIVE_PRIMARY', usSourceMode: 'TRADIER_WS', serverTimeSec: 1_760_000_000 };
    stream.__testApplyMarketStreamFrame({ ...frame, type: 'MARKET_TICK_BATCH', quotes: [] });
    const ar = vi.fn();
    const us = vi.fn();
    const fx = vi.fn();
    const futures = vi.fn();
    const cauciones = vi.fn();
    const stops = [
      stream.subscribeMarketScopedQuotes('AR', 0, ar), stream.subscribeMarketScopedQuotes('US', 0, us),
      stream.subscribeMarketLiveFx(fx), stream.subscribeMarketLiveFutures(futures), stream.subscribeMarketLiveCauciones(cauciones),
    ];
    stream.__testApplyMarketStreamFrame({
      ...frame, type: 'TICK_DELTA', deltaRevision: 1, removed: [],
      quotes: [{ market: 'US', symbol: 'QQQ', price: 421, asOfUtcSec: frame.serverTimeSec }],
    });
    expect(us).toHaveBeenCalledTimes(1);
    for (const fn of [ar, fx, futures, cauciones]) expect(fn).not.toHaveBeenCalled();
    for (const stop of stops) stop();
    stream.__testResetMarketStreamState();
  });

  it('el pulso de latencia avisa solo al drawer y 30 ciclos liberan las suscripciones', async () => {
    vi.useFakeTimers();
    const doc = new VisibilityDocument();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost' } });
    vi.stubGlobal('WebSocket', ReplaySocket);
    const removeListener = vi.spyOn(doc, 'removeEventListener');
    const bridge = await loadBridge();
    const lifecycle = (await import(/* @vite-ignore */ visibilitySpecifier)) as unknown as Visibility;
    const feeds = (await import(/* @vite-ignore */ feedsSpecifier)) as unknown as Feeds;
    const counts = { totalProviders: 1, configuredCount: 1, activeCount: 1 };
    const provider = { id: 'FMP_ENTERPRISE_REST', state: 'CONNECTED', configured: true };
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ asOfUtcSec: 100, summary: counts, providers: [provider] })));
    const release = feeds.acquireFeedsHealthConnection();
    const socket = ReplaySocket.instances[0];
    if (socket === undefined) throw new Error('Expected feeds socket');
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    const full = vi.fn();
    const connectivity = vi.fn();
    const badge = vi.fn();
    const stop = [
      feeds.subscribeFeedsHealth('full', full),
      feeds.subscribeFeedsHealth('connectivity', connectivity),
      feeds.subscribeFeedsHealth('badge', badge),
    ];
    socket.receive({ type: 'FEEDS_HEALTH_PULSE', asOfUtcSec: 101, summary: counts, providers: [provider] });
    socket.receive({ type: 'FEEDS_HEALTH_PULSE', asOfUtcSec: 102, summary: counts, providers: [{ ...provider, latencyMs: 2 }] });
    expect(full).toHaveBeenCalledTimes(2);
    expect(badge).toHaveBeenCalledTimes(1);
    expect(connectivity).not.toHaveBeenCalled();
    for (const off of stop) off();
    release();

    const unmounted = vi.fn();
    for (let cycle = 0; cycle < 30; cycle += 1) {
      const off = bridge.subscribeBridgeChannels(['macro', 'usSnapshot:SPY'], unmounted);
      const disconnect = feeds.acquireFeedsHealthConnection();
      const offFeed = feeds.subscribeFeedsHealth('full', unmounted);
      const offVisibility = lifecycle.subscribeDocumentVisibility(unmounted);
      offFeed();
      offVisibility();
      off();
      disconnect();
    }
    await vi.advanceTimersByTimeAsync(150);
    doc.change('hidden');
    expect(bridge.getBridgeListenerStats()).toMatchObject({ totalListeners: 0, totalChannels: 0 });
    expect(ReplaySocket.instances).toHaveLength(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
