import Anthropic from '@anthropic-ai/sdk';
import { PortError } from '@threatready/shared';
import type { AppConfig } from '../../config/config.js';
import { logger } from '../logging/logger.js';
import type {
  LlmChunk,
  LlmObject,
  LlmPort,
  LlmRequest,
  LlmText,
  LlmTier,
  LlmUsage,
  StructuredSchema,
} from '../ports/llm.port.js';

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

/**
 * The only file that imports the Anthropic SDK (ADD §6 boundary rule: domain modules import ports,
 * never a vendor SDK). Timeouts and retries follow the SDK conventions: the SDK retries 408/409/
 * 429/5xx and connection errors with backoff (LLM_MAX_RETRIES); this adapter adds one retry with a
 * configured fallback model when a LARGE call stops with `refusal`.
 */
export class AnthropicLlmAdapter implements LlmPort {
  private readonly client: Anthropic;

  constructor(private readonly cfg: AppConfig) {
    this.client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, maxRetries: cfg.LLM_MAX_RETRIES });
  }

  modelFor(tier: LlmTier): string {
    return tier === 'SMALL' ? this.cfg.LLM_MODEL_SMALL : this.cfg.LLM_MODEL_LARGE;
  }

  /** Optional boot check that the configured ids exist for this API key (LLM_VERIFY_MODELS_ON_BOOT). */
  async verifyModels(): Promise<void> {
    for (const tier of ['SMALL', 'LARGE'] as const) {
      const id = this.modelFor(tier);
      try {
        await this.client.models.retrieve(id);
      } catch (err) {
        throw new Error(`Configured ${tier} model ${id} is not available to this API key`, { cause: err });
      }
    }
  }

  async generate(req: LlmRequest): Promise<LlmText> {
    const msg = await this.createWithFallback(req, undefined);
    return { text: textOf(msg), usage: usageOf(msg) };
  }

  async generateStructured<T>(req: LlmRequest, schema: StructuredSchema<T>): Promise<LlmObject<T>> {
    const msg = await this.createWithFallback(req, { type: 'json_schema', schema: schema.jsonSchema });
    const usage = usageOf(msg);
    let raw: unknown;
    try {
      raw = JSON.parse(textOf(msg));
    } catch (cause) {
      throw new PortError('invalid_output', `${schema.name}: response was not JSON`, { retryable: true, cause });
    }
    const prepared = schema.prepare ? schema.prepare(raw) : raw;
    const parsed = schema.zod.safeParse(prepared);
    if (!parsed.success) {
      const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join('.')).join(', ');
      throw new PortError('invalid_output', `${schema.name}: schema validation failed at ${paths}`, { retryable: true });
    }
    return { value: parsed.data, usage };
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmChunk> {
    const model = this.modelFor(req.tier);
    const params = this.params(req, model, undefined);
    let stream: ReturnType<Anthropic['messages']['stream']>;
    try {
      stream = this.client.messages.stream(params, { timeout: this.timeout(req), signal: req.signal });
    } catch (err) {
      throw toPortError(err);
    }
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') throw new PortError('refusal', 'stream stopped with refusal', { retryable: false });
      yield { type: 'done', usage: usageOf(final) };
    } catch (err) {
      throw toPortError(err);
    }
  }

  private async createWithFallback(req: LlmRequest, format: Anthropic.JSONOutputFormat | undefined): Promise<Anthropic.Message> {
    const model = this.modelFor(req.tier);
    const first = await this.create(this.params(req, model, format), req);
    if (first.stop_reason !== 'refusal') return checkStop(first);
    const fallback = req.tier === 'LARGE' ? this.cfg.LLM_REFUSAL_FALLBACK_MODEL : undefined;
    logger.warn({ tier: req.tier, model, category: first.stop_details?.category ?? null, fallback: fallback ?? null }, 'llm refusal');
    if (!fallback) throw new PortError('refusal', 'model declined the request', { retryable: false });
    return checkStop(await this.create(this.params(req, fallback, format), req));
  }

  /**
   * Always streamed, then collected: the SDK refuses non-streaming requests whose max_tokens implies a
   * long generation, and a stream keeps the connection alive for long structured outputs.
   */
  private async create(params: CreateParams, req: LlmRequest): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.stream(params, { timeout: this.timeout(req), signal: req.signal }).finalMessage();
    } catch (err) {
      throw toPortError(err);
    }
  }

  private timeout(req: LlmRequest): number {
    return req.timeoutMs ?? (req.tier === 'SMALL' ? this.cfg.LLM_TIMEOUT_MS_SMALL : this.cfg.LLM_TIMEOUT_MS_LARGE);
  }

  private params(req: LlmRequest, model: string, format: Anthropic.JSONOutputFormat | undefined): CreateParams {
    const pricing = this.cfg.pricing[model];
    const outputConfig: Anthropic.OutputConfig = {};
    if (format) outputConfig.format = format;
    if (req.effort && pricing?.supportsEffort) outputConfig.effort = req.effort;
    return {
      model,
      max_tokens: Math.min(req.maxOutputTokens, pricing?.maxOutputTokens ?? req.maxOutputTokens),
      // The system prompt is the stable prefix; marking it lets repeated turns read it from cache.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    };
  }
}

