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
