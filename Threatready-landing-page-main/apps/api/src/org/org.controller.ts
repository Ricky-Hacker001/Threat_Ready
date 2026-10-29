import { Body, Controller, Delete, ForbiddenException, Get, Header, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  orgCreateSchema,
  orgInviteCreateSchema,
  orgMemberRoleSchema,
  orgMemberStatusSchema,
  orgUpdateSchema,
  type InvitationAcceptResult,
  type InvitationPreview,
  type OrgAuditRow,
  type OrgCreate,
  type OrgInvitationRow,
  type OrgInviteCreate,
  type OrgInviteResult,
  type OrgMemberDetail,
  type OrgMemberList,
  type OrgMemberRole,
  type OrgMemberStatusChange,
  type OrgOverview,
  type OrgSummary,
  type OrgUpdate,
} from "@threatready/contracts";
import type { Request } from "express";
import { CurrentPrincipal, FreshSession, Public, RequirePermission, type Principal } from "../authz/authz.js";
import { ClientIpThrottlerGuard, UserThrottlerGuard, clientIp } from "../common/throttle.js";
import { ZodBody } from "../common/zod.js";
import { CONFIG, type Config } from "../config.js";
import { cell } from "../admin/csv.js";
import { OrgService } from "./org.service.js";

/**
 * The organisation console's API (business accounts). Permissions come from the caller's role in
 * their organisation (AuthGuard → ORG_ROLE_PERMISSIONS): managers and org admins read and invite,
 * org admins also change roles and settings. State-changing routes accept only onboard's own origin,
 * as the admin console does: no other app origin may act on an organisation.
 */
