type VisibilityListener = (visible: boolean, hiddenDurationMs: number) => void;

const listeners = new Set<VisibilityListener>();
let hiddenAtMs: number | null = null;

export function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function handleVisibilityChange(): void {
  const visible = isDocumentVisible();
  const hiddenDurationMs = visible && hiddenAtMs !== null ? Date.now() - hiddenAtMs : 0;
  hiddenAtMs = visible ? null : hiddenAtMs ?? Date.now();
  for (const listener of [...listeners]) listener(visible, hiddenDurationMs);
}

export function subscribeDocumentVisibility(listener: VisibilityListener): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const target = document;
  if (listeners.size === 0) {
    hiddenAtMs = isDocumentVisible() ? null : Date.now();
    target.addEventListener('visibilitychange', handleVisibilityChange);
  }
  const subscription: VisibilityListener = (visible, duration) => listener(visible, duration);
  listeners.add(subscription);
  return () => {
    if (!listeners.delete(subscription) || listeners.size > 0) return;
    target.removeEventListener('visibilitychange', handleVisibilityChange);
    hiddenAtMs = null;
  };
}

interface VisibilityIntervalOptions {
  readonly runImmediately?: boolean;
  readonly reconcileAfterMs?: number;
  readonly repeat?: boolean;
}

export function createVisibilityAwareInterval(
  run: (signal: AbortSignal, reason: 'scheduled' | 'reconcile') => void | Promise<void>,
  intervalMs: number,
  options: VisibilityIntervalOptions = {},
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;
  let inFlight = false;
  let started = false;
  let retryOneShot = false;
  const reconcileAfterMs = options.reconcileAfterMs ?? intervalMs;

  const pause = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (inFlight && options.repeat === false) retryOneShot = true;
    controller?.abort();
    controller = undefined;
    inFlight = false;
  };
  const resume = (reconcile: boolean) => {
    if (controller !== undefined) return;
    const current = new AbortController();
    controller = current;
    const invoke = (reason: 'scheduled' | 'reconcile') => {
      if (inFlight || current.signal.aborted) return;
      inFlight = true;
      void Promise.resolve().then(() => {
        if (!current.signal.aborted) return run(current.signal, reason);
      }).finally(() => {
        if (controller === current) inFlight = false;
      });
    };
    if (options.repeat !== false) timer = setInterval(() => invoke('scheduled'), intervalMs);
    if (retryOneShot || reconcile || (!started && options.runImmediately === true)) invoke('reconcile');
    retryOneShot = false;
    started = true;
  };
  const unsubscribe = subscribeDocumentVisibility((visible, hiddenDurationMs) => {
    if (visible) resume(hiddenDurationMs >= reconcileAfterMs);
    else pause();
  });
  if (isDocumentVisible()) resume(options.runImmediately === true);
  return () => {
    unsubscribe();
    pause();
  };
}
