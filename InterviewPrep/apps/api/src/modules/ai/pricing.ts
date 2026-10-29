/**
 * Verified model registry: ids and list prices (USD per million tokens), verified against Anthropic's
 * pricing page (platform.claude.com/docs/en/about-claude/pricing) on 2026-10-27, which added
 * `claude-haiku-5-5` and corrected Sonnet 5.5's cache-read price (0.05x input, was 0.2 here). Interviews
 * keep `claude-haiku-4-5` on SMALL (LLM_MODEL_SMALL, which the interview caps are derived from);
 * `claude-haiku-5-5` is offered to Attack Reasoning only, through REASONING_MODEL_SMALL. Re-verify before
 * changing. Cache writes use the 5-minute rate (1.25x input).
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  /** output_config.effort is accepted (rejected on Haiku 4.5). */
  supportsEffort: boolean;
  maxOutputTokens: number;
  /**
   * Thinks adaptively when the request sends no `thinking` (Haiku 5.5): the thinking counts toward
   * max_tokens and is billed as output, so a request needs room for it. Such a model rejects a thinking
   * budget, temperature, top_p, top_k and an assistant prefill (400); the adapters send none of them.
   */
  adaptiveThinking?: boolean;
  /**
   * A second rate card for long prompts: when a call's input, cache-read and cache-write tokens together
   * exceed `aboveTokens`, every token of that call is priced at these rates.
   */
  longContext?: { aboveTokens: number; inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number };
  /** Characters per token for estimates (estimateTokens); 3 when absent. */
  charsPerToken?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25, supportsEffort: false, maxOutputTokens: 64_000 },
  'claude-haiku-5-5': {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    cacheWritePerMTok: 0.125,
    supportsEffort: true,
    maxOutputTokens: 128_000,
    adaptiveThinking: true,
    longContext: { aboveTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5, cacheReadPerMTok: 0.05, cacheWritePerMTok: 0.625 },
    charsPerToken: 2,
  },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2.5, supportsEffort: true, maxOutputTokens: 128_000 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5, supportsEffort: true, maxOutputTokens: 128_000 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Priced on the model's long-context card when its prompt (input plus cache reads and writes) is over the threshold. */
export function costUsd(p: ModelPricing, u: TokenUsage): number {
  const promptTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const r = p.longContext && promptTokens > p.longContext.aboveTokens ? p.longContext : p;
  const c =
    (u.inputTokens * r.inputPerMTok +
      u.outputTokens * r.outputPerMTok +
      u.cacheReadTokens * r.cacheReadPerMTok +
      u.cacheWriteTokens * r.cacheWritePerMTok) /
    1_000_000;
  return Math.round(c * 1_000_000) / 1_000_000;
}

/**
 * Token estimate for budget reservation: about 3 characters per token by default, which over-counts
 * English prose for the older tokenizers. Settlement uses the provider's reported usage. A model with
 * the newer tokenizer counts about 30% more tokens for the same text, and Attack Reasoning prompts
 * (architecture listings, ids, JSON) are denser than prose: on 27 Oct they measured 2.6-2.8 characters
 * a token on Haiku 4.5 and 2.0-2.1 on Sonnet 5.5, which has the newer tokenizer. At 3 the estimate for
 * Haiku 5.5 would under-count the prompt by a third, and near the 100k-token threshold it could miss the
 * long-context rate card, so that model carries its own `charsPerToken` (2). The others keep 3, so the
 * interview estimates do not move; their output allowance dominates every estimate anyway.
 */
export const estimateTokens = (chars: number, p?: Pick<ModelPricing, 'charsPerToken'>): number => Math.ceil(chars / (p?.charsPerToken ?? 3));

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

/**
 * A model's standard rate card. The cost model's token shapes are totals over many calls, each far
 * below the long-context threshold (LlmService refuses a prompt over 100k tokens), so the total must
 * not switch the card the way one long prompt does (review H55-SEC-1: on Haiku 5.5 it priced the live
 * share at 5x, raising the session and global-day caps about 1.67x and the user-day cap about 1.5x; the
 * scoring reserve, priced on LARGE, did not move).
 */
const standardCard = ({ longContext: _longContext, ...p }: ModelPricing): ModelPricing => p;

export function estimateInterviewCost(small: ModelPricing, large: ModelPricing, model = INTERVIEW_COST_MODEL): InterviewCostEstimate {
  const liveUsd = costUsd(standardCard(small), { ...model.live, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const finalizeUsd = costUsd(standardCard(large), { ...model.finalize, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const sessionCapUsd = usd6(liveUsd + finalizeUsd);
  return {
    liveUsd,
    finalizeUsd,
    sessionCapUsd,
    userDailyCapUsd: usd6(model.interviewsPerUserDay * sessionCapUsd + finalizeUsd),
    globalDailyCapUsd: usd6(model.interviewsPerGlobalDay * sessionCapUsd),
  };
}
