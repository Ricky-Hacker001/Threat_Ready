import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { PersonalRole } from "../tenancy/tenancy.js";

/** Static role → permission map (ADD L7 step 4). Code, not data. */
export const PERMISSIONS = ["me:read", "feature:read", "feature:launch", "launch:read", "overview:read", "admin:read"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<PersonalRole, readonly Permission[]> = {
  learner: ["me:read", "feature:read", "feature:launch", "launch:read", "overview:read"],
  // Trial users hold the same permissions; the entitlement step caps usage.
  trial: ["me:read", "feature:read", "feature:launch", "launch:read"],
};

/** Granted by the platform role, not by the membership role. */
export const ADMIN_PERMISSIONS: readonly Permission[] = ["admin:read"];

/** Platform admin: users.role = 'admin', or a verified email listed in ADMIN_EMAILS. Never a trial user. */
export function isPlatformAdmin(
  user: { role?: string | null; email?: string | null; emailVerified?: boolean | null; isAnonymous?: boolean | null },
  adminEmails: ReadonlySet<string>,
): boolean {
  if (user.isAnonymous) return false;
  if (user.role === "admin") return true;
  return !!user.emailVerified && !!user.email && adminEmails.has(user.email.toLowerCase());
}

export interface Principal {
  userId: string;
  sessionId: string;
  isTrial: boolean;
  isAdmin: boolean;
  username: string | null;
  email: string | null;
  orgId: string;
  role: PersonalRole;
  plan: "trial" | "free";
}

export const IS_PUBLIC = "authz:public";
export const REQUIRED_PERMISSION = "authz:permission";
export const FRESH_SESSION = "authz:fresh";

/** Route needs no session. Use sparingly; every use is reviewed. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Every non-public route declares exactly one permission or it fails closed. */
export const RequirePermission = (permission: Permission) => SetMetadata(REQUIRED_PERMISSION, permission);

/** Bypass the 5-minute session cookie cache so revocation applies immediately. */
export const FreshSession = () => SetMetadata(FRESH_SESSION, true);

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<{ principal?: Principal }>();
  if (!req.principal) throw new Error("CurrentPrincipal used on a route without a principal");
  return req.principal;
});
