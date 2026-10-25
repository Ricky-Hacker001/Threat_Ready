import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import type pg from "pg";
import { AppModule } from "./app.module.js";
import { AUTH, authHttpHandler, type Auth } from "./auth/auth.js";
import { initErrorReports, reportError } from "./common/error-report.js";
import { stampClientIp } from "./common/throttle.js";
import { loadConfig } from "./config.js";
import { PG_POOL } from "./db/db.js";

/** Report, then stop as Node would have: a crash must stay a crash (the launcher restarts the API). */
function crashWith(kind: string) {
  return (err: unknown) => {
    console.error(`[${kind}]`, err);
    const stop = setTimeout(() => process.exit(1), 2_000);
    void reportError(err, kind).finally(() => {
      clearTimeout(stop);
      process.exit(1);
    });
  };
}

async function bootstrap() {
  const config = loadConfig();
  initErrorReports({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    release: config.RELEASE ?? process.env.RENDER_GIT_COMMIT,
  });
  process.on("uncaughtException", crashWith("uncaughtException"));
  process.on("unhandledRejection", crashWith("unhandledRejection"));

  // Body parsing off: Better Auth must read the raw request itself.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bodyParser: false,
    logger: config.NODE_ENV === "production" ? ["error", "warn", "log"] : undefined,
  });
  const http = app.getHttpAdapter().getInstance() as express.Express;
  http.disable("x-powered-by");
  // One client IP for every reader, set here before Better Auth and the routes run (common/throttle.ts).
  http.use((req, _res, next) => {
    stampClientIp(req, config.CLIENT_IP_HEADER);
    next();
  });
  // API responses are per-user (or auth state): never cached or revalidated by browsers or proxies.
  // The public config is the same for everyone and may be cached briefly.
  http.set("etag", false);
  http.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", req.path === "/public/config" ? "public, max-age=60" : "no-store");
    next();
  });

  if (config.WEB_ORIGIN !== new URL(config.BETTER_AUTH_URL).origin) {
    // Split-host deployment (app.* and api.*): credentialed CORS for the SPA only.
    app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  }

  if (config.NODE_ENV !== "production") {
    // Opening the API port in a browser is a common mistake; send people to the UI.
    http.get("/", (_req, res) => res.redirect(302, config.WEB_ORIGIN));
  }

  // Better Auth handler mounted directly (ADD L6: skip the NestJS wrapper).
  const auth = app.get<Auth>(AUTH);
  http.all("/api/auth/*splat", toNodeHandler(authHttpHandler(auth)));

  app.use(express.json({ limit: "64kb" }));
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();

  // HOST=127.0.0.1 behind the single-origin gateway (deploy/start.mjs); every interface otherwise (Docker, local).
  const host = process.env.HOST?.trim();
  if (host) await app.listen(config.PORT, host);
  else await app.listen(config.PORT);
  Logger.log(`API listening on ${host ?? ""}:${config.PORT}`, "Bootstrap");

  const pool = app.get<pg.Pool>(PG_POOL);
  const shutdown = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

bootstrap().catch((err: NodeJS.ErrnoException) => {
  if (err?.code === "EADDRINUSE") {
    const port = process.env.PORT ?? "3000";
    console.error(
      `\nPort ${port} is already in use by another program, so the API can't start.\n` +
        (process.platform === "win32"
          ? `Find it: netstat -ano | findstr :${port}   then stop it: taskkill /PID <PID> /F\n`
          : `Find it: lsof -i :${port}   then stop it: kill <PID>\n`) +
        `Usual culprits: VS Code Live Server, "npx serve", or an old pnpm dev window.\n`,
    );
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  // A failed boot is reported when the configuration got far enough to enable reports.
  const stop = setTimeout(() => process.exit(1), 2_000);
  void reportError(err, "boot").finally(() => {
    clearTimeout(stop);
    process.exit(1);
  });
});
