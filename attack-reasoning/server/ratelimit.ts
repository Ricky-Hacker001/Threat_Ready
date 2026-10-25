// In-memory token-bucket rate limiting, dependency-free. One bucket per client IP (for traffic without
// a valid platform session) and one per signed-in user. Limits are per minute; a bucket holds a
// minute's worth of tokens, so short bursts pass and sustained floods get 429 + Retry-After. State
// lives in this process only (one gateway process on Render), which is all the labs need.
import type { IncomingHttpHeaders } from 'node:http';
import net from 'node:net';

export interface RateLimitOptions {
  /** Requests per minute for one signed-in user (default 120; env *_RATE_PER_MIN). */
  perUserPerMin?: number;
  /** Requests per minute for one client IP (default 300; env *_RATE_IP_PER_MIN). */
  perIpPerMin?: number;
  /** Body of the 429 response, in the app's own error shape. */
  body: (retryAfterSeconds: number) => unknown;
  /**
   * Header a trusted proxy in front of this app sets with the visitor's IP (deploy/gateway.mjs stamps
   * CLIENT_IP_HEADER on every request). Only then is it read; otherwise the client could choose its
   * own bucket by sending it, and req.ip (Express `trust proxy`) is the key (audit AR-REG5).
   */
  clientIpHeader?: string;
}

/** Header the gateway sets with the visitor's real IP (deploy/gateway.mjs CLIENT_IP_HEADER). */
export const CLIENT_IP_HEADER = 'x-threatready-client-ip';
const MAX_BUCKETS = 20000;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() || '';
/**
 * The visitor's IP: the trusted proxy's header when one is configured, else the connection (req.ip).
 * Only IP literals count, so a bogus value can neither pick a bucket nor bloat the key space.
 */
export const clientIp = (headers: IncomingHttpHeaders, fallback?: string, trustedHeader?: string): string => {
  const stamped = trustedHeader ? first(headers[trustedHeader.toLowerCase()]) : '';
  if (net.isIP(stamped)) return stamped;
  return fallback && net.isIP(fallback) ? fallback : 'unknown';
};

/** Per-minute limit from the environment (`name`), or the default when unset/invalid. 0 disables that limit. */
export function limitFromEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export class TokenBuckets {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private calls = 0;
  constructor(private perMinute: number) {}
  /** Takes one token for `key`; returns 0 when allowed, else the seconds until the next token. */
  take(key: string, now = Date.now()): number {
    if (this.perMinute <= 0) return 0;
    if (++this.calls % 1000 === 0 || this.buckets.size > MAX_BUCKETS) this.sweep(now);
    const rate = this.perMinute / 60000; // tokens per ms
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.perMinute, at: now }; this.buckets.set(key, b); }
    else { b.tokens = Math.min(this.perMinute, b.tokens + (now - b.at) * rate); b.at = now; }
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
  }
  /** Drops buckets that have refilled (nothing to remember), oldest first when still over the cap. */
  private sweep(now: number) {
    const rate = this.perMinute / 60000;
    for (const [k, b] of this.buckets) if (b.tokens + (now - b.at) * rate >= this.perMinute) this.buckets.delete(k);
    if (this.buckets.size > MAX_BUCKETS) for (const k of [...this.buckets.keys()].slice(0, this.buckets.size - MAX_BUCKETS)) this.buckets.delete(k);
  }
  get size() { return this.buckets.size; }
}

type Req = { headers: IncomingHttpHeaders; ip?: string; method: string; [k: string]: any };
type Res = { status: (n: number) => Res; set: (k: string, v: string) => Res; json: (b: unknown) => unknown };
type Body = (retryAfterSeconds: number) => unknown;

export interface RateLimiter {
  /** The key this request's per-IP bucket uses (see clientIp). */
  clientKey(req: Req): string;
  /** Seconds to wait before this client IP may call again (0 = allowed; the token is taken). */
  ipWait(req: Req): number;
  /** Seconds to wait before this user may call again (0 = allowed; the token is taken). */
  userWait(userId: string): number;
  /** Per-IP check, for traffic without a known session. Sends 429 (in `body`'s shape when given) and returns false when over the limit. */
  ip(req: Req, res: Res, body?: Body): boolean;
  /** Per-user check, once the user id is known. Sends 429 and returns false when over the limit. */
  user(req: Req, res: Res, userId: string, body?: Body): boolean;
  /** Express middleware form of the per-IP check. */
  ipMiddleware(req: Req, res: Res, next: (err?: unknown) => void): void;
  /** Express middleware form of the per-user check, reading `req.platformUser.id` / `req.user.id`. */
  userMiddleware(req: Req, res: Res, next: (err?: unknown) => void): void;
}

export function rateLimiter(opts: RateLimitOptions): RateLimiter {
  const users = new TokenBuckets(opts.perUserPerMin ?? 120);
  const ips = new TokenBuckets(opts.perIpPerMin ?? 300);
  const reject = (res: Res, wait: number, body: Body = opts.body) => { res.status(429).set('Retry-After', String(wait)).set('Cache-Control', 'no-store').json(body(wait)); return false; };
  const clientKey = (req: Req) => clientIp(req.headers, req.ip ?? req.socket?.remoteAddress, opts.clientIpHeader);
  const ipWait = (req: Req) => ips.take(clientKey(req));
  const userWait = (userId: string) => users.take(userId);
  const ip = (req: Req, res: Res, body?: Body) => { const wait = ipWait(req); return wait ? reject(res, wait, body) : true; };
  const user = (req: Req, res: Res, userId: string, body?: Body) => { const wait = userWait(userId); return wait ? reject(res, wait, body) : true; };
  return {
    clientKey, ipWait, userWait, ip, user,
    ipMiddleware: (req, res, next) => { if (ip(req, res)) next(); },
    userMiddleware: (req, res, next) => { const id = req.platformUser?.id ?? req.user?.id; if (typeof id !== 'string' || user(req, res, id)) next(); },
  };
}
