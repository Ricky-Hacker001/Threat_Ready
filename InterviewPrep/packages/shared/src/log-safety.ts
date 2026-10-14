/**
 * Keys that must never reach CloudWatch or Sentry (ADD §9 "What is never logged").
 * Used by the pino redaction config and by the Sentry beforeSend scrubber.
 */
export const SENSITIVE_KEYS = [
  'answer',
  'answers',
  'text',
  'extractedText',
  'extracted_text',
  'resume',
  'jd',
  'jobDescription',
  'prompt',
  'system',
  'messages',
  'content',
  'output',
  'question',
  'email',
  'password',
  'token',
  'cookie',
  'authorization',
  'apiKey',
  'api_key',
  'x-api-key',
] as const;

const SENSITIVE = new Set<string>(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

/** Deep-copies a value replacing sensitive keys and email-like strings. Bounded depth. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]').slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE.has(k.toLowerCase()) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}
