import { describe, expect, it } from 'vitest';
import { registeredDomains } from '../../src/modules/reasoning/domains/index.js';
import { pickSeed } from '../../src/modules/reasoning/seed.js';
import { generationRequest, generationSchema } from '../../src/modules/reasoning/prompts/generation.prompts.js';
import { normaliseGeneratorOutput, validateGeneratedItem } from '../../src/modules/reasoning/validation.js';
import { fakeReasoningItem } from '../../src/platform/adapters/fake/reasoning.fake.js';

describe('every registered domain generates a valid fake item across difficulties', () => {
  for (const domain of registeredDomains()) {
    for (const difficulty of ['beginner', 'intermediate', 'advanced'] as const) {
      it(`${domain.key} / ${difficulty}`, () => {
        // a few deterministic seeds per bucket
        for (let i = 0; i < 4; i++) {
          const seed = pickSeed(domain, [], () => (i + 0.5) / 4, new Set(), difficulty);
          const req = generationRequest({ domain, seed, avoid: [], previousFailure: [], tryNumber: 1 });
          const raw = fakeReasoningItem(req);
          const parsed = generationSchema().zod.parse(raw);
          const { out } = normaliseGeneratorOutput(parsed, domain, seed);
          const v = validateGeneratedItem(out, domain, seed);
          expect(v.errors, `${domain.key}/${difficulty} seed${i}: ${v.errors.join(' | ')}`).toEqual([]);
          // framework: every technique id matches the domain's pattern
          const pat = (domain.framework?.idPattern) ?? /^T\d{4}(\.\d{3})?$/;
          for (const t of out.techniques) expect(pat.test(t.id), `${domain.key} tech ${t.id}`).toBe(true);
        }
      });
    }
  }
});
