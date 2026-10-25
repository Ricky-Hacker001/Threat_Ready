// Identity. Two modes:
//  - DEV_LOGIN (default on localhost): a self-contained cookie login so the lab runs standalone,
//    without the ThreatReady identity provider. A signed cookie `tr_lab_user` holds the display name.
//  - onboard: forwards the shared *.threatready.io session cookie to onboard's internal identity
//    endpoint (platform parity). Shape: onboard packages/contracts/src/platform.ts (Identity).
import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { clientIp, limitFromEnv } from './ratelimit';

export interface PlatformUser { id: string; name: string; email: string | null; image: string | null; isTrial: boolean; isAdmin: boolean }
export type IdentityResult =
  | { ok: true; user: PlatformUser; setCookies: string[] }
  | { ok: false; reason: 'signed-out'; setCookies: string[] }
  | { ok: false; reason: 'unavailable' };
/**
 * `client` keys the per-client lookup budget (default: the gateway's client-IP header). `peek`, when the
 * resolver has one, answers from its cache only: a user it already knows, else null (nothing is looked up).
 * The app uses `peek` to skip the per-IP rate charge for a learner it already recognises (UX-REG0).
 */
export type IdentityResolver = ((headers: IncomingHttpHeaders, client?: string) => Promise<IdentityResult>) & { peek?: (headers: IncomingHttpHeaders) => PlatformUser | null };

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
  // The dev cookie is verified locally (an HMAC, no network), so `peek` is just the resolve body minus
  // the async wrapper — a signed-in dev learner is recognised synchronously and skips the per-IP charge.
  const read = (headers: IncomingHttpHeaders): PlatformUser | null => {
    const m = new RegExp(`(?:^|;\\s*)${DEV_COOKIE}=([^;]+)`).exec(headers.cookie || '');
    const name = m ? verify(decodeURIComponent(m[1]), secret) : null;
    if (!name) return null;
    const id = 'u_' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 16);
    return { id, name, email: null, image: null, isTrial: false, isAdmin: false };
  };
  const resolver: IdentityResolver = async (headers) => {
    const user = read(headers);
    return user ? { ok: true, user, setCookies: [] } : { ok: false, reason: 'signed-out', setCookies: [] };
  };
  resolver.peek = read;
  return resolver;
}

/**
 * Whether a Cookie header can hold an onboard session: Better Auth's `tr.session_token` (or its
 * `__Secure-` form) holding `<token>.<signature>`, the signature 44 base64 characters ending in "=".
 * Anything else is signed out without asking onboard, so junk cookies never reach a shared lookup slot.
 */
const SESSION_COOKIE = /^(?:__Secure-)?tr\.session_token$/;
/** The value of a well-formed `tr.session_token` in the Cookie header, else null. */
export function sessionTokenOf(cookie: string | undefined): string | null {
  if (!cookie || cookie.length > 8192) return null;
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0 || !SESSION_COOKIE.test(part.slice(0, i).trim())) continue;
    let v: string;
    try { v = decodeURIComponent(part.slice(i + 1).trim()); } catch { continue; }
    const dot = v.lastIndexOf('.');
    const sig = v.slice(dot + 1);
    if (dot >= 1 && dot <= 256 && sig.length === 44 && sig.endsWith('=') && /^[A-Za-z0-9+/]+=*$/.test(sig) && !/[\s;,]/.test(v)) return v;
  }
  return null;
}
export function plausibleSessionCookie(cookie: string | undefined): boolean {
  return sessionTokenOf(cookie) !== null;
}

// ---------- onboard (platform parity) ----------
/** Negative results (signed-out cookies) are remembered this long, so a flood of bad cookies cannot fan out to onboard. */
const NEGATIVE_TTL_MS = 10_000;
const MAX_CACHE = 5000;
const MAX_IN_FLIGHT = 50;
/**
 * Lookups one client (IP) may have running at once, so no single source can fill MAX_IN_FLIGHT. More
 * wait (oldest first) up to CLIENT_WAIT_MS for a slot: a classroom behind one NAT address that opens
 * the lab together after a restart (every cache cold) is served in a few waves, not refused. Same
 * policy as the labs hub (threatready-lab-001/server/identity.ts).
 */
