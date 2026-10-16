import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Served under /labs/ everywhere (locally and in the single-origin deployment), so paths never differ.
// The API and the hosted labs (SOC, DevSecOps, Firewall, Red Team, AI Security) are served by the labs server.
const api = process.env.API_PROXY_TARGET ?? 'http://localhost:4000';
export default defineConfig({ root: 'client', base: '/labs/', plugins: [react()], build: { outDir: '../dist', emptyOutDir: true, target: ['es2020', 'chrome100', 'edge100', 'firefox100', 'safari15'] }, server: { port: 5175, strictPort: true, proxy: Object.fromEntries(['/labs/api', '/labs/soc', '/labs/devsecops', '/labs/threatwall', '/labs/redteam', '/labs/aisec'].map((p) => [p, api])) } });
