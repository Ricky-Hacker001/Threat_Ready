import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import type { AdminOrgDetail, AdminOrgList, AdminOrgPlan, AdminOrgRow, AdminOrgStatus, AdminOverview, AdminRoleChangeResult, AdminUserDetail, AdminUserList } from "@threatready/contracts";
import { adminOrgPlanSchema, adminOrgStatusSchema, adminRoleChangeSchema } from "@threatready/contracts";
import { CurrentPrincipal, FreshSession, RequirePermission, type Principal } from "../authz/authz.js";
import { UserThrottlerGuard, clientIp } from "../common/throttle.js";
import { CONFIG, type Config } from "../config.js";
import { ZodBody } from "../common/zod.js";
import { AdminOrgsService, orgListQuerySchema } from "./admin-orgs.service.js";
import { AdminService, listQuerySchema, parseRange } from "./admin.service.js";
import { toCsv } from "./csv.js";

/**
 * Platform admin console. Read routes plus one write: changing a user's platform role. Every route
 * needs a fresh session (no cookie cache): an admin whose session was revoked loses the console at once.
 */
@Controller("admin")
@RequirePermission("admin:read")
@FreshSession()
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly orgs: AdminOrgsService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private firstParty(req: Request): void {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    // The admin console is onboard's own page: no other app origin may change organisations or roles.
    if (!origin || origin !== new URL(this.config.WEB_ORIGIN).origin) throw new ForbiddenException({ code: "FORBIDDEN", message: "Forbidden" });
  }

  /* ---------------- Organisations (business accounts) ---------------- */

  @Get("orgs")
  @RequirePermission("admin:read")
  orgList(@Query() query: Record<string, unknown>): Promise<AdminOrgList> {
    const parsed = orgListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ code: "VALIDATION_FAILED", message: "Invalid filters" });
    return this.orgs.list(parseRange(query), parsed.data);
  }

  /** One organisation: plan, members with their usage, pending invitations and its audit log. Audited. */
  @Get("orgs/:id")
  @RequirePermission("admin:read")
  async orgDetail(@Param("id") id: string, @Query() query: Record<string, unknown>, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<AdminOrgDetail> {
    const detail = await this.orgs.detail(id, parseRange(query));
    await this.admin.audit("org.view", me, null, { orgId: detail.org.id, name: detail.org.name }, clientIp(req) ?? null);
    return detail;
  }

  /** Set the plan by hand (billing is a later phase): plan, status, seats, period end and AI cap. The caller retypes the organisation's name. */
  @Post("orgs/:id/plan")
  @RequirePermission("admin:write")
  @FreshSession()
  @HttpCode(200)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  orgPlan(@Param("id") id: string, @Body(ZodBody(adminOrgPlanSchema)) body: AdminOrgPlan, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<AdminOrgRow> {
    this.firstParty(req);
    return this.orgs.setPlan(me, id, body, clientIp(req) ?? null);
  }

  /** Approve a pending organisation, suspend it, or reinstate it. */
  @Post("orgs/:id/status")
  @RequirePermission("admin:write")
  @FreshSession()
  @HttpCode(200)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  orgStatus(@Param("id") id: string, @Body(ZodBody(adminOrgStatusSchema)) body: AdminOrgStatus, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<AdminOrgRow> {
    this.firstParty(req);
    return this.orgs.setStatus(me, id, body, clientIp(req) ?? null);
  }

  @Get("overview")
  @RequirePermission("admin:read")
  overview(@Query() query: Record<string, unknown>): Promise<AdminOverview> {
    return this.admin.overview(parseRange(query));
  }

  @Get("users")
  @RequirePermission("admin:read")
  users(@Query() query: Record<string, unknown>): Promise<AdminUserList> {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ code: "VALIDATION_FAILED", message: "Invalid filters" });
    return this.admin.listUsers(parseRange(query), parsed.data);
  }

  /** Every matching user with time, location and AI usage, as CSV (opens in Excel / Sheets). Audited: a bulk read of personal data. */
  @Get("export/users.csv")
  @RequirePermission("admin:read")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="threatready-users.csv"')
  async exportUsers(@Query() query: Record<string, unknown>, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<string> {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ code: "VALIDATION_FAILED", message: "Invalid filters" });
    const range = parseRange(query);
    const { rows } = await this.admin.allUserRows(range, parsed.data);
    await this.admin.audit("users.export", me, null, { rows: rows.length, from: range.from.toISOString(), to: range.to.toISOString(), q: parsed.data.q ?? null, includeTrial: parsed.data.includeTrial }, clientIp(req) ?? null);
    return toCsv(rows, range);
  }

  /** One user's sessions (IPs, user agents), sign-in methods and AI usage. Audited. */
  @Get("users/:id")
  @RequirePermission("admin:read")
  async user(@Param("id") id: string, @Query() query: Record<string, unknown>, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<AdminUserDetail> {
    const detail = await this.admin.userDetail(id, parseRange(query));
    await this.admin.audit("user.view", me, { id: detail.user.id, email: detail.user.email }, {}, clientIp(req) ?? null);
    return detail;
  }

  /**
   * Promote a user to platform admin or remove it. Fresh session (no cookie cache: a revoked admin
   * cannot keep using this), first-party Origin only (defence in depth beside SameSite cookies), the
   * caller retypes the target's email, and the rules in role-change.ts apply. Audited.
   */
  @Post("users/:id/role")
  @RequirePermission("admin:write")
  @FreshSession()
  @HttpCode(200)
  @UseGuards(UserThrottlerGuard) // per admin, not per office IP
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  setRole(@Param("id") id: string, @Body() body: unknown, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<AdminRoleChangeResult> {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    // The admin console is onboard's own page: no other app origin may change roles.
    if (!origin || origin !== new URL(this.config.WEB_ORIGIN).origin) throw new ForbiddenException({ code: "FORBIDDEN", message: "Forbidden" });
    const parsed = adminRoleChangeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "VALIDATION_FAILED", message: "role must be admin or user; confirmEmail must be the user's email" });
    return this.admin.setRole(me, id, parsed.data.role, parsed.data.confirmEmail, clientIp(req) ?? null);
  }
}
