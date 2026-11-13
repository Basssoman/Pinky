/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The `/*` headers of public/_headers (Cloudflare Pages format). */
function pagesHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = fileURLToPath(new URL('./public/_headers', import.meta.url));
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Dev only: `/api` goes to the local API server and `/rpc` to the local
// sandbox node (addresses written by the dev stack into .env.development.local).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const api = env.DEV_API_URL || 'http://127.0.0.1:8788';
  const rpc = env.DEV_RPC_URL || 'http://127.0.0.1:3031';
  return {
    plugins: [react()],
    // `vite preview` sends the same headers as Cloudflare Pages (public/_headers),
    // so the built site can be checked under its real Content-Security-Policy.
    preview: { headers: pagesHeaders() },
    server: {
      proxy: {
        '/api': { target: api, changeOrigin: true },
        '/rpc': { target: rpc, changeOrigin: true, rewrite: () => '/' },
      },
    },
    test: { environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 30_000 },
  };
});
