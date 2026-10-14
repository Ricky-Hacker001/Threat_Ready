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
import type { Request } from "express";
import { AUTH, type Auth } from "../auth/auth.js";
import { CONFIG, type Config } from "../config.js";
import { DB, type Db } from "../db/db.js";
import { ensurePersonalWorkspace, findPersonalMembership } from "../tenancy/tenancy.js";
import {
  ADMIN_PERMISSIONS,
  FRESH_SESSION,
  IS_PUBLIC,
  REQUIRED_PERMISSION,
  ROLE_PERMISSIONS,
  isPlatformAdmin,
  type Permission,
  type Principal,
} from "./authz.js";

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
    if (!session) throw new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sign in to continue" });

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
      // Self-heal if the create hook failed after the user row committed.
      await ensurePersonalWorkspace(this.db, user.id, isTrial ? "trial" : "learner");
      membership = await findPersonalMembership(this.db, user.id);
    }
    if (!membership) throw new ForbiddenException({ code: "NO_MEMBERSHIP", message: "Forbidden" });

    // 3–4. Role → permission (admin permissions come from the platform role)
    const allowed = ADMIN_PERMISSIONS.includes(permission)
      ? isAdmin
      : ROLE_PERMISSIONS[membership.role].includes(permission);
    if (!allowed) {
      throw new ForbiddenException({ code: "FORBIDDEN", message: "Forbidden" });
    }

    req.principal = {
      userId: user.id,
      sessionId: session.session.id,
      isTrial,
      isAdmin,
      username: user.username ?? null,
      email: isTrial ? null : user.email,
      orgId: membership.orgId,
      role: membership.role,
      plan: membership.plan,
    };
    return true;
  }
}
