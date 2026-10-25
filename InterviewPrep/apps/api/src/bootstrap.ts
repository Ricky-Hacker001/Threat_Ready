import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as Sentry from '@sentry/node';
import { ROUTES } from '@threatready/contracts';
import { newRequestId, scrub } from '@threatready/shared';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { AnthropicLlmAdapter } from './platform/adapters/anthropic-llm.adapter.js';
import { ContentService } from './platform/content/content.service.js';
import { Database } from './platform/db/database.js';
import { logger, requestContext } from './platform/logging/logger.js';
import { LLM_PORT } from './platform/ports/llm.port.js';

export function initSentry(cfg: AppConfig): void {
  if (!cfg.SENTRY_DSN) return;
  Sentry.init({
    dsn: cfg.SENTRY_DSN,
    environment: cfg.SENTRY_ENVIRONMENT ?? cfg.NODE_ENV,
    release: cfg.RELEASE,
    sendDefaultPii: false,
    // ADD L27: drop request bodies, resume and answer text, email addresses. Ids and request_id only.
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers.cookie;
          delete event.request.headers.authorization;
        }
        delete event.request.query_string;
      }
      if (event.user) event.user = { id: event.user.id };
      if (event.extra) event.extra = scrub(event.extra) as Record<string, unknown>;
      if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map((b) => ({ ...b, data: b.data ? (scrub(b.data) as Record<string, unknown>) : undefined }));
      return event;
    },
  });
}

/** Asserts every contract route is served by a handler (and vice versa) at boot. */
function assertRouteCoverage(app: NestExpressApplication): void {
  const router = app.getHttpAdapter().getInstance().router as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } | undefined;
  if (!router?.stack) return;
  const served = new Set(
    router.stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} ${l.route!.path.replace(/:(\w+)/g, '{$1}')}`)),
  );
  const missing = ROUTES.filter((r) => !served.has(`${r.method.toUpperCase()} ${r.path}`));
  if (missing.length) throw new Error(`Contract routes without handlers: ${missing.map((r) => r.id).join(', ')}`);
}

export async function createApiApp(cfg: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRole('api', cfg), { bodyParser: false, logger: ['error', 'warn'] });
  const http = app.getHttpAdapter().getInstance() as express.Express;
  http.disable('x-powered-by');
  // Per-user API data: never cached or revalidated (privacy on shared machines; no stale 304s).
  http.set('etag', false);
  http.set('trust proxy', 1);

  http.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && /^req_[\w-]{8,40}$/.test(incoming) ? incoming : newRequestId();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
    requestContext.run({ requestId }, next);
  });
  app.enableCors({ origin: cfg.allowedOrigins, credentials: true, exposedHeaders: ['X-Request-Id', 'Retry-After', 'X-Asset-Key', 'X-Asset-Iv'] });

  // Sign-in lives on onboard.threatready.io (the platform identity provider); there is no
  // /api/auth here. Requests carry the shared session cookie, resolved by IdentityAdapter.
  // 200 KB: a contract-valid 30,000-character document in any script (up to 4 bytes per character,
  // plus JSON escapes) must fit; the schema's character limit stays the real bound (TR-36).
  // Compressed request bodies are refused (400): browsers never send them, and the inflate path is where
  // body-parser <= 2.3.0 can be held by trailing bytes after the compressed data (GHSA-27r3-jxmh-p828).
  http.use(express.json({ limit: '200kb', inflate: false }));

  await app.get(ContentService).seed(app.get(Database));
  if (cfg.LLM_VERIFY_MODELS_ON_BOOT) {
    const port = app.get(LLM_PORT);
    if (port instanceof AnthropicLlmAdapter) await port.verifyModels();
  }
  await app.init();
  assertRouteCoverage(app);
  return app;
}

export async function createWorker(cfg: AppConfig) {
  const ctx = await NestFactory.createApplicationContext(AppModule.forRole('worker', cfg), { logger: ['error', 'warn'] });
  await ctx.get(ContentService).seed(ctx.get(Database));
  return ctx;
}

export { APP_CONFIG, logger };
