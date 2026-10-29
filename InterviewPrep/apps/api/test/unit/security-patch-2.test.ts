import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '@threatready/shared';
import type { Request } from 'express';
import mammoth from 'mammoth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestIdFrom } from '../../src/bootstrap.js';
import { DEV_DEFAULT_MODEL_SMALL, loadConfig } from '../../src/config/config.js';
import { untrusted } from '../../src/modules/ai/json-schema.js';
import { estimateInterviewCost, INTERVIEW_COST_MODEL, MODEL_PRICING } from '../../src/modules/ai/pricing.js';
import { normaliseForQuote, quoteIsIn } from '../../src/modules/ai/prompts/common.js';
import { turnEvaluationSchema } from '../../src/modules/ai/prompts/interview.prompts.js';
import { assertDocxWithinLimits, EXTRACT_WORKER_HEAP_MB, extractFromBuffer, extractInWorker, ExtractError, readZipDirectory, Semaphore, ZIP_LIMITS } from '../../src/modules/documents/extractors.js';
import { normaliseText, redact } from '../../src/modules/documents/redaction.js';
import { cleanQuestion, stripOpening } from '../../src/modules/interview/turn.service.js';
import { assertInternalCaller } from '../../src/modules/platform/internal.controller.js';
import { catalogue, getDomain, isAvailable } from '../../src/modules/reasoning/domains/index.js';
import { poolBucket } from '../../src/modules/reasoning/generation.service.js';
import { DEFAULT_WEIGHTS, normaliseWeights, scoreAttempt, type PointJudgement, type ScoringInput } from '../../src/modules/reasoning/scoring.js';
import { FakeLlmAdapter } from '../../src/platform/adapters/fake-llm.adapter.js';
import { CRITERIA, loadInterviewContent } from '../../src/platform/content/content.service.js';
import { installCrashHandlers } from '../../src/platform/crash.js';
import { Database } from '../../src/platform/db/database.js';
import { cursorBefore } from '../../src/platform/http/cursor.js';
import { docxFrom } from '../harness.js';
import { fuzzPure, PROTO_KEYS } from '../helpers/protoKeys.js';
import type { RubricPoint } from '../../src/modules/reasoning/item.types.js';

const base = { DATABASE_URL: 'postgres://x', APP_ORIGIN: 'http://localhost:5173', API_BASE_URL: 'http://localhost:3000', BETTER_AUTH_SECRET: 's'.repeat(40), INTERNAL_API_TOKEN: 't'.repeat(40), STORAGE_DRIVER: 'fs', LLM_DRIVER: 'fake' };
/** Everything production requires except the thing under test. */
const prod = { ...base, NODE_ENV: 'production', LLM_DRIVER: 'anthropic', ANTHROPIC_API_KEY: 'k', ALLOW_EPHEMERAL_STORAGE: 'true', ALLOW_NO_SENTRY: 'true', ONBOARD_URL: 'https://onboard.example', INTERNAL_TOKENS_ACCEPT: 'a'.repeat(64), INTERNAL_TOKEN_FROM_ONBOARD: 'a'.repeat(64) };

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as unknown as Request;

describe('A1: database pool resilience and process crash handlers', () => {
  it('a pool "error" (idle client dropped by the server) is logged, not thrown, and timeouts are configured', async () => {
    const db = new Database(loadConfig(base));
    const opts = db.pool.options as { connectionTimeoutMillis?: number; idleTimeoutMillis?: number };
    expect(opts.connectionTimeoutMillis).toBe(5_000);
    expect(opts.idleTimeoutMillis).toBe(30_000);
    expect(db.pool.listenerCount('error')).toBeGreaterThan(0);
    // Before the patch this was an unhandled 'error' event: EventEmitter throws and the process dies.
    expect(() => db.pool.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))).not.toThrow();
    await db.pool.end();
  });

  it('an uncaught exception logs, flushes Sentry and exits 1 exactly once; a hung flush cannot hold the exit', async () => {
    const target = new EventEmitter();
    const log = { fatal: vi.fn() };
    const exit = vi.fn();
    const flush = vi.fn(() => Promise.resolve());
    installCrashHandlers({ log, flush, exit, target });
    target.emit('uncaughtException', new Error('boom'));
    target.emit('unhandledRejection', 'second');
    await new Promise((r) => setTimeout(r, 5));
    expect(log.fatal).toHaveBeenCalledTimes(1);
    expect(log.fatal.mock.calls[0]![0]).toMatchObject({ kind: 'uncaughtException', err: { message: 'boom' } });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    const hung = new EventEmitter();
    const exit2 = vi.fn();
    installCrashHandlers({ log, flush: () => new Promise(() => undefined), exit: exit2, target: hung, flushTimeoutMs: 10 });
    hung.emit('unhandledRejection', new Error('never flushes'));
    await new Promise((r) => setTimeout(r, 40));
    expect(exit2).toHaveBeenCalledWith(1);

    const failing = new EventEmitter();
    const exit3 = vi.fn();
    installCrashHandlers({ log: { fatal: () => { throw new Error('logger broken'); } }, flush: () => Promise.reject(new Error('no sentry')), exit: exit3, target: failing });
    failing.emit('uncaughtException', new Error('x'));
    await new Promise((r) => setTimeout(r, 5));
    expect(exit3).toHaveBeenCalledWith(1);
  });
});

