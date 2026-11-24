import React from 'react';
import { isDocumentVisible } from '../data/visibilityLifecycle';

export type RoutedModuleId =
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

export type PrefetchTrigger = 'intent' | 'idle';

export interface PrefetchEnvironmentSnapshot {
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

export type PrefetchDecision =
  | 'ALLOW'
  | 'SKIP_ALREADY_READY'
  | 'DEFER_CONCURRENCY'
  | 'DEFER_MAIN_THREAD_BUSY'
  | 'BLOCK_ENVIRONMENT';

export type ChunkFailureKind = 'TRANSIENT_NETWORK' | 'STALE_DEPLOYMENT_CHUNK';

export interface RegisteredLazyModule<TProps extends object> {
  readonly id: RoutedModuleId;
  readonly Component: React.FC<TProps>;
  readonly preload: () => Promise<void>;
  readonly reset: () => void;
  readonly isLoaded: () => boolean;
}

interface NetworkInformationLike {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

interface NavigatorWithConnection {
  readonly onLine?: boolean;
  readonly connection?: NetworkInformationLike;
  readonly mozConnection?: NetworkInformationLike;
  readonly webkitConnection?: NetworkInformationLike;
}

interface ErasedModuleRecord {
  readonly id: RoutedModuleId;
  readonly getLoaded: () => boolean;
  readonly getInFlight: () => Promise<unknown> | null;
  readonly startErasedLoad: () => Promise<unknown>;
  readonly reset: () => void;
  failureCount: number;
  loadsStarted: number;
}

interface QueuedPrefetch {
  readonly id: RoutedModuleId;
  trigger: PrefetchTrigger;
  readonly resolvers: ((ok: boolean) => void)[];
}

export const MAX_CONCURRENT_PREFETCH = 1;
export const DEFAULT_IDLE_WARMUP_MODULES: readonly RoutedModuleId[] = ['monitoreo', 'acciones'];

const CONSTRAINED_EFFECTIVE_TYPES = new Set(['slow-2g', '2g']);
const STALE_CHUNK_PATTERNS = [
  'failed to fetch dynamically imported module',
  'importing a module script failed',
  'error loading dynamically imported module',
  'mime type',
  'chunkloaderror',
] as const;

const moduleRecords = new Map<RoutedModuleId, ErasedModuleRecord>();
const activeLoadIds = new Set<RoutedModuleId>();
const prefetchQueue: QueuedPrefetch[] = [];
let idleBusyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let lastLongTaskTimestampMs: number | null = null;
let longTaskObserverInstalled = false;
let preloadGuardInstalled = false;

/**
 * Función pura de autorización de prefetch para evitar tormentas de red
 * y degradación del hilo principal. Valida invariantes contra el oráculo Python.
 */
export function evaluatePrefetchDecision(
  trigger: PrefetchTrigger,
  env: PrefetchEnvironmentSnapshot,
): PrefetchDecision {
  if (env.alreadyLoadedOrLoading) {
    return 'SKIP_ALREADY_READY';
  }
  if (!env.online || !env.visible) {
    return 'BLOCK_ENVIRONMENT';
  }

  const normalizedEff =
    typeof env.effectiveType === 'string' ? env.effectiveType.trim().toLowerCase() : '';
  const constrainedNetwork = CONSTRAINED_EFFECTIVE_TYPES.has(normalizedEff);

  if (trigger === 'idle') {
    if (constrainedNetwork || env.saveData) {
      return 'BLOCK_ENVIRONMENT';
    }
    if (
      (env.msSinceLastLongTask !== null && env.msSinceLastLongTask < 1_000) ||
      (env.idleTimeRemainingMs !== null && env.idleTimeRemainingMs < 15)
    ) {
      return 'DEFER_MAIN_THREAD_BUSY';
    }
  } else if (constrainedNetwork && env.saveData) {
    return 'BLOCK_ENVIRONMENT';
  }

  if (env.inFlightCount >= env.maxConcurrent) {
    return 'DEFER_CONCURRENCY';
  }

  return 'ALLOW';
}

/**
 * Clasificación pura del error de descarga de un chunk dinámico: distingue
 * fallos transitorios de red de artefactos obsoletos tras un despliegue.
 */
export function classifyChunkLoadFailure(input: {
  readonly errorMessage: string;
  readonly online: boolean;
  readonly failureCountForModule: number;
  readonly backendReachable: boolean;
}): ChunkFailureKind {
  if (!input.online || !input.backendReachable) {
    return 'TRANSIENT_NETWORK';
  }
  const normalizedMessage = input.errorMessage.toLowerCase();
  const hasStaleSignature = STALE_CHUNK_PATTERNS.some((pattern) =>
    normalizedMessage.includes(pattern),
  );
  if (hasStaleSignature && input.failureCountForModule >= 2) {
    return 'STALE_DEPLOYMENT_CHUNK';
  }
  return 'TRANSIENT_NETWORK';
}

function nowMonotonicMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function readEnvironmentSnapshot(
  record: ErasedModuleRecord,
  idleTimeRemainingMs: number | null,
): PrefetchEnvironmentSnapshot {
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as NavigatorWithConnection)
      : undefined;
  const conn = nav?.connection ?? nav?.mozConnection ?? nav?.webkitConnection;
  const msSinceLastLongTask =
    lastLongTaskTimestampMs === null ? null : Math.max(0, nowMonotonicMs() - lastLongTaskTimestampMs);
  return {
    online: nav?.onLine !== false,
    visible: isDocumentVisible(),
    saveData: conn?.saveData === true,
    effectiveType: typeof conn?.effectiveType === 'string' ? conn.effectiveType : null,
    inFlightCount: activeLoadIds.size,
    maxConcurrent: MAX_CONCURRENT_PREFETCH,
    alreadyLoadedOrLoading: record.getLoaded() || record.getInFlight() !== null,
    msSinceLastLongTask,
    idleTimeRemainingMs,
  };
}

function scheduleDrainAfterBusy(): void {
  if (idleBusyRetryTimer !== null || prefetchQueue.length === 0) return;
  idleBusyRetryTimer = setTimeout(() => {
    idleBusyRetryTimer = null;
    drainPrefetchQueue();
  }, 1_000);
}

function drainPrefetchQueue(): void {
  while (prefetchQueue.length > 0) {
    const head = prefetchQueue[0];
    if (head === undefined) break;
    const record = moduleRecords.get(head.id);
    if (record === undefined) {
      prefetchQueue.shift();
      head.resolvers.forEach((resolve) => resolve(false));
      continue;
    }

    const decision = evaluatePrefetchDecision(
      head.trigger,
      readEnvironmentSnapshot(record, null),
    );
    if (decision === 'SKIP_ALREADY_READY') {
      prefetchQueue.shift();
      const inFlight = record.getInFlight();
      if (record.getLoaded()) {
        head.resolvers.forEach((resolve) => resolve(true));
      } else if (inFlight !== null) {
        void inFlight.then(
          () => head.resolvers.forEach((resolve) => resolve(true)),
          () => head.resolvers.forEach((resolve) => resolve(false)),
        );
      } else {
        head.resolvers.forEach((resolve) => resolve(false));
      }
      continue;
    }
    if (decision === 'BLOCK_ENVIRONMENT') {
      prefetchQueue.shift();
      head.resolvers.forEach((resolve) => resolve(false));
      continue;
    }
    if (decision === 'DEFER_CONCURRENCY') {
      return;
    }
    if (decision === 'DEFER_MAIN_THREAD_BUSY') {
      scheduleDrainAfterBusy();
      return;
    }

    prefetchQueue.shift();
    void record.startErasedLoad().then(
      () => head.resolvers.forEach((resolve) => resolve(true)),
      () => head.resolvers.forEach((resolve) => resolve(false)),
    );
    return;
  }
}

/**
 * Registra un componente diferido con promesa única deduplicada y cortocircuito
 * de render síncrono cuando ya fue precargado.
 */
export function createRegisteredLazyModule<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TComponent extends React.ComponentType<any>,
>(
  id: RoutedModuleId,
  importer: () => Promise<{ readonly default: TComponent }>,
): RegisteredLazyModule<
  React.ComponentProps<TComponent> extends object
    ? React.ComponentProps<TComponent>
    : Record<string, never>
>;
export function createRegisteredLazyModule<TProps extends object>(
  id: RoutedModuleId,
  importer: () => Promise<{ readonly default: React.ComponentType<TProps> }>,
): RegisteredLazyModule<TProps>;
export function createRegisteredLazyModule<TProps extends object>(
  id: RoutedModuleId,
  importer: () => Promise<{ readonly default: React.ComponentType<TProps> }>,
): RegisteredLazyModule<TProps> {
  const existing = moduleRecords.get(id);
  const previousLoadsStarted = existing?.loadsStarted ?? 0;

  let inFlightPromise: Promise<{ default: React.ComponentType<TProps> }> | null = null;
  let resolvedComponent: React.ComponentType<TProps> | null = null;

  const startTypedLoad = (): Promise<{ default: React.ComponentType<TProps> }> => {
    if (resolvedComponent !== null) {
      return Promise.resolve({ default: resolvedComponent });
    }
    if (inFlightPromise !== null) {
      return inFlightPromise;
    }
    record.loadsStarted += 1;
    activeLoadIds.add(id);
    const promise = importer()
      .then((mod) => {
        const resolved = mod.default;
        resolvedComponent = resolved;
        inFlightPromise = null;
        record.failureCount = 0;
        activeLoadIds.delete(id);
        drainPrefetchQueue();
        return { default: resolved };
      })
      .catch((err: unknown) => {
        inFlightPromise = null;
        record.failureCount += 1;
        activeLoadIds.delete(id);
        drainPrefetchQueue();
        throw err;
      });
    inFlightPromise = promise;
    return promise;
  };

  let lazyComponent = React.lazy(
    startTypedLoad as () => Promise<{ default: React.ComponentType<unknown> }>,
  ) as unknown as React.LazyExoticComponent<React.ComponentType<TProps>>;

  const record: ErasedModuleRecord = {
    id,
    getLoaded: () => resolvedComponent !== null,
    getInFlight: () => inFlightPromise,
    startErasedLoad: startTypedLoad,
    reset: () => {
      resolvedComponent = null;
      inFlightPromise = null;
      activeLoadIds.delete(id);
      lazyComponent = React.lazy(
        startTypedLoad as () => Promise<{ default: React.ComponentType<unknown> }>,
      ) as unknown as React.LazyExoticComponent<React.ComponentType<TProps>>;
    },
    failureCount: 0,
    loadsStarted: previousLoadsStarted,
  };
  moduleRecords.set(id, record);

  const RegisteredComponent: React.FC<TProps> = (props) => {
    if (resolvedComponent !== null) {
      return React.createElement(resolvedComponent, props);
    }
    return React.createElement(lazyComponent, props);
  };
  RegisteredComponent.displayName = `RegisteredLazy(${id})`;

  return {
    id,
    Component: RegisteredComponent,
    preload: () => prefetchModule(id, 'intent').then(() => undefined),
    reset: record.reset,
    isLoaded: () => resolvedComponent !== null,
  };
}

function enqueuePrefetch(
  id: RoutedModuleId,
  trigger: PrefetchTrigger,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const existing = prefetchQueue.find((item) => item.id === id);
    if (existing !== undefined) {
      if (trigger === 'intent' && existing.trigger === 'idle') {
        existing.trigger = 'intent';
        const idx = prefetchQueue.indexOf(existing);
        if (idx > 0) {
          prefetchQueue.splice(idx, 1);
          const firstIdleIdx = prefetchQueue.findIndex((item) => item.trigger === 'idle');
          if (firstIdleIdx === -1) prefetchQueue.push(existing);
          else prefetchQueue.splice(firstIdleIdx, 0, existing);
        }
      }
      existing.resolvers.push(resolve);
      return;
    }

    const entry: QueuedPrefetch = { id, trigger, resolvers: [resolve] };
    if (trigger === 'intent') {
      const firstIdleIdx = prefetchQueue.findIndex((item) => item.trigger === 'idle');
      if (firstIdleIdx === -1) prefetchQueue.push(entry);
      else prefetchQueue.splice(firstIdleIdx, 0, entry);
    } else {
      prefetchQueue.push(entry);
    }
    scheduleDrainAfterBusy();
  });
}

