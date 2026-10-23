// Identity. Two modes:
//  - DEV_LOGIN (default on localhost): a self-contained cookie login so the lab runs standalone,
//    without the ThreatReady identity provider. A signed cookie `tr_lab_user` holds the display name.
//  - onboard: forwards the shared *.threatready.io session cookie to onboard's internal identity
//    endpoint (platform parity). Shape: onboard packages/contracts/src/platform.ts (Identity).
import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface PlatformUser { id: string; name: string; email: string | null; image: string | null; isTrial: boolean; isAdmin: boolean }
export type IdentityResult =
  | { ok: true; user: PlatformUser; setCookies: string[] }
  | { ok: false; reason: 'signed-out'; setCookies: string[] }
  | { ok: false; reason: 'unavailable' };
export type IdentityResolver = (headers: IncomingHttpHeaders) => Promise<IdentityResult>;

const str = (v: unknown, max = 500) => (typeof v === 'string' && v.length <= max ? v : null);

// ---------- dev login ----------
const DEV_COOKIE = 'tr_lab_user';
function sign(name: string, secret: string) { const mac = crypto.createHmac('sha256', secret).update(name).digest('base64url'); return `${Buffer.from(name).toString('base64url')}.${mac}`; }
function verify(value: string, secret: string): string | null {
  const [b, mac] = (value || '').split('.'); if (!b || !mac) return null;
  let name: string; try { name = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const expect = crypto.createHmac('sha256', secret).update(name).digest('base64url');
  try { if (crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return name; } catch { /* length mismatch */ }
  return null;
}
export function devUserCookie(name: string, secret: string): string {
  const v = sign(name.slice(0, 60), secret);
  return `${DEV_COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}
export function devLogoutCookie(): string { return `${DEV_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`; }

export function devIdentity(secret: string): IdentityResolver {
  return async (headers) => {
    const m = new RegExp(`(?:^|;\\s*)${DEV_COOKIE}=([^;]+)`).exec(headers.cookie || '');
    const name = m ? verify(decodeURIComponent(m[1]), secret) : null;
    if (!name) return { ok: false, reason: 'signed-out', setCookies: [] };
    const id = 'u_' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 16);
    return { ok: true, user: { id, name, email: null, image: null, isTrial: false, isAdmin: false }, setCookies: [] };
  };
}

// ---------- onboard (platform parity) ----------
/** Negative results (signed-out cookies) are remembered this long, so a flood of bad cookies cannot fan out to onboard. */
const NEGATIVE_TTL_MS = 10_000;
const MAX_CACHE = 5000;
const MAX_IN_FLIGHT = 50;

/**
 * Resolver backed by onboard. Positive results are cached for `cacheSeconds` per cookie (revocation
 * lags that much), negative ones for 10 s; identical in-flight lookups are coalesced and at most
 * `maxInFlight` lookups run at once (beyond that the caller gets `unavailable`, a retryable 503).
 */
export function onboardIdentity(opts: { identityUrl: string; internalToken: string; cacheSeconds?: number; timeoutMs?: number; maxInFlight?: number }): IdentityResolver {
  const cache = new Map<string, { at: number; ttl: number; user: PlatformUser | null }>();
  const inflight = new Map<string, Promise<IdentityResult>>();
  const ttl = (opts.cacheSeconds ?? 30) * 1000;
  const maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT;
  const base = opts.identityUrl.replace(/\/+$/, '');
  const remember = (key: string, user: PlatformUser | null, entryTtl: number) => {
    if (entryTtl <= 0) return;
    cache.delete(key); // re-insert at the end: Map order is insertion order, so the oldest entries come first
    if (cache.size >= MAX_CACHE) { let n = Math.ceil(MAX_CACHE / 10); for (const k of cache.keys()) { cache.delete(k); if (--n <= 0) break; } }
    cache.set(key, { at: Date.now(), ttl: entryTtl, user });
  };
  const lookup = async (key: string, cookie: string): Promise<IdentityResult> => {
    let res: Response;
    try {
      res = await fetch(`${base}/api/internal/identity/session`, {
        headers: { cookie, authorization: `Bearer ${opts.internalToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
    } catch (e: any) { console.error(`identity provider unreachable: ${e?.message ?? e}`); return { ok: false, reason: 'unavailable' }; }
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (res.status === 401) { remember(key, null, NEGATIVE_TTL_MS); return { ok: false, reason: 'signed-out', setCookies }; }
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const body: any = await res.json().catch(() => null);
    const u = body?.user;
    const id = str(u?.id, 100);
    if (!id || typeof u.isTrial !== 'boolean') return { ok: false, reason: 'unavailable' };
    const user: PlatformUser = { id, name: str(u.name, 200) || str(u.email, 254) || 'Learner', email: str(u.email, 254), image: str(u.image), isTrial: u.isTrial, isAdmin: u.isAdmin === true };
    remember(key, user, ttl);
    return { ok: true, user, setCookies };
  };
  return async (headers) => {
    const cookie = headers.cookie;
    if (!cookie) return { ok: false, reason: 'signed-out', setCookies: [] };
    const key = crypto.createHash('sha256').update(cookie).digest('base64url');
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.user ? { ok: true, user: hit.user, setCookies: [] } : { ok: false, reason: 'signed-out', setCookies: [] };
    const pending = inflight.get(key);
    if (pending) return pending;
    if (inflight.size >= maxInFlight) { console.error('identity lookups saturated'); return { ok: false, reason: 'unavailable' }; }
    const p = lookup(key, cookie).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}

export function internalTokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header || '');
  const a = crypto.createHash('sha256').update(m?.[1] ?? '').digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return !!m && crypto.timingSafeEqual(a, b);
}