/** Patches the declared sizes of one entry in a real zip's central directory (nothing is inflated to check them). */
function forgeEntrySizes(zip: Buffer, name: string, sizes: { compressed?: number; uncompressed: number }): Buffer {
  const out = Buffer.from(zip);
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = out.length - 22; i >= 0; i--) if (out.readUInt32LE(i) === EOCD) { eocd = i; break; }
  let p = out.readUInt32LE(eocd + 16);
  const count = out.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    const nameLen = out.readUInt16LE(p + 28);
    const extraLen = out.readUInt16LE(p + 30);
    const commentLen = out.readUInt16LE(p + 32);
    if (out.subarray(p + 46, p + 46 + nameLen).toString() === name) {
      if (sizes.compressed !== undefined) out.writeUInt32LE(sizes.compressed, p + 20);
      out.writeUInt32LE(sizes.uncompressed, p + 24);
      return out;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`entry ${name} not found`);
}

describe('A4: DOCX zip bombs are refused before inflation; extractions are serialised', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the central directory of a real DOCX without inflating it', async () => {
    const docx = await docxFrom('Priya Sharma\nSOC analyst with Splunk experience.');
    const entries = readZipDirectory(docx);
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']));
    for (const e of entries) expect(e.uncompressedSize).toBeLessThan(64 * 1024);
    expect(() => assertDocxWithinLimits(docx)).not.toThrow();
  });

  it('a 1 KB entry that declares a 200 MB expansion is rejected as TOO_LARGE and mammoth is never called', async () => {
    const docx = await docxFrom('x '.repeat(600));
    const bomb = forgeEntrySizes(docx, 'word/document.xml', { compressed: 1024, uncompressed: 200 * 1024 * 1024 });
    const inflate = vi.spyOn(mammoth, 'extractRawText');
    await expect(extractFromBuffer(bomb, 'docx', 15)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    // The parent refuses it too, without starting a worker thread.
    await expect(extractInWorker(bomb, 'docx', 15)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(inflate).not.toHaveBeenCalled();
  });

  it('many modest entries whose declared total passes 50 MB are rejected; a normal DOCX still extracts', async () => {
    const docx = await docxFrom('Priya Sharma\nSOC analyst with Splunk experience.');
    let big = docx;
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
      big = forgeEntrySizes(big, name, { compressed: 1024 * 1024, uncompressed: 20 * 1024 * 1024 }); // 20:1 each, 60 MB total
    }
    await expect(extractFromBuffer(big, 'docx', 15)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const ok = await extractFromBuffer(docx, 'docx', 15);
    expect(ok.text).toContain('Splunk');
    expect(ZIP_LIMITS.maxTotalUncompressedBytes).toBe(50 * 1024 * 1024);
    expect(ZIP_LIMITS.maxEntryRatio).toBe(100);
  });

  it('truncated or non-zip bytes are unreadable, never a crash', () => {
    expect(() => readZipDirectory(Buffer.from('PK\x03\x04 not really'))).toThrow(ExtractError);
    expect(() => readZipDirectory(Buffer.alloc(0))).toThrow(ExtractError);
    const eocdOnly = Buffer.alloc(22);
    eocdOnly.writeUInt32LE(0x06054b50, 0);
    eocdOnly.writeUInt16LE(5, 10); // claims 5 entries
    eocdOnly.writeUInt32LE(500, 12); // central directory beyond the buffer
    expect(() => readZipDirectory(eocdOnly)).toThrow(ExtractError);
  });

  it('the worker heap is 96 MB and extractions run one at a time, queued in order', async () => {
    expect(EXTRACT_WORKER_HEAP_MB).toBe(96);
    const slots = new Semaphore(1);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const job = (n: number) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
      active--;
      return n;
    };
    const p1 = slots.run(job(1));
    const p2 = slots.run(job(2));
    const p3 = slots.run(job(3));
    expect(slots.inUse).toBe(1);
    expect(slots.queued).toBe(2);
    expect(await Promise.all([p1, p2, p3])).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3]);
    // A failing job releases its slot.
    await expect(slots.run(async () => { throw new Error('bad'); })).rejects.toThrow('bad');
    expect(slots.inUse).toBe(0);
    expect(await slots.run(async () => 'next')).toBe('next');
  });
});

