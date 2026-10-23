// Platform identity. Sign-in lives on onboard.threatready.io; this server forwards the browser's
// cookie (shared across *.threatready.io) to onboard's internal identity endpoint. There is no local
// login. Shape: onboard packages/contracts/src/platform.ts (Identity).
import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface PlatformUser { id: string; name: string; email: string | null; image: string | null; isTrial: boolean; isAdmin: boolean }
export type IdentityResult =
  | { ok: true; user: PlatformUser; setCookies: string[] }
  | { ok: false; reason: 'signed-out'; setCookies: string[] }
  | { ok: false; reason: 'unavailable' };
export type IdentityResolver = (headers: IncomingHttpHeaders) => Promise<IdentityResult>;

const str = (v: unknown, max = 500) => (typeof v === 'string' && v.length <= max ? v : null);

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
    if (!res.ok) { console.error(`identity provider error: HTTP ${res.status}`); return { ok: false, reason: 'unavailable' }; }
    const body: any = await res.json().catch(() => null);
    const u = body?.user;
    const id = str(u?.id, 100);
    if (!id || typeof u.isTrial !== 'boolean') { console.error('identity provider returned an unexpected shape'); return { ok: false, reason: 'unavailable' }; }
    const user: PlatformUser = { id, name: str(u.name, 200) || str(u.username, 100) || str(u.email, 254) || 'Learner', email: str(u.email, 254), image: str(u.image), isTrial: u.isTrial, isAdmin: u.isAdmin === true };
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

/** Constant-time check of `Authorization: Bearer <INTERNAL_API_TOKEN>` for /internal/v1/*. */
export function internalTokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header || '');
  const a = crypto.createHash('sha256').update(m?.[1] ?? '').digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return !!m && crypto.timingSafeEqual(a, b);
}

/** Every ThreatReady app's public URL and status, from onboard's public config (cached). Feeds the shared header. */
export function onboardApps(identityUrl: string, ttlSeconds = 300): () => Promise<{ key: string; title: string; url: string; status: string }[]> {
  let cached: { at: number; apps: any[] } | null = null;
  const base = identityUrl.replace(/\/+$/, '');
  return async () => {
    if (cached && Date.now() - cached.at < ttlSeconds * 1000) return cached.apps;
    try {
      const r = await fetch(`${base}/api/public/config`, { signal: AbortSignal.timeout(3000) });
      const body: any = await r.json();
      const apps = Array.isArray(body?.apps) ? body.apps.filter((a: any) => typeof a?.key === 'string' && typeof a?.url === 'string') : [];
      cached = { at: Date.now(), apps };
      return apps;
    } catch { return cached?.apps ?? []; }
  };
}
