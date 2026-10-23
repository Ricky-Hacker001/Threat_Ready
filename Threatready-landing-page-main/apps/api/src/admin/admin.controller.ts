import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import type { AdminOverview, AdminRoleChangeResult, AdminUserDetail, AdminUserList, AdminUserRow } from "@threatready/contracts";
import { APP_KEYS, adminRoleChangeSchema } from "@threatready/contracts";
import { CurrentPrincipal, FreshSession, RequirePermission, type Principal } from "../authz/authz.js";
import { ClientIpThrottlerGuard, clientIp } from "../common/throttle.js";
import { CONFIG, type Config } from "../config.js";
import { AdminService, listQuerySchema, parseRange } from "./admin.service.js";

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
    @Inject(CONFIG) private readonly config: Config,
  ) {}

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
    await this.admin.audit("users.export", me, null, { rows: rows.length, from: range.from.toISOString(), to: range.to.toISOString(), q: parsed.data.q ?? null, includeTrial: parsed.data.includeTrial }, clientIp(req, this.config.CLIENT_IP_HEADER) ?? null);
    return toCsv(rows, range);
  }

  /** One user's sessions (IPs, user agents), sign-in methods and AI usage. Audited. */
  @Get("users/:id")
  @RequirePermission("admin:read")
  async user(@Param("id") id: string, @Query() query: Record<string, unknown>, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<AdminUserDetail> {
    const detail = await this.admin.userDetail(id, parseRange(query));
    await this.admin.audit("user.view", me, { id: detail.user.id, email: detail.user.email }, {}, clientIp(req, this.config.CLIENT_IP_HEADER) ?? null);
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
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  setRole(@Param("id") id: string, @Body() body: unknown, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<AdminRoleChangeResult> {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    // The admin console is onboard's own page: no other app origin may change roles.
    if (!origin || origin !== new URL(this.config.WEB_ORIGIN).origin) throw new ForbiddenException({ code: "FORBIDDEN", message: "Forbidden" });
    const parsed = adminRoleChangeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "VALIDATION_FAILED", message: "role must be admin or user; confirmEmail must be the user's email" });
    return this.admin.setRole(me, id, parsed.data.role, parsed.data.confirmEmail, clientIp(req, this.config.CLIENT_IP_HEADER) ?? null);
  }
}

/** A spreadsheet must never evaluate a cell a user controls (names, emails): prefix formula starts. */
const cell = (v: unknown): string => {
  let t = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

function toCsv(rows: AdminUserRow[], range: { from: Date; to: Date }): string {
  const head = [
    "Name", "Email", "Username", "Admin", "Trial", "Email verified", "Joined", "Last seen", "Active sessions",
    "Hours used", "Country", "Time zone", "Last app", "Last area", "Last active",
    "LLM calls", "Input tokens", "Output tokens", "Cache tokens", "AI cost (USD)",
    ...APP_KEYS.map((k) => `AI cost ${k} (USD)`),
  ];
  const lines = rows.map((u) => [
    u.name, u.email, u.username, u.isAdmin, u.isTrial, u.emailVerified, u.createdAt, u.lastSeenAt, u.activeSessions,
    (u.seconds / 3600).toFixed(2), u.country, u.timeZone, u.lastApp?.app, u.lastApp?.area, u.lastApp?.at,
    u.ai.calls, u.ai.inputTokens, u.ai.outputTokens, u.ai.cacheReadTokens + u.ai.cacheWriteTokens, u.ai.costUsd.toFixed(4),
    ...APP_KEYS.map((k) => (u.aiByApp[k]?.costUsd ?? 0).toFixed(4)),
  ].map(cell).join(","));
  const note = `# ThreatReady users, ${range.from.toISOString()} to ${range.to.toISOString()}`;
  return [note, head.map(cell).join(","), ...lines].join("\r\n") + "\r\n";
}
