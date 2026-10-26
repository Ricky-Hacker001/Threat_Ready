import 'reflect-metadata';
import { runMigrations } from '@threatready/db';
import { loadConfig } from './config/config.js';
import { installCrashHandlers } from './platform/crash.js';

/**
 * One image, three commands (ADD L1/L20): `api` serves HTTP, `worker` runs pg-boss jobs with no
 * inbound port, `migrate` applies SQL migrations before a deploy. `all` runs api + worker in one
 * process for single-instance hosts.
 */
const role = (process.argv[2] ?? 'api') as 'api' | 'worker' | 'all' | 'migrate';
process.env.APP_ROLE = role;

const cfg = loadConfig();
// Behind the gateway the API binds loopback only (HOST=127.0.0.1); every interface otherwise.
const HOST = process.env.HOST ?? '0.0.0.0';
const { createApiApp, createWorker, initSentry, logger } = await import('./bootstrap.js');
initSentry(cfg);
installCrashHandlers({
  log: logger,
  flush: () => (cfg.SENTRY_DSN ? import('@sentry/node').then((s) => s.flush(2_000)) : Promise.resolve()),
  exit: (code) => process.exit(code),
});
logger.info(
  { model_small: cfg.LLM_MODEL_SMALL, model_large: cfg.LLM_MODEL_LARGE, ...cfg.interviewCostEstimate, session_cap_usd: cfg.AI_SESSION_CAP_USD, user_daily_cap_usd: cfg.AI_USER_DAILY_CAP_USD, global_daily_cap_usd: cfg.AI_GLOBAL_DAILY_CAP_USD },
  'AI budget resolved from the pricing table',
);

if (role === 'migrate') {
  await runMigrations(cfg.WORKER_DATABASE_URL ?? cfg.DATABASE_URL);
  logger.info('migrations applied');
  process.exit(0);
}

if (role === 'worker') {
  const ctx = await createWorker(cfg);
  const { JobsService } = await import('./modules/jobs/jobs.service.js');
  await ctx.get(JobsService).startWorker();
  const stop = async () => {
    logger.info('worker stopping');
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else if (role === 'all') {
  // Small single-instance hosts (Render free: no background workers, 512 MB): the API and the
  // pg-boss worker share one process. Same code paths as the separate roles.
  process.env.APP_ROLE = 'api';
  const app = await createApiApp(cfg);
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, HOST);
  logger.info({ port: cfg.PORT, host: HOST }, 'api listening (worker in-process)');
  process.env.APP_ROLE = 'worker';
  const ctx = await createWorker(cfg);
  process.env.APP_ROLE = 'api';
  const { JobsService } = await import('./modules/jobs/jobs.service.js');
  await ctx.get(JobsService).startWorker();
  const stop = async () => {
    await ctx.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else {
  const app = await createApiApp(cfg);
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, HOST);
  logger.info({ port: cfg.PORT, host: HOST }, 'api listening');
}
