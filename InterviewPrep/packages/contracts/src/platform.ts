import { z } from './zod.js';

/**
 * ThreatReady platform. Sign-in lives on onboard.threatready.io (the identity provider);
 * this app trusts the shared session cookie, resolved through onboard's internal identity
 * endpoint. The internal summary and AI-usage shapes below mirror the source of truth in the
 * onboard repository (packages/contracts/src/platform.ts); keep them in step.
 */
export const Me = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    isAdmin: z.boolean(),
  })
  .openapi('Me');
export type Me = z.infer<typeof Me>;

export const AiUsageTotals = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type AiUsageTotals = z.infer<typeof AiUsageTotals>;

/** GET /internal/v1/users/{userId}/summary */
export interface AppSummary {
  app: 'interview';
  stats: { label: string; value: string | number; hint?: string }[];
  items: { id: string; title: string; status: string; score: number | null; at: string; url: string }[];
  aiUsage: AiUsageTotals | null;
}

/** GET /internal/v1/ai-usage?from=&to=[&userId=] */
export interface AppAiUsage {
  app: 'interview';
  users: (AiUsageTotals & { userId: string; lastCallAt: string | null })[];
  byModel: (AiUsageTotals & { model: string })[];
  byFeature: (AiUsageTotals & { feature: string })[];
}

/** Every ThreatReady app for the shared header (from onboard's public config, cached by the API). */
export const PlatformApps = z
  .object({
    apps: z.array(z.object({ key: z.enum(['interview', 'labs', 'reasoning']), title: z.string(), url: z.string(), status: z.string() })),
  })
  .openapi('PlatformApps');
export type PlatformApps = z.infer<typeof PlatformApps>;
