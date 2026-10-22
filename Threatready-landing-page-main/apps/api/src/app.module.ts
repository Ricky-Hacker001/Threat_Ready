import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AccountController } from "./account/account.controller.js";
import { ActivityController } from "./activity/activity.controller.js";
import { AdminController } from "./admin/admin.controller.js";
import { AdminService } from "./admin/admin.service.js";
import { CaptchaService } from "./account/captcha.service.js";
import { AUTH, createAuth } from "./auth/auth.js";
import { AuthGuard } from "./authz/auth.guard.js";
import { HttpExceptionFilter } from "./common/http-exception.filter.js";
import { CONFIG, type Config } from "./config.js";
import { DB, PG_POOL, createDb, createPool, type Db } from "./db/db.js";
import { DevController } from "./dev/dev.controller.js";
import { EMAIL_PORT, LogEmailAdapter, ResendEmailAdapter, SesEmailAdapter, type EmailPort } from "./email/email.port.js";
import { FeaturesController } from "./features/features.controller.js";
import { FeaturesService } from "./features/features.service.js";
import { AppsClient } from "./platform/apps.client.js";
import { PlatformController } from "./platform/platform.controller.js";
import { PublicController } from "./public/public.controller.js";

@Module({})
export class AppModule {
  static forRoot(config: Config): DynamicModule {
    const pool = createPool(config.DATABASE_URL);
    const db = createDb(pool);
    const email: EmailPort =
      config.EMAIL_DRIVER === "ses"
        ? new SesEmailAdapter(config.AWS_REGION, config.EMAIL_FROM)
        : config.EMAIL_DRIVER === "resend"
          ? new ResendEmailAdapter(config.RESEND_API_KEY!, config.EMAIL_FROM)
          : new LogEmailAdapter();
    const auth = createAuth(config, db, email);

    const devControllers = config.EMAIL_DRIVER === "log" && config.NODE_ENV !== "production" ? [DevController] : [];

    return {
      module: AppModule,
      imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 60 }])],
      controllers: [
        PublicController,
        FeaturesController,
        AccountController,
        PlatformController,
        AdminController,
        ActivityController,
        ...devControllers,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: PG_POOL, useValue: pool },
        { provide: DB, useValue: db satisfies Db },
        { provide: EMAIL_PORT, useValue: email },
        { provide: AUTH, useValue: auth },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        FeaturesService,
        CaptchaService,
        AppsClient,
        AdminService,
      ],
    };
  }
}
