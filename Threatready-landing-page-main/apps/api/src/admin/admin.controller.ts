import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import type { AdminOverview, AdminUserDetail, AdminUserList } from "@threatready/contracts";
import { RequirePermission } from "../authz/authz.js";
import { AdminService, listQuerySchema, parseRange } from "./admin.service.js";

/** Platform admin console. Read-only in this release. */
@Controller("admin")
@RequirePermission("admin:read")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

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

  @Get("users/:id")
  @RequirePermission("admin:read")
  user(@Param("id") id: string, @Query() query: Record<string, unknown>): Promise<AdminUserDetail> {
    return this.admin.userDetail(id, parseRange(query));
  }
}
