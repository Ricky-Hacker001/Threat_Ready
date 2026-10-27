import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Review AR-BIZ-7 (27 Oct 2026): most answers are now graded in one pass and only borderline, disputed
 * or sampled ones get the challenger and reconciler, and an on-demand question takes a Haiku try and
 * often a Sonnet rewrite (70-82 s measured). The learner-facing copy must not promise three stages, a
 * reconciler that did not run, or "under a minute" for generation.
 */
const pages = readFileSync(new URL('../client/src/reasoning/pages.tsx', import.meta.url), 'utf8');

describe('grading and waiting copy (review AR-BIZ-7)', () => {
  it('describes one grading pass with a second review for some answers, never three stages for every answer', () => {
    expect(pages).not.toMatch(/three (?:grading )?stages|Evaluating in three|Evaluator: grades|settled by the reconciler/i);
    expect(pages).toContain('Evaluating your answer');
    expect(pages).toMatch(/Borderline or disputed answers, and a random sample of the rest, get a second, adversarial review/);
    // Still three list items in the same element, so the panel's layout is unchanged.
    const panel = pages.match(/<ol className="ar-stages">([\s\S]*?)<\/ol>/)![1]!;
    expect(panel.match(/<li>/g)).toHaveLength(3);
  });

  it('confidence wording fits a single pass and an escalated one alike', () => {
    const conf = pages.match(/const CONF_TEXT[\s\S]*?\n};/)![0];
    expect(conf).not.toMatch(/stage|reconciler/i);
    expect(conf).toMatch(/high: 'the grading was consistent/);
  });

  it('does not promise generation in under a minute, and waits two minutes before saying it is slow', () => {
    expect(pages).not.toMatch(/generat[^.;]*under a minute|under a minute\.\)'|'Usually under a minute\.'/i);
    expect(pages.match(/a minute or two/g)!.length).toBeGreaterThanOrEqual(4);
    expect(pages).toMatch(/state === 'generating' \? 120_000 : 75_000/);
  });
});
