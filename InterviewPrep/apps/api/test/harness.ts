import type { NestExpressApplication } from '@nestjs/platform-express';
import { runMigrations } from '@threatready/db';
import type { TurnStreamEvent } from '@threatready/contracts';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import request from 'supertest';
import { expect } from 'vitest';
import TestAgent from 'supertest/lib/agent.js';
import { createApiApp } from '../src/bootstrap.js';
import { loadConfig, type AppConfig } from '../src/config/config.js';
import { FakeLlmAdapter } from '../src/platform/adapters/fake-llm.adapter.js';
import { LLM_PORT } from '../src/platform/ports/llm.port.js';
import { JOBS } from '../src/platform/ports/queue.port.js';
import { DocumentsService } from '../src/modules/documents/documents.service.js';
import { AnalysisService } from '../src/modules/interview/analysis.service.js';
import { JobsService } from '../src/modules/jobs/jobs.service.js';
import { EvaluationService } from '../src/modules/reasoning/evaluation.service.js';
import { GenerationService } from '../src/modules/reasoning/generation.service.js';
import { ReportsService } from '../src/modules/reports/reports.service.js';
import { SkillsService } from '../src/modules/skills/skills.service.js';

export const ORIGIN = 'http://localhost:5173';

/** Recreates the test database from migrations. */
export async function resetDatabase(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.slice(1);
  // Never let a test run reset a real database (for example when a developer's .env is loaded).
  if (!/_test$/.test(dbName)) throw new Error(`Refusing to reset database "${dbName}": test databases must end in _test`);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/threatready' }).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  await runMigrations(process.env.DATABASE_URL!);
}

export interface TestApp {
  app: NestExpressApplication;
  cfg: AppConfig;
  llm: FakeLlmAdapter;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Stand-in for onboard.threatready.io's GET /api/internal/identity/session: maps the
 * `tr.session_token` cookie to a user, and checks the internal token like the real one.
 */
export interface StubIdentity {
  user: { id: string; name: string; email: string | null; emailVerified: boolean; username: string | null; image: string | null; isTrial: boolean; isAdmin: boolean };
}
export const identities = new Map<string, StubIdentity>();
let identityUrl: Promise<string> | null = null;
export const identityCalls: { cookie?: string; authorization?: string }[] = [];
/** Latency of the identity stub's answers, and the most lookups it saw at once, for in-flight cap tests. */
export const identityStub = { delayMs: 0, active: 0, maxActive: 0 };

function startIdentityStub(): Promise<string> {
  identityUrl ??= new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      identityCalls.push({ cookie: req.headers.cookie, authorization: req.headers.authorization });
      identityStub.active += 1;
      identityStub.maxActive = Math.max(identityStub.maxActive, identityStub.active);
      res.on('close', () => (identityStub.active -= 1));
      if (identityStub.delayMs) await new Promise((r) => setTimeout(r, identityStub.delayMs));
      if (req.url !== '/api/internal/identity/session') return void res.writeHead(404).end();
      if (req.headers.authorization !== `Bearer ${process.env.INTERNAL_API_TOKEN}`) return void res.writeHead(401).end();
      const token = /(?:^|;\s*)tr\.session_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const found = token ? identities.get(decodeURIComponent(token)) : undefined;
      if (!found) return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"code":"UNAUTHENTICATED"}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...found, session: { id: `sess_${token}`, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }));
    });
    server.unref();
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  return identityUrl;
}

export async function startApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const cfg = loadConfig({ ...process.env, IDENTITY_URL: await startIdentityStub(), ...overrides });
  const app = await createApiApp(cfg);
  const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 2 });
  return {
    app,
    cfg,
    llm: app.get<FakeLlmAdapter>(LLM_PORT),
    pool,
    async close() {
      await pool.end();
      await app.close();
    },
  };
}

export type Agent = InstanceType<typeof TestAgent>;

