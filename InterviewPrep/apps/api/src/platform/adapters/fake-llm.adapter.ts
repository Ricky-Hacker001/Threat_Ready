import { PortError, type PortErrorKind } from '@threatready/shared';
import type { AppConfig } from '../../config/config.js';
import { promptChars, type LlmChunk, type LlmObject, type LlmPort, type LlmRequest, type LlmText, type LlmTier, type LlmUsage, type StructuredSchema } from '../ports/llm.port.js';
import { fakeReasoning } from './fake/reasoning.fake.js';

/**
 * Deterministic LlmPort for automated tests and offline demos (LLM_DRIVER=fake; refused in
 * production). Outputs are derived from the request so they are schema-valid and their evidence
 * quotes are real substrings, which exercises the quote checks end to end. Tests can inject
 * failures and overrides per schema name.
 */
export class FakeLlmAdapter implements LlmPort {
  readonly calls: { kind: 'text' | 'structured' | 'stream'; tier: LlmTier; name?: string; promptVersion: string; chars: number; prefixChars: number }[] = [];
  /**
   * Prompt-cache simulation, as the provider behaves (review COST-2): an entry per model, output format
   * (the structured-output schema name: a different format invalidates the cache) and systemPrefix; the
   * first call reports the prefix as cache_creation tokens, later calls as cache_read tokens; input
   * tokens exclude them. Nothing is cached for a request with `cache: false` or a prefix under the
   * model's minimum (4,096 tokens on Haiku 4.5, 512 on the current models; 4 characters a token here).
   * reset() empties it.
   */
  private readonly cache = new Set<string>();
  /** schema name (or 'question' for streams) -> failure kinds to throw, consumed in order. */
  failures = new Map<string, PortErrorKind[]>();
  overrides = new Map<string, (req: LlmRequest) => unknown>();
  /** Artificial latency, for timeout tests. */
  delayMs = 0;

  constructor(private readonly cfg: Pick<AppConfig, 'LLM_MODEL_SMALL' | 'LLM_MODEL_LARGE'>) {}

  modelFor(tier: LlmTier): string {
    return tier === 'SMALL' ? this.cfg.LLM_MODEL_SMALL : this.cfg.LLM_MODEL_LARGE;
  }

  failNext(name: string, ...kinds: PortErrorKind[]): void {
    this.failures.set(name, [...(this.failures.get(name) ?? []), ...kinds]);
  }

  reset(): void {
    this.calls.length = 0;
    this.failures.clear();
    this.overrides.clear();
    this.delayMs = 0;
    this.cache.clear();
  }

  async generate(req: LlmRequest): Promise<LlmText> {
    this.record('text', req);
    await this.maybeFail('text', req);
    const text = 'OK';
    return { text, usage: this.usage(req, text, '') };
  }

  async generateStructured<T>(req: LlmRequest, schema: StructuredSchema<T>): Promise<LlmObject<T>> {
    this.record('structured', req, schema.name);
    await this.maybeFail(schema.name, req);
    const override = this.overrides.get(schema.name);
    const raw = override ? override(req) : this.produce(schema.name, req, schema.jsonSchema);
    const parsed = schema.zod.safeParse(schema.prepare ? schema.prepare(raw) : raw);
    if (!parsed.success) throw new PortError('invalid_output', `${schema.name}: fake output failed validation`, { retryable: true });
    return { value: parsed.data, usage: this.usage(req, JSON.stringify(raw), schema.name) };
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmChunk> {
    this.record('stream', req, 'question');
    await this.maybeFail('question', req);
    const override = this.overrides.get('question');
    const text = override ? String(override(req)) : fakeQuestion(lastUser(req));
    for (const word of text.split(/(?<= )/)) yield { type: 'text', text: word };
    yield { type: 'done', usage: this.usage(req, text, '') };
  }

  private record(kind: 'text' | 'structured' | 'stream', req: LlmRequest, name?: string) {
    this.calls.push({ kind, tier: req.tier, name, promptVersion: req.promptVersion, chars: promptChars(req), prefixChars: req.systemPrefix?.length ?? 0 });
  }

  private async maybeFail(name: string, req: LlmRequest) {
    if (this.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs);
        if (req.timeoutMs && req.timeoutMs < this.delayMs) {
          setTimeout(() => {
            clearTimeout(t);
            reject(new PortError('timeout', 'fake timeout'));
          }, req.timeoutMs);
        }
      });
    }
    const queue = this.failures.get(name);
    const kind = queue?.shift();
    if (kind) throw new PortError(kind, `fake ${kind}`, { retryable: kind !== 'invalid_output' && kind !== 'refusal' ? undefined : kind === 'invalid_output' });
  }

  private usage(req: LlmRequest, out: string, format: string): LlmUsage {
    const model = this.modelFor(req.tier);
    const prefix = req.systemPrefix ?? '';
    const prefixTokens = Math.ceil(prefix.length / 4);
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const minimum = /haiku-4-5/.test(model) ? 4096 : 512;
    if (prefix && req.cache !== false && prefixTokens >= minimum) {
      const key = `${model}\u0000${format}\u0000${prefix}`;
      if (this.cache.has(key)) cacheReadTokens = prefixTokens;
      else {
        this.cache.add(key);
        cacheWriteTokens = prefixTokens;
      }
    }
    const rest = promptChars(req) - prefix.length;
    return { model, inputTokens: Math.ceil(rest / 4), outputTokens: Math.ceil(out.length / 4), cacheReadTokens, cacheWriteTokens };
  }

  private produce(name: string, req: LlmRequest, schema: Record<string, unknown>): unknown {
    const user = lastUser(req);
    switch (name) {
      case 'candidate_profile':
        return fakeCandidate(req.system, tagged(user, 'untrusted_resume') ?? user);
      case 'job_profile':
        return fakeJob(req.system, tagged(user, 'untrusted_job_description') ?? user);
      case 'gap_analysis':
        return fakeGaps(user);
      case 'answer_evaluation':
        return fakeTurnEval(tagged(user, 'untrusted_answer') ?? '', schema);
      case 'turn_assessment':
        return { turns: fakeAssessments(user) };
      case 'report_summary':
        return fakeSummary(schema);
      default:
        return fakeReasoning(name, req) ?? fromSchema(schema);
    }
  }
}

