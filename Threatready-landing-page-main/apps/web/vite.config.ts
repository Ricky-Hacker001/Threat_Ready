import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: /api is proxied to the NestJS API so the SPA and API share an origin and
// the session cookie stays host-only (same layout as Cloudflare routing /api/* to the ALB).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: process.env.API_PROXY_TARGET ?? "http://localhost:3000", changeOrigin: false, xfwd: true },
    },
  },
  build: { sourcemap: true, target: "es2022" },
});