@Controller()
export class OrgController {
  constructor(
    private readonly org: OrgService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private firstParty(req: Request): void {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (!origin || origin !== new URL(this.config.WEB_ORIGIN).origin) throw new ForbiddenException({ code: "FORBIDDEN", message: "Forbidden" });
  }

  /* ---------------- The organisation ---------------- */

  /** Start a business account. The caller becomes its first org admin; the organisation starts on the trial plan. */
  @Post("org")
  @RequirePermission("org:create")
  @FreshSession()
  @HttpCode(201)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  create(@Body(ZodBody(orgCreateSchema)) body: OrgCreate, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<OrgSummary> {
    this.firstParty(req);
    return this.org.create(me, body, clientIp(req) ?? null);
  }

  @Get("org")
  @RequirePermission("org:read")
  overview(@CurrentPrincipal() me: Principal): Promise<OrgOverview> {
    return this.org.overview(me);
  }

  @Patch("org")
  @RequirePermission("org:admin")
  @FreshSession()
  update(@Body(ZodBody(orgUpdateSchema)) body: OrgUpdate, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<OrgSummary> {
    this.firstParty(req);
    return this.org.update(me, body, clientIp(req) ?? null);
  }

  @Get("org/audit")
  @RequirePermission("org:read")
  audit(@CurrentPrincipal() me: Principal): Promise<OrgAuditRow[]> {
    return this.org.auditOf(me);
  }

  /** Leave the organisation (any role; the last org admin hands over first). The seat is freed; the account stays. */
  @Post("org/leave")
  @RequirePermission("me:read")
  @FreshSession()
  @HttpCode(200)
  leave(@Req() req: Request, @CurrentPrincipal() me: Principal): Promise<{ left: true }> {
    this.firstParty(req);
    return this.org.leave(me, clientIp(req) ?? null);
  }

  /* ---------------- People ---------------- */

  @Get("org/members")
  @RequirePermission("org:read")
  members(@CurrentPrincipal() me: Principal): Promise<OrgMemberList> {
    return this.org.members(me);
  }

  /** Every member with their activity this month, as CSV. Audited: a bulk read of the team's data. */
  @Get("org/export/members.csv")
  @RequirePermission("org:read")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="threatready-organisation-members.csv"')
  async exportMembers(@Req() req: Request, @CurrentPrincipal() me: Principal): Promise<string> {
    const { members } = await this.org.members(me);
    await this.org.recordExport(me, members.length, clientIp(req) ?? null);
    const head = ["Name", "Email", "Username", "Role", "Status", "Joined", "Last seen", "Interviews (month)", "Simulations (month)", "Reasoning (month)", "Hours (month)", "Last active in"];
    const lines = members.map((m) =>
      [m.name, m.email, m.username, m.role, m.status, m.joinedAt, m.lastSeenAt, m.launches.interview ?? 0, m.launches.simulations ?? 0, m.launches.reasoning ?? 0, (m.seconds / 3600).toFixed(2), m.lastApp ? `${m.lastApp.app}${m.lastApp.area ? `/${m.lastApp.area}` : ""}` : ""]
        .map(cell)
        .join(","),
    );
    return [`# ${me.org!.name}: members, ${new Date().toISOString()}`, head.map(cell).join(","), ...lines].join("\r\n") + "\r\n";
  }

  @Get("org/members/:userId/summary")
  @RequirePermission("org:read")
  memberDetail(@Param("userId") userId: string, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<OrgMemberDetail> {
    return this.org.memberDetail(me, userId, clientIp(req) ?? null);
  }

  @Post("org/members/:userId/role")
  @RequirePermission("org:admin")
  @FreshSession()
  @HttpCode(200)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  setRole(@Param("userId") userId: string, @Body(ZodBody(orgMemberRoleSchema)) body: OrgMemberRole, @Req() req: Request, @CurrentPrincipal() me: Principal) {
    this.firstParty(req);
    return this.org.setRole(me, userId, body.role, clientIp(req) ?? null);
  }

  @Post("org/members/:userId/status")
  @RequirePermission("org:write")
  @FreshSession()
  @HttpCode(200)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  setStatus(@Param("userId") userId: string, @Body(ZodBody(orgMemberStatusSchema)) body: OrgMemberStatusChange, @Req() req: Request, @CurrentPrincipal() me: Principal) {
    this.firstParty(req);
    return this.org.setStatus(me, userId, body.status, clientIp(req) ?? null);
  }

  @Delete("org/members/:userId")
  @RequirePermission("org:write")
  @FreshSession()
  @HttpCode(200)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  remove(@Param("userId") userId: string, @Req() req: Request, @CurrentPrincipal() me: Principal) {
    this.firstParty(req);
    return this.org.remove(me, userId, clientIp(req) ?? null);
  }

  /* ---------------- Invitations (the organisation's side) ---------------- */

  @Post("org/invitations")
  @RequirePermission("org:write")
  @FreshSession()
  @HttpCode(201)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  invite(@Body(ZodBody(orgInviteCreateSchema)) body: OrgInviteCreate, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<OrgInviteResult> {
    this.firstParty(req);
    return this.org.invite(me, body, clientIp(req) ?? null);
  }

  @Post("org/invitations/:id/resend")
  @RequirePermission("org:write")
  @FreshSession()
  @HttpCode(200)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  resend(@Param("id") id: string, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<OrgInvitationRow> {
    this.firstParty(req);
    return this.org.resend(me, id, clientIp(req) ?? null);
  }

  @Delete("org/invitations/:id")
  @RequirePermission("org:write")
  @FreshSession()
  @HttpCode(200)
  revoke(@Param("id") id: string, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<{ revoked: true }> {
    this.firstParty(req);
    return this.org.revoke(me, id, clientIp(req) ?? null);
  }

  /* ---------------- Invitations (the invitee's side) ---------------- */

  /** The invite page, before sign-in: the organisation's name, the role and a hint of the address. A token that matches nothing is 404. */
  @Get("invitations/:token")
  @Public()
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  preview(@Param("token") token: string): Promise<InvitationPreview> {
    return this.org.preview(token);
  }

  /** Join: the signed-in account's verified email must be the invited one (org-rules.ts, planAccept). */
  @Post("invitations/:token/accept")
  @RequirePermission("invite:accept")
  @FreshSession()
  @HttpCode(200)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  accept(@Param("token") token: string, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<InvitationAcceptResult> {
    this.firstParty(req);
    return this.org.accept(me, token, clientIp(req) ?? null);
  }
}
