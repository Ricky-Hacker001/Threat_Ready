import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { routeById, type RateClass } from '@threatready/contracts';
import { DomainError } from '@threatready/shared';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { AUTH_ADAPTER, type IdentityAdapter } from '../auth/identity.adapter.js';
import { hasPermission, type Principal } from '../authz/principal.js';
import { requestContext } from '../logging/logger.js';
import { CACHE_PORT, type CachePort } from '../ports/cache.port.js';
import { PUBLIC_ROUTE, ROUTE_ID } from './route.decorator.js';

/** Tier-2 token buckets by user and route class (ADD L12 starting values). */
const RATE_LIMITS: Record<RateClass, { limit: number; windowSec: number }> = {
  general: { limit: 600, windowSec: 60 },
  upload: { limit: 10, windowSec: 3600 },
  interview_turn: { limit: 40, windowSec: 60 },
  interview_create: { limit: 10, windowSec: 3600 },
  reasoning_create: { limit: 10, windowSec: 3600 },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AuthedRequest = Request & { principal: Principal };

/**
 * The guard chain (ADD L7, LLD-16): identity -> tenant -> role -> permission -> rate limit ->
 * input validation. Resource ownership is enforced by scoped queries in services, with RLS below.
 */
@Injectable()
export class RouteGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH_ADAPTER) private readonly auth: IdentityAdapter,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler();
    if (this.reflector.get<boolean>(PUBLIC_ROUTE, handler)) return true;
    const routeId = this.reflector.get<string>(ROUTE_ID, handler);
    if (!routeId) throw new DomainError('AUTH_FORBIDDEN', { message: 'Route has no declared permission' });
    const route = routeById(routeId);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();

    // State-changing requests must come from the app origin (SameSite=Lax plus Origin check).
    if (req.method !== 'GET' && !this.cfg.allowedOrigins.includes(req.headers.origin ?? '')) {
      throw new DomainError('AUTH_FORBIDDEN', { message: 'Cross-origin request refused' });
    }

    const { principal, setCookies } = await this.auth.resolve(req.headers);
    // Onboard may have refreshed the session while answering; pass its cookies to the browser.
    for (const c of setCookies) res.append('Set-Cookie', c);
    if (!principal) throw new DomainError('AUTH_REQUIRED');
    req.principal = principal;
    const store = requestContext.getStore();
    if (store) {
      store.userId = principal.userId;
      store.route = route.id;
    }

    if (!hasPermission(principal, route.permission)) throw new DomainError('AUTH_FORBIDDEN');

    const rl = RATE_LIMITS[route.rateClass];
    const count = await this.cache.incr(`rl:${principal.userId}:${route.rateClass}`, rl.windowSec);
    if (count > rl.limit * this.cfg.RATE_LIMIT_SCALE) {
      res.setHeader('Retry-After', String(rl.windowSec));
      throw new DomainError('RATE_LIMITED');
    }

    for (const [name, value] of Object.entries(req.params ?? {})) {
      if (name === 'id' && !UUID.test(String(value))) throw new DomainError('VALIDATION_FAILED', { details: [{ path: 'id', message: 'must be a UUID' }] });
    }
    if (route.body) {
      const parsed = route.body.safeParse(req.body ?? {});
      if (!parsed.success) {
        const details = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
        if (route.id === 'submitAnswer' && parsed.error.issues.some((i) => i.path[0] === 'answer' && i.code === 'too_big')) {
          throw new DomainError('INTERVIEW_ANSWER_TOO_LONG');
        }
        if (route.id === 'submitReasoningAnswer' && parsed.error.issues.some((i) => i.path[0] === 'justification' && i.code === 'too_big')) {
          throw new DomainError('REASONING_ANSWER_TOO_LONG');
        }
        throw new DomainError('VALIDATION_FAILED', { details });
      }
      req.body = parsed.data;
    }
    return true;
  }
}