const lastUser = (req: LlmRequest) => req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
const tagged = (s: string, tag: string) => s.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1];

/** Parses "id: Label (also: a, b)" catalogue lines from the system prompt. */
function catalogue(system: string): { id: string; terms: string[] }[] {
  return [...system.matchAll(/^([a-z]+\.[a-z_]+): ([^(\n]+)\(also: ([^)]*)\)/gm)].map((m) => ({
    id: m[1]!,
    terms: [m[2]!.trim(), ...m[3]!.split(',').map((t) => t.trim())].filter((t) => t.length > 2).map((t) => t.toLowerCase()),
  }));
}

const wordRe = (term: string) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
const hasWord = (text: string, term: string) => wordRe(term).test(text);

function sentenceWith(text: string, term: string): string | null {
  const lower = text.toLowerCase();
  const m = wordRe(term).exec(lower);
  if (!m) return null;
  const i = m.index + m[1]!.length;
  const start = Math.max(0, lower.lastIndexOf('\n', i) + 1);
  const end = lower.indexOf('\n', i);
  return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 200);
}

function fakeCandidate(system: string, text: string) {
  const skills = catalogue(system)
    .map((c) => {
      const term = c.terms.find((t) => t.length > 3 && hasWord(text, t));
      const quote = term ? sentenceWith(text, term) : null;
      return quote ? { skill_id: c.id, claimed_level: 'working', evidence: [{ quote }] } : null;
    })
    .filter(Boolean)
    .slice(0, 12);
  // Skip header lines that carry redaction markers or separators; they are not role titles.
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/\[[A-Z_]+\]|\|/.test(l));
  const fullTime = lines.some((l) => /engineer|analyst|developer|consultant/i.test(l) && !/intern/i.test(l));
  return {
    schema_version: '1',
    career_stage: fullTime ? 'early_career' : 'student',
    headline: lines[1] ?? null,
    years_experience: Number(text.match(/(\d{1,2})\+?\s+years/i)?.[1] ?? 2),
    current_role: lines.find((l) => /engineer|analyst|developer|intern|consultant/i.test(l))?.slice(0, 120) ?? null,
    roles: lines
      .filter((l) => /engineer|analyst|developer|intern/i.test(l))
      .slice(0, 3)
      .map((l) => ({ title: l.slice(0, 100), organisation: 'Employer', kind: /intern/i.test(l) ? 'internship' : 'job', start: null, end: null, highlights: [l.slice(0, 200)] })),
    education: [],
    projects: [],
    certifications: lines.filter((l) => /certified|certification|cissp|oscp|security\+|ceh/i.test(l)).slice(0, 5),
    technologies: [...new Set(skills.map((s) => s!.skill_id.split('.')[1]!.replace(/_/g, ' ')))],
    skills,
    accomplishments: [],
    unmapped_skills: [],
    parse_warnings: [],
  };
}

