import { AI_CONSENT_VERSION } from '@threatready/contracts';
import { ROUTES } from '@threatready/contracts';
import { scrub } from '@threatready/shared';
import PDFDocument from 'pdfkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3StorageAdapter } from '../src/platform/adapters/s3-storage.adapter.js';
import { drainJobs, JD_TEXT, ORIGIN, resetDatabase, RESUME_TEXT, signUp, startApp, type Agent, type TestApp } from './harness.js';
import { docxFrom, uploadDocument } from './harness.js';

const CONSENT = { accepted: true, version: AI_CONSENT_VERSION } as const;

function pdf(text: string, opts: PDFKit.PDFDocumentOptions = {}): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument(opts);
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.text(text);
    doc.end();
  });
}

describe('authorization, ownership and RLS', () => {
  let t: TestApp;
  let owner: Agent;
  let other: Agent;
  let sessionId: string;
  let resumeId: string;

  beforeAll(async () => {
    await resetDatabase();
    t = await startApp();
    owner = await signUp(t, 'Owner Person');
    other = await signUp(t, 'Other Person');
    const resume = await uploadDocument(t, owner, 'resume', await docxFrom(RESUME_TEXT));
    resumeId = resume.id;
    const jd = await owner.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
    const s = await owner.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT });
    sessionId = s.body.id;
    await drainJobs(t);
  });
  afterAll(async () => t?.close());

  it('requires a session and returns the error envelope', async () => {
    const res = await (await import('supertest')).default(t.app.getHttpServer()).get('/v1/interview-prep/dashboard');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'AUTH_REQUIRED', retryable: false });
    expect(res.body.error.request_id).toMatch(/^req_/);
    expect(res.headers['x-request-id']).toBe(res.body.error.request_id);
  });

  it('serves the licensed interviewer model only to signed-in users, encrypted and uncached', async () => {
    const anon = await (await import('supertest')).default(t.app.getHttpServer()).get('/v1/assets/interviewer-model');
    expect(anon.status).toBe(401);
    const res = await owner
      .get('/v1/assets/interviewer-model')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.body as Buffer;
    // not the plain GLB: the magic bytes are encrypted away
    expect(body.subarray(0, 4).toString()).not.toBe('glTF');
    const { createDecipheriv } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    const d = createDecipheriv('aes-256-gcm', Buffer.from(String(res.headers['x-asset-key']), 'base64'), Buffer.from(String(res.headers['x-asset-iv']), 'base64'));
    d.setAuthTag(body.subarray(body.length - 16));
    const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
    expect(plain.equals(readFileSync(new URL('../assets/interviewer.glb', import.meta.url)))).toBe(true);
    // a second response uses a different key
    const again = await owner.get('/v1/assets/interviewer-model').buffer(true).parse((r, cb) => {
      r.on('data', () => undefined);
      r.on('end', () => cb(null, null));
    });
    expect(again.headers['x-asset-key']).not.toBe(res.headers['x-asset-key']);
  });

  it('requires explicit, versioned AI-processing consent before analysis', async () => {
    const jd = await owner.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
    const missing = await owner.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resumeId, jdDocumentId: jd.body.id });
    expect(missing.status).toBe(422);
    const stale = await owner
      .post('/v1/interviews')
      .set('Origin', ORIGIN)
      .send({ resumeDocumentId: resumeId, jdDocumentId: jd.body.id, aiProcessingConsent: { accepted: true, version: 'old' } });
    expect(stale.status).toBe(422);
    const { rows } = await t.pool.query('SELECT ai_consent_version, ai_consent_at FROM interview_sessions WHERE id = $1', [sessionId]);
    expect(rows[0].ai_consent_version).toBe(CONSENT.version);
    expect(rows[0].ai_consent_at).toBeInstanceOf(Date);
  });

  it('refuses state-changing requests from another origin', async () => {
    const res = await owner.post('/v1/documents/text').set('Origin', 'https://evil.example').send({ kind: 'jd', text: JD_TEXT });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
  });

  it("generated second-user test: every route with an id returns 404 for another user's resource", async () => {
    const idRoutes = ROUTES.filter((r) => r.path.includes('{id}'));
    expect(idRoutes.length).toBeGreaterThan(15);
    for (const r of idRoutes) {
      const id = r.path.startsWith('/v1/documents') ? resumeId : sessionId;
      const path = r.path.replace('{id}', id);
      const body =
        r.id === 'updateDocumentText'
          ? { text: 'x'.repeat(300) }
          : r.id === 'planInterview'
            ? { config: { interviewType: 'technical', difficulty: 'beginner', durationMin: 15, mode: 'realistic', track: 'general', focusSkillIds: [], speakQuestions: false } }
            : r.id === 'submitAnswer'
              ? { turnId: '00000000-0000-4000-8000-000000000000', answer: 'hello', clientSubmissionId: '00000000-0000-4000-8000-000000000001' }
              : r.id === 'clarifyQuestion'
                ? { turnId: '00000000-0000-4000-8000-000000000000', message: 'Could you repeat that?' }
              : r.id === 'endInterview'
                ? { reason: 'candidate_ended' }
                : r.id === 'submitReasoningAnswer'
                  ? { selectedOption: 'B', justification: 'x'.repeat(60), clientSubmissionId: '00000000-0000-4000-8000-000000000002' }
                  : undefined;
      const req = other[r.method](path).set('Origin', ORIGIN);
      const res = await (body ? req.send(body) : req);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(404);
    }
    // The owner still has everything.
    expect((await owner.get(`/v1/interviews/${sessionId}`)).status).toBe(200);
    expect((await owner.get(`/v1/documents/${resumeId}`)).status).toBe(200);
  });

  it('RLS is a backstop: as tr_app_user a query without WHERE sees only the caller’s rows', async () => {
    const { rows: users } = await t.pool.query<{ user_id: string }>('SELECT DISTINCT user_id FROM interview_sessions');
    const ownerId = users[0]!.user_id;
    const { rows: [otherUser] } = await t.pool.query<{ id: string }>('SELECT id FROM users WHERE id <> $1 LIMIT 1', [ownerId]);
    const c = await t.pool.connect();
    try {
      const countAs = async (userId: string | null, table: string) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE tr_app_user');
        if (userId) await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        await c.query('ROLLBACK');
        return rows[0].n as number;
      };
      for (const table of ['interview_sessions', 'resumes', 'job_descriptions', 'candidate_profiles', 'llm_call_log']) {
        expect(await countAs(ownerId, table), table).toBeGreaterThan(0);
        expect(await countAs(otherUser!.id, table), table).toBe(0);
        expect(await countAs(null, table), table).toBe(0);
      }
      // Writes under another user's id are rejected by WITH CHECK.
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE tr_app_user');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [otherUser!.id]);
      const upd = await c.query(`UPDATE interview_sessions SET state = 'cancelled'`);
      expect(upd.rowCount).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});

