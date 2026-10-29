import { describe, expect, it } from 'vitest';
import { fakeReasoningItem } from '../../src/platform/adapters/fake/reasoning.fake.js';
import { CLOUD_SECURITY } from '../../src/modules/reasoning/domains/cloud-security.js';
import type { VariationSeed } from '../../src/modules/reasoning/domain.types.js';
import type { GeneratorOutput } from '../../src/modules/reasoning/item.types.js';
import { generationRequest, generationSchema } from '../../src/modules/reasoning/prompts/generation.prompts.js';
import { checkAnswerLeak, checkDistractors, checkRegulationFacts, checkTimeline, extractTimeline, qualityChecks } from '../../src/modules/reasoning/quality.js';
import { validateGeneratedItem } from '../../src/modules/reasoning/validation.js';

/**
 * Content-quality rules added 28 Oct 2026 after a review of 20 small-tier questions that passed the
 * structural validator: four gave the answer away in the scenario, one ran its timeline backwards,
 * one misstated GDPR, one had two defensible answers. Each case below is modelled on one of those.
 */

const seed = (over: Partial<VariationSeed> = {}): VariationSeed => ({ domain: 'cloud_security', difficulty: 'intermediate', topology: 'three_tier_web', entryPoint: 'leaked_access_key', objective: 'break_the_path', technique: 'T1078.004', constraint: 'change_freeze', ...over });

function fakeItem(s: VariationSeed = seed()): GeneratorOutput {
  const req = generationRequest({ domain: CLOUD_SECURITY, seed: s, avoid: [], previousFailure: [], tryNumber: 1 });
  return generationSchema().zod.parse(fakeReasoningItem(req));
}

const errors = (fs: { severity: string; message: string }[]) => fs.filter((f) => f.severity === 'error').map((f) => f.message);
const why = (out: GeneratorOutput, id: string) => out.option_analysis.find((a) => a.id === id)!;

describe('attack reasoning: content quality — answer leakage', () => {
  it('a clean item raises no error', () => {
    expect(errors(qualityChecks(fakeItem()))).toEqual([]);
    expect(validateGeneratedItem(fakeItem(), CLOUD_SECURITY, seed()).ok).toBe(true);
  });

  it('rejects visible text that refers to an option by letter', () => {
    const out = fakeItem();
    out.attack_narrative = `${out.attack_narrative} The on-call lead leaned towards option B.`;
    expect(errors(checkAnswerLeak(out)).join(' ')).toMatch(/refers to an option by letter \("option B"\)/);
  });

  it('rejects a scenario that repeats the wording of the best option', () => {
    const out = fakeItem();
    const best = out.options.find((o) => o.id === out.correct_option)!.text;
    out.scenario = `${out.scenario} The runbook's first step reads: ${best}`;
    const msgs = errors(checkAnswerLeak(out)).join(' ');
    expect(msgs).toMatch(/repeats the wording of the best option/);
    // The same run inside a distractor is not a tell: components are named in every option.
    const shared = fakeItem();
    shared.scenario = `${shared.scenario} Everyone can read the ${shared.diagram.nodes.find((n) => n.id === 'bucket')!.label} today.`;
    expect(errors(checkAnswerLeak(shared))).toEqual([]);
  });

  it('rejects a sentence that recommends the best option', () => {
    const out = fakeItem();
    out.scenario = `${out.scenario} The incident runbook says the team should revoke the session and scope the policy before anything else.`;
    expect(errors(checkAnswerLeak(out)).join(' ')).toMatch(/a sentence recommends the best option/);
    // A recommendation about something no option proposes is just a fact of the environment.
    const neutral = fakeItem();
    neutral.scenario = `${neutral.scenario} Policy says every vendor contract must be renewed yearly.`;
    expect(errors(checkAnswerLeak(neutral))).toEqual([]);
  });

  it('rejects a scenario whose vocabulary steers to the best option', () => {
    const out = fakeItem();
    // Every distinctive term of the best option, worked into the environment description without a recommendation verb.
    out.scenario = `${out.scenario} Engineers had discussed revoking stale sessions, scoping each policy and whether reads could be stopped so nothing lingers longer than needed.`;
    expect(errors(checkAnswerLeak(out)).join(' ')).toMatch(/steering to option B/);
  });

  it('feeds leakage back through the validator as an error the generator can act on', () => {
    const out = fakeItem();
    out.question = `${out.question} (Hint: scope the policy and revoke the session.)`;
    const v = validateGeneratedItem(out, CLOUD_SECURITY, seed());
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/best option/);
  });
});

