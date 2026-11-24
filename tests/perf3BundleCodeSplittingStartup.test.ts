import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const reactRuntime = webRequire('react') as {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
};
const reactDomServer = webRequire('react-dom/server') as {
  renderToStaticMarkup(element: unknown): string;
};

type RoutedModuleId =
  | 'monitoreo'
  | 'acciones'
  | 'opciones'
  | 'macro'
  | 'eeuu'
  | 'bonos'
  | 'futuros'
  | 'relaciones'
  | 'ggal-specialist'
  | 'posiciones'
  | 'espacios'
  | 'alertas'
  | 'configuracion'
  | 'opciones:volatilidad'
  | 'opciones:mapa'
  | 'opciones:cadena'
  | 'overlay:order-ticket'
  | 'overlay:command-palette'
  | 'overlay:shortcuts'
  | 'overlay:feeds-health';

type PrefetchTrigger = 'intent' | 'idle';

interface PrefetchEnvironmentSnapshot {
  readonly online: boolean;
  readonly visible: boolean;
  readonly saveData: boolean;
  readonly effectiveType: string | null;
  readonly inFlightCount: number;
  readonly maxConcurrent: number;
  readonly alreadyLoadedOrLoading: boolean;
  readonly msSinceLastLongTask: number | null;
  readonly idleTimeRemainingMs: number | null;
}

interface ModuleRegistryApi {
  readonly MAX_CONCURRENT_PREFETCH: number;
  evaluatePrefetchDecision(trigger: PrefetchTrigger, env: PrefetchEnvironmentSnapshot): string;
  classifyChunkLoadFailure(input: {
    readonly errorMessage: string;
    readonly online: boolean;
    readonly failureCountForModule: number;
    readonly backendReachable: boolean;
  }): string;
  createRegisteredLazyModule<TProps extends object = Record<string, never>>(
    id: RoutedModuleId,
    importer: () => Promise<{ readonly default: (props: TProps) => unknown }>,
  ): {
    readonly id: RoutedModuleId;
    readonly Component: (props: TProps) => unknown;
    readonly preload: () => Promise<void>;
    readonly reset: () => void;
    readonly isLoaded: () => boolean;
  };
  prefetchModule(id: RoutedModuleId, trigger?: PrefetchTrigger): Promise<boolean>;
  createPrefetchHandlers(
    id: RoutedModuleId,
    hoverDelayMs?: number,
  ): {
    readonly onPointerEnter: () => void;
    readonly onPointerLeave: () => void;
    readonly onFocus: () => void;
  };
  resetModuleLoader(id: RoutedModuleId): void;
  getModuleRegistryStats(): {
    readonly loadedIds: readonly RoutedModuleId[];
    readonly inFlightCount: number;
    readonly totalLoadsStarted: Readonly<Record<string, number>>;
  };
}

interface ReferenceFixture {
  readonly prefetchCases: readonly {
    readonly trigger: PrefetchTrigger;
    readonly env: PrefetchEnvironmentSnapshot;
    readonly expected: string;
  }[];
  readonly chunkFailureCases: readonly {
    readonly input: {
      readonly errorMessage: string;
      readonly online: boolean;
      readonly failureCountForModule: number;
      readonly backendReachable: boolean;
    };
    readonly expected: string;
  }[];
}

class StubDocument extends EventTarget {
  public visibilityState: 'visible' | 'hidden' = 'visible';

