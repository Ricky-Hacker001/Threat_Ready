import { describe, expect, it } from 'vitest';
import { fakeReasoningItem } from '../../src/platform/adapters/fake/reasoning.fake.js';
import { fakeReasoningQuestion } from '../../src/platform/adapters/fake/reasoning-question.fake.js';
import { architecturesFor, surfacesFor, type ArchitectureDef } from '../../src/modules/reasoning/architectures/index.js';
import { CLOUD_SECURITY } from '../../src/modules/reasoning/domains/cloud-security.js';
import type { VariationSeed } from '../../src/modules/reasoning/domain.types.js';
import type { GeneratorOutput, LibraryGeneratorOutput } from '../../src/modules/reasoning/item.types.js';
import { generationRequest, generationSchema, questionRequest, questionSchema } from '../../src/modules/reasoning/prompts/generation.prompts.js';
import { checkAnswerLeak, checkDistractors, checkRegulationFacts, checkTimeline, extractTimeline, legacyView, qualityChecks, type QualityFinding } from '../../src/modules/reasoning/quality.js';
import { pickLibrarySeed } from '../../src/modules/reasoning/seed.js';
import { libraryQualityView, normaliseLibraryOutput, validateGeneratedItem, validateLibraryItem } from '../../src/modules/reasoning/validation.js';

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

describe('attack reasoning: content quality — false positives fixed at the merge (29 Oct 2026)', () => {
  it('reads "answer a page" and "no choice a week later" as the article, not an option letter', () => {
    const out = fakeItem();
    out.attack_narrative = `${out.attack_narrative} The on-call engineer did not answer a page until morning and had no choice a week later.`;
    expect(errors(checkAnswerLeak(out))).toEqual([]);
  });

  it('reads a bracketed time-zone conversion as the same moment, and still catches a real step back', () => {
    const out = fakeItem();
    out.attack_narrative = 'At 09:00 IST (03:30 UTC) the audit log shows the first call. At 09:20 IST the bucket was listed.';
    expect(errors(checkTimeline(out))).toEqual([]);
    out.attack_narrative = 'At 09:00 IST (03:30 UTC) the audit log shows the first call. At 08:40 IST the bucket was listed.';
    expect(errors(checkTimeline(out)).join(' ')).toMatch(/runs backwards \("09:00" then "08:40"\)/);
  });

  it('leaves a contractual deadline alone in a sentence that names a regulation', () => {
    const out = fakeItem();
    out.reference_answer = `${out.reference_answer} The processor contract requires the processor to notify the controller of a breach within 24 hours under GDPR. The BAA gives the vendor 10 days to report a HIPAA breach to the covered entity.`;
    expect(errors(checkRegulationFacts(out))).toEqual([]);
  });

  it('does not read two different actions on one component as a restatement', () => {
    const out = fakeItem();
    const role = out.diagram.nodes.find((n) => n.id === 'role') ?? out.diagram.nodes[0]!;
    const bucket = out.diagram.nodes.find((n) => n.id === 'bucket') ?? out.diagram.nodes[1]!;
    out.options = out.options.map((o) =>
      o.id === out.correct_option ? { ...o, text: `Revoke the ${role.label} session and remove its write permission on the ${bucket.label}.` } : o.id === 'D' ? { ...o, text: `Enable logging for the ${role.label} session and alert on writes to the ${bucket.label}.` } : o,
    );
    expect(errors(checkDistractors(out)).filter((m) => /restates/.test(m))).toEqual([]);
  });
});

/* ---------------- The same rules on the architecture library (the default question path since 26 Oct) ---------------- */

interface LibFixture {
  arch: ArchitectureDef;
  seed: VariationSeed;
  out: LibraryGeneratorOutput;
}

/** A schema-valid library question from the fake writer (cloud security, the first beginner architecture and surface). */
function libFixture(): LibFixture {
  const arch = architecturesFor(CLOUD_SECURITY.key, 'beginner')[0]!;
  const surface = surfacesFor(arch, CLOUD_SECURITY.key)[0]!;
  const base = pickLibrarySeed(CLOUD_SECURITY, arch.level, [arch], [], () => 0);
  const technique = surface.techniques.find((t) => CLOUD_SECURITY.techniques.some((x) => x.id === t)) ?? base.technique;
  const seed: VariationSeed = { ...base, entryPoint: surface.id, objective: 'break_the_path', technique, architecture: { id: arch.id, version: arch.version, surface: surface.id } };
  const req = questionRequest({ arch, domain: CLOUD_SECURITY, seed, surface, tier: 'SMALL', avoid: [], previousFailure: [], tryNumber: 1 });
  return { arch, seed, out: questionSchema(arch, CLOUD_SECURITY).zod.parse(fakeReasoningQuestion(req)) };
}

/** The library gate as GenerationService runs it, after a mutation of the writer's output. */
function libGate(mutate?: (o: LibraryGeneratorOutput) => void) {
  const f = libFixture();
  const out = structuredClone(f.out);
  mutate?.(out);
  const n = normaliseLibraryOutput(out, f.arch, CLOUD_SECURITY, f.seed);
  return validateLibraryItem(n.out, f.arch, CLOUD_SECURITY, f.seed, n.overlay);
}
const qualityErrors = (fs: QualityFinding[]) => fs.filter((f) => f.severity === 'error');

