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
/** A cookie onboard rejected is remembered this long, so a flood of junk cookies costs one lookup each per window. */
const NEGATIVE_TTL_MS = 10_000;
/**
 * A session onboard confirmed within this window skips the in-flight caps when its cache entry expires
 * (still looked up, never shed). 12 h, as the labs, Red Team and Attack Reasoning resolvers.
 */
const KNOWN_GOOD_MS = 12 * 3600_000;
const SATURATION_LOG_MS = 10_000;

/** Cold lookups queued behind one client's in-flight share; beyond this they are refused at once. */
const MAX_WAITERS_PER_CLIENT = 64;

/**
 * How long a cold lookup over its client's in-flight share waits for a slot before it is refused, so
 * a classroom behind one NAT signing in at once is queued, not turned away. Mutable for tests.
 */
export const IDENTITY_TIMING = { clientWaitMs: 2_000 };

/**
 * The Better Auth session cookie onboard sets (`tr.session_token`, `__Secure-` over https):
 * `<token>.<signature>` URL-encoded, the signature 44 base64 characters ending in "=" (better-call's
 * signed cookie, exactly what onboard accepts). The same test as the labs, Red Team and onboard
 * resolvers. Anything else cannot be a session, so it is answered as signed out without asking
 * onboard and without taking an in-flight slot (audit 2026-10-23 IP-REG1). Returns the decoded value.
 */
const SESSION_COOKIE_NAME = /^(?:__Secure-)?tr\.session_token$/;

export function sessionTokenOf(cookie: string | undefined): string | null {
  if (!cookie || cookie.length > 8192) return null;
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0 || !SESSION_COOKIE_NAME.test(part.slice(0, i).trim())) continue;
    let v: string;
    try {
      v = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      continue;
    }
    const dot = v.lastIndexOf('.');
    const sig = v.slice(dot + 1);
    if (dot >= 1 && dot <= 256 && sig.length === 44 && sig.endsWith('=') && /^[A-Za-z0-9+/]+=*$/.test(sig) && !/[\s;,]/.test(v)) return v;
  }
  return null;
}

/**
 * ADD §6 AuthPort, platform edition. Sign-in happens once, on onboard.threatready.io; this app
 * never sees a password. The browser's cookie (shared across *.threatready.io) is forwarded to
 * onboard, which answers with the user. The user row is mirrored locally because interview data
 * references users(id); onboard stays the authority for every field in it.
 */
