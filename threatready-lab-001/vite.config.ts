import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Served under /labs/ everywhere (locally and in the single-origin deployment), so paths never differ.
export default defineConfig({ root: 'client', base: '/labs/', plugins: [react()], build: { outDir: '../dist', emptyOutDir: true }, server: { port: 5175, strictPort: true, proxy: { '/labs/api': process.env.API_PROXY_TARGET ?? 'http://localhost:4000' } } });