describe('A6: SMALL model is explicit in production; budgets follow the price list', () => {
  it('fails closed without LLM_MODEL_SMALL in production, and tells you why', () => {
    const { INTERNAL_TOKENS_ACCEPT: _a, INTERNAL_TOKEN_FROM_ONBOARD: _o, ...noTokens } = prod;
    expect(() => loadConfig(prod)).toThrow(/LLM_MODEL_SMALL: required in production/);
    expect(() => loadConfig({ ...noTokens, INTERNAL_TOKEN_LEGACY_ACCEPT: 'true' })).toThrow(/LLM_MODEL_SMALL/);
    expect(loadConfig({ ...prod, LLM_MODEL_SMALL: 'claude-haiku-4-5' }).LLM_MODEL_SMALL).toBe('claude-haiku-4-5');
    // Development keeps the documented default.
    expect(DEV_DEFAULT_MODEL_SMALL).toBe('claude-haiku-4-5');
    expect(loadConfig(base).LLM_MODEL_SMALL).toBe('claude-haiku-4-5');
  });

  it('the per-interview estimate comes from the pricing table and reproduces the previous defaults for the current models', () => {
    const est = estimateInterviewCost(MODEL_PRICING['claude-haiku-4-5']!, MODEL_PRICING['claude-sonnet-5-5']!);
    const live = (INTERVIEW_COST_MODEL.live.inputTokens * 1 + INTERVIEW_COST_MODEL.live.outputTokens * 5) / 1e6;
    const fin = (INTERVIEW_COST_MODEL.finalize.inputTokens * 2 + INTERVIEW_COST_MODEL.finalize.outputTokens * 10) / 1e6;
    expect(est.liveUsd).toBeCloseTo(live, 6);
    expect(est.finalizeUsd).toBeCloseTo(fin, 6);
    expect(est).toMatchObject({ sessionCapUsd: 0.6, finalizeUsd: 0.2, userDailyCapUsd: 2, globalDailyCapUsd: 60 });
    const cfg = loadConfig(base);
    expect([cfg.AI_SESSION_CAP_USD, cfg.AI_FINAL_SCORING_RESERVE_USD, cfg.AI_USER_DAILY_CAP_USD, cfg.AI_GLOBAL_DAILY_CAP_USD]).toEqual([0.6, 0.2, 2, 60]);
    expect(cfg.interviewCostEstimate).toEqual(est);
  });

  it('a dearer SMALL model raises the derived caps; an explicit cap still wins', () => {
    const cfg = loadConfig({ ...base, LLM_MODEL_SMALL: 'claude-sonnet-5-5' });
    const est = estimateInterviewCost(MODEL_PRICING['claude-sonnet-5-5']!, MODEL_PRICING['claude-sonnet-5-5']!);
    expect(cfg.AI_SESSION_CAP_USD).toBe(est.sessionCapUsd);
    expect(cfg.AI_SESSION_CAP_USD).toBeGreaterThan(0.6);
    expect(cfg.AI_GLOBAL_DAILY_CAP_USD).toBe(est.globalDailyCapUsd);
    expect(loadConfig({ ...base, AI_SESSION_CAP_USD: '1.5', AI_GLOBAL_DAILY_CAP_USD: '10' })).toMatchObject({ AI_SESSION_CAP_USD: 1.5, AI_GLOBAL_DAILY_CAP_USD: 10, AI_USER_DAILY_CAP_USD: 2 });
  });
});

