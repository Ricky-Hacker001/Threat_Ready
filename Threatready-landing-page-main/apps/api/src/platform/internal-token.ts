import { UnauthorizedException } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

/**
 * Service-to-service calls between onboard and the apps carry `Authorization: Bearer <token>`, where
 * the token is the caller's own (config.internalTokensAccept lists one per calling app, plus the raw
 * INTERNAL_API_TOKEN while legacy acceptance is on). The presented value is compared against every
 * accepted token in constant time (hashes first, so unequal lengths do not short-circuit); any match
 * passes. No early return on a match, so timing does not reveal which caller's token it was.
 */
export function internalTokenMatches(header: string | undefined, tokens: string | readonly string[]): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m?.[1]) return false;
  const a = createHash("sha256").update(m[1]).digest();
  let ok = false;
  for (const token of typeof tokens === "string" ? [tokens] : tokens) {
    const b = createHash("sha256").update(token).digest();
    if (timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

export function assertInternalCaller(req: Request, tokens: string | readonly string[]): void {
  if (!internalTokenMatches(req.headers.authorization, tokens)) {
    throw new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Internal token required" });
  }
}
