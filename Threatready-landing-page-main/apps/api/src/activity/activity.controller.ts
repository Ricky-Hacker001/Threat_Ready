import { BadRequestException, Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { activityPingSchema, type ActivityPing } from "@threatready/contracts";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { CurrentPrincipal, RequirePermission, type Principal } from "../authz/authz.js";
import { ClientIpThrottlerGuard, clientIp } from "../common/throttle.js";
import { CONFIG, type Config } from "../config.js";
import { DB, type Db } from "../db/db.js";
import { countryOf } from "./geo.js";

/**
 * Time spent and location, for the admin console. Every ThreatReady page pings once a minute while
 * it is visible and the user is active (activity.js). Time is credited from the gap since the last
 * ping of the same app/area (at most 75 s), so extra or replayed pings add nothing; the first ping
 * of a stretch counts 30 s.
 */
const STEP = sql`case when now() - t.last_at < interval '150 seconds'
  then least(75, greatest(0, extract(epoch from now() - t.last_at)::int)) else 30 end`;

@Controller("activity")
@UseGuards(ClientIpThrottlerGuard)
export class ActivityController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Post("ping")
  @RequirePermission("me:read")
  @HttpCode(204)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  async ping(@Body() body: unknown, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<void> {
    const parsed = activityPingSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "VALIDATION_FAILED", message: "Invalid activity ping" });
    const p: ActivityPing = parsed.data;
    const country = countryOf(clientIp(req, this.config.CLIENT_IP_HEADER));
    await this.db.execute(sql`
      insert into activity_days as t (user_id, day, app, area, seconds)
      values (${me.userId}, (now() at time zone 'utc')::date, ${p.app}, ${p.area}, 30)
      on conflict (user_id, day, app, area) do update set seconds = t.seconds + ${STEP}, last_at = now()`);
    await this.db.execute(sql`
      insert into user_locations as t (user_id, day, country, time_zone, seconds)
      values (${me.userId}, (now() at time zone 'utc')::date, ${country}, ${p.timeZone}, 30)
      on conflict (user_id, day, country, time_zone) do update set seconds = t.seconds + ${STEP}, last_at = now()`);
  }
}
