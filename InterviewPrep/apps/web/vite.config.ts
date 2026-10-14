import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Static SPA for Cloudflare (L2/L3), served at interviewprep.threatready.io. In development the API
// is proxied so cookies stay first-party. Sign-in is on onboard (VITE_ONBOARD_URL, :5173 locally);
// this app runs on :5174 and shares onboard's localhost session cookie.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/v1': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:3100', changeOrigin: false },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // The 3D stack loads only on the interview room route.
        manualChunks: (id) => (id.includes('node_modules/three') || id.includes('@react-three') ? 'three' : undefined),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
  },
});
