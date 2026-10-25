import { gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** three.js, its examples and React Three Fiber/drei with their 3D-only dependencies. */
export const THREE_STACK = /[\\/]node_modules[\\/](three|three-stdlib|three-mesh-bvh|@react-three[\\/][^\\/]+|@monogrid[\\/]gainmap-js|troika-[^\\/]+|camera-controls|maath|meshline|stats-gl|stats\.js|detect-gpu|hls\.js|fflate|zustand|its-fine|suspend-react|react-use-measure)[\\/]/;
/** Runtime modules both the 3D stack and the main app use. */
const SHARED_WITH_THREE = /[\\/]node_modules[\\/](react|react-dom|scheduler|use-sync-external-store|@babel[\\/]runtime|@oxc-project[\\/]runtime|@oxc-project\+runtime[^\\/]*)[\\/]|^\0?@oxc-project/;

/** Gzipped budget for what every page downloads before it renders (the entry and its static imports). */
const ENTRY_BUDGET_GZ = 250 * 1024;

/**
 * Bundle check, run by every build: fails when a page's first load would include three.js (it belongs
 * to the interview room alone) or when the first-load JavaScript outgrows ENTRY_BUDGET_GZ.
 */
export function bundleCheck(): Plugin {
  return {
    name: 'interview-prep-bundle-check',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = new Map(Object.values(bundle).flatMap((c) => (c.type === 'chunk' ? [[c.fileName, c] as const] : [])));
      for (const entry of [...chunks.values()].filter((c) => c.isEntry)) {
        const seen = new Set<string>();
        const queue = [entry.fileName];
        while (queue.length) {
          const f = queue.pop()!;
          if (seen.has(f)) continue;
          seen.add(f);
          queue.push(...(chunks.get(f)?.imports ?? []));
        }
        let gz = 0;
        for (const f of seen) {
          const c = chunks.get(f);
          if (!c) continue;
          const three = c.moduleIds.find((id) => THREE_STACK.test(id));
          if (three) this.error(`${entry.fileName} statically imports ${f}, which contains ${three}: three.js must load only with the 3D interviewer`);
          gz += gzipSync(c.code).length;
        }
        if (gz > ENTRY_BUDGET_GZ) this.error(`${entry.fileName} loads ${Math.round(gz / 1024)} KB gzipped of JavaScript up front (budget ${ENTRY_BUDGET_GZ / 1024} KB)`);
      }
    },
  };
}

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
    bundleCheck(),
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
    rolldownOptions: {
      output: {
        // The 3D stack is its own chunk, loaded only when the 3D interviewer is shown (interview room).
        // Modules it shares with every page (React, the bundler's helpers) go to 'vendor', which wins
        // over 'three': a group also captures its dependencies, so without it React lands in 'three'
        // and every page imports three.js (bundleCheck, above, fails the build if that comes back).
        codeSplitting: {
          groups: [
            { name: 'vendor', test: SHARED_WITH_THREE, priority: 20 },
            { name: 'three', test: THREE_STACK, priority: 10 },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
    // jsdom and the interview-room renders are slow on a loaded machine (CI, parallel suites); the 5 s
    // default fails them there although nothing is wrong. Tests that wait on purpose use fake timers.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