function runPrefetchWithBudget(
  id: RoutedModuleId,
  trigger: PrefetchTrigger,
  idleTimeRemainingMs: number | null,
): Promise<boolean> {
  const record = moduleRecords.get(id);
  if (record === undefined) {
    return Promise.resolve(false);
  }
  const decision = evaluatePrefetchDecision(
    trigger,
    readEnvironmentSnapshot(record, idleTimeRemainingMs),
  );
  if (decision === 'SKIP_ALREADY_READY') {
    const inFlight = record.getInFlight();
    if (record.getLoaded()) return Promise.resolve(true);
    if (inFlight !== null) {
      return inFlight.then(() => true, () => false);
    }
    return Promise.resolve(false);
  }
  if (decision === 'BLOCK_ENVIRONMENT') {
    return Promise.resolve(false);
  }
  if (decision === 'DEFER_CONCURRENCY' || decision === 'DEFER_MAIN_THREAD_BUSY') {
    return enqueuePrefetch(id, trigger);
  }
  return record.startErasedLoad().then(() => true, () => false);
}

/**
 * Prefetch deduplicado y nunca bloqueante: nunca deja rechazos sin capturar.
 */
export function prefetchModule(
  id: RoutedModuleId,
  trigger: PrefetchTrigger = 'intent',
): Promise<boolean> {
  return runPrefetchWithBudget(id, trigger, null);
}