export class IdentityAdapter {
  /** Insertion-ordered: a hit is re-inserted, so the first key is the least recently used. */
  private readonly cache = new Map<string, { at: number; value: ResolvedSession }>();
  /** sha256(session token) -> when onboard answered 401 for it. Every cache here is keyed on the token, not the whole Cookie header. */
  private readonly negative = new Map<string, number>();
  /** One lookup per cookie at a time; concurrent requests with the same cookie share it. */
  private readonly inFlight = new Map<string, Promise<ResolvedSession>>();
  /** Lookups in flight per client address, so one source cannot fill the global cap. */
  private readonly inFlightByClient = new Map<string, number>();
  /** Cold lookups waiting for one of their client's slots, woken in order as lookups finish. */
  private readonly waiters = new Map<string, (() => void)[]>();
  /** sha256(token) -> when onboard last confirmed it: these sessions are never shed by the caps. */
  private readonly knownGood = new Map<string, number>();
  private shed = { count: 0, loggedAt: 0 };
  /** Users whose mirror row and personal organisation are known to exist in this process. */
  private readonly provisioned = new Map<string, string>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Database,
  ) {}

  /**
   * `clientKey` (the caller's address, see clientKeyOf) bounds that caller's concurrent lookups: past
   * its share a cold lookup waits briefly for a slot, then is refused with a retryable 429. A cached
   * or recently confirmed session never waits behind other callers' lookups.
   */
  async resolve(headers: IncomingHttpHeaders, clientKey?: string): Promise<ResolvedSession> {
    const cookie = headers.cookie;
    const token = sessionTokenOf(cookie);
    if (!cookie || !token) return { principal: null, setCookies: [], image: null };

    const key = createHash('sha256').update(token).digest('base64url');
    const ttl = this.cfg.IDENTITY_CACHE_SECONDS * 1000;
    const perClient = this.cfg.IDENTITY_MAX_IN_FLIGHT_PER_CLIENT;
    const total = this.cfg.IDENTITY_MAX_IN_FLIGHT;
    const deadline = Date.now() + IDENTITY_TIMING.clientWaitMs;
    let known: boolean;
    for (;;) {
      const answered = this.answered(key, ttl);
      if (answered) return answered;
      const confirmedAt = this.knownGood.get(key);
      known = confirmedAt !== undefined && Date.now() - confirmedAt < KNOWN_GOOD_MS;
      if (known || !clientKey || perClient <= 0 || (this.inFlightByClient.get(clientKey) ?? 0) < perClient) break;
      // Woken when one of this client's lookups ends; the answer may then be cached or in flight.
      if (await this.waitForSlot(clientKey, deadline - Date.now())) continue;
      this.noteShed('client');
      throw new DomainError('RATE_LIMITED', { message: 'Too many sign-in checks at once from this network; try again shortly', retryAfterSec: 1, retryable: true, details: { reason: 'busy' } });
    }
    if (!known && total > 0 && this.inFlight.size >= total) {
      this.noteShed('total');
      throw new DomainError('AUTH_PROVIDER_UNAVAILABLE', { retryAfterSec: 2, details: { reason: 'busy' } });
    }
    const client = known ? undefined : clientKey;
    if (client) this.inFlightByClient.set(client, (this.inFlightByClient.get(client) ?? 0) + 1);
    const lookup = this.lookup(cookie, key, ttl).finally(() => {
      this.inFlight.delete(key);
      if (!client) return;
      const n = (this.inFlightByClient.get(client) ?? 1) - 1;
      if (n <= 0) this.inFlightByClient.delete(client);
      else this.inFlightByClient.set(client, n);
      // Every waiter re-checks: the first takes the slot, one whose answer is now cached needs none,
      // the rest wait again. Waking only one could strand the others behind a free slot.
      const queue = this.waiters.get(client);
      this.waiters.delete(client);
      for (const wake of queue ?? []) wake();
    });
    this.inFlight.set(key, lookup);
    return lookup;
  }

  /** A cached answer for this session, a shared lookup already in flight, or null. */
  private answered(key: string, ttl: number): ResolvedSession | Promise<ResolvedSession> | null {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) {
      this.cache.delete(key);
      this.cache.set(key, hit); // most recently used
      return { ...hit.value, setCookies: [] };
    }
    const rejectedAt = this.negative.get(key);
    if (rejectedAt !== undefined) {
      if (Date.now() - rejectedAt < NEGATIVE_TTL_MS) return { principal: null, setCookies: [], image: null };
      this.negative.delete(key);
    }
    const pending = this.inFlight.get(key);
    return pending ? pending.then((v) => ({ ...v, setCookies: [] })) : null;
  }

  /** Waits up to `ms` for one of the client's lookups to end; false when the time is up or the queue is full. */
  private waitForSlot(client: string, ms: number): Promise<boolean> {
    const queue = this.waiters.get(client) ?? [];
    if (ms <= 0 || queue.length >= MAX_WAITERS_PER_CLIENT) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const q = this.waiters.get(client);
        const i = q?.indexOf(wake) ?? -1;
        if (q && i >= 0) q.splice(i, 1);
        if (q && !q.length) this.waiters.delete(client);
        resolve(false);
      }, ms);
      queue.push(wake);
      this.waiters.set(client, queue);
    });
  }

  /** Shedding is load, not a fault: one warning per interval with the count, never a line per request. */
  private noteShed(cap: 'client' | 'total'): void {
    this.shed.count += 1;
    if (Date.now() - this.shed.loggedAt < SATURATION_LOG_MS) return;
    logger.warn({ shed: this.shed.count, cap, in_flight: this.inFlight.size }, 'identity lookups shed');
    this.shed = { count: 0, loggedAt: Date.now() };
  }

  private async lookup(cookie: string, key: string, ttl: number): Promise<ResolvedSession> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.IDENTITY_URL.replace(/\/+$/, '')}/api/internal/identity/session`, {
        headers: { cookie, authorization: `Bearer ${this.cfg.internalTokenToOnboard}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'identity provider unreachable');
      throw new DomainError('AUTH_PROVIDER_UNAVAILABLE');
    }
    const setCookies = res.headers.getSetCookie?.() ?? [];

    if (res.status === 401) {
      this.cache.delete(key);
      this.knownGood.delete(key);
      if (this.negative.size >= CACHE_MAX) this.negative.delete(this.negative.keys().next().value!);
      this.negative.set(key, Date.now());
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
    this.negative.delete(key);
    // Full: evict the least recently used entry instead of dropping every session at once.
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    if (ttl > 0) this.cache.set(key, { at: Date.now(), value });
    this.knownGood.delete(key);
    if (this.knownGood.size >= CACHE_MAX) this.knownGood.delete(this.knownGood.keys().next().value!);
    this.knownGood.set(key, Date.now());
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
