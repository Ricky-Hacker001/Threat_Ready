import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Served under /lab/ so it can later sit behind a gateway without path changes.
export default defineConfig({
  root: 'client',
  base: '/lab/',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, target: ['es2020', 'chrome100', 'edge100', 'firefox100', 'safari15'] },
  // /lab/api and /lab/target-frame.html (the sandboxed XSS target document, served by the API with its own
  // CSP) are proxied to the API server; everything else is served by Vite.
  server: { port: 5180, strictPort: true, proxy: Object.fromEntries(['/lab/api', '/lab/target-frame.html'].map((p) => [p, process.env.API_PROXY_TARGET ?? 'http://localhost:4300'])) },
});