describe('attack reasoning: content quality — timeline', () => {
  it('reads clock times, ISO stamps and am/pm in written order and skips sentences that look back', () => {
    const t = extractTimeline('The key had been created on 2025-01-02. At 09:14 calls began. By 9:40 pm listing was done. On 2026-03-05T01:10Z the export left.');
    expect(t.map((p) => p.text)).toEqual(['09:14', '9:40 pm', '2026-03-05T01:10Z']);
    expect(t[1]!.minutes - t[0]!.minutes).toBe(12 * 60 + 26);
  });

  it('rejects a narrative whose times run backwards', () => {
    const out = fakeItem();
    out.attack_narrative = 'At 09:40 the control-plane audit log records the deploy-prod role used from an unknown address. At 09:12 the attacker listed the exports-prod bucket and pulled objects. By 10:05 the customer database saw scans from the orders web app network.';
    expect(errors(checkTimeline(out)).join(' ')).toMatch(/runs backwards \("09:40" then "09:12"\)/);
  });

  it('rejects "N minutes later at HH:MM" that does not add up, accepts one that does', () => {
    const out = fakeItem();
    out.attack_narrative = 'At 09:14 the audit log shows the first call. 20 minutes later, at 09:50, the bucket was listed.';
    expect(errors(checkTimeline(out)).join(' ')).toMatch(/does not add up from "09:14"/);
    out.attack_narrative = 'At 09:14 the audit log shows the first call. 20 minutes later, at 09:34, the bucket was listed. Two hours on, at 11:40, exports left.';
    expect(errors(checkTimeline(out))).toEqual([]);
  });

  it('accepts dated steps across midnight, a look-back sentence, and a narrative without times', () => {
    const out = fakeItem();
    out.attack_narrative = 'The deploy key was created on 2025-11-02 and never rotated. On 2026-03-04 at 23:50 the first call arrived. At 00:10 the attacker enumerated the bucket; earlier that week the same address had probed the login page at 14:00.';
    expect(errors(checkTimeline(out))).toEqual([]);
    out.attack_narrative = 'The trail shows the role used from an address nobody recognises, then the bucket listed and the database probed.';
    expect(errors(checkTimeline(out))).toEqual([]);
  });

  it('rejects ISO timestamps out of order', () => {
    const out = fakeItem();
    out.attack_narrative = 'Exfiltration completed at 2026-03-04T09:40:00Z. Initial access was logged at 2026-03-04T09:52:00Z, then at 2026-03-04T09:12:00Z the role was first used.';
    expect(errors(checkTimeline(out)).join(' ')).toMatch(/runs backwards/);
  });
});

