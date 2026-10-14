import { z, type ZodType } from 'zod';

const DROP = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'maxItems',
  'minItems',
  'multipleOf',
  'default',
]);

/**
 * Converts a Zod schema to the JSON schema sent as output_config.format. Structured outputs do not
 * carry numeric or length ranges, so those are dropped here and enforced in code (ADD L15).
 * Every object is closed (additionalProperties: false) and lists all properties as required.
 */
export function toOutputSchema(schema: ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return clean(raw) as Record<string, unknown>;
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP.has(k)) continue;
    out[k] = clean(v);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as object);
  }
  return out;
}

/**
 * Normalises model output before validation: trims strings to a ceiling and arrays to a length,
 * so a slightly verbose answer is clamped instead of failing the whole call. Values stored for
 * display stay bounded no matter what the model returns.
 */
export function clampDeep(value: unknown, maxString = 1200, maxArray = 40): unknown {
  if (typeof value === 'string') return value.length > maxString ? value.slice(0, maxString) : value;
  if (Array.isArray(value)) return value.slice(0, maxArray).map((v) => clampDeep(v, maxString, maxArray));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clampDeep(v, maxString, maxArray)]));
  }
  return value;
}

/** Wraps untrusted text so it cannot close its own delimiter. */
export function untrusted(tag: string, text: string): string {
  const safe = text.replace(new RegExp(`</?${tag}`, 'gi'), (m) => m.replace('<', '‹'));
  return `<${tag}>\n${safe}\n</${tag}>`;
}