describe('A9: per-caller internal tokens', () => {
  const derivedA = 'A'.repeat(64);
  const derivedB = 'B'.repeat(64);
  const raw = base.INTERNAL_API_TOKEN;

  it('accepts every token in INTERNAL_TOKENS_ACCEPT and rejects a different derived token', () => {
    const cfg = loadConfig({ ...base, INTERNAL_TOKENS_ACCEPT: `${derivedA}, ${derivedB}` });
    expect(() => assertInternalCaller(bearer(derivedA), cfg.internalTokensAccept)).not.toThrow();
    expect(() => assertInternalCaller(bearer(derivedB), cfg.internalTokensAccept)).not.toThrow();
    expect(() => assertInternalCaller(bearer('C'.repeat(64)), cfg.internalTokensAccept)).toThrow(DomainError);
    expect(() => assertInternalCaller(bearer(derivedA.slice(0, 63)), cfg.internalTokensAccept)).toThrow(DomainError);
    expect(() => assertInternalCaller({ headers: {} } as Request, cfg.internalTokensAccept)).toThrow(DomainError);
    // Outside production the raw token is still accepted by default (local development unchanged).
    expect(() => assertInternalCaller(bearer(raw), cfg.internalTokensAccept)).not.toThrow();
    expect(() => assertInternalCaller(bearer(raw), loadConfig({ ...base, INTERNAL_TOKENS_ACCEPT: derivedA, INTERNAL_TOKEN_LEGACY_ACCEPT: 'false' }).internalTokensAccept)).toThrow(DomainError);
  });

  it('in production the raw INTERNAL_API_TOKEN is not accepted unless INTERNAL_TOKEN_LEGACY_ACCEPT=true', () => {
    const cfg = loadConfig({ ...prod, LLM_MODEL_SMALL: 'claude-haiku-4-5', INTERNAL_TOKENS_ACCEPT: derivedA });
    expect(cfg.internalTokensAccept).toEqual([derivedA]);
    expect(() => assertInternalCaller(bearer(raw), cfg.internalTokensAccept)).toThrow(DomainError);
    expect(() => assertInternalCaller(bearer(derivedA), cfg.internalTokensAccept)).not.toThrow();
    const legacy = loadConfig({ ...prod, LLM_MODEL_SMALL: 'claude-haiku-4-5', INTERNAL_TOKENS_ACCEPT: derivedA, INTERNAL_TOKEN_LEGACY_ACCEPT: 'true' });
    expect(() => assertInternalCaller(bearer(raw), legacy.internalTokensAccept)).not.toThrow();
    // No accepted token at all is a configuration error, not a silently unreachable internal API.
    const { INTERNAL_TOKENS_ACCEPT: _a, ...none } = prod;
    expect(() => loadConfig({ ...none, LLM_MODEL_SMALL: 'claude-haiku-4-5' })).toThrow(/INTERNAL_TOKENS_ACCEPT/);
    expect(() => loadConfig({ ...base, INTERNAL_TOKENS_ACCEPT: 'short' })).toThrow(/at least 32/);
  });

  it('M-SEC-1: the onboard-only routes (summary, AI usage, erasure) accept INTERNAL_TOKEN_FROM_ONBOARD, never the other accepted tokens', () => {
    const onboardToInterview = derivedA;
    const arToInterview = derivedB;
    const both = `${onboardToInterview},${arToInterview}`;
    // Production (the launcher's shape): reasoning routes take both callers, the onboard-only routes onboard's token alone.
    const cfg = loadConfig({ ...prod, LLM_MODEL_SMALL: 'claude-haiku-4-5', INTERNAL_TOKENS_ACCEPT: both, INTERNAL_TOKEN_FROM_ONBOARD: onboardToInterview });
    expect(cfg.internalTokensAccept).toEqual([onboardToInterview, arToInterview]);
    expect(cfg.internalTokensFromOnboard).toEqual([onboardToInterview]);
    expect(() => assertInternalCaller(bearer(arToInterview), cfg.internalTokensFromOnboard)).toThrow(DomainError);
    expect(() => assertInternalCaller(bearer(raw), cfg.internalTokensFromOnboard)).toThrow(DomainError);
    expect(() => assertInternalCaller(bearer(onboardToInterview), cfg.internalTokensFromOnboard)).not.toThrow();
    expect(() => assertInternalCaller(bearer(arToInterview), cfg.internalTokensAccept)).not.toThrow();
    // Legacy acceptance adds the raw token to both lists, still never Attack Reasoning's on the onboard-only routes.
    const legacy = loadConfig({ ...prod, LLM_MODEL_SMALL: 'claude-haiku-4-5', INTERNAL_TOKENS_ACCEPT: both, INTERNAL_TOKEN_FROM_ONBOARD: onboardToInterview, INTERNAL_TOKEN_LEGACY_ACCEPT: 'true' });
    expect(legacy.internalTokensFromOnboard).toEqual([onboardToInterview, raw]);
    // Production refuses to boot without it (unless legacy acceptance is on), so the scoping cannot be forgotten.
    const { INTERNAL_TOKEN_FROM_ONBOARD: _o, ...unscoped } = prod;
    expect(() => loadConfig({ ...unscoped, LLM_MODEL_SMALL: 'claude-haiku-4-5', INTERNAL_TOKENS_ACCEPT: both })).toThrow(/INTERNAL_TOKEN_FROM_ONBOARD: required in production/);
    expect(loadConfig({ ...unscoped, LLM_MODEL_SMALL: 'claude-haiku-4-5', INTERNAL_TOKENS_ACCEPT: both, INTERNAL_TOKEN_LEGACY_ACCEPT: 'true' }).internalTokensFromOnboard).toEqual([onboardToInterview, arToInterview, raw]);
    expect(() => loadConfig({ ...base, INTERNAL_TOKEN_FROM_ONBOARD: 'short' })).toThrow(/INTERNAL_TOKEN_FROM_ONBOARD/);
    // Outside production, unset keeps the previous rule (the accept list, plus the raw token by default).
    expect(loadConfig({ ...base, INTERNAL_TOKENS_ACCEPT: both }).internalTokensFromOnboard).toEqual([onboardToInterview, arToInterview, raw]);
  });

  it('presents INTERNAL_TOKEN_TO_ONBOARD to onboard when set, else the raw token', () => {
    expect(loadConfig(base).internalTokenToOnboard).toBe(raw);
    expect(loadConfig({ ...base, INTERNAL_TOKEN_TO_ONBOARD: derivedB }).internalTokenToOnboard).toBe(derivedB);
  });

  it('the bearer regex and digest compare are linear in the header length', () => {
    const cfg = loadConfig(base);
    const huge = bearer('x'.repeat(200_000));
    const t = performance.now();
    expect(() => assertInternalCaller(huge, cfg.internalTokensAccept)).toThrow(DomainError);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe('A13: gateway request id is echoed', () => {
  it('accepts a log-safe id from the gateway and generates req_... otherwise', () => {
    expect(requestIdFrom('gw_01HZX6K3Q9Y7B8C2D4E5F6G7H8')).toBe('gw_01HZX6K3Q9Y7B8C2D4E5F6G7H8');
    expect(requestIdFrom('req_abcdefghij')).toBe('req_abcdefghij');
    expect(requestIdFrom('0f4b2c9e-6f0a-4a2b-9c1d-2e3f4a5b6c7d')).toBe('0f4b2c9e-6f0a-4a2b-9c1d-2e3f4a5b6c7d');
    for (const bad of [undefined, '', 'short', 'has space here', 'x'.repeat(129), 'new\nline-injection', '"quoted"', ['a', 'b'], '-leading-dash', '<script>alert(1)</script>']) {
      expect(requestIdFrom(bad as string)).toMatch(/^req_[\w-]{8,40}$/);
    }
  });
});

/* ---------------- A11 (b): LLM injection replay set ---------------- */

interface Case {
  id: string;
  category: string;
  fakeDetects: boolean;
  text: string;
}
const corpus = (JSON.parse(readFileSync(new URL('../fixtures/injection-corpus.json', import.meta.url), 'utf8')) as { cases: Case[] }).cases;

const rubric: RubricPoint[] = [
  { id: 'r1', dimension: 'reasoning', text: 'names the identity', weight: 5, hint: 'h', explanation: 'e' },
  { id: 'a1', dimension: 'architecture', text: 'traces the path', weight: 3, hint: 'h', explanation: 'e' },
  { id: 'k1', dimension: 'risk', text: 'evidence and constraint', weight: 2, hint: 'h', explanation: 'e' },
];
const credited = (quote: string): PointJudgement[] => rubric.map((p) => ({ pointId: p.id, status: 'met', rationale: 'r', quote }));
const scoringInput = (justification: string, over: Partial<ScoringInput> = {}): ScoringInput => ({
  weights: DEFAULT_WEIGHTS,
  rubric,
  mustNotCredit: [],
  correctOption: 'B',
  selectedOption: 'B',
  selectedVerdict: 'best',
  partialCreditForPlausible: 0.25,
  justification,
  final: credited(justification.slice(0, 60)),
  evaluator: credited(justification.slice(0, 60)),
  assertedClaims: [],
  technicalErrors: [],
  challenger: { hallucinatedReferences: 0, fluentButWrong: false, missingCritical: 0 },
  integrity: { offTopic: false, instructsGrader: true, arguesForOption: null },
  degraded: false,
  ...over,
});

describe('A11b: prompt-injection replay set', () => {
  it('has at least 40 cases across the required categories', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40);
    const categories = new Set(corpus.map((c) => c.category));
    for (const c of ['grader_instruction', 'delimiter_escape', 'role_play', 'encoded', 'quote_fabrication', 'multilingual']) expect(categories.has(c), c).toBe(true);
    expect(new Set(corpus.map((c) => c.id)).size).toBe(corpus.length);
  });

  it('no case can close or forge its <untrusted_*> delimiter, for every tag the prompts use', () => {
    const tags = ['untrusted_answer', 'untrusted_justification', 'untrusted_resume', 'untrusted_job_description', 'untrusted_candidate_message', 'untrusted_candidate_digest', 'untrusted_answer_excerpt'];
    for (const c of corpus) {
      for (const tag of tags) {
        const wrapped = untrusted(tag, c.text);
        // Counted with string search, not a RegExp built from the tag (tools/check-regexp-from-input.mjs).
        const occurrences = (hay: string, marker: string) => hay.split(marker).length - 1;
        expect(occurrences(wrapped, `<${tag}>`), `${c.id}: extra opening <${tag}>`).toBe(1);
        expect(occurrences(wrapped, `</${tag}>`), `${c.id}: extra closing </${tag}>`).toBe(1);
        expect(wrapped.toLowerCase().indexOf(`</${tag}>`), `${c.id}: closing tag must be the last thing`).toBe(wrapped.length - `</${tag}>`.length);
        // Case variants of the tag are neutralised too: no `<tag` or `</tag` followed by anything but a tag-name character.
        const inner = wrapped.slice(`<${tag}>\n`.length, -`\n</${tag}>`.length).toLowerCase();
        for (const open of [`<${tag}`, `</${tag}`]) {
          for (let i = inner.indexOf(open); i >= 0; i = inner.indexOf(open, i + 1)) {
            const next = inner[i + open.length] ?? '';
            expect(/^[a-z_]$/.test(next), `${c.id}: "${open}" survives in the wrapped text`).toBe(true);
          }
        }
      }
    }
  });

  it('with the integrity flag a grader is instructed to return, every case scores 0 on the reasoning dimensions and is flagged for review', () => {
    for (const c of corpus) {
      const out = scoreAttempt(scoringInput(c.text));
      for (const d of out.dimensions) {
        if (d.key === 'correctness') continue;
        expect(d.score, `${c.id}: ${d.key} scored ${d.score}`).toBe(0);
      }
      expect(out.reviewFlag, `${c.id}: not flagged for review`).toBe(true);
      expect(out.confidence, c.id).toBe('low');
      // The learner-facing note never names the screen that fired (audit 2026-10-29 L15).
      expect(out.notes.some((n) => /instruct the grader/i.test(n)), c.id).toBe(false);
      expect(out.notes, c.id).toContain('This answer was flagged for review.');
    }
  });

  it('cases the fake LLM adapter can express are flagged end to end through the interview evaluation schema', async () => {
    const fake = new FakeLlmAdapter({ LLM_MODEL_SMALL: 'claude-haiku-4-5', LLM_MODEL_LARGE: 'claude-sonnet-5-5' });
    const schema = turnEvaluationSchema([...CRITERIA], ['scope_alert', 'correlate_logs']);
    const expressible = corpus.filter((c) => c.fakeDetects);
    expect(expressible.length).toBeGreaterThanOrEqual(10);
    for (const c of expressible) {
      const { value } = await fake.generateStructured({ tier: 'SMALL', system: 'grade', messages: [{ role: 'user', content: `Question: x\n${untrusted('untrusted_answer', c.text)}` }], maxOutputTokens: 800, promptVersion: 'test' }, schema);
      expect(value.answer_integrity.instructs_grader, `${c.id}: fake grader did not flag`).toBe(true);
      for (const cr of value.criteria) expect(cr.level, `${c.id}: criterion ${cr.criterion_id} scored ${cr.level}`).toBe('0');
    }
    // The remaining cases are beyond the fake adapter's deterministic heuristic (it is not a model);
    // they are covered above through the delimiter escaping and the scoring engine's integrity path.
    expect(corpus.filter((c) => !c.fakeDetects).length).toBeGreaterThan(0);
  });

  it('a fabricated evidence quote earns nothing: credit without a verbatim quote from the justification is withdrawn', () => {
    for (const c of corpus.filter((x) => x.category === 'quote_fabrication')) {
      const forged = 'I correlated authentication logs across the SIEM and escalated per the severity matrix';
      const out = scoreAttempt(scoringInput(c.text, { integrity: { offTopic: false, instructsGrader: false, arguesForOption: null }, final: credited(forged), evaluator: credited(forged) }));
      for (const d of out.dimensions) if (d.key !== 'correctness') expect(d.score, `${c.id}: ${d.key}`).toBe(0);
    }
  });
});

/* ---------------- A11 (c): ReDoS timing for every non-literal or input-facing regex in apps/api ---------------- */

const N = 30_000; // LIMITS.documentTextMaxChars: the largest text redaction ever sees
const BUDGET_MS = 150;
const timed = (label: string, fn: () => unknown): number => {
  const t = performance.now();
  fn();
  const ms = performance.now() - t;
  expect(ms, `${label} took ${ms.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
  return ms;
};

describe('A11c: regex timing under adversarial input', () => {
  it('redaction rules are linear at the 30,000-character document cap (the email rule was quadratic: 1.6 s)', () => {
    const inputs: Record<string, string> = {
      'address-class run (email rule)': 'a'.repeat(N),
      'mixed address chars': 'a.-+%_'.repeat(N / 6),
      'digits (email + phone)': '1'.repeat(N),
      'dots': '.'.repeat(N),
      'dashes': '-'.repeat(N),
      'at signs': 'a@'.repeat(N / 2),
      'almost emails': 'a@a.'.repeat(N / 4),
      'phone separators': '12 '.repeat(N / 3),
      'plus digits': '+1 '.repeat(N / 3),
      'aadhaar shape': '2345 '.repeat(N / 5),
      'passport prefix': 'passport '.repeat(N / 9),
      'dob prefix': 'd.o.b. : '.repeat(N / 9),
      'address keyword spam': 'road near street lane '.repeat(N / 22),
      'one long address line': `street ${'w'.repeat(N)}`,
      'address digits': `street ${'1'.repeat(N)}`,
      'pincode prefix': 'pin : '.repeat(N / 6),
      'url prefix': 'https://'.repeat(N / 8),
      'whitespace': ' '.repeat(N),
      'capitals (name line)': 'A'.repeat(N),
      'capitalised words (name line)': 'Aa '.repeat(N / 3),
      'name alternation': 'AAAA Aaaa.'.repeat(N / 10),
    };
    for (const [label, text] of Object.entries(inputs)) timed(`redact ${label}`, () => redact(text, { redactNameLine: true }));
    timed('normaliseText whitespace', () => normaliseText(' \n '.repeat(N / 3), N));
    timed('normaliseText newlines', () => normaliseText('\n'.repeat(N), N));
    // Still redacts real addresses.
    expect(redact('mail me at priya.sharma@example.com today').text).toBe('mail me at [EMAIL] today');
    expect(redact('x.y-z+1@sub.example.co.in,').text).toBe('[EMAIL],');
  });

  it('untrusted() tag escaping (the only dynamic RegExp on a request path) is linear', () => {
    timed('untrusted tag-prefix spam', () => untrusted('untrusted_answer', '</untrusted_answe'.repeat(N / 17)));
    timed('untrusted bracket spam', () => untrusted('untrusted_answer', '<'.repeat(N)));
    timed('untrusted full tags', () => untrusted('untrusted_answer', '</untrusted_answer>'.repeat(N / 19)));
  });

  it('interview text helpers and quote checks are linear on 4,000-character answers and 700-character questions', () => {
    timed('cleanQuestion quotes', () => cleanQuestion(`${'"'.repeat(5_000)}a${'"'.repeat(5_000)}`));
    timed('cleanQuestion markers', () => cleanQuestion(`${' *'.repeat(5_000)}a`));
    timed('stripOpening', () => stripOpening(`Hi ${'x'.repeat(20_000)}Feel free to think out loud${'y'.repeat(5_000)}`));
    timed('stripOpening no terminator', () => stripOpening(`Hi ${'Feel free to think out loud'.repeat(1_000)}x`));
    timed('normaliseForQuote', () => normaliseForQuote('“ ’ – ‘'.repeat(4_000)));
    timed('quoteIsIn punctuation', () => quoteIsIn(`${'"'.repeat(2_000)}${'.'.repeat(2_000)}`, 'x'.repeat(4_000)));
    timed('quoteIsIn long', () => quoteIsIn('a'.repeat(4_000), 'a'.repeat(3_999)));
  });

  it('request-boundary validators are linear', () => {
    timed('cursor', () => expect(() => cursorBefore('A'.repeat(64))).toThrow(DomainError));
    timed('request id', () => requestIdFrom('a'.repeat(128)));
    timed('request id junk', () => requestIdFrom(`${'a'.repeat(127)} `));
  });
});

/* ---------------- A11 (a): prototype keys through pure functions ---------------- */

describe('A11a: prototype keys through pure lookups', () => {
  const content = loadInterviewContent(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../content/interview'));

  it('content, domain, pool and cursor lookups treat __proto__ and friends as ordinary unknown ids', () => {
    fuzzPure((k) => content.skills.get(k), (o) => expect(o.result).toBeUndefined());
    fuzzPure((k) => content.rubrics.find((r) => r.questionTypes.includes(k)), (o) => expect(o.result).toBeUndefined());
    // Plain-object records (templates, levels) do resolve prototype names; they are only ever indexed by
    // server-generated plan item kinds, never by client input. The guard here is that no key is an own property.
    fuzzPure((k) => Object.hasOwn(content.templates, k) || Object.hasOwn(content.levels, k), (o) => expect(o.result).toBe(false));
    fuzzPure((k) => getDomain(k), (o) => expect(o.result ?? null).toBeNull());
    fuzzPure((k) => isAvailable(k), (o) => expect(o.result).toBe(false));
    fuzzPure((k) => catalogue().some((c) => c.key === k), (o) => expect(o.result).toBe(false));
    fuzzPure((k) => poolBucket(k), (o) => expect(o.result).toBe('intermediate'));
    fuzzPure((k) => normaliseWeights({ [k]: 50 } as never), (o) => expect(Object.keys(o.result!)).toEqual(['correctness', 'reasoning', 'architecture', 'risk']));
    fuzzPure((k) => cursorBefore(k), (o) => expect((o.error as DomainError).code).toBe('VALIDATION_FAILED'));
    fuzzPure((k) => redact(`${k}\n${k}@example.com`, { redactNameLine: true }).counts, (o) => expect(o.result!.email).toBe(1));
    // A request id is an opaque string (logged, echoed), never an object key: a prototype name is just a short id.
    fuzzPure((k) => requestIdFrom(k), (o) => expect(o.result).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/));
    fuzzPure((k) => loadConfig({ ...base, LLM_MODEL_SMALL: k }), (o) => expect(String((o.error as Error).message)).toMatch(/not in the verified model registry/));
    expect(PROTO_KEYS).toHaveLength(6);
  });
});
