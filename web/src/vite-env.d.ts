/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_PERF_TELEMETRY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
