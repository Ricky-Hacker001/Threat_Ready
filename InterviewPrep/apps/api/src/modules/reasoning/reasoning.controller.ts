import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { AppAiUsage, CreateReasoningAttemptRequest, SubmitReasoningRequest } from '@threatready/contracts';
import { DomainError } from '@threatready/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { AUTH_ADAPTER, type IdentityAdapter } from '../../platform/auth/identity.adapter.js';
import { Public, Route } from '../../platform/http/route.decorator.js';
import type { AuthedRequest } from '../../platform/http/route.guard.js';
import { acquireStreamSlot, SSE_IDENTITY_RECHECK_MS, SseStream } from '../../platform/http/sse.js';
import { assertInternalCaller } from '../platform/internal.controller.js';
import { PlatformService } from '../platform/platform.service.js';
import { ReasoningService } from './reasoning.service.js';

const STABLE = new Set(['ready', 'evaluated', 'generation_failed', 'evaluation_failed']);

@Controller('v1/reasoning')
export class ReasoningController {
  constructor(
    @Inject(ReasoningService) private readonly reasoning: ReasoningService,
    @Inject(AUTH_ADAPTER) private readonly auth: IdentityAdapter,
  ) {}

  @Get('domains')
  @Route('listReasoningDomains')
  domains(@Req() req: AuthedRequest) {
    return this.reasoning.domains(req.principal);
  }

  @Get('dashboard')
  @Route('getReasoningDashboard')
  dashboard(@Req() req: AuthedRequest) {
    return this.reasoning.dashboard(req.principal);
  }

  @Post('attempts')
  @HttpCode(202)
  @Route('createReasoningAttempt')
  create(@Req() req: AuthedRequest, @Body() body: CreateReasoningAttemptRequest) {
    return this.reasoning.create(req.principal, body);
  }

  @Post('attempts/prefetch')
  @HttpCode(202)
  @Route('prefetchReasoningAttempt')
  prefetch(@Req() req: AuthedRequest, @Body() body: CreateReasoningAttemptRequest) {
    return this.reasoning.poolStatus(req.principal, body);
  }

  @Post('attempts/:id/abandon')
  @HttpCode(200)
  @Route('abandonReasoningAttempt')
  abandon(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.reasoning.abandon(req.principal, id);
  }

  @Get('attempts')
  @Route('listReasoningAttempts')
  list(@Req() req: AuthedRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const n = Math.min(50, Math.max(1, Number(limit) || 20));
    return this.reasoning.list(req.principal, cursor, n);
  }

  @Get('attempts/:id')
  @Route('getReasoningAttempt')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.reasoning.get(req.principal, id);
  }

  /** SSE: state changes while generation or evaluation runs; ends at a stable state (same shape as interviews). */
  @Get('attempts/:id/events')
  @Route('streamReasoningEvents')
  async events(@Req() req: AuthedRequest, @Param('id') id: string, @Res() res: Response) {
    let state = await this.reasoning.stateOf(req.principal, id);
    // At most a few streams per user, and the stream ends when the session is signed out or revoked.
    const release = acquireStreamSlot(req.principal.userId);
    res.on('close', release);
    try {
      const sse = new SseStream(res);
      sse.open();
      let last = '';
      const deadline = Date.now() + 5 * 60_000;
      let nextIdentityCheck = Date.now() + SSE_IDENTITY_RECHECK_MS;
      // Each poll is a database read: every 2 s just after a change, easing to every 5 s while nothing moves (audit TR-25).
      let pollMs = 2000;
      while (!sse.isClosed && Date.now() < deadline) {
        const sig = `${state.state}:${state.version}`;
        if (sig !== last) {
          last = sig;
          pollMs = 2000;
          sse.send({ type: 'state', state: state.state, version: state.version });
          if (STABLE.has(state.state)) break;
        } else pollMs = Math.min(5000, pollMs + 1000);
        await new Promise((r) => setTimeout(r, pollMs));
        if (Date.now() >= nextIdentityCheck) {
          nextIdentityCheck = Date.now() + SSE_IDENTITY_RECHECK_MS;
          const still = await this.auth.resolve(req.headers).catch(() => null);
          if (still?.principal?.userId !== req.principal.userId) break;
        }
        state = await this.reasoning.stateOf(req.principal, id).catch(() => state);
      }
      sse.end();
    } finally {
      release();
    }
  }

  @Post('attempts/:id/submit')
  @HttpCode(202)
  @Route('submitReasoningAnswer')
  submit(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: SubmitReasoningRequest) {
    return this.reasoning.submit(req.principal, id, body);
  }

  @Post('attempts/:id/retry')
  @HttpCode(202)
  @Route('retryReasoningAttempt')
  retry(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.reasoning.retry(req.principal, id);
  }

  @Get('attempts/:id/result')
  @Route('getReasoningResult')
  result(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.reasoning.result(req.principal, id);
  }
}

const DAY = 86_400_000;
const UsageQuery = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), userId: z.string().min(1).max(100).optional() });

/**
 * Service-to-service API for the Attack Reasoning gateway (which answers onboard's profile overview
 * and admin console for ar.threatready.io). Same token rule as the interview internal API.
 */
@Controller('internal/v1/reasoning')
export class ReasoningInternalController {
  constructor(
    @Inject(ReasoningService) private readonly reasoning: ReasoningService,
    @Inject(PlatformService) private readonly platform: PlatformService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Get('users/:userId/summary')
  @Public()
  summary(@Req() req: Request, @Param('userId') userId: string, @Query('appOrigin') appOrigin?: string) {
    assertInternalCaller(req, this.cfg.internalTokensAccept);
    if (!userId || userId.length > 100) throw new DomainError('VALIDATION_FAILED');
    const origin = typeof appOrigin === 'string' && /^https?:\/\//.test(appOrigin) && appOrigin.length < 200 ? appOrigin : `${this.cfg.APP_ORIGIN}/ar`;
    return this.reasoning.platformSummary(userId, origin);
  }

  @Get('ai-usage')
  @Public()
  aiUsage(@Req() req: Request, @Query() query: Record<string, unknown>): Promise<AppAiUsage> {
    assertInternalCaller(req, this.cfg.internalTokensAccept);
    const q = UsageQuery.safeParse(query);
    if (!q.success) throw new DomainError('VALIDATION_FAILED', { details: q.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const from = new Date(q.data.from);
    const to = new Date(q.data.to);
    if (from >= to || to.getTime() - from.getTime() > 400 * DAY) throw new DomainError('VALIDATION_FAILED', { message: 'Invalid range' });
    return this.platform.aiUsage(from, to, q.data.userId ?? null, 'reasoning');
  }
}
