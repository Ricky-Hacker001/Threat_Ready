import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Attack Reasoning Lab, served under /ar/ everywhere. Dev: web on :5176, API on :4100 (proxied so the session cookie stays first-party).
export default defineConfig({ root: 'client', base: '/ar/', plugins: [react()], build: { outDir: '../dist', emptyOutDir: true }, server: { port: 5176, strictPort: true, proxy: { '/ar/api': process.env.API_PROXY_TARGET ?? 'http://localhost:4100' } } });