function fakeJob(system: string, text: string) {
  const roles = [...system.matchAll(/^([a-z_]+): ([A-Za-z /]+)$/gm)].map((m) => ({ id: m[1]!, label: m[2]!.toLowerCase() }));
  const lower = text.toLowerCase();
  const role = roles.find((r) => r.label.split(/[ /]/).every((w) => w.length < 3 || lower.includes(w))) ?? roles.find((r) => r.id === 'general_technical') ?? roles[0];
  const required = catalogue(system)
    .filter((c) => c.terms.some((t) => t.length > 3 && hasWord(lower, t)))
    .slice(0, 10)
    .map((c, i) => ({ skill_id: c.id, level: 'working', weight: i < 4 ? 'must' : 'should' }));
  const senior = /senior|lead|principal|staff/i.test(text) ? 'senior' : /junior|entry|graduate|fresher|intern/i.test(text) ? 'junior' : 'mid';
  return {
    schema_version: '1',
    title: text.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 120) ?? 'Technical role',
    role_id: role?.id ?? 'general_technical',
    seniority: senior,
    expected_experience: null,
    required_skills: required,
    responsibilities: [],
    technical_requirements: [],
    tools: [],
    behavioral_competencies: /stakeholder|communicat/i.test(text) ? ['Stakeholder communication'] : [],
    unmapped_requirements: [],
  };
}

function fakeGaps(user: string) {
  const candidate = JSON.parse(tagged(user, 'untrusted_candidate_profile') ?? '{}') as { skills?: { skill_id: string; evidence: { quote: string }[] }[] };
  const job = JSON.parse(tagged(user, 'untrusted_job_profile') ?? '{}') as { required_skills?: { skill_id: string; level: string }[] };
  const has = new Set((candidate.skills ?? []).map((s) => s.skill_id));
  return {
    claims_to_verify: (candidate.skills ?? [])
      .filter((s) => s.evidence.length)
      .slice(0, 4)
      .map((s) => ({ skill_id: s.skill_id, claim: `experience with ${s.skill_id.split('.')[1]!.replace(/_/g, ' ')}`, evidence_quote: s.evidence[0]!.quote })),
    gaps: (job.required_skills ?? [])
      .filter((r) => !has.has(r.skill_id))
      .slice(0, 6)
      .map((r) => ({ skill_id: r.skill_id, required_level: r.level, claimed_level: 'none', priority: 'high', reason: 'Required by the JD; not evidenced in the resume.' })),
    strengths: [...has].filter((id) => (job.required_skills ?? []).some((r) => r.skill_id === id)).slice(0, 4),
  };
}

/** Length- and specificity-based level: a stand-in for judgement, good enough to drive the flow. */
function heuristicLevel(answer: string): number {
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  if (words < 6) return 0;
  if (words < 20) return 1;
  if (words < 45) return 2;
  if (words < 90) return 3;
  return 4;
}

function firstQuote(answer: string): string | null {
  const s = answer.trim().split(/(?<=[.!?])\s+/)[0] ?? '';
  return s.length >= 8 ? s.slice(0, 200) : answer.trim().length >= 8 ? answer.trim().slice(0, 200) : null;
}

function enumValues(schema: Record<string, unknown>, path: string[]): string[] {
  let node: unknown = schema;
  for (const p of path) {
    const n = node as Record<string, unknown>;
    node = p === '[]' ? (n.items as unknown) : (n.properties as Record<string, unknown>)?.[p];
    if (node && typeof node === 'object' && 'anyOf' in (node as object)) node = ((node as { anyOf: unknown[] }).anyOf).find((x) => (x as { type?: string }).type !== 'null');
  }
  return ((node as { enum?: string[] })?.enum ?? []) as string[];
}

function fakeTurnEval(answer: string, schema: Record<string, unknown>) {
  const level = heuristicLevel(answer);
  const quote = level > 0 ? firstQuote(answer) : null;
  const criteria = enumValues(schema, ['criteria', '[]', 'criterion_id']);
  const concepts = enumValues(schema, ['concepts_missing', '[]']);
  const injected = /ignore (all|previous)|award (me|full)|give (me )?(full|maximum) marks/i.test(answer);
  return {
    criteria: criteria.map((c) => ({ criterion_id: c, level: String(injected ? 0 : level), evidence_quote: quote })),
    concepts_demonstrated: level >= 3 && concepts[0] && quote ? [{ concept_id: concepts[0], evidence_quote: quote }] : [],
    concepts_missing: concepts.slice(level >= 3 ? 1 : 0, 3),
    misconceptions: [],
    follow_up_suggested: level === 1 || level === 2 || level === 4,
    follow_up_focus: concepts[1]?.replace(/_/g, ' ') ?? null,
    answer_integrity: { off_topic: level === 0, instructs_grader: injected },
    practice_tip: level < 3 ? 'Add a concrete example from your own work and explain the trade-offs.' : null,
  };
}