  public setVisibility(next: 'visible' | 'hidden'): void {
    this.visibilityState = next;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(err: Error): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function collectStaticImportSpecifiers(relFilePath: string): {
  readonly valueImports: readonly string[];
  readonly typeOnlyImports: readonly string[];
  readonly dynamicImports: readonly string[];
  readonly exportedNames: readonly string[];
} {
  const absPath = path.resolve(REPO_ROOT, relFilePath);
  const source = readFileSync(absPath, 'utf8');
  const sf = ts.createSourceFile(
    absPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const valueImports: string[] = [];
  const typeOnlyImports: string[] = [];
  const dynamicImports: string[] = [];
  const exportedNames: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) {
        typeOnlyImports.push(spec);
      } else {
        valueImports.push(spec);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const firstArg = node.arguments[0];
      if (firstArg !== undefined && ts.isStringLiteral(firstArg)) {
        dynamicImports.push(firstArg.text);
      }
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        exportedNames.push(el.name.text);
      }
    } else if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
    ) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) exportedNames.push(decl.name.text);
      }
    } else if (
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true &&
      node.name !== undefined
    ) {
      exportedNames.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { valueImports, typeOnlyImports, dynamicImports, exportedNames };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Perf-3 · Code-Splitting, Arranque Inicial y Reconexión Worker', () => {
  it('Bloque 1: paridad 100 % de decisiones puras contra referencia Python independiente', async () => {
    const fixture = JSON.parse(
      readFileSync(path.resolve(REPO_ROOT, 'fixtures/perf3_bundle_startup_reference.json'), 'utf8'),
    ) as ReferenceFixture;
    const registrySpecifier = '../web/src/perf/moduleRegistry';
    const mod = (await import(/* @vite-ignore */ registrySpecifier)) as unknown as ModuleRegistryApi;

    expect(fixture.prefetchCases.length).toBeGreaterThan(1000);
    for (const c of fixture.prefetchCases) {
      expect(mod.evaluatePrefetchDecision(c.trigger, c.env)).toBe(c.expected);
    }
    expect(fixture.chunkFailureCases.length).toBeGreaterThanOrEqual(64);
    for (const c of fixture.chunkFailureCases) {
      expect(mod.classifyChunkLoadFailure(c.input)).toBe(c.expected);
    }
  });

  it('Bloque 2: fronteras dinámicas AST sin imports estáticos regresivos ni ciclos indirectos', () => {
    const appAst = collectStaticImportSpecifiers('web/src/App.tsx');
    for (const forbidden of [
      './components/StockDetailView',
      './components/OptionsModule',
      './components/ggal/GgalSpecialistModule',
      './components/MarketModules',
      './components/Overlays',
      './components/FeedsHealthDrawer',
    ]) {
      expect(appAst.valueImports).not.toContain(forbidden);
    }
    expect(appAst.valueImports).toContain('./components/HomeDashboard');
    expect(appAst.valueImports).toContain('./data/feedsHealthStore');
    expect(appAst.typeOnlyImports).toContain('./components/OptionsModule');
    expect(appAst.typeOnlyImports).toContain('./components/MarketModules');
    expect(appAst.typeOnlyImports).toContain('./components/Overlays');
    expect(appAst.dynamicImports).toContain('./components/StockDetailView');
    expect(appAst.dynamicImports).toContain('./components/OptionsModule');
    expect(appAst.dynamicImports).toContain('./components/ggal/GgalSpecialistModule');
    expect(appAst.dynamicImports).toContain('./components/MarketModules');
    expect(appAst.dynamicImports).toContain('./components/Overlays');

    const optionsAst = collectStaticImportSpecifiers('web/src/components/OptionsModule.tsx');
    for (const forbidden of [
      './options/VolatilitySuiteView',
      './options/map/InteractiveOptionPriceMap',
      './options/VirtualizedOptionChainTable',
      './MarketModules',
    ]) {
      expect(optionsAst.valueImports).not.toContain(forbidden);
    }
    expect(optionsAst.dynamicImports).toContain('./options/VolatilitySuiteView');
    expect(optionsAst.dynamicImports).toContain('./options/map/InteractiveOptionPriceMap');
    expect(optionsAst.dynamicImports).toContain('./options/VirtualizedOptionChainTable');

    const tickerAst = collectStaticImportSpecifiers('web/src/components/MarketTickerBar.tsx');
    expect(tickerAst.valueImports).not.toContain('./FeedsHealthDrawer');
    expect(tickerAst.valueImports).toContain('../data/feedsHealthStore');
    expect(tickerAst.dynamicImports).toContain('./FeedsHealthDrawer');

    const stockDetailAst = collectStaticImportSpecifiers('web/src/components/StockDetailView.tsx');
    expect(stockDetailAst.valueImports).not.toContain('./MarketModules');
    expect(stockDetailAst.valueImports).toContain('./common/LiveClockBadge');

    const ggalAst = collectStaticImportSpecifiers('web/src/components/ggal/GgalSpecialistModule.tsx');
    expect(ggalAst.valueImports).not.toContain('../MarketModules');
    expect(ggalAst.valueImports).toContain('../common/LiveClockBadge');

    const marketsAst = collectStaticImportSpecifiers('web/src/components/MarketModules.tsx');
    expect(marketsAst.exportedNames).not.toContain('HomeDashboard');
  });

  it('Bloque 3: deduplicación de loaders, MAX_CONCURRENT_PREFETCH = 1, debounce 60ms, bloqueo ambiental y reset', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const doc = new StubDocument();
    const navConn = { saveData: false, effectiveType: '4g', onLine: true };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { onLine: true, connection: navConn });

    const registrySpecifier = '../web/src/perf/moduleRegistry';
    const reg = (await import(/* @vite-ignore */ registrySpecifier)) as unknown as ModuleRegistryApi;

    expect(reg.MAX_CONCURRENT_PREFETCH).toBe(1);

    // 3a: Deduplicación + fast-path síncrono tras resolver
    const deferredOpt = createDeferred<{ readonly default: (props: { label: string }) => unknown }>();
    const optImporter = vi.fn(() => deferredOpt.promise);
    const LazyOpt = reg.createRegisteredLazyModule('opciones', optImporter);

    const p1 = reg.prefetchModule('opciones', 'intent');
    const p2 = reg.prefetchModule('opciones', 'intent');
    expect(optImporter).toHaveBeenCalledTimes(1);
    expect(reg.getModuleRegistryStats().inFlightCount).toBe(1);

    const DummyComp = (props: { label: string }) => props.label;
    deferredOpt.resolve({ default: DummyComp });
    await expect(Promise.all([p1, p2])).resolves.toEqual([true, true]);
    expect(LazyOpt.isLoaded()).toBe(true);
    expect(reg.getModuleRegistryStats().inFlightCount).toBe(0);
    // Render directo tras resolver no invoca React.lazy (devuelve ReactElement sin lanzar promesa)
    const renderedEl = LazyOpt.Component({ label: 'ok' }) as { type: unknown; props: { label: string } };
    expect(renderedEl.type).toBe(DummyComp);
    expect(renderedEl.props.label).toBe('ok');

    // 3b: Concurrencia máxima = 1 para 4 prefetches idle y bloqueo en hidden/saveData/2g
    const defs = [
      createDeferred<{ readonly default: (props: Record<string, never>) => unknown }>(),
      createDeferred<{ readonly default: (props: Record<string, never>) => unknown }>(),
      createDeferred<{ readonly default: (props: Record<string, never>) => unknown }>(),
      createDeferred<{ readonly default: (props: Record<string, never>) => unknown }>(),
    ];
    let peakInFlight = 0;
    const ids = ['monitoreo', 'acciones', 'macro', 'bonos'] as const;
    ids.forEach((id, idx) => {
      reg.createRegisteredLazyModule(id, () => {
        peakInFlight = Math.max(peakInFlight, reg.getModuleRegistryStats().inFlightCount);
        const def = defs[idx];
        if (def === undefined) throw new Error('missing deferred');
        return def.promise;
      });
    });

    const idlePromises = ids.map((id) => reg.prefetchModule(id, 'idle'));
    expect(reg.getModuleRegistryStats().inFlightCount).toBe(1);
    expect(peakInFlight).toBe(1);

    for (let i = 0; i < defs.length; i += 1) {
      defs[i]?.resolve({ default: () => null });
      await vi.advanceTimersByTimeAsync(0);
    }
    await expect(Promise.all(idlePromises)).resolves.toEqual([true, true, true, true]);
    expect(peakInFlight).toBe(1);

    // Bloqueo en hidden / saveData / 2g
    const blockedImp = vi.fn(() => Promise.resolve({ default: () => null }));
    reg.createRegisteredLazyModule('futuros', blockedImp);
    doc.setVisibility('hidden');
    await expect(reg.prefetchModule('futuros', 'idle')).resolves.toBe(false);
    doc.setVisibility('visible');
    navConn.saveData = true;
    await expect(reg.prefetchModule('futuros', 'idle')).resolves.toBe(false);
    navConn.saveData = false;
    navConn.effectiveType = '2g';
    await expect(reg.prefetchModule('futuros', 'idle')).resolves.toBe(false);
    expect(blockedImp).not.toHaveBeenCalled();

    // 3c: Debounce hover 60 ms cancelable en pointerLeave + focus inmediato 0 ms
    navConn.effectiveType = '4g';
    const ggalImp = vi.fn(() => Promise.resolve({ default: () => null }));
    reg.createRegisteredLazyModule('ggal-specialist', ggalImp);
    const handlers = reg.createPrefetchHandlers('ggal-specialist', 60);
    handlers.onPointerEnter();
    await vi.advanceTimersByTimeAsync(59);
    handlers.onPointerLeave();
    await vi.advanceTimersByTimeAsync(20);
    expect(ggalImp).not.toHaveBeenCalled();
    handlers.onPointerEnter();
    await vi.advanceTimersByTimeAsync(60);
    expect(ggalImp).toHaveBeenCalledTimes(1);

    const eeuuImp = vi.fn(() => Promise.resolve({ default: () => null }));
    reg.createRegisteredLazyModule('eeuu', eeuuImp);
    reg.createPrefetchHandlers('eeuu', 60).onFocus();
    await vi.advanceTimersByTimeAsync(0);
    expect(eeuuImp).toHaveBeenCalledTimes(1);

    // 3d: Recuperación limpia tras error en prefetch + resetModuleLoader
    let failNext = true;
    const flakyImp = vi.fn(() => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('Failed to fetch dynamically imported module'));
      }
      return Promise.resolve({ default: DummyComp });
    });
    const lazyRel = reg.createRegisteredLazyModule('relaciones', flakyImp);
    await expect(reg.prefetchModule('relaciones', 'intent')).resolves.toBe(false);
    expect(lazyRel.isLoaded()).toBe(false);
    reg.resetModuleLoader('relaciones');
    await expect(reg.prefetchModule('relaciones', 'intent')).resolves.toBe(true);
    expect(flakyImp).toHaveBeenCalledTimes(2);
    expect(lazyRel.isLoaded()).toBe(true);
  });

  it('Bloque 4: cero efectos secundarios financieros al importar módulos diferidos e identidad singleton única', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const doc = new StubDocument();
    const winListeners: string[] = [];
    const docListeners: string[] = [];
    const origDocAdd = doc.addEventListener.bind(doc);
    doc.addEventListener = (...args: Parameters<EventTarget['addEventListener']>) => {
      docListeners.push(args[0]);
      origDocAdd(...args);
    };
    const fetchSpy = vi.fn(() => Promise.reject(new Error('unexpected network during import')));
    const wsSpy = vi.fn();
    const workerSpy = vi.fn();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: '127.0.0.1:4173' },
      addEventListener: (type: string) => { winListeners.push(type); },
      removeEventListener: () => undefined,
    });
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', wsSpy);
    vi.stubGlobal('Worker', workerSpy);

    const bridgeSpec: string = '../web/src/data/liveRuntimeBridge.js';
    const streamSpec: string = '../web/src/api/useMarketLiveStream.js';
    const feedsStoreSpec: string = '../web/src/data/feedsHealthStore.js';
    const bridge = (await import(/* @vite-ignore */ bridgeSpec)) as {
      getBridgeListenerStats(): { totalListeners: number };
    };
    await import(/* @vite-ignore */ streamSpec);
    const feedsFromStore = (await import(/* @vite-ignore */ feedsStoreSpec)) as {
      acquireFeedsHealthConnection: unknown;
      subscribeFeedsHealth: unknown;
    };

    const baselineListeners = bridge.getBridgeListenerStats().totalListeners;
    const baselineDocListenerCount = docListeners.length;
    const baselineWinListenerCount = winListeners.length;
    const baselineTimerCount = vi.getTimerCount();

    const feedsDrawerSpec: string = '../web/src/components/FeedsHealthDrawer.tsx';
    const deferredSpecs: readonly string[] = [
      '../web/src/components/MarketModules.tsx',
      '../web/src/components/StockDetailView.tsx',
      '../web/src/components/OptionsModule.tsx',
      '../web/src/components/options/VolatilitySuiteView.tsx',
      '../web/src/components/options/map/InteractiveOptionPriceMap.tsx',
      '../web/src/components/options/VirtualizedOptionChainTable.tsx',
      '../web/src/components/ggal/GgalSpecialistModule.tsx',
      '../web/src/components/Overlays.tsx',
    ];
    const feedsFromDrawer = (await import(/* @vite-ignore */ feedsDrawerSpec)) as {
      acquireFeedsHealthConnection: unknown;
      subscribeFeedsHealth: unknown;
    };
    await Promise.all(deferredSpecs.map((spec) => import(/* @vite-ignore */ spec)));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(wsSpy).not.toHaveBeenCalled();
    expect(workerSpy).not.toHaveBeenCalled();
    expect(bridge.getBridgeListenerStats().totalListeners).toBe(baselineListeners);
    expect(docListeners.length).toBe(baselineDocListenerCount);
    expect(winListeners.length).toBe(baselineWinListenerCount);
    expect(vi.getTimerCount()).toBe(baselineTimerCount);

    expect(Object.is(feedsFromStore.acquireFeedsHealthConnection, feedsFromDrawer.acquireFeedsHealthConnection)).toBe(true);
    expect(Object.is(feedsFromStore.subscribeFeedsHealth, feedsFromDrawer.subscribeFeedsHealth)).toBe(true);
  });

  it('Bloque 5: geometría reservada e higiene CSS en ModuleViewFallback y recuperación/guard 60s en ModuleLoadErrorBoundary', async () => {
    const fallbackSrc = readFileSync(path.resolve(REPO_ROOT, 'web/src/components/common/ModuleViewFallback.tsx'), 'utf8');
    const boundarySrc = readFileSync(path.resolve(REPO_ROOT, 'web/src/components/common/ModuleLoadErrorBoundary.tsx'), 'utf8');
    expect(fallbackSrc).not.toMatch(/backdrop-blur-|animate-pulse|animate-ping/);
    expect(boundarySrc).not.toMatch(/backdrop-blur-|animate-pulse|animate-ping/);

    const fallbackSpec: string = '../web/src/components/common/ModuleViewFallback.tsx';
    const fallbackMod = (await import(/* @vite-ignore */ fallbackSpec)) as {
      ModuleViewFallback: unknown;
    };
    for (const variant of ['chart-deck', 'options-suite', 'dual-chart', 'table-grid', 'options-subview'] as const) {
      const html = reactDomServer.renderToStaticMarkup(
        reactRuntime.createElement(fallbackMod.ModuleViewFallback, { moduleId: `test-${variant}`, variant }),
      );
      expect(html).toContain(`data-qot-module-fallback="test-${variant}"`);
      expect(html).toContain('tabular-nums');
      expect(html).toMatch(/min-h-\[(?:180|540|560|620)px\]/);
      expect(html).not.toMatch(/backdrop-blur-|animate-pulse|animate-ping/);
    }

    const boundarySpec: string = '../web/src/components/common/ModuleLoadErrorBoundary.tsx';
    const boundaryMod = (await import(/* @vite-ignore */ boundarySpec)) as {
      ModuleLoadErrorBoundary: {
        new (props: Record<string, unknown>): { state: Record<string, unknown>; render(): unknown };
        getDerivedStateFromError(err: Error): Record<string, unknown>;
        getDerivedStateFromProps(props: Record<string, unknown>, state: Record<string, unknown>): Record<string, unknown> | null;
      };
      canTriggerStaleChunkReload(
        storage: { getItem(k: string): string | null; setItem(k: string, v: string): void },
        chunkKey: string,
        nowMs: number,
      ): boolean;
    };

    const errState = boundaryMod.ModuleLoadErrorBoundary.getDerivedStateFromError(
      new Error('Failed to fetch dynamically imported module'),
    );
    expect(errState['error']).toBeInstanceOf(Error);
    const resetPatch = boundaryMod.ModuleLoadErrorBoundary.getDerivedStateFromProps(
      { moduleId: 'opciones', resetKey: 'opciones', variant: 'options-suite' },
      { ...errState, prevResetKey: 'ggal-specialist' },
    );
    expect(resetPatch).not.toBeNull();
    expect(resetPatch?.['error']).toBeNull();

    const instance = new boundaryMod.ModuleLoadErrorBoundary({
      moduleId: 'ggal-specialist',
      resetKey: 'ggal-specialist',
      variant: 'dual-chart',
      children: 'ok',
    });
    instance.state = {
      error: new Error('Failed to fetch dynamically imported module: mod-ggal.js'),
      prevResetKey: 'ggal-specialist',
      failureKind: 'STALE_DEPLOYMENT_CHUNK',
      reloadBlockedByGuard: false,
    };
    const errorHtml = reactDomServer.renderToStaticMarkup(instance.render());
    expect(errorHtml).toContain('data-qot-module-error="ggal-specialist"');
    expect(errorHtml).toContain('data-qot-retry-module="ggal-specialist"');
    expect(errorHtml).toContain('data-qot-reload-terminal="ggal-specialist"');

    const memStore = new Map<string, string>();
    const storageStub = {
      getItem: (k: string) => memStore.get(k) ?? null,
      setItem: (k: string, v: string) => { memStore.set(k, v); },
    };
    expect(boundaryMod.canTriggerStaleChunkReload(storageStub, 'ggal-specialist', 100_000)).toBe(true);
    expect(boundaryMod.canTriggerStaleChunkReload(storageStub, 'ggal-specialist', 159_999)).toBe(false);
    expect(boundaryMod.canTriggerStaleChunkReload(storageStub, 'ggal-specialist', 160_000)).toBe(true);
  });

  it('Bloque 6: artefactos reales en web/dist/.vite/manifest.json cumplen presupuestos, DAG sin ciclos, Worker aislado y limpieza Bloque III', () => {
    const distDir = path.resolve(REPO_ROOT, 'web/dist');
    const htmlPath = path.resolve(distDir, 'index.html');
    const manifestPath = path.resolve(distDir, '.vite/manifest.json');
    expect(existsSync(htmlPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);

    const html = readFileSync(htmlPath, 'utf8');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
      string,
      {
        readonly file: string;
        readonly name?: string;
        readonly isEntry?: boolean;
        readonly imports?: readonly string[];
        readonly dynamicImports?: readonly string[];
      }
    >;

    const assetsDir = path.resolve(distDir, 'assets');
    const jsAssets = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    expect(jsAssets.length).toBeGreaterThanOrEqual(15);
    for (const fileName of jsAssets) {
      const size = readFileSync(path.resolve(assetsDir, fileName)).length;
      expect(size).toBeLessThan(500_000);
    }

    const entryRecord = manifest['index.html'];
    expect(entryRecord?.isEntry).toBe(true);
    if (!entryRecord) throw new Error('Missing index.html entry in manifest.json');

    const entryRawBytes = readFileSync(path.resolve(distDir, entryRecord.file)).length;
    expect(entryRawBytes).toBeLessThanOrEqual(120_000);

    // Clausura estática desde index.html excluyendo dynamicImports
    const visited = new Set<string>();
    const queue: string[] = ['index.html'];
    const staticFiles: string[] = [];
    while (queue.length > 0) {
      const key = queue.shift();
      if (key === undefined || visited.has(key)) continue;
      visited.add(key);
      const rec = manifest[key];
      if (!rec) continue;
      staticFiles.push(rec.file);
      for (const imp of rec.imports ?? []) {
        if (!visited.has(imp)) queue.push(imp);
      }
    }

    const initialRawBytes = staticFiles.reduce(
      (acc, rel) => acc + readFileSync(path.resolve(distDir, rel)).length,
      0,
    );
    const initialGzip6Bytes = staticFiles.reduce(
      (acc, rel) => acc + gzipSync(readFileSync(path.resolve(distDir, rel)), { level: 6 }).length,
      0,
    );
    expect(initialRawBytes).toBeLessThanOrEqual(580_000);
    expect(initialGzip6Bytes).toBeLessThanOrEqual(195_000);

    const staticJoined = staticFiles.join('\n') + '\n' + html;
    for (const deferredPrefix of [
      'vendor-charts',
      'vendor-motion',
      'vendor-virtual',
      'core-options-quant',
      'mod-stock-detail',
      'mod-options',
      'mod-volatility',
      'mod-options-map',
      'mod-options-chain',
      'mod-ggal',
      'mod-markets',
      'mod-overlays',
    ]) {
      expect(staticJoined).not.toContain(deferredPrefix);
    }
    expect((entryRecord.dynamicImports ?? []).length).toBeGreaterThanOrEqual(5);

    // Aciclicidad estricta DAG en manifest.json
    const visiting = new Set<string>();
    const done = new Set<string>();
    const assertAcyclic = (key: string): void => {
      visiting.add(key);
      for (const dep of manifest[key]?.imports ?? []) {
        expect(visiting.has(dep)).toBe(false);
        if (!done.has(dep)) assertAcyclic(dep);
      }
      visiting.delete(key);
      done.add(key);
    };
    for (const k of Object.keys(manifest)) {
      if (!done.has(k)) assertAcyclic(k);
    }

    // Worker independiente intacto (20–26 kB) sin React ni DOM
    const workerAsset = jsAssets.find((f) => f.startsWith('marketFeed.worker-'));
    expect(workerAsset).toBeDefined();
    if (!workerAsset) throw new Error('Missing marketFeed.worker chunk');
    const workerBuf = readFileSync(path.resolve(assetsDir, workerAsset), 'utf8');
    expect(workerBuf.length).toBeGreaterThanOrEqual(20_000);
    expect(workerBuf.length).toBeLessThanOrEqual(26_000);
    expect(workerBuf).not.toContain('__reactFiber$');
    expect(workerBuf).not.toContain('document.createElement');

    // Bloque III: 4 archivos huérfanos y @luxalgo/vela ausentes; chunkSizeWarningLimit intacto
    for (const deadPath of [
      'web/src/components/stock-detail/MainPriceAmtChart.tsx',
      'web/src/components/options/VolatilitySurface.tsx',
      'web/src/components/stock-detail/StockDetailHeader.tsx',
      'web/src/hooks/useMarketLiveStream.ts',
    ]) {
      expect(existsSync(path.resolve(REPO_ROOT, deadPath))).toBe(false);
    }
    expect(existsSync(path.resolve(REPO_ROOT, 'web/src/api/useMarketLiveStream.ts'))).toBe(true);
    const webPkg = readFileSync(path.resolve(REPO_ROOT, 'web/package.json'), 'utf8');
    const webLock = readFileSync(path.resolve(REPO_ROOT, 'web/package-lock.json'), 'utf8');
    expect(webPkg).not.toContain('@luxalgo/vela');
    expect(webLock).not.toContain('@luxalgo/vela');
    const viteCfg = readFileSync(path.resolve(REPO_ROOT, 'web/vite.config.ts'), 'utf8');
    expect(viteCfg).not.toContain('chunkSizeWarningLimit');
  });

  it('Bloque 7: ciclo determinista de reconexión del Worker (open timeout 2.000 ms, reconnect 1.500 ms, scope actualizado y RESYNC_WS)', async () => {
    vi.resetModules();
    vi.useFakeTimers();

    class MockWorkerWebSocket extends EventTarget {
      public static readonly CONNECTING = 0;
      public static readonly OPEN = 1;
      public static readonly CLOSING = 2;
      public static readonly CLOSED = 3;
      public static readonly instances: MockWorkerWebSocket[] = [];

      public readyState = 0;
      public readonly sentFrames: Record<string, unknown>[] = [];
      public readonly closedCodes: number[] = [];

      public constructor(public readonly url: string) {
        super();
        MockWorkerWebSocket.instances.push(this);
      }

      public send(raw: string): void {
        this.sentFrames.push(JSON.parse(raw) as Record<string, unknown>);
      }

      public close(code = 1000): void {
        this.readyState = 3;
        this.closedCodes.push(code);
        this.dispatchEvent(new Event('close'));
      }

      public triggerOpen(): void {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }

      public triggerMessage(payload: Record<string, unknown>): void {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
      }

      public triggerDrop(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
      }
    }

    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal('WebSocket', MockWorkerWebSocket);
    vi.stubGlobal('postMessage', (msg: Record<string, unknown>) => {
      posted.push(msg);
    });
    vi.stubGlobal('onmessage', null);

    const workerSpecifier = '../web/src/workers/marketFeed.worker.ts';
    await import(/* @vite-ignore */ workerSpecifier);
    const dispatchToWorker = (data: Record<string, unknown>): void => {
      const handler = (globalThis as unknown as { onmessage: ((ev: { data: Record<string, unknown> }) => void) | null }).onmessage;
      if (!handler) throw new Error('Worker onmessage not registered');
      handler({ data });
    };

    try {
      // Caso A: timeout de apertura 2.000 ms -> open -> subscribe/focus/set_view_scope -> primer lote -> 1x WS_STOP_POLL
      dispatchToWorker({
        type: 'SET_VIEW_SCOPE',
        view: 'options',
        focusSymbol: 'SPY',
        focusMarket: 'US',
        optionScopeEpoch: 1,
      });
      dispatchToWorker({ type: 'CONNECT', url: 'ws://127.0.0.1:8787/ws' });

      expect(MockWorkerWebSocket.instances).toHaveLength(1);
      expect(posted[0]).toEqual({ type: 'WS_STATUS', status: 'CONNECTING', transport: 'WS', isLive: false });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(posted.filter((m) => m['type'] === 'WS_FALLBACK_POLL')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(posted.filter((m) => m['type'] === 'WS_FALLBACK_POLL')).toHaveLength(1);

      const ws0 = MockWorkerWebSocket.instances[0];
      if (!ws0) throw new Error('Missing ws0');
      ws0.triggerOpen();
      expect(ws0.sentFrames).toEqual([
        { action: 'subscribe', symbols: ['*'] },
        { action: 'focus', symbol: '' },
        { type: 'set_view_scope', view: 'options', focusSymbol: 'SPY', focusMarket: 'US' },
      ]);
      expect(posted.at(-1)).toEqual({ type: 'WS_STATUS', status: 'LIVE', transport: 'WS', isLive: true });

      ws0.triggerMessage({ type: 'MARKET_TICK_BATCH', serverTimeSec: 1_790_000_001, quotes: [] });
      ws0.triggerMessage({ type: 'MARKET_TICK_BATCH', serverTimeSec: 1_790_000_002, quotes: [] });
      expect(posted.filter((m) => m['type'] === 'WS_STOP_POLL')).toHaveLength(1);

      // Caso B: caída abrupta 1006 + cambio de vista durante desconexión + reconexión exacta a 1.500 ms
      posted.length = 0;
      ws0.triggerDrop();
      expect(posted).toEqual([
        { type: 'WS_STATUS', status: 'RECONNECTING', transport: 'WS', isLive: false },
        { type: 'WS_FALLBACK_POLL' },
      ]);
      expect(MockWorkerWebSocket.instances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(400);
      expect(() => {
        dispatchToWorker({
          type: 'SET_VIEW_SCOPE',
          view: 'ggal_specialist',
          focusSymbol: 'GGAL',
          focusMarket: 'AR',
          ggalMode: 'ADR',
          ggalTimeframe: '5m',
          optionScopeEpoch: 2,
        });
      }).not.toThrow();

      await vi.advanceTimersByTimeAsync(1_099);
      expect(MockWorkerWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWorkerWebSocket.instances).toHaveLength(2);

      const ws1 = MockWorkerWebSocket.instances[1];
      if (!ws1) throw new Error('Missing ws1');
      ws1.triggerOpen();
      expect(ws1.sentFrames).toEqual([
        { action: 'subscribe', symbols: ['*'] },
        { action: 'focus', symbol: '' },
        {
          type: 'set_view_scope',
          view: 'ggal_specialist',
          focusSymbol: 'GGAL',
          focusMarket: 'AR',
          ggalMode: 'ADR',
          ggalTimeframe: '5m',
        },
      ]);
      expect(posted.filter((m) => m['type'] === 'WS_STOP_POLL')).toHaveLength(0);

      ws1.triggerMessage({ type: 'MARKET_TICK_BATCH', serverTimeSec: 1_790_000_003, quotes: [] });
      expect(posted.filter((m) => m['type'] === 'WS_STOP_POLL')).toHaveLength(1);

      // Caso C: RESYNC_WS cierra con 4000 y reconecta inmediatamente preservando scope vigente
      dispatchToWorker({ type: 'RESYNC_WS', reason: 'delta_resync_required' });
      expect(ws1.closedCodes).toContain(4000);
      expect(MockWorkerWebSocket.instances).toHaveLength(3);
      const ws2 = MockWorkerWebSocket.instances[2];
      if (!ws2) throw new Error('Missing ws2');
      ws2.triggerOpen();
      expect(ws2.sentFrames.at(-1)).toEqual({
        type: 'set_view_scope',
        view: 'ggal_specialist',
        focusSymbol: 'GGAL',
        focusMarket: 'AR',
        ggalMode: 'ADR',
        ggalTimeframe: '5m',
      });
    } finally {
      dispatchToWorker({ type: 'DISCONNECT' });
    }
  });
});