let userSeq = 0;

/**
 * A cookie value shaped like onboard's (`<token>.<44-char HMAC signature>`, URL-encoded), which the
 * identity adapter requires before it asks onboard at all. `token` defaults to a random one.
 */
export function sessionCookieValue(token = randomBytes(24).toString('base64url')): string {
  return encodeURIComponent(`${token}.${randomBytes(32).toString('base64')}`);
}

/**
 * A fresh signed-in user: registered with the identity stub (as if they had signed in on onboard)
 * and an agent carrying the shared session cookie.
 */
export async function signUp(t: TestApp, name = 'Priya Sharma', extra: Partial<StubIdentity['user']> = {}): Promise<Agent> {
  userSeq += 1;
  const token = sessionCookieValue();
  identities.set(decodeURIComponent(token), {
    user: {
      id: randomUUID().replace(/-/g, '').slice(0, 32),
      name,
      email: `candidate${userSeq}.${Date.now()}@example.test`,
      emailVerified: true,
      username: null,
      image: null,
      isTrial: false,
      isAdmin: false,
      ...extra,
    },
  });
  return request.agent(t.app.getHttpServer()).set('Cookie', `tr.session_token=${token}`) as Agent;
}

/** Ends a stub session, as signing out on onboard would. */
export function signOutEverywhere(agent: Agent): void {
  const header = (agent as unknown as { _defaults?: { fn: string; args: string[] }[] })._defaults?.find((d) => d.fn === 'set' && d.args[0] === 'Cookie');
  const token = header && /tr\.session_token=([^;]+)/.exec(header.args[1]!)?.[1];
  if (token) identities.delete(decodeURIComponent(token));
}

/**
 * Runs queued pg-boss jobs in-process, as the worker role would, until the queue is empty.
 * Returns the names of the jobs run. Failing jobs throw, so tests see the failure.
 */
export async function drainJobs(t: TestApp, opts: { only?: string[]; maxRounds?: number } = {}): Promise<string[]> {
  const ran: string[] = [];
  const handlers: Record<string, (d: Record<string, string>, retry: number) => Promise<void>> = {
    [JOBS.documentExtract]: (d) => t.app.get(DocumentsService).runExtraction(d.documentId!, d.kind as 'resume' | 'jd'),
    [JOBS.interviewAnalyse]: (d, retry) => t.app.get(AnalysisService).run(d.sessionId!, retry >= 1),
    [JOBS.interviewFinalScoring]: (d) => t.app.get(ReportsService).runFinalScoring(d.sessionId!),
    [JOBS.reportPdf]: (d) => t.app.get(ReportsService).runPdf(d.evaluationId!),
    [JOBS.emailSend]: (d) => t.app.get(ReportsService).runEmail(d.evaluationId!),
    [JOBS.skillsRecalculate]: (d) => t.app.get(SkillsService).recalculate(d.userId!),
    [JOBS.reasoningGenerate]: (d) => t.app.get(GenerationService).runGeneration(d.attemptId!),
    // As the worker does: a manual retry's job carries escalate: true (the second review).
    [JOBS.reasoningEvaluate]: (d) => t.app.get(EvaluationService).runEvaluation(d.attemptId!, { escalate: (d as { escalate?: unknown }).escalate === true }),
    [JOBS.reasoningPoolRefill]: (d) => t.app.get(GenerationService).refillPool(d ?? {}),
    [JOBS.deadLetter]: (d) => t.app.get(JobsService).onDeadLetter(d),
  };
  for (let round = 0; round < (opts.maxRounds ?? 10); round++) {
    const { rows } = await t.pool.query<{ id: string; name: string; data: Record<string, string>; retry_count: number }>(
      `SELECT id, name, data, retry_count FROM pgboss.job WHERE state IN ('created','retry') AND name <> $1 ORDER BY created_on`,
      [JOBS.interviewSweep],
    );
    const todo = rows.filter((r) => !opts.only || opts.only.includes(r.name));
    if (!todo.length) break;
    for (const job of todo) {
      const handler = handlers[job.name];
      if (!handler) continue;
      process.env.APP_ROLE = 'worker';
      try {
        await handler(job.data, job.retry_count);
        await t.pool.query(`UPDATE pgboss.job SET state = 'completed', completed_on = now() WHERE id = $1 AND name = $2`, [job.id, job.name]);
      } finally {
        process.env.APP_ROLE = 'api';
      }
      ran.push(job.name);
    }
  }
  return ran;
}