/**
 * Manejadores accesibles de intención: `onPointerEnter` con debounce de 60 ms
 * cancelable al salir el cursor y `onFocus` inmediato (0 ms).
 */
export function createPrefetchHandlers(
  id: RoutedModuleId,
  hoverDelayMs = 60,
): {
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onFocus: () => void;
} {
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelHover = (): void => {
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  };
  return {
    onPointerEnter: () => {
      cancelHover();
      if (hoverDelayMs <= 0) {
        void prefetchModule(id, 'intent');
        return;
      }
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        void prefetchModule(id, 'intent');
      }, hoverDelayMs);
    },
    onPointerLeave: cancelHover,
    onFocus: () => {
      cancelHover();
      void prefetchModule(id, 'intent');
    },
  };
}

/**
 * Descarta promesa fallida y recrea `React.lazy` limpio para permitir reintento en sitio.
 */
export function resetModuleLoader(id: RoutedModuleId): void {
  const record = moduleRecords.get(id);
  if (record === undefined) return;
  record.reset();
}

export function getModuleFailureCount(id: RoutedModuleId): number {
  return moduleRecords.get(id)?.failureCount ?? 0;
}

export function getModuleRegistryStats(): {
  readonly loadedIds: readonly RoutedModuleId[];
  readonly inFlightCount: number;
  readonly totalLoadsStarted: Readonly<Record<string, number>>;
} {
  const loadedIds: RoutedModuleId[] = [];
  const totalLoadsStarted: Record<string, number> = {};
  for (const [id, record] of moduleRecords.entries()) {
    if (record.getLoaded()) loadedIds.push(id);
    if (record.loadsStarted > 0) totalLoadsStarted[id] = record.loadsStarted;
  }
  return {
    loadedIds,
    inFlightCount: activeLoadIds.size,
    totalLoadsStarted,
  };
}

