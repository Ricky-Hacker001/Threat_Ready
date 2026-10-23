import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

function baseRedirect(req: { url?: string }, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: () => void }, next: () => void) {
  if (req.url === '/interview-prep' || req.url?.startsWith('/interview-prep?') || req.url === '/') {
    res.statusCode = 302;
    res.setHeader('Location', `/interview-prep/${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
    res.end();
    return;
  }
  next();
}

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
      // Vite's dev and preview servers serve the base with a trailing slash; the app and the other apps
      // link to /interview-prep (production's gateway accepts both).
      name: 'interview-prep-base-redirect',
      configurePreviewServer(server) {
        server.middlewares.use(baseRedirect);
      },
      configureServer(server) {
        server.middlewares.use(baseRedirect);
      },
    },
  ],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/v1': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:3100', changeOrigin: false },
      // onboard's API (activity pings), same-origin like the single-origin deployment
      '/api': { target: process.env.ONBOARD_API_TARGET ?? 'http://localhost:3200', changeOrigin: false },
    },
  },
  build: {
    // Cross-browser: Chrome/Edge/Firefox 100+, Safari 15+ (every browser from 2022 on).
    target: ['es2020', 'chrome100', 'edge100', 'firefox100', 'safari15'],
    // Source maps are never shipped: they expose the application source to anyone on the site.
    sourcemap: false,
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