function checkStop(msg: Anthropic.Message): Anthropic.Message {
  if (msg.stop_reason === 'max_tokens') {
    throw new PortError('invalid_output', 'response truncated at max_tokens', { retryable: true });
  }
  if (msg.stop_reason === 'refusal') throw new PortError('refusal', 'model declined the request', { retryable: false });
  return msg;
}

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function usageOf(msg: Anthropic.Message): LlmUsage {
  return {
    model: msg.model,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Typed SDK errors, most specific first. The raw provider message never reaches users, but
 * non-retryable failures (billing, auth, bad request, unknown model) are logged for operators:
 * provider error bodies carry no user content, and without them a misconfiguration is invisible.
 */
export function toPortError(err: unknown): PortError {
  if (err instanceof PortError) return err;
  const port = classify(err);
  if (!(err instanceof Anthropic.APIError) && !(err instanceof Anthropic.APIConnectionError)) {
    // Client-side failures (SDK validation, programming errors) carry no user content.
    logger.error({ err_name: (err as Error)?.name, err_message: String((err as Error)?.message ?? err).slice(0, 300) }, 'llm call failed before reaching the provider');
  } else if (!port.retryable && err instanceof Anthropic.APIError) {
    const body = (err as { error?: { error?: { type?: string; message?: string } } }).error?.error;
    logger.error(
      { provider_status: (err as { status?: number }).status, provider_error_type: body?.type, provider_message: body?.message?.slice(0, 300), provider_request_id: (err as { requestID?: string }).requestID },
      'llm provider rejected the request',
    );
  }
  return port;
}

function classify(err: unknown): PortError {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new PortError('timeout', 'llm timeout', { cause: err });
  if (err instanceof Anthropic.APIUserAbortError) return new PortError('timeout', 'llm call aborted', { cause: err });
  if (err instanceof Anthropic.RateLimitError) return new PortError('rate_limited', 'llm rate limited', { cause: err });
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new PortError('auth', 'llm credentials rejected', { retryable: false, cause: err });
  }
  if (err instanceof Anthropic.NotFoundError) return new PortError('not_found', 'llm model not found', { retryable: false, cause: err });
  if (err instanceof Anthropic.BadRequestError) return new PortError('bad_request', 'llm request rejected', { retryable: false, cause: err });
  if (err instanceof Anthropic.InternalServerError) return new PortError('unavailable', 'llm provider error', { cause: err });
  if (err instanceof Anthropic.APIConnectionError) return new PortError('unavailable', 'llm connection failed', { cause: err });
  if (err instanceof Anthropic.APIError) {
    // 402 billing and 529 overloaded arrive as the base class.
    const status = (err as { status?: number }).status;
    return new PortError(status === 529 ? 'unavailable' : 'bad_request', `llm api error ${status ?? ''}`.trim(), {
      retryable: status === 529,
      cause: err,
    });
  }
  return new PortError('unavailable', 'llm call failed', { cause: err });
}