const MAX_IN_FLIGHT_PER_CLIENT = 16;
const CLIENT_WAIT_MS = 5000;
/** Waiting lookups per client, in multiples of its cap; past that the caller is answered at once (a memory bound). */
const CLIENT_QUEUE_FACTOR = 16;
/** A session onboard confirmed this recently is never shed by the caps when it is checked again. */
const KNOWN_GOOD_MS = 12 * 3600_000;
const SHED_LOG_MS = 10_000;

/**
 * Resolver backed by onboard. Positive results are cached for `cacheSeconds` per session token
 * (revocation lags that much), negative ones for 10 s. Every caller with the same session shares one
 * lookup, from the moment it is queued. A cookie that cannot hold a session is signed out without a
 * lookup. At most `maxInFlight` lookups run at once and at most `maxPerClient` for one client (more
 * wait up to 5 s for a slot); beyond that the caller gets `unavailable`, a retryable 503 — so anonymous
 * junk-cookie traffic cannot exhaust the global cap and 503 valid sessions (IP-REG1). A session onboard
 * confirmed in the last 12 hours is never shed when it is checked again. Both caps: env
 * REDTEAM_IDENTITY_MAX_IN_FLIGHT / REDTEAM_IDENTITY_MAX_PER_CLIENT, 0 = none.
 */
