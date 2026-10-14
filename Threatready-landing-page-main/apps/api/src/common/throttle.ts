import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";

let ipHeader = "x-forwarded-for";
export function setClientIpHeader(header: string): void {
  ipHeader = header.toLowerCase();
}

/**
 * Client IP from the configured header. Behind Cloudflare -> ALB that is
 * cf-connecting-ip, which is trustworthy only because the ALB accepts
 * Cloudflare address ranges alone (ADD HLD-4).
 */
export function clientIp(req: Request, header = ipHeader): string | undefined {
  const raw = req.headers[header.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const first = value?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || undefined;
}

@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return clientIp(req as unknown as Request) ?? "unknown";
  }
}
