import { memberships, organisations, users } from '@threatready/db';
import { DomainError } from '@threatready/shared';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import type { AppConfig } from '../../config/config.js';
import type { Database } from '../db/database.js';
import { logger } from '../logging/logger.js';
import type { MembershipRole, Principal } from '../authz/principal.js';

/** Shape of onboard's GET /api/internal/identity/session (onboard packages/contracts/src/platform.ts). */
const IdentitySchema = z.object({
  user: z.object({
    id: z.string().min(1).max(100),
    name: z.string(),
    email: z.string().nullable(),
    emailVerified: z.boolean(),
    username: z.string().nullable(),
    image: z.string().nullable(),
    isTrial: z.boolean(),
    isAdmin: z.boolean(),
  }),
  session: z.object({ id: z.string(), expiresAt: z.string() }),
});

export interface ResolvedSession {
  principal: Principal | null;
  /** Session-refresh cookies from onboard to relay to the browser (Domain=threatready.io). */
  setCookies: string[];
  image: string | null;
}

const TIMEOUT_MS = 5_000;
const CACHE_MAX = 5_000;

/**
 * ADD §6 AuthPort, platform edition. Sign-in happens once, on onboard.threatready.io; this app
 * never sees a password. The browser's cookie (shared across *.threatready.io) is forwarded to
 * onboard, which answers with the user. The user row is mirrored locally because interview data
 * references users(id); onboard stays the authority for every field in it.
 */
export class IdentityAdapter {
  private readonly cache = new Map<string, { at: number; value: ResolvedSession }>();
  /** Users whose mirror row and personal organisation are known to exist in this process. */
  private readonly provisioned = new Map<string, string>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Database,
  ) {}

  async resolve(headers: IncomingHttpHeaders): Promise<ResolvedSession> {
    const cookie = headers.cookie;
    if (!cookie) return { principal: null, setCookies: [], image: null };

    const key = createHash('sha256').update(cookie).digest('base64url');
    const ttl = this.cfg.IDENTITY_CACHE_SECONDS * 1000;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return { ...hit.value, setCookies: [] };

    let res: Response;
    try {
      res = await fetch(`${this.cfg.IDENTITY_URL.replace(/\/+$/, '')}/api/internal/identity/session`, {
        headers: { cookie, authorization: `Bearer ${this.cfg.INTERNAL_API_TOKEN}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'identity provider unreachable');
      throw new DomainError('AUTH_PROVIDER_UNAVAILABLE');
    }
    const setCookies = res.headers.getSetCookie?.() ?? [];

    if (res.status === 401) {
      this.cache.delete(key);
      return { principal: null, setCookies, image: null };
    }
    if (!res.ok) {
      logger.error({ status: res.status }, 'identity provider error');
      throw new DomainError('AUTH_PROVIDER_UNAVAILABLE');
    }
    const parsed = IdentitySchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      logger.error({ issue: parsed.error.issues[0]?.message }, 'identity provider returned an unexpected shape');
      throw new DomainError('AUTH_PROVIDER_UNAVAILABLE');
    }

    const { user, session } = parsed.data;
    // A no-account trial session exists only on onboard; this app needs an account.
    if (user.isTrial || !user.email) throw new DomainError('AUTH_ACCOUNT_REQUIRED');

    const membership = await this.provision(user);
    const value: ResolvedSession = {
      principal: {
        userId: user.id,
        sessionId: session.id,
        orgId: membership.orgId,
        role: membership.role,
        isStaff: user.isAdmin,
        email: user.email,
        name: user.name || user.username || user.email,
        image: user.image,
      },
      setCookies,
      image: user.image,
    };
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    if (ttl > 0) this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Mirrors the user (on first sight or when a field changed) and returns the active membership. */
  private async provision(user: z.infer<typeof IdentitySchema>['user']): Promise<{ orgId: string; role: MembershipRole }> {
    const fingerprint = JSON.stringify([user.name, user.email, user.emailVerified, user.image, user.isAdmin]);
    const name = user.name || user.username || user.email || 'Learner';
    if (this.provisioned.get(user.id) !== fingerprint) {
      await this.db.system(async ({ db }) => {
        await db
          .insert(users)
          .values({ id: user.id, name, email: user.email!, emailVerified: user.emailVerified, image: user.image, isStaff: user.isAdmin })
          .onConflictDoUpdate({
            target: users.id,
            set: { name, email: user.email!, emailVerified: user.emailVerified, image: user.image, isStaff: user.isAdmin, updatedAt: sql`now()` },
          });
      });
      if (this.provisioned.size >= CACHE_MAX) this.provisioned.clear();
      this.provisioned.set(user.id, fingerprint);
    }
    const [m] = await this.db.db
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, user.id), eq(memberships.isActive, true)))
      .limit(1);
    return m ?? ensurePersonalOrg(this.db, user.id, name);
  }
}

/** An individual learner gets a personal organisation (L7 tenant context). Idempotent. */
async function ensurePersonalOrg(db: Database, userId: string, name: string): Promise<{ orgId: string; role: MembershipRole }> {
  return db.system(async ({ db: tx }) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 7))`);
    const [existing] = await tx
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.isActive, true)))
      .limit(1);
    if (existing) return existing;
    const [org] = await tx.insert(organisations).values({ name: `${name} (personal)`, kind: 'personal' }).returning();
    await tx.insert(memberships).values({ userId, orgId: org!.id, role: 'learner' });
    return { orgId: org!.id, role: 'learner' as const };
  });
}

export const AUTH_ADAPTER = Symbol('AuthAdapter');
