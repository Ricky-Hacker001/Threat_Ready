/**
 * Production server for Render (Web Service).
 * Serves the built Vite app from ./dist and binds to $PORT.
 * SPA fallback: any unknown path returns index.html.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "dist");

const app = express();

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
