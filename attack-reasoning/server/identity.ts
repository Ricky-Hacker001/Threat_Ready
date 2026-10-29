// Platform identity. Sign-in lives on onboard.threatready.io; this server forwards the browser's
// cookie (shared across *.threatready.io) to onboard's internal identity endpoint. There is no local
// login. Shape: onboard packages/contracts/src/platform.ts (Identity).
import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface PlatformUser { id: string; name: string; email: string | null; image: string | null; isTrial: boolean; isAdmin: boolean }
export type IdentityResult =
  | { ok: true; user: PlatformUser; setCookies: string[] }
  | { ok: false; reason: 'signed-out'; setCookies: string[] }
  /** Onboard could not answer (down, or every lookup slot in use): a retryable 503. */
  | { ok: false; reason: 'unavailable' }
  /** This client's lookups are all in use and its queue is full or it waited 5 s: a short 429, so it cannot starve everyone else. */
  | { ok: false; reason: 'busy' };
/**
 * Resolves the browser's session. `clientKey` (the per-IP bucket key) scopes the per-client in-flight
 * limit. `peek` answers from the cache only: the user when this cookie resolved recently, else null.
 */
export type IdentityResolver = ((headers: IncomingHttpHeaders, clientKey?: string) => Promise<IdentityResult>) & { peek?: (headers: IncomingHttpHeaders) => PlatformUser | null };

const str = (v: unknown, max = 500) => (typeof v === 'string' && v.length <= max ? v : null);

/** Negative results (signed-out cookies) are remembered this long, so a flood of bad cookies cannot fan out to onboard. */
const NEGATIVE_TTL_MS = 10_000;
const MAX_CACHE = 5000;
const MAX_IN_FLIGHT = 50;
/**
 * Lookups one client (IP) may have running at once, so no single source can fill MAX_IN_FLIGHT. More
 * wait (oldest first) up to CLIENT_WAIT_MS for a slot: a classroom behind one NAT address that opens
 * the lab together after a restart (every cache cold) is served in a few waves, not refused.
 */
const MAX_IN_FLIGHT_PER_CLIENT = 16;
const CLIENT_WAIT_MS = 5000;
/** Waiting lookups per client, in multiples of its cap; past that the caller is answered at once (a memory bound). */
const CLIENT_QUEUE_FACTOR = 16;
/** A session onboard confirmed this recently is never shed by the caps when it is checked again. */
const KNOWN_GOOD_MS = 12 * 3600_000;
const SHED_LOG_MS = 10_000;
/** A rejected internal token is this app's misconfiguration, logged as an error at most this often. */
const TOKEN_REJECTED_LOG_MS = 60_000;

/**
 * Whether a 401 from onboard rejected this app's internal token (onboard's `assertInternalCaller` answers
 * `{ code: "UNAUTHENTICATED", message: "Internal token required" }`) rather than the learner's cookie.
 * Such an answer says nothing about the session: never cached as signed-out, or a token rotation signs
 * every learner out silently (audit 2026-10-29 L14).
 */
export function internalTokenRejected(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const { code, message } = body as { code?: unknown; message?: unknown };
  return code === 'UNAUTHENTICATED' && typeof message === 'string' && /internal token/i.test(message);
}

const SESSION_COOKIE = /^(?:__Secure-)?tr\.session_token$/;
/**
 * The session-token pairs (`name=value`) of a Cookie header that can hold an onboard session: Better
 * Auth's `tr.session_token` (or its `__Secure-` form) holding `<token>.<signature>`, the signature 44
 * base64 characters ending in "=", which is exactly what onboard itself accepts. The same check as the
 * labs hub, InterviewPrep and Red Team resolvers.
 */
function sessionTokens(cookie: string | undefined): string[] {
  if (!cookie || cookie.length > 8192) return [];
  const out: string[] = [];
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    const name = i > 0 ? part.slice(0, i).trim() : '';
    if (!SESSION_COOKIE.test(name)) continue;
    let v: string;
    try { v = decodeURIComponent(part.slice(i + 1).trim()); } catch { continue; }
    const dot = v.lastIndexOf('.');
    const sig = v.slice(dot + 1);
    if (dot >= 1 && dot <= 256 && sig.length === 44 && sig.endsWith('=') && /^[A-Za-z0-9+/]+=*$/.test(sig) && !/[\s;,]/.test(v)) out.push(`${name}=${v}`);
  }
  return out;
}
/** Whether a Cookie header can hold an onboard session. Anything else is signed out without asking onboard. */
export const hasPlausibleSession = (cookie: string | undefined): boolean => sessionTokens(cookie).length > 0;
/**
 * Cache key of a Cookie header: its session token(s) only, so other cookies (theme, analytics) that
 * come and go neither cost a fresh lookup nor turn one session into many keys. Null: no session.
 */