describe('attack reasoning: content quality — regulation figures', () => {
  it('rejects a wrong GDPR breach-notification deadline and names the right figure', () => {
    const out = fakeItem();
    out.reference_answer = `${out.reference_answer} Under GDPR the supervisory authority must be notified within 24 hours of the breach.`;
    const msgs = errors(checkRegulationFacts(out)).join(' ');
    expect(msgs).toMatch(/reference_answer: "within 24 hours" misstates GDPR supervisory-authority breach notification: GDPR Art\. 33 requires .* 72 hours/);
  });

  it('accepts correct figures, number words and the one-month data subject deadline', () => {
    const out = fakeItem();
    out.reference_answer = 'GDPR Article 33 requires the regulator to be notified within seventy-two hours. The access request must be answered within one month under GDPR. HIPAA requires notice to individuals no later than 60 days after discovery. The SEC Form 8-K disclosure is due within four business days. Fines under GDPR reach 4% of global annual turnover or €20 million.';
    expect(errors(checkRegulationFacts(out))).toEqual([]);
  });

  it('rejects wrong HIPAA, SEC, NIS2, DPDP and GDPR fine figures wherever they appear', () => {
    const out = fakeItem();
    out.options[2]!.text = 'Notify the regulator inside 30 days as HIPAA requires for a breach of this size and continue monitoring.';
    out.rubric[0]!.hint = 'Name the SEC rule: a material incident must be disclosed on Form 8-K within 2 business days.';
    out.rubric[1]!.explanation = 'NIS2 requires the incident notification to the CSIRT within 48 hours.';
    out.must_not_credit[0]!.claim = 'DPDP allows a 7-day window for the detailed breach report to the Data Protection Board.';
    out.option_analysis[0]!.why = 'A GDPR fine of 10% of annual turnover makes this the priority, but it leaves the identity active.';
    const msgs = errors(checkRegulationFacts(out));
    expect(msgs.join('\n')).toMatch(/options\.C: "inside 30 days" misstates HIPAA/);
    expect(msgs.join('\n')).toMatch(/rubric\.\w+\.hint: "within 2 business days" misstates SEC/);
    expect(msgs.join('\n')).toMatch(/rubric\.\w+\.explanation: "within 48 hours" misstates NIS2/);
    expect(msgs.join('\n')).toMatch(/must_not_credit\.\w+\.claim: "7-day window" misstates India DPDP/);
    expect(msgs.join('\n')).toMatch(/option_analysis\.A: "10% of annual turnover" misstates GDPR fines/);
    expect(msgs).toHaveLength(5);
  });

  it('leaves a figure alone when the sentence is about a different obligation', () => {
    const out = fakeItem();
    out.scenario = `${out.scenario} The GDPR data subject access request received last week must be answered within 30 days.`;
    expect(errors(checkRegulationFacts(out))).toEqual([]);
  });
});

describe('attack reasoning: content quality — two defensible answers', () => {
  it('rejects a distractor described as also valid with no reason it fails', () => {
    const out = fakeItem();
    why(out, 'D').why = 'Taking the public load balancer offline also works and would equally stop the attacker reaching anything.';
    expect(errors(checkDistractors(out)).join(' ')).toMatch(/option D is called "also works" with no reason it fails here/);
  });

  it('rejects a distractor analysis that never says why it is weaker', () => {
    const out = fakeItem();
    why(out, 'C').why = 'Alerting on the audit log is a standard incident response practice in most organisations.';
    expect(errors(checkDistractors(out)).join(' ')).toMatch(/option C is not shown to fail/);
  });

  it('accepts a hedged distractor that then states a decisive failure (as a warning only)', () => {
    const out = fakeItem();
    why(out, 'A').why = 'Rotating everything also works against this attacker, but it breaks the change freeze and destroys the evidence of which identity was used.';
    const fs = checkDistractors(out);
    expect(errors(fs)).toEqual([]);
    expect(fs.some((f) => f.severity === 'warning' && /option A/.test(f.message))).toBe(true);
  });

  it('rejects a best option that the generator itself calls one of several valid answers', () => {
    const out = fakeItem();
    why(out, 'B').why = `${why(out, 'B').why} Option A would also work here.`;
    expect(errors(checkDistractors(out)).join(' ')).toMatch(/the best option is described as one of several valid answers/);
  });

  it('rejects a distractor that restates the best option', () => {
    const out = fakeItem();
    const best = out.options.find((o) => o.id === out.correct_option)!.text;
    out.options[3]!.text = best.replace(/^\w+/, 'Terminate').replace('scope its policy', 'restrict its policy').replace('can no longer', 'cannot');
    expect(errors(checkDistractors(out)).join(' ')).toMatch(/option D restates the best option/);
  });
});
