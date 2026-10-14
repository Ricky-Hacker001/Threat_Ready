import type { ZodType } from 'zod';

export type LlmTier = 'SMALL' | 'LARGE';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** ADD §6: the application asks for tiers, never model names. */
export interface LlmRequest {
  tier: LlmTier;
  system: string;
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
}

export interface LlmObject<T> {
  value: T;
  usage: LlmUsage;
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

export interface LlmPort {
  generate(req: LlmRequest): Promise<LlmText>;
  generateStructured<T>(req: LlmRequest, schema: StructuredSchema<T>): Promise<LlmObject<T>>;
  stream(req: LlmRequest): AsyncIterable<LlmChunk>;
  /** Resolves the model id for a tier (for budgeting and the call log). */
  modelFor(tier: LlmTier): string;
}

export const LLM_PORT = Symbol('LlmPort');
