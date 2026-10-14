import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Static SPA for Cloudflare (L2/L3), served at interviewprep.threatready.io. In development the API
// is proxied so cookies stay first-party. Sign-in is on onboard (VITE_ONBOARD_URL, :5173 locally);
// this app runs on :5174 and shares onboard's localhost session cookie.
export default defineConfig({
  // Built under /interview-prep/ so its assets never collide with onboard's /assets when every app
  // shares one origin. The app's routes already all start with /interview-prep.
  base: '/interview-prep/',
  plugins: [
    react(),
    {
      // Dev only: Vite serves the base with a trailing slash; the app and other apps link to /interview-prep.
      name: 'interview-prep-base-redirect',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/interview-prep' || req.url?.startsWith('/interview-prep?') || req.url === '/') {
            res.statusCode = 302;
            res.setHeader('Location', `/interview-prep/${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
            res.end();
            return;
          }
          next();
        });
      },
    },
  ],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/v1': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:3100', changeOrigin: false },
    },
  },
  build: {
    // Cross-browser: Chrome/Edge/Firefox 100+, Safari 15+ (every browser from 2022 on).
    target: ['es2020', 'chrome100', 'edge100', 'firefox100', 'safari15'],
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