const sessionKey = (cookie: string | undefined) => { const t = sessionTokens(cookie); return t.length ? crypto.createHash('sha256').update(t.join(';')).digest('base64url') : null; };

/** Per-minute-style integer from the environment (`name`), or the default when unset/invalid. 0 = no cap. */
const intFromEnv = (name: string, fallback: number) => { const v = Number(process.env[name]); return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback; };

/**
 * Resolver backed by onboard. Positive results are cached for `cacheSeconds` per session token
 * (revocation lags that much), negative ones for 10 s. Every caller with the same session shares one
 * lookup, from the moment it is queued. A cookie that cannot hold a session is signed out without a
 * lookup. At most `maxInFlight` lookups run at once (beyond that `unavailable`, a retryable 503) and at
 * most `maxPerClient` for one client; more from that client wait up to 5 s for one of its slots, oldest
 * first, and only past that (or past a bounded queue) get `busy`, a short 429. So one source of junk
 * cookies cannot fill every slot, and a classroom behind one NAT is served in waves rather than
 * refused. A session onboard confirmed in the last 12 hours is never shed when it is checked again
 * (audit IP-REG1). Env: AR_IDENTITY_MAX_IN_FLIGHT, AR_IDENTITY_MAX_PER_CLIENT (0 = no cap).
 */
