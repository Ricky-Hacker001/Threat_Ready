import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { routeById, type RateClass } from '@threatready/contracts';
import { DomainError } from '@threatready/shared';
import type { IncomingHttpHeaders } from 'node:http';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/config.js';
import { AUTH_ADAPTER, type IdentityAdapter } from '../auth/identity.adapter.js';
import { hasPermission, type Principal } from '../authz/principal.js';
import { requestContext } from '../logging/logger.js';
import { CACHE_PORT, type CachePort } from '../ports/cache.port.js';
import { PUBLIC_ROUTE, ROUTE_ID } from './route.decorator.js';

/** Tier-2 buckets by user and route class (ADD L12 starting values, from configuration). A limit of 0 is off. */
export function rateLimits(cfg: AppConfig): Record<RateClass, { limit: number; windowSec: number }> {
  return {
    general: { limit: cfg.INTERVIEW_RATE_GENERAL_PER_MIN, windowSec: 60 },
    upload: { limit: cfg.INTERVIEW_RATE_UPLOADS_PER_HOUR, windowSec: 3600 },
    jd_text: { limit: cfg.INTERVIEW_RATE_JD_TEXTS_PER_HOUR, windowSec: 3600 },
    document_edit: { limit: cfg.INTERVIEW_RATE_TEXT_EDITS_PER_HOUR, windowSec: 3600 },
    interview_turn: { limit: cfg.INTERVIEW_RATE_TURNS_PER_MIN, windowSec: 60 },
    interview_create: { limit: cfg.INTERVIEW_RATE_CREATES_PER_HOUR, windowSec: 3600 },
    reasoning_create: { limit: cfg.REASONING_RATE_CREATES_PER_HOUR, windowSec: 3600 },
  };
}

/** A wait longer than this is not retried automatically: the client shows when to try again instead. */
export const AUTO_RETRY_MAX_SEC = 10;

/**
 * The 429 for a spent bucket: Retry-After is the time left in the window (not the window length), and
 * a long wait is marked not retryable so clients stop and tell the learner when to come back.
 */
export function rateLimitedError(retryAfterSec: number, scope: string): DomainError {
  const wait = Math.max(1, Math.ceil(retryAfterSec));
  const when = wait <= 90 ? `in ${wait} seconds` : `in about ${Math.ceil(wait / 60)} minutes`;
  return new DomainError('RATE_LIMITED', {
    message: wait <= AUTO_RETRY_MAX_SEC ? 'Too many requests, try again shortly' : `You have reached the limit for this action; try again ${when}`,
    retryAfterSec: wait,
    retryable: wait <= AUTO_RETRY_MAX_SEC,
    details: { scope, retryAfterSec: wait },
  });
}

/**
 * The visitor's address for per-client limits: the header a trusted gateway sets (CLIENT_IP_HEADER, which
 * the gateway always overwrites), else Express's req.ip. IPv6 is reduced to its /64, the unit one client
 * controls, so rotating addresses inside a prefix does not give a fresh budget.
 */
export function clientKeyOf(cfg: Pick<AppConfig, 'CLIENT_IP_HEADER'>, headers: IncomingHttpHeaders, fallback: string | undefined): string {
  const header = cfg.CLIENT_IP_HEADER ? headers[cfg.CLIENT_IP_HEADER.toLowerCase()] : undefined;
  const raw = ((Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim() || fallback || 'unknown').replace(/^::ffff:/i, '');
  if (!raw.includes(':')) return raw;
  const groups = raw.split('%')[0]!.split('::');
  const head = groups[0] ? groups[0].split(':') : [];
  const tail = groups.length > 1 && groups[1] ? groups[1].split(':') : [];
  const full = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return `${full.slice(0, 4).map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

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

    const { principal, setCookies } = await this.auth.resolve(req.headers, clientKeyOf(this.cfg, req.headers, req.ip));
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

    // Input validation before the route's bucket: a learner whose upload or paste was refused as
    // invalid has not used up the hourly allowance for valid ones. Invalid requests still cost a
    // token of the cheap per-minute `general` bucket, so they are not free to repeat.
    const invalid = this.validate(route.id, route.body, req);
    if (invalid) {
      await this.charge(principal.userId, 'general');
      throw invalid;
    }
    await this.charge(principal.userId, route.rateClass);
    return true;
  }

  private async charge(userId: string, rateClass: RateClass): Promise<void> {
    const rl = rateLimits(this.cfg)[rateClass];
    const limit = rl.limit * this.cfg.RATE_LIMIT_SCALE;
    if (limit <= 0) return;
    const key = `rl:${userId}:${rateClass}`;
    const count = await this.cache.incr(key, rl.windowSec);
    if (count > limit) throw rateLimitedError((await this.cache.ttl(key)) ?? rl.windowSec, rateClass);
  }

  /** Path and body validation; returns the error to throw, or null and replaces the body with the parsed value. */
  private validate(routeId: string, body: ReturnType<typeof routeById>['body'], req: AuthedRequest): DomainError | null {
    for (const [name, value] of Object.entries(req.params ?? {})) {
      if (name === 'id' && !UUID.test(String(value))) return new DomainError('VALIDATION_FAILED', { details: [{ path: 'id', message: 'must be a UUID' }] });
    }
    if (!body) return null;
    const parsed = body.safeParse(req.body ?? {});
    if (parsed.success) {
      req.body = parsed.data;
      return null;
    }
    const tooBig = (field: string) => parsed.error.issues.some((i) => i.path[0] === field && i.code === 'too_big');
    if (routeId === 'submitAnswer' && tooBig('answer')) return new DomainError('INTERVIEW_ANSWER_TOO_LONG');
    if (routeId === 'submitReasoningAnswer' && tooBig('justification')) return new DomainError('REASONING_ANSWER_TOO_LONG');
    if ((routeId === 'createTextDocument' || routeId === 'updateDocumentText') && tooBig('text')) return new DomainError('TEXT_TOO_LONG');
    if (routeId === 'createTextDocument' && parsed.error.issues.some((i) => i.path[0] === 'text' && i.code === 'too_small')) return new DomainError('JD_TOO_SHORT');
    return new DomainError('VALIDATION_FAILED', { details: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
}
