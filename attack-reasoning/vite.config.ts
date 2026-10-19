import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Attack Reasoning Lab, served under /ar/ everywhere. Dev: web on :5176, API on :4100 (proxied so the session cookie stays first-party).
export default defineConfig({ root: 'client', base: '/ar/', plugins: [react()], build: { outDir: '../dist', emptyOutDir: true, target: ['es2020', 'chrome100', 'edge100', 'firefox100', 'safari15'] }, server: { port: 5176, strictPort: true, proxy: { '/ar/api': process.env.API_PROXY_TARGET ?? 'http://localhost:4100', '/v1': { target: process.env.REASONING_API_TARGET ?? 'http://localhost:3100', changeOrigin: false } } } });