/** Starts the app's HTTP server on a loopback port (for raw-socket tests); returns the port. */
export async function listen(t: TestApp): Promise<number> {
  const server = t.app.getHttpServer() as http.Server;
  server.setMaxListeners(0); // supertest adds listeners per request to an already-listening server
  if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** Parses an SSE response body into events. */
export function parseSse(text: string): TurnStreamEvent[] {
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as TurnStreamEvent);
}

export async function sse(agent: Agent, path: string, body?: object) {
  const res = await agent.post(path).set('Origin', ORIGIN).send(body ?? {}).buffer(true).parse((r, cb) => {
    let data = '';
    r.setEncoding('utf8');
    r.on('data', (c: string) => (data += c));
    r.on('end', () => cb(null, data));
  });
  return { status: res.status, events: parseSse(String(res.body)), raw: res };
}

export const RESUME_TEXT = `Priya Sharma
Security Analyst | priya.sharma@example.com | +91 98765 43210 | linkedin.com/in/priyasharma
Address: 12 MG Road, Bengaluru 560001

EXPERIENCE
Security Analyst, Aero Fintech (2022 - present)
- Triaged 60+ SIEM alerts per shift in Splunk and escalated confirmed incidents to the IR team.
- Wrote SPL correlation searches for password spraying and impossible travel detection.
- Deployed microservices using Kubernetes on EKS for an internal phishing-report tool.

Security Intern, Beta Bank (2021)
- Supported incident response for a ransomware precursor investigation using CrowdStrike EDR.

SKILLS
Splunk, Sentinel, KQL, Python, AWS IAM, CloudTrail, Wireshark, Kubernetes

CERTIFICATIONS
CompTIA Security+ certification
`;

export const JD_TEXT = `SOC Analyst (L2)
We are hiring a SOC Analyst to join our 24x7 security operations centre.

Requirements (must have):
- Alert triage and escalation in a SIEM such as Splunk or Sentinel
- Incident response experience following NIST 800-61
- Investigating brute force and password spraying attacks
- Writing detection rules and correlation searches

Preferred:
- Endpoint investigation with EDR tools such as CrowdStrike or Defender
- Threat intelligence enrichment of IOCs
- Clear stakeholder communication during incidents
`;

/** Builds a minimal valid DOCX in memory. */
export async function docxFrom(text: string): Promise<Buffer> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras = text.split('\n').map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function uploadDocument(t: TestApp, agent: Agent, kind: 'resume' | 'jd', file: Buffer, contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
  const created = await agent.post('/v1/documents').set('Origin', ORIGIN).send({ kind, contentType, sizeBytes: file.length });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const { document, upload } = created.body;
  const target = new URL(upload.url);
  const form = agent.post(`${target.pathname}${target.search}`); // the signed policy rides in the query string
  for (const [k, v] of Object.entries(upload.fields as Record<string, string>)) form.field(k, v);
  const up = await form.attach('file', file, { filename: 'upload.bin', contentType });
  expect(up.status).toBe(204);
  const done = await agent.post(`/v1/documents/${document.id}/complete`).set('Origin', ORIGIN);
  expect(done.status).toBe(202);
  await drainJobs(t, { only: ['document.extract'] });
  const got = await agent.get(`/v1/documents/${document.id}`);
  return got.body;
}

