import 'reflect-metadata';
import { runMigrations } from '@threatready/db';
import { loadConfig } from './config/config.js';

/**
 * One image, three commands (ADD L1/L20): `api` serves HTTP, `worker` runs pg-boss jobs with no
 * inbound port, `migrate` applies SQL migrations before a deploy. `all` runs api + worker in one
 * process for single-instance hosts.
 */
const role = (process.argv[2] ?? 'api') as 'api' | 'worker' | 'all' | 'migrate';
process.env.APP_ROLE = role;

const cfg = loadConfig();
const { createApiApp, createWorker, initSentry, logger } = await import('./bootstrap.js');
initSentry(cfg);

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
  await app.listen(cfg.PORT);
  logger.info({ port: cfg.PORT }, 'api listening (worker in-process)');
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
  await app.listen(cfg.PORT);
  logger.info({ port: cfg.PORT }, 'api listening');
}
