import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const DEFERRED_HTML_CHUNK_PREFIXES = [
  'assets/vendor-charts-',
  'assets/vendor-motion-',
  'assets/vendor-virtual-',
  'assets/core-options-quant-',
  'assets/mod-',
] as const;

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    manifest: true,
    cssCodeSplit: true,
    modulePreload: {
      polyfill: false,
      resolveDependencies(_filename, deps, context) {
        if (context.hostType === 'html') {
          return deps.filter(
            (dep) => !DEFERRED_HTML_CHUNK_PREFIXES.some((prefix) => dep.startsWith(prefix)),
          );
        }
        return deps;
      },
    },
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 50,
            },
            {
              name: 'vendor-charts',
              test: /[\\/]node_modules[\\/](?:lightweight-charts|fancy-canvas)[\\/]/,
              priority: 45,
            },
            {
              name: 'vendor-motion',
              test: /[\\/]node_modules[\\/](?:motion|framer-motion|motion-dom|motion-utils|tslib)[\\/]/,
              priority: 42,
            },
            {
              name: 'vendor-virtual',
              test: /[\\/]node_modules[\\/]@tanstack[\\/](?:react-virtual|virtual-core)[\\/]/,
              priority: 40,
            },
            {
              name: 'runtime-shared',
              test: (id: string) =>
                /preload-helper/.test(id) ||
                /[\\/]node_modules[\\/]lucide-react[\\/]/.test(id) ||
                /[\\/]web[\\/]src[\\/](?:data[\\/](?:liveRuntimeBridge|marketData|visibilityLifecycle|feedsHealthStore|optionsUnderlying|snapshotPublication|expiryChainMerge|usBarsMemoryCache)|api[\\/]useMarketLiveStream|store[\\/]marketStoreSoa|perf[\\/](?:loafTelemetry|moduleRegistry)|components[\\/](?:DesignSystem|ImperativePriceCell|common[\\/](?:CompanyLogo|LiveClockBadge|ModuleViewFallback|ModuleLoadErrorBoundary)|options[\\/]engine|stock-detail[\\/]stockDetailRouting))\.(?:ts|tsx)$/.test(
                  id,
                ) ||
                /[\\/]src[\\/]core[\\/](?:ema|stockDetailStability)\.ts$/.test(id),
              priority: 35,
            },
            {
              name: 'core-options-quant',
              test: (id: string) =>
                /[\\/]web[\\/]src[\\/]components[\\/]options[\\/](?:optionsDerived|activeExpiryBinding)\.ts$/.test(
                  id,
                ) ||
                /[\\/]src[\\/]core[\\/]terminal[\\/]structureOptimizer\.ts$/.test(id) ||
                /[\\/]src[\\/]core[\\/]options[\\/](?:american|americanIvDiagnostics|chainIntegrity|exposure|impliedVol|oiProvenance|probabilisticDivergence|syntheticRates|volAnalyticsSuite)\.ts$/.test(
                  id,
                ),
              priority: 30,
            },
            {
              name: 'mod-volatility',
              test: (id: string) =>
                /[\\/]web[\\/]src[\\/]components[\\/]options[\\/]VolatilitySuiteView\.tsx$/.test(id) ||
                /[\\/]src[\\/]core[\\/]options[\\/]volMetrics\.ts$/.test(id),
              priority: 25,
            },
            {
              name: 'mod-options-map',
              test: /[\\/]web[\\/]src[\\/]components[\\/]options[\\/]map[\\/]/,
              priority: 24,
            },
            {
              name: 'mod-options-chain',
              test: /[\\/]web[\\/]src[\\/]components[\\/]options[\\/]VirtualizedOptionChainTable\.tsx$/,
              priority: 23,
            },
            {
              name: 'mod-options-export',
              test: (id: string) =>
                /[\\/]web[\\/]src[\\/]components[\\/]options[\\/]export[\\/]/.test(id) ||
                /[\\/]src[\\/]core[\\/]options[\\/]usOptions(?:IntelligenceExport|IntelligenceExportTypes|SnapshotMarkdown)\.ts$/.test(
                  id,
                ),
              priority: 22,
            },
            {
              name: 'mod-options',
              test: /[\\/]web[\\/]src[\\/]components[\\/](?:OptionsModule\.tsx|OptionsSymbolSelector\.tsx|common[\\/]VirtualizedRows\.tsx|options[\\/]WhatIfPayoffSimulator\.tsx)$/,
              priority: 20,
            },
            {
              name: 'mod-stock-detail',
              test: /[\\/]web[\\/]src[\\/]components[\\/](?:StockDetailView\.tsx|StockDetailSymbolSelector\.tsx|stock-detail[\\/](?:ExecutionBottomDeck|GexStrikeProfileChart|SyncedLowerPaneChart|stockDetailMath)\.(?:ts|tsx))$/,
              priority: 20,
            },
            {
              name: 'mod-ggal',
              test: /[\\/]web[\\/]src[\\/](?:components[\\/]ggal[\\/]|api[\\/]ggalSpecialistClient\.ts$)/,
              priority: 20,
            },
            {
              name: 'mod-markets',
              test: /[\\/]web[\\/]src[\\/]components[\\/]MarketModules\.tsx$/,
              priority: 20,
            },
            {
              name: 'mod-overlays',
              test: /[\\/]web[\\/]src[\\/]components[\\/](?:Overlays|FeedsHealthDrawer)\.tsx$/,
              priority: 18,
            },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    hmr: {
      protocol: 'ws',
      host: '127.0.0.1',
      port: 5173,
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
});
