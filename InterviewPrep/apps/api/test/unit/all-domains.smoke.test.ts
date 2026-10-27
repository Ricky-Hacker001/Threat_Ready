import { describe, expect, it } from 'vitest';
import { architecturesFor, surfacesFor } from '../../src/modules/reasoning/architectures/index.js';
import { registeredDomains } from '../../src/modules/reasoning/domains/index.js';
import { questionRequest, questionSchema } from '../../src/modules/reasoning/prompts/generation.prompts.js';
import { DEFAULT_WEIGHTS } from '../../src/modules/reasoning/scoring.js';
import { pickLibrarySeed } from '../../src/modules/reasoning/seed.js';
import { normaliseLibraryOutput, toLibraryItem, validateLibraryItem } from '../../src/modules/reasoning/validation.js';
import { fakeReasoningQuestion } from '../../src/platform/adapters/fake/reasoning-question.fake.js';

/**
 * Every registered domain, at every level, on every architecture that covers it, and for every one of
 * its attack surfaces: the fake writer's question passes the output schema and the quality gate
 * (gen.v3, questions on the architecture library; before 26 Oct 2026 this ran the model-drawn items).
 */
describe('every registered domain generates a valid fake library question on every eligible architecture and surface', () => {
  for (const domain of registeredDomains()) {
    for (const level of ['beginner', 'intermediate', 'advanced'] as const) {
      it(`${domain.key} / ${level}`, () => {
        const archs = architecturesFor(domain.key, level);
        expect(archs.length, `${domain.key}/${level}: architectures covering the bucket`).toBeGreaterThanOrEqual(3);
        for (const arch of archs) {
          surfacesFor(arch, domain.key).forEach((surface, i) => {
            const seed = { ...pickLibrarySeed(domain, level, [arch], [], () => (i + 0.5) / 4), entryPoint: surface.id, architecture: { id: arch.id, version: arch.version, surface: surface.id } };
            seed.technique = surface.techniques[i % surface.techniques.length]!;
            const req = questionRequest({ arch, domain, seed, surface, tier: 'SMALL', avoid: [], previousFailure: [], tryNumber: 1 });
            const parsed = questionSchema(arch, domain).zod.parse(fakeReasoningQuestion(req));
            const { out, overlay } = normaliseLibraryOutput(parsed, arch, domain, seed);
            const v = validateLibraryItem(out, arch, domain, seed, overlay);
            const where = `${domain.key}/${level}/${arch.id}/${surface.id}`;
            expect(v.errors, `${where}: ${v.errors.join(' | ')}`).toEqual([]);
            const item = toLibraryItem(out, arch, domain, seed, DEFAULT_WEIGHTS, overlay);
            // framework: every technique id matches the domain's pattern
            const pat = domain.framework?.idPattern ?? /^T\d{4}(\.\d{3})?$/;
            for (const t of item.public.techniques) expect(pat.test(t.id), `${where} tech ${t.id}`).toBe(true);
            expect(item.public.difficulty).toBe(level);
          });
        }
      });
    }
  }
});