export function onboardIdentity(opts: { identityUrl: string; internalToken: string; cacheSeconds?: number; timeoutMs?: number; maxInFlight?: number; maxPerClient?: number }): IdentityResolver {
  const cache = new Map<string, { at: number; ttl: number; user: PlatformUser | null }>();
  // Lookups by session key, queued or running: a second caller joins instead of taking another slot.
  const inflight = new Map<string, Promise<IdentityResult>>();
  // Session key -> when onboard last confirmed it (insertion-ordered, oldest first).
  const knownGood = new Map<string, number>();
  let running = 0; // lookups talking to onboard now (the global cap)
  const ttl = (opts.cacheSeconds ?? 30) * 1000;
  const maxInFlight = opts.maxInFlight ?? limitFromEnv('REDTEAM_IDENTITY_MAX_IN_FLIGHT', MAX_IN_FLIGHT);
  const maxPerClient = opts.maxPerClient ?? limitFromEnv('REDTEAM_IDENTITY_MAX_PER_CLIENT', MAX_IN_FLIGHT_PER_CLIENT);
  // Per-client slots: running lookups and the callers queued for one (oldest first).
  const clients = new Map<string, { running: number; waiting: (() => void)[] }>();
  const acquire = (who: string) => new Promise<boolean>((resolve) => {
    if (maxPerClient <= 0) return resolve(true);
    const c = clients.get(who) ?? { running: 0, waiting: [] };
    clients.set(who, c);
    if (c.running < maxPerClient) { c.running++; return resolve(true); }
    if (c.waiting.length >= maxPerClient * CLIENT_QUEUE_FACTOR) return resolve(false);
    const go = () => { clearTimeout(timer); c.running++; resolve(true); };
    const timer = setTimeout(() => { c.waiting = c.waiting.filter((w) => w !== go); if (!c.running && !c.waiting.length) clients.delete(who); resolve(false); }, CLIENT_WAIT_MS);
    c.waiting.push(go);
  });
  const release = (who: string) => {
    if (maxPerClient <= 0) return;
    const c = clients.get(who); if (!c) return;
    c.running--;
    const next = c.waiting.shift();
    if (next) next(); else if (c.running <= 0) clients.delete(who);
  };
  // Shedding is load, not a fault: one warning per interval with the count.
  const shed = { count: 0, at: 0 };
  const noteShed = (cap: 'client' | 'total') => {
    shed.count++;
    if (Date.now() - shed.at < SHED_LOG_MS) return;
    console.warn(`identity lookups shed: ${shed.count} in the last ${Math.round(SHED_LOG_MS / 1000)} s (${cap} cap; ${running} running)`);
    shed.count = 0; shed.at = Date.now();
  };
  const base = opts.identityUrl.replace(/\/+$/, '');
  const remember = (key: string, user: PlatformUser | null, entryTtl: number) => {
    if (entryTtl <= 0) return;
    cache.delete(key); // re-insert at the end: Map order is insertion order, so the oldest entries come first
    if (cache.size >= MAX_CACHE) { let n = Math.ceil(MAX_CACHE / 10); for (const k of cache.keys()) { cache.delete(k); if (--n <= 0) break; } }
    cache.set(key, { at: Date.now(), ttl: entryTtl, user });
  };
  const confirmed = (key: string, ok: boolean) => {
    knownGood.delete(key);
    if (!ok) return;
    if (knownGood.size >= MAX_CACHE) knownGood.delete(knownGood.keys().next().value!);
    knownGood.set(key, Date.now());
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
    if (res.status === 401) { remember(key, null, NEGATIVE_TTL_MS); confirmed(key, false); return { ok: false, reason: 'signed-out', setCookies }; }
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const body: any = await res.json().catch(() => null);
    const u = body?.user;
    const id = str(u?.id, 100);
    if (!id || typeof u.isTrial !== 'boolean') return { ok: false, reason: 'unavailable' };
    const user: PlatformUser = { id, name: str(u.name, 200) || str(u.email, 254) || 'Learner', email: str(u.email, 254), image: str(u.image), isTrial: u.isTrial, isAdmin: u.isAdmin === true };
    remember(key, user, ttl);
    confirmed(key, true);
    return { ok: true, user, setCookies };
  };
  /** One lookup: a client slot (unless the session is known good), then a global one, then onboard. */
  const run = async (key: string, cookie: string, who: string): Promise<IdentityResult> => {
    const at = knownGood.get(key);
    const known = at !== undefined && Date.now() - at < KNOWN_GOOD_MS;
    if (!known && !(await acquire(who))) { noteShed('client'); return { ok: false, reason: 'unavailable' }; }
    try {
      if (!known && maxInFlight > 0 && running >= maxInFlight) { noteShed('total'); return { ok: false, reason: 'unavailable' }; }
      running++;
      try { return await lookup(key, cookie); } finally { running--; }
    } finally { if (!known) release(who); }
  };
  // Key the cache on the session token alone, not the whole Cookie header: a rotating non-session cookie
  // (analytics, CSRF, …) alongside a stable session otherwise changes the key on every request and busts
  // the positive cache, turning one learner's ordinary browsing into a fresh onboard lookup each time
  // (and a per-client slot). The full header is still sent to onboard for the lookup (ONB-REG0 handoff).
  const keyOf = (token: string) => crypto.createHash('sha256').update(token).digest('base64url');
  const cached = (key: string) => { const hit = cache.get(key); return hit && Date.now() - hit.at < hit.ttl ? hit : null; };
  const resolver: IdentityResolver = async (headers, client) => {
    const cookie = headers.cookie;
    const token = sessionTokenOf(cookie);
    if (!cookie || !token) return { ok: false, reason: 'signed-out', setCookies: [] };
    const key = keyOf(token);
    const hit = cached(key);
    if (hit) return hit.user ? { ok: true, user: hit.user, setCookies: [] } : { ok: false, reason: 'signed-out', setCookies: [] };
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = run(key, cookie, (client ?? clientIp(headers)).slice(0, 64)).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
  resolver.peek = (headers) => { const token = sessionTokenOf(headers.cookie); if (!token) return null; return cached(keyOf(token))?.user ?? null; };
  return resolver;
}

export function internalTokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header || '');
  const a = crypto.createHash('sha256').update(m?.[1] ?? '').digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return !!m && crypto.timingSafeEqual(a, b);
}
