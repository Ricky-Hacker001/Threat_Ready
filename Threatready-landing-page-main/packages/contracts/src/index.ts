import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Credential policy — shared by the SPA (inline validation) and API.  */
/* The API is the authority; the SPA copy only gives early feedback.   */
/* ------------------------------------------------------------------ */

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 600;

export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN, `Username must be at least ${USERNAME_MIN} characters`)
  .max(USERNAME_MAX, `Username must be at most ${USERNAME_MAX} characters`)
  .regex(/^[a-zA-Z0-9_.]+$/, "Use letters, numbers, dots and underscores only");

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`);

export const otpSchema = z
  .string()
  .trim()
  .regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Enter the ${OTP_LENGTH}-digit code`);

export const signUpSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const forgotUsernameRequestSchema = z.object({ email: emailSchema });
export type ForgotUsernameRequest = z.infer<typeof forgotUsernameRequestSchema>;

/** Always the same body, whether or not the email is registered. */
export const genericAcceptedSchema = z.object({ accepted: z.literal(true) });
export type GenericAccepted = z.infer<typeof genericAcceptedSchema>;

/* ------------------------------------------------------------------ */
/* Features and entitlements                                           */
/* ------------------------------------------------------------------ */

export const FEATURE_KEYS = ["interview", "simulations", "reasoning"] as const;
export const featureKeySchema = z.enum(FEATURE_KEYS);
export type FeatureKey = z.infer<typeof featureKeySchema>;

export const featureAccessSchema = z.enum(["full", "trial", "exhausted"]);
export type FeatureAccess = z.infer<typeof featureAccessSchema>;

export const featureStateSchema = z.object({
  key: featureKeySchema,
  access: featureAccessSchema,
  /** null when unlimited */
  remaining: z.number().int().nonnegative().nullable(),
  limit: z.number().int().nonnegative().nullable(),
});
export type FeatureState = z.infer<typeof featureStateSchema>;

/** The organisation (business or institute account) the signed-in user belongs to, if any. */
export const orgContextSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["business", "institute"]),
  /** Who the organisation is for; shown in the console copy. */
  segment: z.enum(["business", "institute"]),
  /** pending: created, waiting for platform approval. suspended: no launches on the org's plan. */
  status: z.enum(["pending", "active", "suspended"]),
  /** The caller's role in the organisation. Only org_admin and manager open the organisation console. */
  role: z.enum(["org_admin", "manager", "member"]),
  /** The caller's membership state: a suspended member keeps the account but falls back to the personal plan. */
  memberStatus: z.enum(["active", "suspended"]),
  plan: z.enum(["business_trial", "business"]),
  planStatus: z.enum(["trialing", "active", "past_due", "suspended", "cancelled"]),
  seats: z.number().int().nonnegative(),
  /** Trial end or renewal date, ISO; null when open-ended. */
  periodEnd: z.string().nullable(),
  /** True when launches are counted against this organisation's plan right now. */
  effective: z.boolean(),
});
export type OrgContext = z.infer<typeof orgContextSchema>;

export const meSchema = z.object({
  user: z.object({
    id: z.string(),
    username: z.string().nullable(),
    email: z.string().nullable(),
    isTrial: z.boolean(),
    isAdmin: z.boolean(),
  }),
  /** The organisation launches are counted against right now: the business org while its membership and plan are live, else the personal workspace. */
  orgId: z.string(),
  role: z.enum(["learner", "trial"]),
  plan: z.enum(["free", "trial", "business_trial", "business"]),
  /** Personal workspace, always present. */
  personal: z.object({ orgId: z.string(), plan: z.enum(["free", "trial"]) }),
  org: orgContextSchema.nullable(),
  features: z.array(featureStateSchema),
});
export type Me = z.infer<typeof meSchema>;

export const launchResponseSchema = z.object({
  launchId: z.string(),
  feature: featureKeySchema,
  /** SPA route that hosts the module */
  route: z.string(),
  state: featureStateSchema,
});
export type LaunchResponse = z.infer<typeof launchResponseSchema>;

export const apiErrorSchema = z.object({
  statusCode: z.number(),
  code: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const FEATURE_ROUTES: Record<FeatureKey, string> = {
  interview: "/app/interview",
  simulations: "/app/simulations",
  reasoning: "/app/reasoning",
};

/* ------------------------------------------------------------------ */
/* Plan limits — shared so the SPA's copy can never drift from what    */
/* the API enforces. PLACEHOLDER values until pricing is decided.      */
/*                                                                     */
/* Interview Prep and Attack Reasoning call the LLM (≈US$0.13–0.17 per */
/* interview, ≈US$0.10–0.12 per reasoning session, Architecture        */
/* Summary §6), so they are capped. Simulations run on server-side     */
/* emulators with no per-session usage cost.                           */
/* ------------------------------------------------------------------ */

export type Plan = "trial" | "free" | "business_trial" | "business";
export const PLANS = ["trial", "free", "business_trial", "business"] as const;
export const planSchema = z.enum(PLANS);

export interface FeatureLimit {
  /** null = unlimited */
  limit: number | null;
  /** "lifetime" counts every launch; "month" counts the current UTC calendar month. */
  period: "lifetime" | "month";
}

/**
 * Business plans are per seat: every member of the organisation gets these limits each month on the
 * organisation's plan. Figures are placeholders until pricing is decided (business-accounts plan §3.2);
 * the platform admin can also set seats, the plan period and an AI cap per organisation.
 */
export const PLAN_LIMITS: Record<Plan, Record<FeatureKey, FeatureLimit>> = {
  trial: {
    interview: { limit: 1, period: "lifetime" },
    simulations: { limit: 2, period: "lifetime" },
    reasoning: { limit: 1, period: "lifetime" },
  },
  free: {
    interview: { limit: 3, period: "month" },
    simulations: { limit: null, period: "month" },
    reasoning: { limit: 10, period: "month" },
  },
  business_trial: {
    interview: { limit: 5, period: "month" },
    simulations: { limit: null, period: "month" },
    reasoning: { limit: 20, period: "month" },
  },
  business: {
    interview: { limit: 20, period: "month" },
    simulations: { limit: null, period: "month" },
    reasoning: { limit: 100, period: "month" },
  },
};

/** How each plan is shown. Prices are not here on purpose: billing is a later phase. */
export const PLAN_INFO: Record<Plan, { label: string; audience: "individual" | "organisation" }> = {
  trial: { label: "Guest", audience: "individual" },
  free: { label: "Free", audience: "individual" },
  business_trial: { label: "Business trial", audience: "organisation" },
  business: { label: "Business", audience: "organisation" },
};

export const isOrganisationPlan = (plan: Plan): boolean => PLAN_INFO[plan].audience === "organisation";

export * from "./org.js";
export * from "./platform.js";