function fakeAssessments(user: string) {
  const blocks = user.split('### turn_id: ').slice(1);
  return blocks.map((b) => {
      const id = b.split('\n')[0]!.trim();
      const crit = b.match(/Applicable criteria: ([^\n]+)/)?.[1]?.split(', ') ?? [];
      const answer = tagged(b, 'untrusted_answer') ?? '';
      const level = heuristicLevel(answer);
      const quote = level > 0 ? firstQuote(answer) : null;
      const injected = /ignore (all|previous)|award (me|full)|give (me )?(full|maximum) marks/i.test(answer);
      return {
        turn_id: id,
        criteria: crit.map((c) => ({ criterion_id: c, level: String(injected ? 0 : level), evidence_quote: quote })),
        correct_concepts: level >= 2 ? ['Relevant core idea identified'] : [],
        missing_concepts: level < 4 ? ['Concrete trade-offs and failure modes'] : [],
        inaccuracies: [],
        improvements: ['Structure the answer: context, approach, decision, result.', 'Name the specific tools and controls you used.'],
        strong_answer_example: 'A strong answer states the goal, walks through the approach step by step with the specific controls or components involved, explains the trade-offs considered, and closes with how the result was verified.',
        explanation: level >= 3 ? 'The answer covered the main points with specific detail.' : 'The answer was brief and missed specific detail the question asked for.',
        instructs_grader: injected,
      };
  });
}

function fakeSummary(schema: Record<string, unknown>) {
  const skillIds = enumValues(schema, ['next_focus_skill_ids', '[]']);
  return {
    summary: 'This assessment was produced by the offline fake model for development; it is not a real evaluation.',
    high_priority: [{ topic: 'Depth on core role skills', why: 'Several answers lacked specific detail.' }],
    secondary: [{ topic: 'Answer structure', why: 'A consistent structure makes answers easier to follow.' }],
    practice_questions: ['Walk through how you would investigate a suspicious login alert end to end.'],
    next_focus_skill_ids: skillIds.slice(0, 2),
  };
}

function fakeQuestion(user: string): string {
  const clarifying = user.match(/Your question to the candidate: ([^\n]+)/)?.[1];
  if (clarifying) return /answer|hint|looking for/i.test(tagged(user, 'untrusted_candidate_message') ?? '') ? "I can't give that away, but I'd like to hear how you would think it through." : `Sure. In other words: ${clarifying}`;
  const skill = user.match(/Topic: ([^(\n]+) \(/)?.[1]?.trim();
  const ack = /Conversation so far:\n\(none yet\)/.test(user) ? '' : 'Thanks, that helps. ';
  if (/Ask ONE follow-up/.test(user)) {
    const focus = user.match(/Focus: ([^.\n]+)/)?.[1] ?? 'that';
    return `Okay. You touched on ${focus} there. Could you walk me through a concrete example from your own work?`;
  }
  if (/walk you through their background/.test(user)) return 'To start, could you walk me through your background and what draws you to this role?';
  if (/wrapping up|have not covered/.test(user)) return `${ack}We're nearly out of time. Before we wrap up, is there anything about your experience we haven't covered that you'd like me to know?`;
  const claim = user.match(/Experience to ask about: ([^\n]+)/)?.[1];
  if (claim) return `${ack}I'd like to dig into your experience with ${claim}. Can you walk me through what you did there and the decisions you made?`;
  const seed = user.match(/Scenario idea[^:]*: ([^\n]+)/)?.[1];
  if (seed) return `${ack}Let me give you a scenario. ${seed} What would you do first?`;
  return `${ack}How have you applied ${skill ?? 'this skill'} in practice, and what mistakes would you watch out for?`;
}

/** Minimal valid instance for any closed JSON schema. */
function fromSchema(node: unknown): unknown {
  const n = node as Record<string, unknown>;
  if (n.anyOf) return fromSchema((n.anyOf as unknown[])[0]);
  if (n.enum) return (n.enum as unknown[])[0];
  if (n.const !== undefined) return n.const;
  switch (n.type) {
    case 'object':
      return Object.fromEntries(Object.entries((n.properties as Record<string, unknown>) ?? {}).map(([k, v]) => [k, fromSchema(v)]));
    case 'array':
      return [];
    case 'string':
      return 'sample';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return false;
    default:
      return null;
  }
}
