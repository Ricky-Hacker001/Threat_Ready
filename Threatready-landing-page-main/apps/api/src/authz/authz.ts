import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { OrgContext, OrgRole, Plan } from "@threatready/contracts";
import type { PersonalRole } from "../tenancy/tenancy.js";

/** Static role → permission map (ADD L7 step 4). Code, not data. */
export const PERMISSIONS = [
  "me:read",
  "feature:read",
  "feature:launch",
  "launch:read",
  "overview:read",
  "admin:read",
  "admin:write",
  // Organisations (business accounts, migration 0012)
  "org:create", // start a business account (personal role, verified email)
  "invite:accept", // accept an invitation into an organisation
  "org:read", // organisation console: overview, people, reports, audit
  "org:write", // invite, remove, suspend members; resend and revoke invitations
  "org:admin", // roles, settings, leaving rules
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<PersonalRole, readonly Permission[]> = {
  learner: ["me:read", "feature:read", "feature:launch", "launch:read", "overview:read", "org:create", "invite:accept"],
  // Trial users hold the same product permissions; the entitlement step caps usage. No organisations: a guest has no verified email.
  trial: ["me:read", "feature:read", "feature:launch", "launch:read"],
};

/** Granted by the platform role, not by the membership role. */
export const ADMIN_PERMISSIONS: readonly Permission[] = ["admin:read", "admin:write"];

/** Granted by the role in the organisation the user belongs to. A member uses the product; the console is for managers and org admins. */
export const ORG_PERMISSIONS: readonly Permission[] = ["org:read", "org:write", "org:admin"];
export const ORG_ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  org_admin: ["org:read", "org:write", "org:admin"],
  manager: ["org:read", "org:write"],
  member: [],
};

/** Platform admin: users.role = 'admin', or a verified email listed in ADMIN_EMAILS. Never a trial user. */
export function isPlatformAdmin(
  user: { role?: string | null; email?: string | null; emailVerified?: boolean | null; isAnonymous?: boolean | null },
  adminEmails: ReadonlySet<string>,
): boolean {
  if (user.isAnonymous) return false;
  if (user.role === "admin") return true;
  return !!user.emailVerified && !!user.email && adminEmails.has(user.email.toLowerCase());
}

/** Where a user's admin access comes from, for the console: "role" can be changed there, "env" only by editing ADMIN_EMAILS. */
export function adminSourceOf(
  user: { role?: string | null; email?: string | null; emailVerified?: boolean | null; isAnonymous?: boolean | null },
  adminEmails: ReadonlySet<string>,
): "role" | "env" | null {
  if (user.isAnonymous) return null;
  if (user.role === "admin") return "role";
  return !!user.emailVerified && !!user.email && adminEmails.has(user.email.toLowerCase()) ? "env" : null;
}

export interface Principal {
  userId: string;
  sessionId: string;
  isTrial: boolean;
  isAdmin: boolean;
  username: string | null;
  email: string | null;
  emailVerified: boolean;
  /** The tenant launches are counted against right now: the organisation while its plan applies, else the personal workspace. */
  orgId: string;
  role: PersonalRole;
  plan: Plan;
  /** The personal workspace, always present. */
  personal: { orgId: string; plan: "trial" | "free" };
  /** The organisation the user belongs to, if any (one per user in phase 1), whether or not its plan applies right now. */
  org: OrgContext | null;
}

export const IS_PUBLIC = "authz:public";
export const REQUIRED_PERMISSION = "authz:permission";
export const FRESH_SESSION = "authz:fresh";

/** Route needs no session. Use sparingly; every use is reviewed. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Every non-public route declares exactly one permission or it fails closed. */
export const RequirePermission = (permission: Permission) => SetMetadata(REQUIRED_PERMISSION, permission);

/** Bypass the session cookie cache (one minute) so revocation applies immediately. */
export const FreshSession = () => SetMetadata(FRESH_SESSION, true);

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<{ principal?: Principal }>();
  if (!req.principal) throw new Error("CurrentPrincipal used on a route without a principal");
  return req.principal;
});