describe('upload validation and storage access', () => {
  let t: TestApp;
  let agent: Agent;
  beforeAll(async () => {
    t = await startApp();
    agent = await signUp(t);
  });
  afterAll(async () => t?.close());

  it('rejects oversize and unsupported uploads before issuing a URL', async () => {
    const big = await agent.post('/v1/documents').set('Origin', ORIGIN).send({ kind: 'resume', contentType: 'application/pdf', sizeBytes: 6 * 1024 * 1024 });
    expect(big.status).toBe(422);
    const exe = await agent.post('/v1/documents').set('Origin', ORIGIN).send({ kind: 'resume', contentType: 'application/x-msdownload', sizeBytes: 1000 });
    expect(exe.status).toBe(422);
    expect(exe.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('extracts a real PDF and records the page count', async () => {
    const doc = await uploadDocument(t, agent, 'resume', await pdf(RESUME_TEXT), 'application/pdf');
    expect(doc.status).toBe('extracted');
    expect(doc.pageCount).toBe(1);
    expect(doc.extractedText).toContain('Splunk');
    expect(doc.extractedText).not.toContain('priya.sharma@example.com');
  });

  it('fails clearly on a password-protected PDF', async () => {
    const doc = await uploadDocument(t, agent, 'resume', await pdf(RESUME_TEXT, { userPassword: 'secret', ownerPassword: 'owner' }), 'application/pdf');
    expect(doc.status).toBe('failed');
    expect(doc.failureCode).toBe('RESUME_UNREADABLE');
    expect(doc.warnings.join(' ')).toMatch(/password/i);
  });

  it('fails on a corrupted file and on content that does not match its declared type', async () => {
    const corrupt = await uploadDocument(t, agent, 'resume', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3000, 7)]), 'application/pdf');
    expect(corrupt.status).toBe('failed');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 1)]);
    const mismatch = await uploadDocument(t, agent, 'resume', png, 'application/pdf');
    expect(mismatch.status).toBe('failed');
    expect(mismatch.failureCode).toBe('RESUME_UNSUPPORTED_TYPE');
  });

  it('flags image-only or near-empty documents', async () => {
    const doc = await uploadDocument(t, agent, 'resume', await pdf('Resume'), 'application/pdf');
    expect(doc.status).toBe('failed');
    expect(doc.warnings.join(' ')).toMatch(/scanned|paste/i);
  });

  it('rejects a too-short pasted JD and re-redacts corrected text', async () => {
    const short = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: 'Too short' });
    expect(short.status).toBe(422);
    const jd = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
    const edited = await agent.patch(`/v1/documents/${jd.body.id}/text`).set('Origin', ORIGIN).send({ text: `${JD_TEXT}\nApply to hiring@acme.example or call +91 99887 66554` });
    expect(edited.status).toBe(200);
    expect(edited.body.editedByUser).toBe(true);
    expect(edited.body.extractedText).not.toMatch(/hiring@acme|99887/);
  });

  it('the upload endpoint enforces the signed policy (type, key, signature) before reading the body', async () => {
    const created = await agent.post('/v1/documents').set('Origin', ORIGIN).send({ kind: 'resume', contentType: 'application/pdf', sizeBytes: 2000 });
    const { upload } = created.body;
    const target = new URL(upload.url);
    // The policy and signature travel in the query string, so a bad signature is refused without buffering the file.
    expect(target.searchParams.get('policy')).toBeTruthy();
    expect(target.searchParams.get('signature')).toBeTruthy();
    expect(upload.fields.policy).toBeUndefined();
    const tampered = new URL(upload.url);
    tampered.searchParams.set('signature', 'x'.repeat(43));
    const form = agent.post(`${tampered.pathname}${tampered.search}`);
    for (const [k, v] of Object.entries(upload.fields as Record<string, string>)) form.field(k, v);
    expect((await form.attach('file', Buffer.from('%PDF-1.4'), 'a.pdf')).status).toBe(403);
    expect((await agent.post('/v1/dev-storage/upload').attach('file', Buffer.from('%PDF-1.4'), 'a.pdf')).status).toBe(403);
    const wrongType = agent.post(`${target.pathname}${target.search}`);
    for (const [k, v] of Object.entries({ ...upload.fields, 'Content-Type': 'text/html' } as Record<string, string>)) wrongType.field(k, v);
    expect((await wrongType.attach('file', Buffer.from('<script>'), 'a.html')).status).toBe(415);
  });

  it('S3 presigned POSTs are short-lived with size and type conditions and opaque keys', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'test/test/test/test/test/test/test/test';
    const s3 = new S3StorageAdapter('threatready-private', 'ap-south-1');
    const signed = await s3.putUrl('quarantine/org/AbCdEf', { contentType: 'application/pdf', maxBytes: 5 * 1024 * 1024, ttlSec: 300 });
    const policy = JSON.parse(Buffer.from(signed.fields.Policy!, 'base64').toString()) as { expiration: string; conditions: unknown[] };
    expect(JSON.stringify(policy.conditions)).toContain('["content-length-range",1,5242880]');
    expect(JSON.stringify(policy.conditions)).toContain('["eq","$Content-Type","application/pdf"]');
    expect(new Date(policy.expiration).getTime() - Date.now()).toBeLessThanOrEqual(301_000);
    const get = await s3.getUrl('reports/org/key.pdf', 120);
    expect(get).toMatch(/X-Amz-Expires=120/);
    const fresh = await signUp(t, 'Key Check');
    const created = await fresh.post('/v1/documents').set('Origin', ORIGIN).send({ kind: 'resume', contentType: 'application/pdf', sizeBytes: 2000 });
    expect(created.body.upload.fields.key).toMatch(/^quarantine\/[0-9a-f-]{36}\/[\w-]{32}$/);
  });

  it('rate-limits uploads per user (tier 2)', async () => {
    const fresh = await signUp(t, 'Rate Limited');
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await fresh.post('/v1/documents').set('Origin', ORIGIN).send({ kind: 'resume', contentType: 'application/pdf', sizeBytes: 1000 })).status;
    }
    expect(last).toBe(429);
  });

  it('scrubs personal text before anything reaches Sentry', () => {
    const out = scrub({ answer: 'my answer', nested: { email: 'a@b.co', note: 'contact a@b.co now' }, request_id: 'req_1' }) as Record<string, unknown>;
    expect(out.answer).toBe('[redacted]');
    expect(JSON.stringify(out)).not.toContain('a@b.co');
    expect(out.request_id).toBe('req_1');
  });
});
