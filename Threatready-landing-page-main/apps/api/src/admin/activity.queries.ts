import type { ActivityApp, AdminTimeByArea } from "@threatready/contracts";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "../db/db.js";
import { activityDays, userLocations } from "../db/schema.js";

/**
 * The first and last UTC day of the range [from, to) (activity is stored per UTC day); a `to` at
 * midnight ends with the day before. parseRange widens the console's range to whole UTC days, so
 * these are exactly the days its AI usage covers too.
 */
export const dayBounds = (range: { from: Date; to: Date }) => ({
  from: range.from.toISOString().slice(0, 10),
  to: new Date(range.to.getTime() - 1).toISOString().slice(0, 10),
});

const inRange = (col: typeof activityDays.day | typeof userLocations.day, range: { from: Date; to: Date }) => {
  const d = dayBounds(range);
  return and(gte(col, d.from), lte(col, d.to));
};

/** Platform-wide time: total, per app/area, per day. */
export async function timeOverview(db: Db, range: { from: Date; to: Date }) {
  const where = inRange(activityDays.day, range);
  const [totals] = await db
    .select({
      seconds: sql<number>`coalesce(sum(${activityDays.seconds}), 0)`.mapWith(Number),
      users: sql<number>`count(distinct ${activityDays.userId})`.mapWith(Number),
    })
    .from(activityDays)
    .where(where);
  const byArea = await db
    .select({
      app: activityDays.app,
      area: activityDays.area,
      seconds: sql<number>`sum(${activityDays.seconds})`.mapWith(Number),
      users: sql<number>`count(distinct ${activityDays.userId})`.mapWith(Number),
    })
    .from(activityDays)
    .where(where)
    .groupBy(activityDays.app, activityDays.area)
    .orderBy(desc(sql`sum(${activityDays.seconds})`));
  const daily = await db
    .select({
      day: activityDays.day,
      seconds: sql<number>`sum(${activityDays.seconds})`.mapWith(Number),
      users: sql<number>`count(distinct ${activityDays.userId})`.mapWith(Number),
    })
    .from(activityDays)
    .where(where)
    .groupBy(activityDays.day)
    .orderBy(activityDays.day);
  return {
    seconds: totals?.seconds ?? 0,
    users: totals?.users ?? 0,
    byArea: byArea as AdminTimeByArea[],
    daily,
  };
}

/** Seconds per user in the range. */
export async function secondsByUser(db: Db, range: { from: Date; to: Date }, userId?: string) {
  const rows = await db
    .select({ userId: activityDays.userId, seconds: sql<number>`sum(${activityDays.seconds})`.mapWith(Number) })
    .from(activityDays)
    .where(and(inRange(activityDays.day, range), userId ? eq(activityDays.userId, userId) : undefined))
    .groupBy(activityDays.userId);
  return new Map(rows.map((r) => [r.userId, r.seconds]));
}

/** Each user's most-used country and time zone in the range (by seconds). */
export async function primaryLocations(db: Db, range: { from: Date; to: Date }) {
  const rows = await db
    .select({
      userId: userLocations.userId,
      country: userLocations.country,
      timeZone: userLocations.timeZone,
      seconds: sql<number>`sum(${userLocations.seconds})`.mapWith(Number),
    })
    .from(userLocations)
    .where(inRange(userLocations.day, range))
    .groupBy(userLocations.userId, userLocations.country, userLocations.timeZone);
  const best = new Map<string, { country: string; timeZone: string; seconds: number }>();
  for (const r of rows) {
    const cur = best.get(r.userId);
    if (!cur || r.seconds > cur.seconds) best.set(r.userId, { country: r.country, timeZone: r.timeZone, seconds: r.seconds });
  }
  return best;
}

/** The app and area each user was last active in (any time). */
export async function lastApps(db: Db, userId?: string) {
  const rows = await db
    .selectDistinctOn([activityDays.userId], {
      userId: activityDays.userId,
      app: activityDays.app,
      area: activityDays.area,
      at: activityDays.lastAt,
    })
    .from(activityDays)
    .where(userId ? eq(activityDays.userId, userId) : undefined)
    .orderBy(activityDays.userId, desc(activityDays.lastAt));
  return new Map(rows.map((r) => [r.userId, { app: r.app as ActivityApp, area: r.area, at: r.at.toISOString() }]));
}

/** One user's time by app/area and by day, and their locations, in the range. */
export async function userActivity(db: Db, range: { from: Date; to: Date }, userId: string) {
  const where = and(inRange(activityDays.day, range), eq(activityDays.userId, userId));
  const byArea = await db
    .select({
      app: activityDays.app,
      area: activityDays.area,
      seconds: sql<number>`sum(${activityDays.seconds})`.mapWith(Number),
      lastAt: sql<Date>`max(${activityDays.lastAt})`,
    })
    .from(activityDays)
    .where(where)
    .groupBy(activityDays.app, activityDays.area)
    .orderBy(desc(sql`sum(${activityDays.seconds})`));
  const daily = await db
    .select({ day: activityDays.day, seconds: sql<number>`sum(${activityDays.seconds})`.mapWith(Number) })
    .from(activityDays)
    .where(where)
    .groupBy(activityDays.day)
    .orderBy(activityDays.day);
  const locations = await db
    .select({
      country: userLocations.country,
      timeZone: userLocations.timeZone,
      seconds: sql<number>`sum(${userLocations.seconds})`.mapWith(Number),
      firstAt: sql<Date>`min(${userLocations.firstAt})`,
      lastAt: sql<Date>`max(${userLocations.lastAt})`,
    })
    .from(userLocations)
    .where(and(inRange(userLocations.day, range), eq(userLocations.userId, userId)))
    .groupBy(userLocations.country, userLocations.timeZone)
    .orderBy(desc(sql`sum(${userLocations.seconds})`));
  const iso = (d: Date | string) => new Date(d).toISOString();
  return {
    seconds: byArea.reduce((n, r) => n + r.seconds, 0),
    byArea: byArea.map((r) => ({ app: r.app as ActivityApp, area: r.area, seconds: r.seconds, lastAt: iso(r.lastAt) })),
    daily,
    locations: locations.map((l) => ({ ...l, firstAt: iso(l.firstAt), lastAt: iso(l.lastAt) })),
  };
}
