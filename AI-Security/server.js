/**
 * Local preview server only. Inside ThreatReady this lab is served by the Labs app (behind the
 * platform sign-in and the gateway's security headers), not by this file.
 * Serves the built Vite app from ./dist and binds to $PORT. SPA fallback: any unknown path returns index.html.
 */
if (process.env.NODE_ENV === "production") {
  console.error("AI-Security/server.js is a local preview server and refuses to start with NODE_ENV=production; the lab is served by the ThreatReady Labs app.");
  process.exit(1);
}

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "dist");

const app = express();
app.disable("x-powered-by");

// Baseline security headers for local use.
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Static assets (hashed filenames -> safe to cache long).
app.use(
  express.static(dist, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache");
      } else {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }),
);

// Simple health check.
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// SPA fallback.
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

const port = process.env.PORT || 4173;
app.listen(port, "0.0.0.0", () => {
  console.log(`AI Security Lab (ThreatReady) listening on :${port}`);
});
