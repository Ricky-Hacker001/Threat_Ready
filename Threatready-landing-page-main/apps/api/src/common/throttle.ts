import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";
import type { IncomingMessage } from "node:http";

/**
 * The one header every client-IP reader uses: Better Auth's limiter, the throttles, audit rows and
 * the country lookup. The API sets it on every request (stampClientIp); a value a client sends under
 * this name is overwritten.
 */
export const CLIENT_IP = "x-onboard-client-ip";

/**
 * Client IP from `proxyHeader` only when a trusted proxy sets it (CLIENT_IP_HEADER: the gateway's
 * x-threatready-client-ip, or cf-connecting-ip behind an ALB that admits Cloudflare ranges alone,
 * ADD HLD-4); otherwise, or when the header is missing, the TCP peer. Without a configured proxy a
 * client cannot choose its own rate-limit bucket.
 */
export function stampClientIp(req: IncomingMessage, proxyHeader: string | undefined): void {
  let ip: string | undefined;
  if (proxyHeader) {
    const raw = req.headers[proxyHeader.toLowerCase()];
    ip = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim() || undefined;
  }
  ip ??= req.socket.remoteAddress || undefined;
  // An IPv4 client on a dual-stack socket reads "::ffff:203.0.113.7"; keep one spelling per client.
  if (ip) req.headers[CLIENT_IP] = ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");
  else delete req.headers[CLIENT_IP];
}

/** The client IP stamped for this request (stampClientIp). */
export function clientIp(req: Request): string | undefined {
  const raw = req.headers[CLIENT_IP];
  return (Array.isArray(raw) ? raw[0] : raw) || req.socket?.remoteAddress || undefined;
}

@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return clientIp(req as unknown as Request) ?? "unknown";
  }
}

/**
 * Signed-in routes: one bucket per user. The global AuthGuard runs first and sets req.principal, so
 * learners sharing one public IP (a classroom or office NAT) never share a budget. Falls back to the
 * client IP for a request without a principal (a @Public route).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = (req as { principal?: { userId?: string } }).principal?.userId;
    return userId ? `user:${userId}` : `ip:${clientIp(req as unknown as Request) ?? "unknown"}`;
  }
}

/**
 * Fixed-window counter per key, in process (one API instance). For limits whose size comes from
 * configuration, where the @Throttle decorator's static values cannot reach. A limit of 0 turns it off.
 */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Counts a hit; returns 0 when allowed, otherwise the seconds until the key's window resets. */
  hit(key: string, now = Date.now()): number {
    if (this.limit <= 0) return 0;
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (!w && this.windows.size >= this.maxKeys) this.prune(now);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    return w.count > this.limit ? Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)) : 0;
  }

  private prune(now: number): void {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
    // Still full (a flood of distinct keys): start over rather than grow without bound.
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}