describe('attack reasoning: content quality — on the library gate (validateLibraryItem rule 10)', () => {
  it('accepts a clean library question; its quality warnings stay warnings', () => {
    const g = libGate();
    expect(g.ok).toBe(true);
    expect(qualityErrors(g.quality)).toEqual([]);
    for (const f of g.quality) expect(g.warnings).toContain(f.message);
  });

  it('rejects a situation that recommends the best option, naming the situation (not "scenario") in the fed-back reason', () => {
    const g = libGate((o) => {
      o.situation = `${o.situation} The incident lead says the team should disable whatever the intruder holds and scope it tightly.`;
    });
    expect(g.ok).toBe(false);
    expect(qualityErrors(g.quality)).toEqual([expect.objectContaining({ rule: 'answer_leak', field: 'situation', message: expect.stringMatching(/^situation: a sentence recommends the best option/) })]);
    // Only the content rule failed it, and its message is what the rewrite is told.
    expect(g.errors).toEqual(qualityErrors(g.quality).map((f) => f.message));
  });

  it('rejects an attack-step label (drawn on the diagram) that repeats the best option', () => {
    const g = libGate((o) => {
      o.options = o.options.map((x) => (x.id === o.correct_option ? { ...x, text: x.text.replace(/ and scope it so that /, ' and rotate the signing credential so that ') } : x));
      o.attack.steps[0]!.label = 'uses the key; rotate the signing credential so';
    });
    expect(g.ok).toBe(false);
    expect(qualityErrors(g.quality)).toEqual([expect.objectContaining({ rule: 'answer_leak', field: 'attack step 1 label', message: expect.stringMatching(/repeats the wording of the best option \("rotate the signing credential so/) })]);
  });

  it('rejects a narrative whose times run backwards', () => {
    const g = libGate((o) => {
      o.attack_narrative = `${o.attack_narrative} At 21:40 the shop application log shows the bucket listing. At 21:02 the key was used again.`;
    });
    expect(g.ok).toBe(false);
    expect(g.errors).toEqual([expect.stringMatching(/^attack_narrative: the timeline runs backwards \("21:40" then "21:02"\)/)]);
  });

  it('rejects a misstated regulation figure in the private architecture analysis', () => {
    const g = libGate((o) => {
      o.architecture_analysis = `${o.architecture_analysis} Under GDPR the supervisory authority must be notified within 24 hours of the breach.`;
    });
    expect(g.ok).toBe(false);
    expect(qualityErrors(g.quality)).toEqual([expect.objectContaining({ rule: 'regulation', field: 'architecture_analysis' })]);
    expect(g.errors.join(' ')).toMatch(/architecture_analysis: "within 24 hours" misstates GDPR supervisory-authority breach notification/);
  });

  it('rejects a distractor called also valid with no reason it fails', () => {
    const g = libGate((o) => {
      o.option_analysis = o.option_analysis.map((a) => (a.id === 'A' ? { ...a, why: 'Rotating every secret also works and would equally stop the attacker reaching anything.' } : a));
    });
    expect(g.ok).toBe(false);
    expect(g.errors).toEqual([expect.stringMatching(/^option_analysis\.A: option A is called "also works" with no reason it fails here/)]);
  });

  it('leaves option letters to the gate\'s own rule: one reason, not two', () => {
    const g = libGate((o) => {
      o.attack_narrative = `${o.attack_narrative} The on-call lead leaned towards option B.`;
    });
    expect(g.errors.filter((e) => /option B|by its letter|by letter/.test(e))).toEqual(['attack_narrative: must not refer to an option by its letter']);
  });
});

describe('attack reasoning: content quality — tuned on the stored Haiku 5.5 questions (H55)', () => {
  const view = (mutate?: (o: LibraryGeneratorOutput) => void) => {
    const f = libFixture();
    const out = structuredClone(f.out);
    mutate?.(out);
    return libraryQualityView(out, f.arch, CLOUD_SECURITY, f.seed);
  };

  it('a short field repeating the objective\'s own wording is no tell (53587579, e82ad7f9)', () => {
    // The objective names two of the best option's distinctive terms that no distractor uses.
    const v = view((o) => (o.objective = 'Disable what the attacker holds and scope it'));
    expect(errors(checkAnswerLeak({ ...v, given: undefined })).join(' ')).toMatch(/^objective: names the best option's action/);
    expect(errors(checkAnswerLeak({ ...v, given: 'Disable what the attacker holds and scope it' }))).toEqual([]);
  });

  it('a question or a judgement on the past is not a recommendation (e82ad7f9)', () => {
    const v = view((o) => (o.situation = `${o.situation} The review asks which team should have disabled what the intruder holds and scoped it tightly.`));
    expect(errors(checkAnswerLeak(v))).toEqual([]);
  });

  it('a distractor analysis that says never, neither ... nor, or overstating states a failure (977a2d9e, 3849b7dd, f9b9143e)', () => {
    for (const reason of ['This never touches the deploy-prod access key, so the attacker keeps the foothold.', 'Neither the CDN events nor the WAF alerts record this call.', 'Overstating the reach of the key, this treats a read path as cluster-admin.']) {
      const v = view((o) => (o.option_analysis = o.option_analysis.map((a) => (a.id === 'D' ? { ...a, why: reason } : a))));
      expect(errors(checkDistractors(v)), reason).toEqual([]);
    }
  });

  it('a "window" is not a look-back: a time before the previous one in its sentence is caught (1561ef78)', () => {
    const v = view((o) => (o.attack_narrative = 'At 09:12 the attacker signed in from the external address. At 09:14 the deploy-prod access key listed the exports-prod bucket. The EDR agent on the build host was disabled at 09:10 during the blind window.'));
    expect(errors(checkTimeline(v)).join(' ')).toMatch(/runs backwards \("09:14" then "09:10"\)/);
  });

  it('the legacy view reads the legacy item exactly as before', () => {
    const out = fakeItem();
    expect(qualityChecks(legacyView(out))).toEqual(qualityChecks(out));
  });
});