function ensureRuntimeTelemetryGuards(): void {
  if (typeof window !== 'undefined' && !preloadGuardInstalled) {
    preloadGuardInstalled = true;
    window.addEventListener('vite:preloadError', (event) => {
      // Delega la recuperación a ModuleLoadErrorBoundary o prefetchModule sin auto-recarga.
      event.preventDefault();
    });
  }
  if (!longTaskObserverInstalled && typeof PerformanceObserver !== 'undefined') {
    longTaskObserverInstalled = true;
    try {
      const supported = PerformanceObserver.supportedEntryTypes;
      if (Array.isArray(supported) && supported.includes('longtask')) {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 50) {
              lastLongTaskTimestampMs = entry.startTime + entry.duration;
            }
          }
        });
        observer.observe({ type: 'longtask', buffered: false });
      }
    } catch {
      // Entorno sin soporte de longtask observer.
    }
  }
}

export function installRuntimeTelemetryGuardsForTest(): void {
  ensureRuntimeTelemetryGuards();
}

export function setLastLongTaskTimestampForTest(timestampMs: number | null): void {
  lastLongTaskTimestampMs = timestampMs;
}

/**
 * Warmup selectivo post-arranque: espera rAF + 1.500 ms y precarga a lo sumo
 * 2 módulos primarios en turnos ociosos respetando conectividad y red móvil.
 */