export function onboardIdentity(opts: { identityUrl: string; internalToken: string; cacheSeconds?: number; timeoutMs?: number; maxInFlight?: number; maxPerClient?: number; clientWaitMs?: number; /** Token presented to onboard. Default: INTERNAL_TOKEN_TO_ONBOARD, else `internalToken`. */ callerToken?: string }): IdentityResolver {
  const cache = new Map<string, { at: number; ttl: number; user: PlatformUser | null }>();
  // Lookups by session key, queued or running: a second caller joins instead of taking another slot.
  const inflight = new Map<string, Promise<IdentityResult>>();
  // Session key -> when onboard last confirmed it (insertion-ordered, oldest first).
  const knownGood = new Map<string, number>();
  let running = 0; // lookups talking to onboard now (the global cap)
  const ttl = (opts.cacheSeconds ?? 30) * 1000;
  const maxInFlight = opts.maxInFlight ?? intFromEnv('AR_IDENTITY_MAX_IN_FLIGHT', MAX_IN_FLIGHT);
  const maxPerClient = opts.maxPerClient ?? intFromEnv('AR_IDENTITY_MAX_PER_CLIENT', MAX_IN_FLIGHT_PER_CLIENT);
  const clientWaitMs = opts.clientWaitMs ?? CLIENT_WAIT_MS;
  // Per-client slots: running lookups and the callers queued for one (oldest first).
  const clients = new Map<string, { running: number; waiting: (() => void)[] }>();
  const acquire = (who: string) => new Promise<boolean>((resolve) => {
    if (maxPerClient <= 0) return resolve(true);
    const c = clients.get(who) ?? { running: 0, waiting: [] };
    clients.set(who, c);
    if (c.running < maxPerClient) { c.running++; return resolve(true); }
    if (c.waiting.length >= maxPerClient * CLIENT_QUEUE_FACTOR) return resolve(false);
    const go = () => { clearTimeout(timer); c.running++; resolve(true); };
    const timer = setTimeout(() => { c.waiting = c.waiting.filter((w) => w !== go); if (!c.running && !c.waiting.length) clients.delete(who); resolve(false); }, clientWaitMs);
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
  const bearer = opts.callerToken ?? callerInternalToken('onboard', opts.internalToken);
  let tokenRejectedAt = 0;
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
        headers: { cookie, authorization: `Bearer ${bearer}`, accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
    } catch (e: any) { console.error(`identity provider unreachable: ${e?.message ?? e}`); return { ok: false, reason: 'unavailable' }; }
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (res.status === 401) {
      if (internalTokenRejected(await res.json().catch(() => null))) {
        // Provider misconfiguration (a wrong or rotated token), not a signed-out learner: nothing cached, a retryable 503.
        if (Date.now() - tokenRejectedAt >= TOKEN_REJECTED_LOG_MS) { tokenRejectedAt = Date.now(); console.error('identity provider rejected this app\'s internal token (INTERNAL_TOKEN_TO_ONBOARD / INTERNAL_API_TOKEN); check the token rotation'); }
        return { ok: false, reason: 'unavailable' };
      }
      remember(key, null, NEGATIVE_TTL_MS); confirmed(key, false); return { ok: false, reason: 'signed-out', setCookies };
    }
    if (!res.ok) { console.error(`identity provider error: HTTP ${res.status}`); return { ok: false, reason: 'unavailable' }; }
    const body: any = await res.json().catch(() => null);
    const u = body?.user;
    const id = str(u?.id, 100);
    if (!id || typeof u.isTrial !== 'boolean') { console.error('identity provider returned an unexpected shape'); return { ok: false, reason: 'unavailable' }; }
    const user: PlatformUser = { id, name: str(u.name, 200) || str(u.username, 100) || str(u.email, 254) || 'Learner', email: str(u.email, 254), image: str(u.image), isTrial: u.isTrial, isAdmin: u.isAdmin === true };
    remember(key, user, ttl);
    confirmed(key, true);
    return { ok: true, user, setCookies };
  };
  /** One lookup: a client slot (unless the session is known good), then a global one, then onboard. */
  const run = async (key: string, cookie: string, who: string | undefined): Promise<IdentityResult> => {
    const at = knownGood.get(key);
    const known = at !== undefined && Date.now() - at < KNOWN_GOOD_MS;
    const slot = !known && who !== undefined;
    if (slot && !(await acquire(who))) { noteShed('client'); return { ok: false, reason: 'busy' }; }
    try {
      if (!known && maxInFlight > 0 && running >= maxInFlight) { noteShed('total'); return { ok: false, reason: 'unavailable' }; }
      running++;
      try { return await lookup(key, cookie); } finally { running--; }
    } finally { if (slot) release(who); }
  };
  const cached = (key: string) => { const hit = cache.get(key); return hit && Date.now() - hit.at < hit.ttl ? hit : null; };
  const resolve = async (headers: IncomingHttpHeaders, clientKey?: string): Promise<IdentityResult> => {
    const cookie = headers.cookie;
    const key = sessionKey(cookie);
    if (!cookie || !key) return { ok: false, reason: 'signed-out', setCookies: [] };
    const hit = cached(key);
    if (hit) return hit.user ? { ok: true, user: hit.user, setCookies: [] } : { ok: false, reason: 'signed-out', setCookies: [] };
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = run(key, cookie, clientKey?.slice(0, 64)).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
  return Object.assign(resolve, {
    peek: (headers: IncomingHttpHeaders) => { const key = sessionKey(headers.cookie); return key ? cached(key)?.user ?? null : null; },
  });
}

/**
 * Constant-time check of `Authorization: Bearer <token>` for /internal/v1/* against one or more accepted
 * tokens (every candidate is compared; no early exit).
 */
export function internalTokenMatches(header: string | undefined, token: string | readonly string[]): boolean {
  const m = /^Bearer (.+)$/.exec(header || '');
  const a = crypto.createHash('sha256').update(m?.[1] ?? '').digest();
  let ok = false;
  for (const t of typeof token === 'string' ? [token] : token) {
    const b = crypto.createHash('sha256').update(t).digest();
    if (crypto.timingSafeEqual(a, b)) ok = true;
  }
  return !!m && ok;
}

/**
 * Per-caller internal tokens (deploy/start.mjs derives one per caller→callee pair with HKDF). The callee
 * accepts every token in `INTERNAL_TOKENS_ACCEPT` (comma list) plus `configured` when it is a token of its
 * own (not the shared raw `INTERNAL_API_TOKEN`); the shared raw token is accepted only when
 * `INTERNAL_TOKEN_LEGACY_ACCEPT` is true (default: false in production, true elsewhere). With no derived
 * list configured at all (local dev, older launcher) the configured token alone is accepted, as before.
 */
export function acceptedInternalTokens(configured: string | undefined, opts: { accept?: readonly string[]; legacyAccept?: boolean; env?: NodeJS.ProcessEnv } = {}): string[] {
  const env = opts.env ?? process.env;
  const list = (opts.accept ?? (env.INTERNAL_TOKENS_ACCEPT ?? '').split(',')).map(s => s.trim()).filter(Boolean);
  const legacy = opts.legacyAccept ?? (env.INTERNAL_TOKEN_LEGACY_ACCEPT !== undefined ? env.INTERNAL_TOKEN_LEGACY_ACCEPT === 'true' : env.NODE_ENV !== 'production');
  const isRaw = !!env.INTERNAL_API_TOKEN && configured === env.INTERNAL_API_TOKEN;
  if (configured && (!isRaw || legacy || list.length === 0)) list.push(configured);
  if (legacy && env.INTERNAL_API_TOKEN) list.push(env.INTERNAL_API_TOKEN);
  return [...new Set(list)];
}

/**
 * The token this app presents to `callee`: `INTERNAL_TOKEN_TO_<CALLEE>` when set, else `configured`.
 * A `configured` value that is not the shared raw `INTERNAL_API_TOKEN` was chosen deliberately (the
 * launcher passes the derived token straight in) and is used as given.
 */
export function callerInternalToken(callee: 'onboard' | 'interview', configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (configured && configured !== env.INTERNAL_API_TOKEN) return configured;
  return env[`INTERNAL_TOKEN_TO_${callee.toUpperCase()}`] || configured || '';
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
