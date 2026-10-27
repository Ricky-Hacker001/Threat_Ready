import type { ZodType } from 'zod';

export type LlmTier = 'SMALL' | 'LARGE';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** ADD §6: the application asks for tiers, never model names. */
export interface LlmRequest {
  tier: LlmTier;
  /**
   * Stable, cacheable prefix rendered as the first system block (cache_control: ephemeral), before
   * `system`. Byte-identical across the calls that should share a cache entry. Never learner text:
   * learner input always travels in the user message, inside <untrusted_*> tags.
   */
  systemPrefix?: string;
  system: string;
  /**
   * false: no cache_control marker on any block. For prompts nothing reads back within the cache
   * lifetime (review COST-2: each Attack Reasoning stage sends its own structured-output format, which
   * invalidates the prompt cache, so the cross-stage entries were written and never read and the write
   * premium was a surcharge). Default: marked, as before.
   */
  cache?: boolean;
  messages: LlmMessage[];
  maxOutputTokens: number;
  promptVersion: string;
  /** Overrides the tier timeout. */
  timeoutMs?: number;
  /** Thinking depth on models that support it; ignored elsewhere. */
  effort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmText {
  text: string;
  usage: LlmUsage;
  /** Earlier billed messages this result also paid for (a refused first try before the fallback model answered). */
  extraUsage?: LlmUsage[];
}

export interface LlmObject<T> {
  value: T;
  usage: LlmUsage;
  extraUsage?: LlmUsage[];
}

export interface StructuredSchema<T> {
  name: string;
  /** JSON schema sent as output_config.format (no numeric ranges; those are checked in code). */
  jsonSchema: Record<string, unknown>;
  /** Validates the parsed output. Failure is a PortError of kind invalid_output. */
  zod: ZodType<T>;
  /** Optional normaliser applied before validation (length clamps, enum cleanup). */
  prepare?: (raw: unknown) => unknown;
}

export type LlmChunk = { type: 'text'; text: string } | { type: 'done'; usage: LlmUsage };

/**
 * Attaches the provider's usage to an error for a call the provider billed but the adapter must
 * reject (truncated at max_tokens, output that fails the schema, refusal after tokens, a stream cut
 * off part-way). `extraUsage` is any earlier message of the same call (the refused first try before a
 * fallback). LlmService records that cost against every budget; a failure without usage costs nothing.
 */
export function withUsage<E extends Error>(err: E, usage: LlmUsage, extraUsage?: LlmUsage[]): E & { usage: LlmUsage; extraUsage?: LlmUsage[] } {
  return Object.assign(err, { usage }, extraUsage?.length ? { extraUsage } : {});
}

/** Characters of the whole prompt (cached prefix, system and messages): the basis of estimates and the fake's usage. */
export function promptChars(req: Pick<LlmRequest, 'systemPrefix' | 'system' | 'messages'>): number {
  return (req.systemPrefix?.length ?? 0) + req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
}

export interface LlmPort {
  generate(req: LlmRequest): Promise<LlmText>;
  generateStructured<T>(req: LlmRequest, schema: StructuredSchema<T>): Promise<LlmObject<T>>;
  stream(req: LlmRequest): AsyncIterable<LlmChunk>;
  /** Resolves the model id for a tier (for budgeting and the call log). */
  modelFor(tier: LlmTier): string;
}

export const LLM_PORT = Symbol('LlmPort');
