import { UnauthorizedException } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

/**
 * Service-to-service calls between onboard and the apps carry
 * `Authorization: Bearer <INTERNAL_API_TOKEN>`. Compared in constant time
 * (hashes first, so unequal lengths do not short-circuit).
 */
export function internalTokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m?.[1]) return false;
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export function assertInternalCaller(req: Request, token: string): void {
  if (!internalTokenMatches(req.headers.authorization, token)) {
    throw new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Internal token required" });
  }
}
