import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Platform: one identity (onboard.threatready.io), separate apps on    */
/* their own subdomains. Each app keeps its own overview, reports and   */
/* status; onboard aggregates them for the profile and the admin page.  */
/*                                                                     */
/* This file is the source of truth for the internal API every app      */
/* implements (`/internal/v1/...`). InterviewPrep and Labs live in      */
/* separate repositories and mirror these shapes; keep them in step.    */
/* ------------------------------------------------------------------ */

export const APP_KEYS = ["interview", "labs", "reasoning"] as const;
export const appKeySchema = z.enum(APP_KEYS);
export type AppKey = z.infer<typeof appKeySchema>;

/** "live": reachable and serving. "soon": registered, not built yet (no calls are made). */
export const appStatusSchema = z.enum(["live", "soon"]);
export type AppStatus = z.infer<typeof appStatusSchema>;

export const appInfoSchema = z.object({
  key: appKeySchema,
  title: z.string(),
  /** Public origin the browser is sent to, e.g. https://interviewprep.threatready.io */
  url: z.string(),
  status: appStatusSchema,
});
export type AppInfo = z.infer<typeof appInfoSchema>;

/* ---------------- Identity (onboard → apps) ---------------- */

/** What `GET /api/internal/identity/session` returns for the forwarded cookie. */
export const identitySchema = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    emailVerified: z.boolean(),
    username: z.string().nullable(),
    image: z.string().nullable(),
    isTrial: z.boolean(),
    isAdmin: z.boolean(),
  }),
  session: z.object({ id: z.string(), expiresAt: z.string() }),
});
export type Identity = z.infer<typeof identitySchema>;

/* ---------------- App summary (apps → onboard) ---------------- */

export const aiUsageTotalsSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type AiUsageTotals = z.infer<typeof aiUsageTotalsSchema>;

export const appSummaryItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** App-specific status label, shown as-is (e.g. "Report ready", "In progress"). */
  status: z.string(),
  /** 0–100 when the item has a score */
  score: z.number().nullable(),
  at: z.string(),
  /** Absolute URL of the item's own page in its app (report, run, …) */
  url: z.string(),
});
export type AppSummaryItem = z.infer<typeof appSummaryItemSchema>;

/** `GET /internal/v1/users/:userId/summary` */
export const appSummarySchema = z.object({
  app: appKeySchema,
  stats: z.array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]), hint: z.string().optional() })),
  /** Most recent first, at most 10 */
  items: z.array(appSummaryItemSchema),
  /** Lifetime AI usage for this user; null when the app makes no LLM calls */
  aiUsage: aiUsageTotalsSchema.nullable(),
});
export type AppSummary = z.infer<typeof appSummarySchema>;

/** `GET /internal/v1/ai-usage?from=&to=[&userId=]` */
export const appAiUsageSchema = z.object({
  app: appKeySchema,
  users: z.array(aiUsageTotalsSchema.extend({ userId: z.string(), lastCallAt: z.string().nullable() })),
  byModel: z.array(aiUsageTotalsSchema.extend({ model: z.string() })),
  byFeature: z.array(aiUsageTotalsSchema.extend({ feature: z.string() })),
});
export type AppAiUsage = z.infer<typeof appAiUsageSchema>;

/* ---------------- Browser-facing (onboard SPA) ---------------- */

/** One app's block in the unified overview. `error` set when the app could not be reached. */
export type OverviewApp = AppInfo & { summary: AppSummary | null; error: string | null };

export interface Overview {
  apps: OverviewApp[];
  /** All apps' items merged, newest first */
  recent: (AppSummaryItem & { app: AppKey })[];
}

export interface AdminUserRow {
  id: string;
  name: string;
  email: string | null;
  username: string | null;
  emailVerified: boolean;
  isTrial: boolean;
  isAdmin: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  activeSessions: number;
  ai: AiUsageTotals;
  aiByApp: Partial<Record<AppKey, AiUsageTotals>>;
}

export interface AdminOverview {
  range: { from: string; to: string };
  users: { total: number; verified: number; trial: number; admins: number; activeLast7Days: number; newInRange: number };
  /** `users`: distinct users with at least one AI call in the range (for cost per AI user) */
  ai: AiUsageTotals & { byApp: Partial<Record<AppKey, AiUsageTotals>>; users: number };
  byModel: (AiUsageTotals & { model: string })[];
  byFeature: (AiUsageTotals & { app: AppKey; feature: string })[];
  /** Apps whose usage could not be fetched; totals exclude them */
  unavailable: { app: AppKey; error: string }[];
}

export interface AdminUserList {
  range: { from: string; to: string };
  total: number;
  rows: AdminUserRow[];
  unavailable: { app: AppKey; error: string }[];
}

export interface AdminUserDetail {
  range: { from: string; to: string };
  user: AdminUserRow;
  sessions: { id: string; createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null }[];
  signInMethods: string[];
  apps: OverviewApp[];
  byModel: (AiUsageTotals & { app: AppKey; model: string })[];
  byFeature: (AiUsageTotals & { app: AppKey; feature: string })[];
}

export const emptyAiUsage = (): AiUsageTotals => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});

export function addAiUsage(into: AiUsageTotals, add: AiUsageTotals): AiUsageTotals {
  into.calls += add.calls;
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheWriteTokens += add.cacheWriteTokens;
  into.costUsd += add.costUsd;
  return into;
}

/**
 * Only these redirect targets are honoured after sign-in/out (`?next=`).
 * An open redirect on the identity host would be a phishing gift.
 */
export function safeNext(next: string | null | undefined, allowedOrigins: readonly string[]): string | null {
  if (!next) return null;
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return allowedOrigins.includes(url.origin) ? url.toString() : null;
}
