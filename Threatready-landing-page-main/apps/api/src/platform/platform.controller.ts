import { Controller, Get, Inject, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Identity, Overview } from "@threatready/contracts";
import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response } from "express";
import { AUTH, type Auth } from "../auth/auth.js";
import { CurrentPrincipal, Public, RequirePermission, isPlatformAdmin, type Principal } from "../authz/authz.js";
import { CONFIG, type Config } from "../config.js";
import { DB, type Db } from "../db/db.js";
import { findOrgMembership, orgPlanApplies } from "../tenancy/tenancy.js";
import { AppsClient } from "./apps.client.js";
import { assertInternalCaller } from "./internal-token.js";

/**
 * Set-Cookie headers worth relaying to the browser. Reading the session without the cookie cache
 * re-mints the session_data cache cookie on every call; relayed, it changes the browser's Cookie
 * header after each lookup and defeats every app's identity cache (keyed on that header). Keep
 * session_token refreshes and every expiry (sign-out, revoked session); drop session_data values,
 * including Better Auth's chunks (`<name>.0`, `<name>.1`, …).
 */
export function relayedCookies(setCookies: string[], sessionDataName: string): string[] {
  return setCookies.filter((c) => {
    const name = c.slice(0, c.indexOf("=")).trim();
    const isSessionData = name === sessionDataName || name.startsWith(`${sessionDataName}.`);
    return !isSessionData || /;\s*max-age=0\b/i.test(c);
  });
}

@Controller()
export class PlatformController {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Db,
    private readonly apps: AppsClient,
  ) {}

  /**
   * Identity for the apps. InterviewPrep and Labs forward the browser's Cookie
   * header here (with the internal token) instead of running their own auth.
   * Better Auth may refresh the session while answering; its Set-Cookie headers
   * are passed back so the app can relay them to the browser (Domain=threatready.io).
   */
  @Get("internal/identity/session")
  @Public()
  async identity(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<Identity> {
    assertInternalCaller(req, this.config.internalTokensAccept);
    const cookie = req.headers.cookie;
    if (!cookie) throw new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sign in to continue" });

    // No cookie cache: the apps cache this answer themselves (IDENTITY_CACHE_SECONDS), so a revoked
    // session must not also survive here for the cookie-cache lifetime.
    const { headers, response } = await this.auth.api.getSession({
      headers: fromNodeHeaders({ cookie }),
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    const setCookies = relayedCookies(headers?.getSetCookie?.() ?? [], (await this.auth.$context).authCookies.sessionData.name);
    if (setCookies.length) res.setHeader("set-cookie", setCookies);
    if (!response) throw new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sign in to continue" });

    const user = response.user as typeof response.user & {
      username?: string | null;
      isAnonymous?: boolean | null;
      role?: string | null;
    };
    const isTrial = user.isAnonymous === true;
    // The organisation whose plan this session runs on, for the apps to record usage against (business accounts).
    const org = isTrial ? null : await findOrgMembership(this.db, user.id);
    return {
      user: {
        id: user.id,
        name: user.name,
        email: isTrial ? null : user.email,
        emailVerified: user.emailVerified,
        username: user.username ?? null,
        image: user.image ?? null,
        isTrial,
        isAdmin: isPlatformAdmin(user, this.config.adminEmails),
      },
      session: { id: response.session.id, expiresAt: new Date(response.session.expiresAt).toISOString() },
      ...(org && orgPlanApplies(org) ? { org: { id: org.orgId, name: org.name, kind: org.kind, role: org.role, plan: org.plan } } : {}),
    };
  }

  /** The unified profile: every app's own summary for this user, plus a merged recent-activity feed. */
  @Get("overview")
  @RequirePermission("overview:read")
  async overview(@CurrentPrincipal() p: Principal): Promise<Overview> {
    const apps = await this.apps.overviewApps(p.userId);
    const recent = apps
      .flatMap((a) => (a.summary?.items ?? []).map((i) => ({ ...i, app: a.key })))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 15);
    return { apps, recent };
  }
}
