/**
 * Verified model registry: ids and list prices (USD per million tokens) from Anthropic's model
 * table as of 2026-09-25. The ADD names `claude-haiku-5-5` for SMALL at US$0.10/0.50; that id is
 * not in the verified table, so SMALL defaults to `claude-haiku-4-5`. Re-verify before changing.
 * Cache writes use the 5-minute rate (1.25x input).
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  /** output_config.effort is accepted (rejected on Haiku 4.5). */
  supportsEffort: boolean;
  maxOutputTokens: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25, supportsEffort: false, maxOutputTokens: 64_000 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5, supportsEffort: true, maxOutputTokens: 128_000 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5, supportsEffort: true, maxOutputTokens: 128_000 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costUsd(p: ModelPricing, u: TokenUsage): number {
  const c =
    (u.inputTokens * p.inputPerMTok +
      u.outputTokens * p.outputPerMTok +
      u.cacheReadTokens * p.cacheReadPerMTok +
      u.cacheWriteTokens * p.cacheWritePerMTok) /
    1_000_000;
  return Math.round(c * 1_000_000) / 1_000_000;
}

/**
 * Conservative token estimate for budget reservation: about 3 characters per token, which
 * over-counts English for current tokenizers. Settlement uses the provider's reported usage.
 */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 3);

/**
 * Token shape of one interview, from which the default AI caps are derived (security patch 2, A6).
 * Before this the caps were fixed dollar figures, so switching LLM_MODEL_SMALL to a dearer model
 * silently bought fewer turns per cap, and a cheaper one silently raised the exposure in tokens.
 *
 * `live` is every SMALL-tier call of a 30-minute interview (questions, provisional evaluations,
 * clarifications); `finalize` is the LARGE-tier final scoring and report. At the registry prices
 * for claude-haiku-4-5 (live) and claude-sonnet-5-5 (finalize) these reproduce the previous
 * defaults exactly: session cap US$0.60, scoring reserve US$0.20, user day US$2 (three interviews
 * plus one re-scored report), global day US$60 (one hundred interviews).
 */
export const INTERVIEW_COST_MODEL = {
  live: { inputTokens: 200_000, outputTokens: 40_000 },
  finalize: { inputTokens: 50_000, outputTokens: 10_000 },
  interviewsPerUserDay: 3,
  interviewsPerGlobalDay: 100,
} as const;

export interface InterviewCostEstimate {
  liveUsd: number;
  finalizeUsd: number;
  sessionCapUsd: number;
  userDailyCapUsd: number;
  globalDailyCapUsd: number;
}

const usd6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

export function estimateInterviewCost(small: ModelPricing, large: ModelPricing, model = INTERVIEW_COST_MODEL): InterviewCostEstimate {
  const liveUsd = costUsd(small, { ...model.live, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const finalizeUsd = costUsd(large, { ...model.finalize, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const sessionCapUsd = usd6(liveUsd + finalizeUsd);
  return {
    liveUsd,
    finalizeUsd,
    sessionCapUsd,
    userDailyCapUsd: usd6(model.interviewsPerUserDay * sessionCapUsd + finalizeUsd),
    globalDailyCapUsd: usd6(model.interviewsPerGlobalDay * sessionCapUsd),
  };
}
