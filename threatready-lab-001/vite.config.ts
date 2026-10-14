import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ root: 'client', plugins: [react()], build: { outDir: '../dist', emptyOutDir: true }, server: { port: 5175, strictPort: true, proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:4000' } } });
