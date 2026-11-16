import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

type ViteProxyServer = Parameters<NonNullable<ProxyOptions['configure']>>[0];

function isBenignSocketDisconnect(err: Error): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ECONNABORTED' || code === 'ECONNRESET';
}

/**
 * Vite dev proxy hardening: browser reloads and HMR close WebSockets abruptly.
 * `ECONNABORTED` / `ECONNRESET` are expected transport resets, not runtime
 * failures, so they are silenced; every other proxy error stays visible.
 */
function configureWsProxy(proxy: ViteProxyServer): void {
  proxy.on('error', (err, _req, res) => {
    if (isBenignSocketDisconnect(err)) return;
    console.warn(`[vite] /ws proxy error: ${err.message}`);
    if ('writeHead' in res && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('WebSocket proxy error');
    }
  });

  proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') return;
      console.warn(`[vite] /ws upstream socket error: ${err.message}`);
    });
  });
}

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        secure: false,
        timeout: 15_000,
        proxyTimeout: 15_000,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
        secure: false,
        timeout: 70_000,
        proxyTimeout: 70_000,
        configure: configureWsProxy,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
});
