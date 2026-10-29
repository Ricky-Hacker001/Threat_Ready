import type { AppConfig } from '../../config/config.js';
import { resolveModel } from '../../platform/ports/llm.port.js';

/**
 * How Attack Reasoning asks its SMALL tier, from the model that tier resolves to for the reasoning
 * profile (REASONING_MODEL_SMALL, else LLM_MODEL_SMALL). A model that thinks adaptively (Haiku 5.5)
 * spends its thinking out of max_tokens and takes longer, so the request builders give it more output
 * room and a longer timeout; `effort` is set only when the model accepts it. Haiku 4.5 gets
 * `{ thinking: false }`: exactly the parameters it had before.
 */
export interface SmallTierParams {
  thinking: boolean;
  effort?: 'low' | 'medium' | 'high';
}

type SmallTierConfig = Pick<AppConfig, 'LLM_MODEL_SMALL' | 'LLM_MODEL_LARGE' | 'REASONING_MODEL_SMALL' | 'REASONING_SMALL_EFFORT_GENERATION' | 'REASONING_SMALL_EFFORT_EVALUATION' | 'pricing'>;

export function smallTierParams(cfg: SmallTierConfig, stage: 'generation' | 'evaluation'): SmallTierParams {
  const pricing = cfg.pricing[resolveModel(cfg, 'SMALL', 'reasoning')];
  const effort = stage === 'generation' ? cfg.REASONING_SMALL_EFFORT_GENERATION : cfg.REASONING_SMALL_EFFORT_EVALUATION;
  return { thinking: pricing?.adaptiveThinking === true, ...(pricing?.supportsEffort ? { effort } : {}) };
}
