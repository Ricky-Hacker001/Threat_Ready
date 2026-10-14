import { Controller, Get, Inject, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Identity, Overview } from "@threatready/contracts";
import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response } from "express";
import { AUTH, type Auth } from "../auth/auth.js";
import { CurrentPrincipal, Public, RequirePermission, isPlatformAdmin, type Principal } from "../authz/authz.js";
import { CONFIG, type Config } from "../config.js";
import { AppsClient } from "./apps.client.js";
import { assertInternalCaller } from "./internal-token.js";

@Controller()
export class PlatformController {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(CONFIG) private readonly config: Config,
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
    assertInternalCaller(req, this.config.INTERNAL_API_TOKEN);
    const cookie = req.headers.cookie;
    if (!cookie) throw new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sign in to continue" });

    const { headers, response } = await this.auth.api.getSession({
      headers: fromNodeHeaders({ cookie }),
      returnHeaders: true,
    });
    const setCookies = headers?.getSetCookie?.() ?? [];
    if (setCookies.length) res.setHeader("set-cookie", setCookies);
    if (!response) throw new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sign in to continue" });

    const user = response.user as typeof response.user & {
      username?: string | null;
      isAnonymous?: boolean | null;
      role?: string | null;
    };
    const isTrial = user.isAnonymous === true;
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
