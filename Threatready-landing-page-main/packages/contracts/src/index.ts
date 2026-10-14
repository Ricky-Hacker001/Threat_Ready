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

export const meSchema = z.object({
  user: z.object({
    id: z.string(),
    username: z.string().nullable(),
    email: z.string().nullable(),
    isTrial: z.boolean(),
    isAdmin: z.boolean(),
  }),
  orgId: z.string(),
  role: z.enum(["learner", "trial"]),
  plan: z.enum(["free", "trial"]),
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

export type Plan = "trial" | "free";

export interface FeatureLimit {
  /** null = unlimited */
  limit: number | null;
  /** "lifetime" counts every launch; "month" counts the current UTC calendar month. */
  period: "lifetime" | "month";
}

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
};

export * from "./platform.js";