export function schedulePostStartupIdleWarmup(
  ids: readonly RoutedModuleId[] = DEFAULT_IDLE_WARMUP_MODULES,
  initialDelayMs = 1_500,
): () => void {
  ensureRuntimeTelemetryGuards();
  const cappedIds = ids.slice(0, 2);
  if (cappedIds.length === 0) return () => undefined;

  let cancelled = false;
  let rafHandle: number | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let stepTimer: ReturnType<typeof setTimeout> | null = null;
  let idleHandle: number | null = null;
  let cursor = 0;

  const scheduleNext = (): void => {
    if (cancelled || cursor >= cappedIds.length) return;
    const runStep = (timeRemainingMs: number | null): void => {
      if (cancelled || cursor >= cappedIds.length) return;
      const targetId = cappedIds[cursor];
      cursor += 1;
      if (targetId === undefined) return;
      void runPrefetchWithBudget(targetId, 'idle', timeRemainingMs).finally(() => {
        if (!cancelled && cursor < cappedIds.length) {
          stepTimer = setTimeout(() => {
            stepTimer = null;
            scheduleNext();
          }, 250);
        }
      });
    };

    const win =
      typeof window !== 'undefined'
        ? (window as Window & {
            requestIdleCallback?: (
              cb: (deadline: { timeRemaining: () => number }) => void,
              opts?: { timeout: number },
            ) => number;
            cancelIdleCallback?: (handle: number) => void;
          })
        : undefined;

    if (typeof win?.requestIdleCallback === 'function') {
      idleHandle = win.requestIdleCallback(
        (deadline) => {
          idleHandle = null;
          runStep(deadline.timeRemaining());
        },
        { timeout: 2_500 },
      );
    } else {
      stepTimer = setTimeout(() => {
        stepTimer = null;
        runStep(null);
      }, 600);
    }
  };

  const armDelay = (): void => {
    if (cancelled) return;
    initialTimer = setTimeout(() => {
      initialTimer = null;
      scheduleNext();
    }, initialDelayMs);
  };

  if (typeof requestAnimationFrame === 'function') {
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      armDelay();
    });
  } else {
    armDelay();
  }

  return () => {
    cancelled = true;
    if (rafHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (initialTimer !== null) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (stepTimer !== null) {
      clearTimeout(stepTimer);
      stepTimer = null;
    }
    if (idleHandle !== null && typeof window !== 'undefined') {
      const win = window as Window & { cancelIdleCallback?: (handle: number) => void };
      if (typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(idleHandle);
      }
      idleHandle = null;
    }
  };
}
