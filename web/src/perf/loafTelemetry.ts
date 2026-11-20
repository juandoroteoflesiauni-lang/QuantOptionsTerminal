/**
 * Pieza 49 (Fase 2): Telemetría opcional de Long Animation Frames (LoAF).
 *
 * Estrictamente condicionada a `import.meta.env.VITE_ENABLE_PERF_TELEMETRY === 'true'`.
 * Cuando la bandera no está activa, retorna `null` inmediatamente sin registrar
 * observers ni añadir overhead alguno al Main Thread.
 */

export const LOAF_DURATION_THRESHOLD_MS = 50;

export interface LoafScriptTimingLike {
  readonly invoker?: string;
  readonly invokerType?: string;
  readonly sourceURL?: string;
  readonly sourceFunctionName?: string;
  readonly sourceCharPosition?: number;
  readonly duration?: number;
  readonly forcedStyleAndLayoutDuration?: number;
}

export interface LoafPerformanceEntryLike extends PerformanceEntry {
  readonly blockingDuration?: number;
  readonly forcedStyleAndLayoutDuration?: number;
  readonly scripts?: readonly LoafScriptTimingLike[];
}

export interface LoafTelemetrySummary {
  readonly startTimeMs: number;
  readonly durationMs: number;
  readonly blockingDuration: number;
  readonly forcedStyleAndLayoutDuration: number;
  readonly scripts: readonly {
    readonly invoker: string;
    readonly invokerType: string;
    readonly sourceFunctionName: string;
    readonly sourceURL: string;
    readonly durationMs: number;
    readonly forcedStyleAndLayoutDuration: number;
  }[];
}

export function summarizeLoafEntry(entry: LoafPerformanceEntryLike): LoafTelemetrySummary {
  const scriptsList = Array.isArray(entry.scripts) ? entry.scripts : [];
  let sumForcedStyleLayout =
    typeof entry.forcedStyleAndLayoutDuration === 'number' &&
    Number.isFinite(entry.forcedStyleAndLayoutDuration)
      ? entry.forcedStyleAndLayoutDuration
      : 0;

  const scripts = scriptsList.map((script) => {
    const forced =
      typeof script.forcedStyleAndLayoutDuration === 'number' &&
      Number.isFinite(script.forcedStyleAndLayoutDuration)
        ? script.forcedStyleAndLayoutDuration
        : 0;
    if (entry.forcedStyleAndLayoutDuration === undefined) {
      sumForcedStyleLayout += forced;
    }
    return {
      invoker: script.invoker ?? '',
      invokerType: script.invokerType ?? '',
      sourceFunctionName: script.sourceFunctionName ?? '',
      sourceURL: script.sourceURL ?? '',
      durationMs:
        typeof script.duration === 'number' && Number.isFinite(script.duration)
          ? Math.round(script.duration * 100) / 100
          : 0,
      forcedStyleAndLayoutDuration: Math.round(forced * 100) / 100,
    };
  });

  return {
    startTimeMs: Math.round(entry.startTime * 100) / 100,
    durationMs: Math.round(entry.duration * 100) / 100,
    blockingDuration:
      typeof entry.blockingDuration === 'number' && Number.isFinite(entry.blockingDuration)
        ? Math.round(entry.blockingDuration * 100) / 100
        : 0,
    forcedStyleAndLayoutDuration: Math.round(sumForcedStyleLayout * 100) / 100,
    scripts,
  };
}

export function initLoafTelemetry(): (() => void) | null {
  if (import.meta.env.VITE_ENABLE_PERF_TELEMETRY !== 'true') {
    return null;
  }
  if (typeof PerformanceObserver === 'undefined') {
    return null;
  }
  const supported = PerformanceObserver.supportedEntryTypes;
  if (!Array.isArray(supported) || !supported.includes('long-animation-frame')) {
    return null;
  }

  const observer = new PerformanceObserver((list) => {
    const entries = list.getEntries() as readonly LoafPerformanceEntryLike[];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry === undefined || entry.duration <= LOAF_DURATION_THRESHOLD_MS) continue;
      const summary = summarizeLoafEntry(entry);
      console.warn('[LoAF >50ms]', summary);
    }
  });

  try {
    observer.observe({ type: 'long-animation-frame', buffered: true });
  } catch {
    return null;
  }

  return () => {
    observer.disconnect();
  };
}
