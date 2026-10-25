import { BadRequestException, Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { activityPingSchema, type ActivityPing } from "@threatready/contracts";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { CurrentPrincipal, RequirePermission, type Principal } from "../authz/authz.js";
import { TooManyRequestsException } from "../common/http-exception.filter.js";
import { WindowLimiter, clientIp } from "../common/throttle.js";
import { CONFIG, type Config } from "../config.js";
import { DB, type Db } from "../db/db.js";
import { countryOf } from "./geo.js";

/**
 * Time spent and location, for the admin console. Every ThreatReady page pings once a minute while
 * it is visible and the user is active (activity.js). Time is credited once per user, from the gap
 * since that user's previous ping from any tab, app or area (at most 75 s): the ping locks the user's
 * activity_last_ping row, so parallel pings from several tabs add the elapsed time once and extra or
 * replayed pings add nothing. The first ping of a stretch counts 30 s.
 */
const STEP = sql`case when now() - last_at < interval '150 seconds'
  then least(75, greatest(0, extract(epoch from now() - last_at)::int)) else 30 end`;

@Controller("activity")
export class ActivityController {
  // Per user, with a per-IP backstop far above it: a classroom behind one NAT never shares a budget.
  private readonly perUser: WindowLimiter;
  private readonly perIp: WindowLimiter;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
  ) {
    this.perUser = new WindowLimiter(config.ACTIVITY_PING_PER_USER_PER_MINUTE, 60_000);
    this.perIp = new WindowLimiter(config.ACTIVITY_PING_PER_IP_PER_MINUTE, 60_000);
  }

  @Post("ping")
  @RequirePermission("me:read")
  @HttpCode(204)
  async ping(@Body() body: unknown, @Req() req: Request, @CurrentPrincipal() me: Principal): Promise<void> {
    const ip = clientIp(req);
    const wait = Math.max(this.perUser.hit(me.userId), this.perIp.hit(ip ?? "unknown"));
    if (wait) throw new TooManyRequestsException(wait, "Too many activity updates. Try again later.");

    const parsed = activityPingSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "VALIDATION_FAILED", message: "Invalid activity ping" });
    const p: ActivityPing = parsed.data;
    const country = countryOf(ip);
    await this.db.transaction(async (tx) => {
      // 'epoch' marks a user's first ping ever: the stretch starts with 30 s like any other.
      await tx.execute(sql`
        insert into activity_last_ping (user_id, last_at) values (${me.userId}, 'epoch')
        on conflict (user_id) do nothing`);
      const { rows } = await tx.execute<{ step: number }>(sql`
        select ${STEP} as step from activity_last_ping where user_id = ${me.userId} for update`);
      const step = Number(rows[0]?.step ?? 0);
      await tx.execute(sql`update activity_last_ping set last_at = now() where user_id = ${me.userId}`);
      await tx.execute(sql`
        insert into activity_days as t (user_id, day, app, area, seconds)
        values (${me.userId}, (now() at time zone 'utc')::date, ${p.app}, ${p.area}, ${step})
        on conflict (user_id, day, app, area) do update set seconds = t.seconds + ${step}, last_at = now()`);
      await tx.execute(sql`
        insert into user_locations as t (user_id, day, country, time_zone, seconds)
        values (${me.userId}, (now() at time zone 'utc')::date, ${country}, ${p.timeZone}, ${step})
        on conflict (user_id, day, country, time_zone) do update set seconds = t.seconds + ${step}, last_at = now()`);
    });
  }
}
