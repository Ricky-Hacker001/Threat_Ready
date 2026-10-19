import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { AppAiUsage, AppSummary } from '@threatready/contracts';
import { DomainError } from '@threatready/shared';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { Public } from '../../platform/http/route.decorator.js';
import { PlatformService } from './platform.service.js';

const DAY = 86_400_000;

/** Constant-time check of `Authorization: Bearer <INTERNAL_API_TOKEN>`; shared by every internal controller. */
export function assertInternalCaller(req: Request, token: string): void {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  const a = createHash('sha256').update(m?.[1] ?? '').digest();
  const b = createHash('sha256').update(token).digest();
  if (!m || !timingSafeEqual(a, b)) throw new DomainError('AUTH_REQUIRED');
}
const UsageQuery = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  userId: z.string().min(1).max(100).optional(),
});

/**
 * Service-to-service API for onboard.threatready.io (profile overview, admin console).
 * Not routed through Cloudflare: onboard reaches it in-VPC, and every call must carry
 * `Authorization: Bearer <INTERNAL_API_TOKEN>`. Browsers have no way in.
 */
@Controller('internal/v1')
export class InternalController {
  constructor(
    @Inject(PlatformService) private readonly platform: PlatformService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private assertCaller(req: Request): void {
    assertInternalCaller(req, this.cfg.INTERNAL_API_TOKEN);
  }

  @Get('users/:userId/summary')
  @Public()
  summary(@Req() req: Request, @Param('userId') userId: string): Promise<AppSummary> {
    this.assertCaller(req);
    if (!userId || userId.length > 100) throw new DomainError('VALIDATION_FAILED');
    return this.platform.summary(userId);
  }

  @Get('ai-usage')
  @Public()
  aiUsage(@Req() req: Request, @Query() query: Record<string, unknown>): Promise<AppAiUsage> {
    this.assertCaller(req);
    const q = UsageQuery.safeParse(query);
    if (!q.success) throw new DomainError('VALIDATION_FAILED', { details: q.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const from = new Date(q.data.from);
    const to = new Date(q.data.to);
    if (from >= to || to.getTime() - from.getTime() > 400 * DAY) throw new DomainError('VALIDATION_FAILED', { message: 'Invalid range' });
    return this.platform.aiUsage(from, to, q.data.userId ?? null, 'interview');
  }
}
