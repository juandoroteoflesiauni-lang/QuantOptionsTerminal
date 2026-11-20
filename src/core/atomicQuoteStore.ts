/**
 * Store externo atómico por clave para ticks de alta frecuencia (Pieza 48).
 *
 * Funciones y estado puro sin dependencias de React, DOM ni red. Permite
 * suscripciones exactas por símbolo/contrato (`useSyncExternalStore`) con
 * throttling diferenciado (L2 100 ms / Tablas 250 ms) y canales imperativos
 * directos para renderizado 60 FPS en Canvas vía `requestAnimationFrame`.
 */

export const L2_THROTTLE_MS = 100;
export const TABLE_THROTTLE_MS = 250;

export interface AtomicKeyedStoreOptions {
  readonly nowMsFn?: () => number;
}

export interface AtomicKeyedStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T, equals?: (prev: T, next: T) => boolean): boolean;
  delete(key: string): boolean;
  clear(): void;
  size(): number;
  entries(): IterableIterator<[string, T]>;
  getVersion(): number;
  subscribeKey(key: string, listener: () => void): () => void;
  subscribeKeyThrottled(key: string, throttleMs: number, listener: () => void): () => void;
  subscribeKeyValue(key: string, listener: (value: T) => void): () => void;
  subscribeAnyThrottled(throttleMs: number, listener: () => void): () => void;
}

export function normalizeOptionContractKey(raw: string): string {
  const clean = raw.trim().toUpperCase();
  return clean.startsWith('O:') ? clean.slice(2) : clean;
}

function createThrottledWrapper(
  throttleMs: number,
  nowMsFn: () => number,
  listener: () => void,
): { readonly trigger: () => void; readonly dispose: () => void } {
  let hasEmitted = false;
  let lastEmittedAtMs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const trigger = (): void => {
    if (disposed) return;
    if (throttleMs <= 0) {
      listener();
      return;
    }
    const now = nowMsFn();
    const elapsed = hasEmitted ? now - lastEmittedAtMs : throttleMs;
    if (elapsed >= throttleMs) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      hasEmitted = true;
      lastEmittedAtMs = now;
      listener();
      return;
    }
    if (timer !== null) return;
    const waitMs = Math.max(0, throttleMs - elapsed);
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      hasEmitted = true;
      lastEmittedAtMs = nowMsFn();
      listener();
    }, waitMs);
  };

  const dispose = (): void => {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { trigger, dispose };
}

export function createAtomicKeyedStore<T>(
  options: AtomicKeyedStoreOptions = {},
): AtomicKeyedStore<T> {
  const nowMsFn = options.nowMsFn ?? (() => Date.now());
  const values = new Map<string, T>();
  const listenersByKey = new Map<string, Set<() => void>>();
  const valueListenersByKey = new Map<string, Set<(value: T) => void>>();
  const anyListeners = new Set<() => void>();
  let version = 0;

  const notifyKey = (key: string): void => {
    const keySet = listenersByKey.get(key);
    if (keySet !== undefined) {
      for (const fn of [...keySet]) {
        fn();
      }
    }
    for (const fn of [...anyListeners]) {
      fn();
    }
  };

  const subscribeKey = (key: string, listener: () => void): (() => void) => {
    let set = listenersByKey.get(key);
    if (set === undefined) {
      set = new Set();
      listenersByKey.set(key, set);
    }
    set.add(listener);
    return () => {
      const current = listenersByKey.get(key);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) {
        listenersByKey.delete(key);
      }
    };
  };

  const subscribeKeyThrottled = (
    key: string,
    throttleMs: number,
    listener: () => void,
  ): (() => void) => {
    if (throttleMs <= 0) {
      return subscribeKey(key, listener);
    }
    const { trigger, dispose } = createThrottledWrapper(throttleMs, nowMsFn, listener);
    const unsub = subscribeKey(key, trigger);
    return () => {
      dispose();
      unsub();
    };
  };

  const subscribeKeyValue = (key: string, listener: (value: T) => void): (() => void) => {
    let set = valueListenersByKey.get(key);
    if (set === undefined) {
      set = new Set();
      valueListenersByKey.set(key, set);
    }
    set.add(listener);
    return () => {
      const current = valueListenersByKey.get(key);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) {
        valueListenersByKey.delete(key);
      }
    };
  };

  const subscribeAnyThrottled = (throttleMs: number, listener: () => void): (() => void) => {
    const { trigger, dispose } = createThrottledWrapper(throttleMs, nowMsFn, listener);
    anyListeners.add(trigger);
    return () => {
      dispose();
      anyListeners.delete(trigger);
    };
  };

  return {
    get(key: string): T | undefined {
      return values.get(key);
    },
    set(key: string, value: T, equals?: (prev: T, next: T) => boolean): boolean {
      const prev = values.get(key);
      if (prev !== undefined && equals !== undefined && equals(prev, value)) {
        return false;
      }
      values.set(key, value);
      version += 1;
      const valSet = valueListenersByKey.get(key);
      if (valSet !== undefined) {
        for (const fn of [...valSet]) {
          fn(value);
        }
      }
      notifyKey(key);
      return true;
    },
    delete(key: string): boolean {
      const existed = values.delete(key);
      if (!existed) return false;
      version += 1;
      notifyKey(key);
      return true;
    },
    clear(): void {
      if (values.size === 0) return;
      const keys = [...values.keys()];
      values.clear();
      version += 1;
      for (const key of keys) {
        const keySet = listenersByKey.get(key);
        if (keySet !== undefined) {
          for (const fn of [...keySet]) {
            fn();
          }
        }
      }
      for (const fn of [...anyListeners]) {
        fn();
      }
    },
    size(): number {
      return values.size;
    },
    entries(): IterableIterator<[string, T]> {
      return values.entries();
    },
    getVersion(): number {
      return version;
    },
    subscribeKey,
    subscribeKeyThrottled,
    subscribeKeyValue,
    subscribeAnyThrottled,
  };
}
