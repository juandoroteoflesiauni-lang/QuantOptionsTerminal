import React from 'react';
import {
  classifyChunkLoadFailure,
  getModuleFailureCount,
  resetModuleLoader,
  type ChunkFailureKind,
  type RoutedModuleId,
} from '../../perf/moduleRegistry';
import type { FallbackLayoutVariant } from './ModuleViewFallback';

export const CHUNK_RELOAD_GUARD_KEY = 'qot:chunk-reload-guard';
export const CHUNK_RELOAD_COOLDOWN_MS = 60_000;

interface ReloadGuardRecord {
  readonly chunkKey: string;
  readonly timestampMs: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function canTriggerStaleChunkReload(
  storage: StorageLike | null | undefined,
  chunkKey: string,
  nowMs: number = Date.now(),
): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(CHUNK_RELOAD_GUARD_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ReloadGuardRecord>;
      if (
        parsed.chunkKey === chunkKey &&
        typeof parsed.timestampMs === 'number' &&
        Number.isFinite(parsed.timestampMs) &&
        nowMs - parsed.timestampMs < CHUNK_RELOAD_COOLDOWN_MS
      ) {
        return false;
      }
    }
    storage.setItem(
      CHUNK_RELOAD_GUARD_KEY,
      JSON.stringify({ chunkKey, timestampMs: nowMs }),
    );
    return true;
  } catch {
    return false;
  }
}

export interface ModuleLoadErrorBoundaryProps {
  readonly moduleId: RoutedModuleId;
  readonly resetKey: string;
  readonly variant: FallbackLayoutVariant;
  readonly children: React.ReactNode;
}

interface ModuleLoadErrorBoundaryState {
  readonly error: Error | null;
  readonly prevResetKey: string;
  readonly failureKind: ChunkFailureKind;
  readonly reloadBlockedByGuard: boolean;
}

function minHeightClassForVariant(variant: FallbackLayoutVariant): string {
  if (variant === 'options-suite') return 'min-h-[620px]';
  if (variant === 'chart-deck' || variant === 'dual-chart') return 'min-h-[560px]';
  return 'min-h-[540px]';
}

export class ModuleLoadErrorBoundary extends React.Component<
  ModuleLoadErrorBoundaryProps,
  ModuleLoadErrorBoundaryState
> {
  private probeController: AbortController | null = null;
  private mounted = false;

  public constructor(props: ModuleLoadErrorBoundaryProps) {
    super(props);
    this.state = {
      error: null,
      prevResetKey: props.resetKey,
      failureKind: 'TRANSIENT_NETWORK',
      reloadBlockedByGuard: false,
    };
  }

  public static getDerivedStateFromProps(
    props: ModuleLoadErrorBoundaryProps,
    state: ModuleLoadErrorBoundaryState,
  ): Partial<ModuleLoadErrorBoundaryState> | null {
    if (props.resetKey !== state.prevResetKey) {
      return {
        error: null,
        prevResetKey: props.resetKey,
        failureKind: 'TRANSIENT_NETWORK',
        reloadBlockedByGuard: false,
      };
    }
    return null;
  }

  public static getDerivedStateFromError(error: Error): Partial<ModuleLoadErrorBoundaryState> {
    return {
      error,
      failureKind: 'TRANSIENT_NETWORK',
      reloadBlockedByGuard: false,
    };
  }

  public componentDidMount(): void {
    this.mounted = true;
  }

  public componentDidCatch(error: Error): void {
    this.probeController?.abort();
    const controller = new AbortController();
    this.probeController = controller;
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    const moduleId = this.props.moduleId;
    const failureCount = Math.max(1, getModuleFailureCount(moduleId));

    void fetch('/api/health', {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
      .then((res) => res.ok)
      .catch(() => false)
      .then((backendReachable) => {
        if (!this.mounted || controller.signal.aborted) return;
        const kind = classifyChunkLoadFailure({
          errorMessage: error.message,
          online,
          failureCountForModule: failureCount,
          backendReachable,
        });
        this.setState({ failureKind: kind });
      });
  }

  public componentWillUnmount(): void {
    this.mounted = false;
    this.probeController?.abort();
    this.probeController = null;
  }

  private readonly handleRetryModule = (): void => {
    this.probeController?.abort();
    resetModuleLoader(this.props.moduleId);
    this.setState({
      error: null,
      failureKind: 'TRANSIENT_NETWORK',
      reloadBlockedByGuard: false,
    });
  };

  private readonly handleReloadTerminal = (): void => {
    const storage =
      typeof window !== 'undefined' ? window.sessionStorage : undefined;
    if (!canTriggerStaleChunkReload(storage, this.props.moduleId)) {
      this.setState({ reloadBlockedByGuard: true });
      return;
    }
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  public render(): React.ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }

    const boxMinH = minHeightClassForVariant(this.props.variant);
    const isStale = this.state.failureKind === 'STALE_DEPLOYMENT_CHUNK';

    return (
      <div
        data-qot-module-error={this.props.moduleId}
        data-qot-error-kind={this.state.failureKind}
        className={`${boxMinH} rounded-[10px] bg-[#131722] border border-[#4A2229] p-6 flex flex-col items-center justify-center gap-4 text-center font-mono-num tabular-nums`}
      >
        <div className="space-y-1.5 max-w-md">
          <div className="text-[14px] font-bold text-[#ECEDF2]">
            {isStale
              ? 'Nueva compilación disponible para este módulo'
              : `No se pudo cargar el módulo ${this.props.moduleId}`}
          </div>
          <p className="text-[12px] text-[#9CA3AF]">
            {isStale
              ? 'El recurso diferido cambió tras un despliegue reciente. Recargá la terminal para sincronizar los artefactos.'
              : 'Error temporal al descargar o evaluar el módulo. La conexión principal y el stream de datos siguen activos.'}
          </p>
          <p className="text-[11px] text-[#787B86] break-all">
            {this.state.error.message || 'Chunk load failure'}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <button
            type="button"
            data-qot-retry-module={this.props.moduleId}
            onClick={this.handleRetryModule}
            className="px-4 py-2 rounded-[8px] bg-[#1D4ED8] hover:bg-[#2563EB] text-white text-[12px] font-semibold cursor-pointer transition-colors"
          >
            Reintentar módulo
          </button>

          {isStale && (
            <button
              type="button"
              data-qot-reload-terminal={this.props.moduleId}
              onClick={this.handleReloadTerminal}
              disabled={this.state.reloadBlockedByGuard}
              className="px-4 py-2 rounded-[8px] bg-[#1F2430] hover:bg-[#2A3142] border border-[#343B4F] text-[#D1D4DC] text-[12px] font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {this.state.reloadBlockedByGuard
                ? 'Recarga reciente bloqueada (60s)'
                : 'Recargar terminal actualizada'}
            </button>
          )}
        </div>
      </div>
    );
  }
}
