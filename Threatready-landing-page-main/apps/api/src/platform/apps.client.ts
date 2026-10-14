import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  APP_KEYS,
  appAiUsageSchema,
  appSummarySchema,
  type AppAiUsage,
  type AppKey,
  type AppSummary,
  type OverviewApp,
} from "@threatready/contracts";
import type { ZodType } from "zod";
import { CONFIG, type Config, type RegisteredApp } from "../config.js";

const TIMEOUT_MS = 4_000;

export type Fetched<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Onboard's view of the apps: each owns its data and serves it on
 * /internal/v1/*. A slow or down app degrades its own card, never the page.
 */
@Injectable()
export class AppsClient {
  private readonly logger = new Logger("Apps");

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  /** Apps that are built and reachable (status "live"). */
  live(): RegisteredApp[] {
    return APP_KEYS.map((k) => this.config.apps[k]).filter((a) => a.status === "live");
  }

  all(): RegisteredApp[] {
    return APP_KEYS.map((k) => this.config.apps[k]);
  }

  private async get<T>(app: RegisteredApp, path: string, schema: ZodType<T>): Promise<Fetched<T>> {
    try {
      const res = await fetch(`${app.internalUrl}${path}`, {
        headers: { authorization: `Bearer ${this.config.INTERNAL_API_TOKEN}`, accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`${app.key} ${path.split("?")[0]} → ${res.status}`);
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const parsed = schema.safeParse(await res.json());
      if (!parsed.success) {
        this.logger.warn(`${app.key} returned an unexpected shape: ${parsed.error.issues[0]?.message}`);
        return { ok: false, error: "Unexpected response" };
      }
      return { ok: true, data: parsed.data };
    } catch (err) {
      const msg = err instanceof Error && err.name === "TimeoutError" ? "Timed out" : "Unreachable";
      this.logger.warn(`${app.key} ${path.split("?")[0]}: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  summary(app: RegisteredApp, userId: string): Promise<Fetched<AppSummary>> {
    return this.get(app, `/internal/v1/users/${encodeURIComponent(userId)}/summary`, appSummarySchema);
  }

  aiUsage(app: RegisteredApp, range: { from: Date; to: Date }, userId?: string): Promise<Fetched<AppAiUsage>> {
    const q = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString() });
    if (userId) q.set("userId", userId);
    return this.get(app, `/internal/v1/ai-usage?${q}`, appAiUsageSchema);
  }

  /** Every registered app with this user's summary (null for "soon" apps and failures). */
  async overviewApps(userId: string): Promise<OverviewApp[]> {
    return Promise.all(
      this.all().map(async ({ internalUrl: _internal, ...info }) => {
        if (info.status !== "live") return { ...info, summary: null, error: null };
        const r = await this.summary(this.config.apps[info.key], userId);
        return r.ok ? { ...info, summary: r.data, error: null } : { ...info, summary: null, error: r.error };
      }),
    );
  }

  /** AI usage from every live app, keyed by app. */
  async aiUsageAll(range: { from: Date; to: Date }, userId?: string) {
    const results = await Promise.all(this.live().map(async (a) => [a.key, await this.aiUsage(a, range, userId)] as const));
    const ok: Partial<Record<AppKey, AppAiUsage>> = {};
    const unavailable: { app: AppKey; error: string }[] = [];
    for (const [key, r] of results) {
      if (r.ok) ok[key] = r.data;
      else unavailable.push({ app: key, error: r.error });
    }
    return { ok, unavailable };
  }
}
