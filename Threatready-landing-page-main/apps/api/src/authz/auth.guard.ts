import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { AUTH, type Auth } from "../auth/auth.js";
import { CONFIG, type Config } from "../config.js";
import { DB, type Db } from "../db/db.js";
import { sessions, users } from "../db/schema.js";
import { effectiveTenant, ensurePersonalWorkspace, findOrgMembership, findPersonalMembership, toOrgContext } from "../tenancy/tenancy.js";
import {
  ADMIN_PERMISSIONS,
  FRESH_SESSION,
  IS_PUBLIC,
  ORG_PERMISSIONS,
  ORG_ROLE_PERMISSIONS,
  REQUIRED_PERMISSION,
  ROLE_PERMISSIONS,
  isPlatformAdmin,
  type Permission,
  type Principal,
} from "./authz.js";

const unauthenticated = () => new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sign in to continue" });

async function userExists(db: Db, userId: string): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  return rows.length > 0;
}

/**
 * Global, default-deny guard. Implements ADD L7 steps 1–4:
 * identity → tenant context → role → permission. Entitlement (5) lives in the
 * feature services; ownership (6) in scoped repositories plus RLS.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger("AuthGuard");

  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, targets);
    if (!permission) {
      // Fails closed. The e2e suite also checks that no route ships without one.
      this.logger.error(`route without permission: ${context.getClass().name}.${context.getHandler().name}`);
      throw new ForbiddenException({ code: "FORBIDDEN", message: "Forbidden" });
    }

    const req = context.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const fresh = this.reflector.getAllAndOverride<boolean>(FRESH_SESSION, targets) === true;

    // 1. Identity
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
      query: fresh ? { disableCookieCache: true } : undefined,
    });
    if (!session) throw unauthenticated();
    // Absolute lifetime (AUTH_SESSION_MAX_AGE_DAYS) on top of the sliding seven days: a long-lived
    // cookie on a shared or stolen device ends on its own. The row is deleted so the cookie cache
    // cannot revive it, and the client sees a plain sign-out.
    const maxAgeDays = this.config.AUTH_SESSION_MAX_AGE_DAYS;
    if (maxAgeDays > 0) {
      const createdAt = new Date(session.session.createdAt as unknown as string | Date).getTime();
      if (Number.isFinite(createdAt) && Date.now() - createdAt > maxAgeDays * 24 * 60 * 60 * 1000) {
        await this.db.delete(sessions).where(eq(sessions.id, session.session.id));
        throw unauthenticated();
      }
    }

    const user = session.user as typeof session.user & {
      username?: string | null;
      isAnonymous?: boolean | null;
      role?: string | null;
    };
    const isTrial = user.isAnonymous === true;
    const isAdmin = isPlatformAdmin(user, this.config.adminEmails);

    // 2. Tenant context from the membership table, never from the request.
    let membership = await findPersonalMembership(this.db, user.id);
    if (!membership) {
      // No membership also means the user was deleted (a guest who left, an account removed) while a
      // cookie-cached session still names it: that is signed out, not a server error.
      if (!(await userExists(this.db, user.id))) throw unauthenticated();
      // Self-heal if the create hook failed after the user row committed.
      await ensurePersonalWorkspace(this.db, user.id, isTrial ? "trial" : "learner").catch((err: unknown) => {
        // Deleted between the check and the insert (foreign key violation): same answer.
        if ((err as { code?: string; cause?: { code?: string } })?.cause?.code === "23503" || (err as { code?: string })?.code === "23503") throw unauthenticated();
        throw err;
      });
      membership = await findPersonalMembership(this.db, user.id);
    }
    if (!membership) throw new ForbiddenException({ code: "NO_MEMBERSHIP", message: "Forbidden" });

    // The organisation (business account) the user belongs to, if any. Its plan applies only while the
    // organisation, the member and the plan are all live (tenancy.ts); its console permissions only
    // while the member is active and the organisation is not suspended.
    const org = isTrial ? null : await findOrgMembership(this.db, user.id);
    const orgPermissions: readonly Permission[] = org && org.memberStatus === "active" && org.orgStatus !== "suspended" ? ORG_ROLE_PERMISSIONS[org.role] : [];

    // 3–4. Role → permission (admin permissions come from the platform role, organisation ones from the organisation role)
    const allowed = ADMIN_PERMISSIONS.includes(permission)
      ? isAdmin
      : ORG_PERMISSIONS.includes(permission)
        ? orgPermissions.includes(permission)
        : ROLE_PERMISSIONS[membership.role].includes(permission);
    if (!allowed) {
      throw new ForbiddenException({ code: "FORBIDDEN", message: "Forbidden" });
    }

    const tenant = effectiveTenant(membership, org);
    req.principal = {
      userId: user.id,
      sessionId: session.session.id,
      isTrial,
      isAdmin,
      username: user.username ?? null,
      email: isTrial ? null : user.email,
      emailVerified: user.emailVerified === true,
      orgId: tenant.orgId,
      role: membership.role,
      plan: tenant.plan,
      personal: { orgId: membership.orgId, plan: membership.plan },
      org: org ? toOrgContext(org) : null,
    };
    return true;
  }
}
