import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, loadConfig, type AppConfig } from './config/config.js';
import { AnthropicLlmAdapter } from './platform/adapters/anthropic-llm.adapter.js';
import { FakeLlmAdapter } from './platform/adapters/fake-llm.adapter.js';
import { FilesystemStorageAdapter } from './platform/adapters/fs-storage.adapter.js';
import { PgBossQueueAdapter } from './platform/adapters/pgboss-queue.adapter.js';
import { S3StorageAdapter } from './platform/adapters/s3-storage.adapter.js';
import { InMemoryCacheAdapter, LogEmailAdapter, SesEmailAdapter } from './platform/adapters/simple-adapters.js';
import { AUTH_ADAPTER, IdentityAdapter } from './platform/auth/identity.adapter.js';
import { ContentService } from './platform/content/content.service.js';
import { Database } from './platform/db/database.js';
import { DevStorageController } from './platform/http/dev-storage.controller.js';
import { EnvelopeExceptionFilter } from './platform/http/exception.filter.js';
import { RouteGuard } from './platform/http/route.guard.js';
import { CACHE_PORT } from './platform/ports/cache.port.js';
import { EMAIL_PORT } from './platform/ports/email.port.js';
import { LLM_PORT } from './platform/ports/llm.port.js';
import { QUEUE_PORT } from './platform/ports/queue.port.js';
import { STORAGE_PORT } from './platform/ports/storage.port.js';
import { LlmService } from './modules/ai/llm.service.js';
import { AssetsController, DocumentsController, HealthController, InterviewsController, MeController, ProgressController } from './modules/controllers.js';
import { InternalController } from './modules/platform/internal.controller.js';
import { PlatformService } from './modules/platform/platform.service.js';
import { AssetsService } from './modules/assets/assets.service.js';
import { DocumentsService } from './modules/documents/documents.service.js';
import { AnalysisService } from './modules/interview/analysis.service.js';
import { InterviewService } from './modules/interview/interview.service.js';
import { TurnService } from './modules/interview/turn.service.js';
import { JobsService } from './modules/jobs/jobs.service.js';
import { ReportsService } from './modules/reports/reports.service.js';
import { SkillsService } from './modules/skills/skills.service.js';

export type AppRole = 'api' | 'worker';

/** Port bindings: adapters are chosen by configuration, domain code sees only the ports (ADD §6). */
function portProviders(role: AppRole): Provider[] {
  return [
    {
      provide: LLM_PORT,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => (cfg.LLM_DRIVER === 'fake' ? new FakeLlmAdapter(cfg) : new AnthropicLlmAdapter(cfg)),
    },
    {
      provide: STORAGE_PORT,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) =>
        cfg.STORAGE_DRIVER === 'fs'
          ? new FilesystemStorageAdapter(cfg.FS_STORAGE_DIR, cfg.API_BASE_URL, cfg.BETTER_AUTH_SECRET)
          : new S3StorageAdapter(cfg.S3_BUCKET!, cfg.AWS_REGION),
    },
    {
      provide: QUEUE_PORT,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => new PgBossQueueAdapter(role === 'worker' ? (cfg.WORKER_DATABASE_URL ?? cfg.DATABASE_URL) : cfg.DATABASE_URL, role),
    },
    {
      provide: EMAIL_PORT,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => (cfg.EMAIL_DRIVER === 'ses' ? new SesEmailAdapter(cfg.AWS_REGION, cfg.SES_FROM_ADDRESS!) : new LogEmailAdapter()),
    },
    { provide: CACHE_PORT, useValue: new InMemoryCacheAdapter() },
  ];
}

@Global()
@Module({})
export class PlatformModule {
  static forRole(role: AppRole, cfg: AppConfig): DynamicModule {
    return {
      module: PlatformModule,
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        Database,
        ContentService,
        ...portProviders(role),
        {
          provide: AUTH_ADAPTER,
          inject: [APP_CONFIG, Database],
          useFactory: (c: AppConfig, db: Database) => new IdentityAdapter(c, db),
        },
      ],
      exports: [APP_CONFIG, Database, ContentService, LLM_PORT, STORAGE_PORT, QUEUE_PORT, EMAIL_PORT, CACHE_PORT, AUTH_ADAPTER],
    };
  }
}

const domainProviders: Provider[] = [LlmService, DocumentsService, AnalysisService, InterviewService, TurnService, ReportsService, SkillsService, AssetsService];

@Module({})
export class AppModule {
  static forRole(role: AppRole, cfg: AppConfig = loadConfig()): DynamicModule {
    if (role === 'worker') {
      return { module: AppModule, imports: [PlatformModule.forRole(role, cfg)], providers: [...domainProviders, JobsService] };
    }
    const controllers: DynamicModule['controllers'] = [DocumentsController, InterviewsController, ProgressController, AssetsController, HealthController, MeController, InternalController];
    if (cfg.STORAGE_DRIVER === 'fs') controllers.push(DevStorageController);
    return {
      module: AppModule,
      imports: [PlatformModule.forRole(role, cfg)],
      controllers,
      providers: [...domainProviders, JobsService, PlatformService, { provide: APP_GUARD, useClass: RouteGuard }, { provide: APP_FILTER, useClass: EnvelopeExceptionFilter }],
    };
  }
}
