import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// ar.threatready.io. Dev: web on :5176, API on :4100 (proxied so the session cookie stays first-party).
export default defineConfig({ root: 'client', plugins: [react()], build: { outDir: '../dist', emptyOutDir: true }, server: { port: 5176, strictPort: true, proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:4100' } } });
