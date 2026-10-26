import http from 'node:http';
import net from 'node:net';
import { AI_CONSENT_VERSION } from '@threatready/contracts';
import { ROUTES } from '@threatready/contracts';
import { scrub } from '@threatready/shared';
import PDFDocument from 'pdfkit';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FilesystemStorageAdapter } from '../src/platform/adapters/fs-storage.adapter.js';
import { JobsService } from '../src/modules/jobs/jobs.service.js';
import { S3StorageAdapter } from '../src/platform/adapters/s3-storage.adapter.js';
import { IDENTITY_TIMING } from '../src/platform/auth/identity.adapter.js';
import { SSE_TIMING } from '../src/platform/http/sse.js';
import { STORAGE_PORT } from '../src/platform/ports/storage.port.js';
import { drainJobs, identityCalls, identityStub, JD_TEXT, listen, ORIGIN, resetDatabase, RESUME_TEXT, sessionCookieValue, signOutEverywhere, signUp, startApp, type Agent, type TestApp } from './harness.js';
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

/** Raw HTTP/1.1 over a socket: headers and part of a body, to see when the server answers. */
function rawExchange(port: number, head: string, body: Buffer, opts: { keepOpen?: boolean } = {}): Promise<{ status: number; ms: number; sentAll: boolean; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(head);
      socket.write(body);
    });
    let data = '';
    socket.on('data', (c) => {
      data += c.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (m) {
        resolve({ status: Number(m[1]), ms: Date.now() - started, sentAll: false, socket });
        if (!opts.keepOpen) socket.destroy();
      }
    });
    socket.on('error', reject);
    setTimeout(() => {
      if (!opts.keepOpen) socket.destroy();
      resolve({ status: 0, ms: Date.now() - started, sentAll: false, socket });
    }, 5000);
  });
}

describe('storage links, identity lookups and limits (audit 2026-10-23, second pass)', () => {
  let t: TestApp;
  let port: number;
  const IP = 'x-threatready-client-ip';
  beforeAll(async () => {
    t = await startApp({ CLIENT_IP_HEADER: IP, INTERVIEW_DATA_STORAGE_LOCATION: 'Singapore' });
    port = await listen(t);
  });
  afterAll(async () => {
    identityStub.delayMs = 0;
    await t?.close();
  });

  async function signedUpload(agent: Agent, kind: 'resume' | 'jd' = 'resume') {
    const created = await agent.post('/v1/documents').set('Origin', ORIGIN).send({ kind, contentType: 'application/pdf', sizeBytes: 2000 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return { document: created.body.document as { id: string }, upload: created.body.upload as { url: string; fields: Record<string, string> } };
  }

  it('refuses a bad signature before reading the body (TR-07)', async () => {
    const head = ['POST /v1/dev-storage/upload?policy=e30&signature=' + 'x'.repeat(43) + ' HTTP/1.1', 'Host: localhost', 'Content-Type: multipart/form-data; boundary=b', `Content-Length: ${5 * 1024 * 1024}`, `${IP}: 198.51.100.1`, '', ''].join('\r\n');
    const res = await rawExchange(port, head, Buffer.alloc(16 * 1024, 0x61));
    expect(res.status).toBe(403);
    expect(res.ms).toBeLessThan(1000);
  });

  it('a valid link: an oversize chunked body is cut off at the policy size, the link works once, and a concurrent second upload is refused (TR-07, TR-35)', async () => {
    const agent = await signUp(t, 'Upload Once');
    const { document, upload } = await signedUpload(agent);
    const target = new URL(upload.url);
    // No Content-Length to check up front (chunked): the body streams to disk and stops at the policy's 5 MB.
    const chunkedResult = await new Promise<{ status: number; sent: number; total: number }>((resolve, reject) => {
      const total = 8 * 1024 * 1024;
      let sent = 0;
      let answered = false;
      const s = net.connect(port, '127.0.0.1', async () => {
        s.write(['POST ' + target.pathname + target.search + ' HTTP/1.1', 'Host: localhost', 'Content-Type: multipart/form-data; boundary=bnd', 'Transfer-Encoding: chunked', '', ''].join('\r\n'));
        const chunk = (b: Buffer) => s.write(Buffer.concat([Buffer.from(`${b.length.toString(16)}\r\n`), b, Buffer.from('\r\n')]));
        const fields = Object.entries(upload.fields).map(([k, v]) => `--bnd\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
        chunk(Buffer.from(`${fields}--bnd\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`));
        const piece = Buffer.alloc(64 * 1024, 0x61);
        while (!answered && sent < total && !s.destroyed) {
          if (!chunk(piece)) await new Promise((r) => s.once('drain', r));
          sent += piece.length;
        }
      });
      s.on('data', (c) => {
        const m = /^HTTP\/1\.1 (\d{3})/.exec(c.toString('latin1'));
        if (m && !answered) {
          answered = true;
          resolve({ status: Number(m[1]), sent, total });
          s.destroy();
        }
      });
      s.on('error', (e) => (answered ? undefined : reject(e)));
    });
    expect(chunkedResult.status).toBe(413);
    expect(chunkedResult.sent).toBeLessThan(chunkedResult.total);
    await new Promise((r) => setTimeout(r, 200));

    // A stalled upload holds the link: a second one with the same link is refused, not buffered.
    const stalled = await new Promise<net.Socket>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(['POST ' + target.pathname + target.search + ' HTTP/1.1', 'Host: localhost', 'Content-Type: multipart/form-data; boundary=bnd', 'Content-Length: 4000', '', '--bnd\r\n'].join('\r\n'));
        setTimeout(() => resolve(s), 300);
      });
    });
    const second = agent.post(`${target.pathname}${target.search}`);
    for (const [k, v] of Object.entries(upload.fields)) second.field(k, v);
    const secondRes = await second.attach('file', Buffer.from('%PDF-1.4 second'), 'b.pdf');
    expect(secondRes.status).toBe(409);
    expect(secondRes.body.error.code).toBe('STORAGE_UPLOAD_CONFLICT');
    stalled.destroy();
    await new Promise((r) => setTimeout(r, 200));

    const form = agent.post(`${target.pathname}${target.search}`);
    for (const [k, v] of Object.entries(upload.fields)) form.field(k, v);
    expect((await form.attach('file', Buffer.from('%PDF-1.4 first'), 'a.pdf')).status).toBe(204);
    expect((await agent.post(`/v1/documents/${document.id}/complete`).set('Origin', ORIGIN)).status).toBe(202);
    // After completion the link is spent: no overwrite of a file that is being extracted.
    const replay = agent.post(`${target.pathname}${target.search}`);
    for (const [k, v] of Object.entries(upload.fields)) replay.field(k, v);
    const replayed = await replay.attach('file', Buffer.from('<html>forged</html>'), 'x.pdf');
    expect(replayed.status).toBe(409);
  });

  it('multipart limits come from the policy: extra fields and long values are refused', async () => {
    const agent = await signUp(t, 'Form Limits');
    const { upload } = await signedUpload(agent);
    const target = new URL(upload.url);
    const many = agent.post(`${target.pathname}${target.search}`);
    for (const [k, v] of Object.entries(upload.fields)) many.field(k, v);
    for (let i = 0; i < 6; i++) many.field(`extra${i}`, 'x');
    expect((await many.attach('file', Buffer.from('%PDF-1.4'), 'a.pdf')).status).toBe(422);
    const long = agent.post(`${target.pathname}${target.search}`);
    for (const [k, v] of Object.entries(upload.fields)) long.field(k, v);
    long.field('note', 'x'.repeat(2048));
    expect((await long.attach('file', Buffer.from('%PDF-1.4'), 'a.pdf')).status).toBe(422);
  });

  it('a download link is not an upload policy, and a missing file is a 404, not a 500 (TR-35, TR-36)', async () => {
    const fs = t.app.get<FilesystemStorageAdapter>(STORAGE_PORT);
    const get = new URL(await fs.getUrl('reports/none/missing.pdf', 120));
    const asUpload = await (await import('supertest')).default(t.app.getHttpServer())
      .post(`/v1/dev-storage/upload?policy=${get.searchParams.get('t')}&signature=${get.searchParams.get('s')}`)
      .set(IP, '198.51.100.2')
      .field('key', 'reports/none/missing.pdf')
      .field('Content-Type', 'text/html')
      .attach('file', Buffer.from('<script>alert(1)</script>'), 'x.html');
    expect(asUpload.status).toBe(403);
    const missing = await (await import('supertest')).default(t.app.getHttpServer()).get(`${get.pathname}${get.search}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('STORAGE_OBJECT_NOT_FOUND');
  });

  it('per-IP limits count only failed signatures: a classroom behind one NAT uploads freely (IP-REG4, UX-REG0)', async () => {
    const nat = '203.0.113.77';
    const server = (await import('supertest')).default(t.app.getHttpServer());
    for (let i = 0; i < 25; i++) {
      const learner = await signUp(t, `Learner ${i}`);
      const { upload } = await signedUpload(learner);
      const target = new URL(upload.url);
      const form = server.post(`${target.pathname}${target.search}`).set(IP, nat);
      for (const [k, v] of Object.entries(upload.fields)) form.field(k, v);
      expect((await form.attach('file', Buffer.from('%PDF-1.4 resume'), 'r.pdf')).status, `learner ${i}`).toBe(204);
    }
    let last: request.Response | undefined;
    for (let i = 0; i < 31; i++) {
      last = await server.post('/v1/dev-storage/upload?policy=e30&signature=bad').set(IP, nat).field('key', 'x').attach('file', Buffer.from('x'), 'x.pdf');
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    expect(last!.body.error.retryable).toBe(false);
    // Learners elsewhere are unaffected.
    expect((await server.post('/v1/dev-storage/upload?policy=e30&signature=bad').set(IP, '203.0.113.78').attach('file', Buffer.from('x'), 'x.pdf')).status).toBe(403);
  });

  it('uploads, pasted job descriptions and text edits have separate buckets; invalid requests do not use them (TR-46, TR-52)', async () => {
    const agent = await signUp(t, 'Bucket Owner');
    for (let i = 0; i < 12; i++) {
      const bad = await agent.post('/v1/documents').set('Origin', ORIGIN).send({ kind: 'resume', contentType: 'application/pdf', sizeBytes: 99 * 1024 * 1024 });
      expect(bad.status).toBe(422);
    }
    const jd = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
    expect(jd.status).toBe(201);
    for (let i = 0; i < 10; i++) expect((await agent.post('/v1/documents').set('Origin', ORIGIN).send({ kind: 'resume', contentType: 'application/pdf', sizeBytes: 1000 })).status).toBe(201);
    const limited = await agent.post('/v1/documents').set('Origin', ORIGIN).send({ kind: 'resume', contentType: 'application/pdf', sizeBytes: 1000 });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatchObject({ code: 'RATE_LIMITED', retryable: false });
    expect(limited.body.error.message).toMatch(/try again in about \d+ minutes/);
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(3000);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    // The JD bucket and the edit bucket are untouched by the upload limit.
    expect((await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT })).status).toBe(201);
    const short = await agent.patch(`/v1/documents/${jd.body.id}/text`).set('Origin', ORIGIN).send({ text: 'x'.repeat(120) });
    expect(short.status).toBe(422);
    expect(short.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'text' }] });
    expect((await agent.patch(`/v1/documents/${jd.body.id}/text`).set('Origin', ORIGIN).send({ text: `${JD_TEXT} Updated.` })).status).toBe(200);
  });

  it('accepts a 22,000-character job description in any script, and says when text is too long (TR-36)', async () => {
    const agent = await signUp(t, 'Long Text');
    const cjk = `${JD_TEXT}\n${'安全运营中心分析师负责告警分诊与事件响应。'.repeat(1050)}`.slice(0, 22_000);
    const ok = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: cjk });
    expect(ok.status, JSON.stringify(ok.body).slice(0, 200)).toBe(201);
    const tooLong = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: 'a'.repeat(30_001) });
    expect(tooLong.status).toBe(413);
    expect(tooLong.body.error.code).toBe('TEXT_TOO_LONG');
    const tooShort = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: 'Too short' });
    expect(tooShort.body.error.code).toBe('JD_TOO_SHORT');
    // Compressed request bodies are never inflated (browsers do not send them; GHSA-27r3-jxmh-p828).
    const { gzipSync } = await import('node:zlib');
    const gz = await agent
      .post('/v1/documents/text')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(gzipSync(Buffer.from(JSON.stringify({ kind: 'jd', text: JD_TEXT }))));
    expect(gz.status).toBe(400);
    expect(gz.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('identity: junk cookies never reach onboard, one client cannot fill the lookup cap, known sessions are never shed (IP-REG1)', async () => {
    const small = await startApp({ CLIENT_IP_HEADER: IP, IDENTITY_MAX_IN_FLIGHT: '4', IDENTITY_MAX_IN_FLIGHT_PER_CLIENT: '2' });
    const wait = IDENTITY_TIMING.clientWaitMs;
    try {
      const server = (await import('supertest')).default(small.app.getHttpServer());
      const before = identityCalls.length;
      const unsigned = (i: number) => `tr.session_token=${'U'.repeat(32)}${i}`; // the right shape but no signature
      const junk = await Promise.all(Array.from({ length: 20 }, (_, i) => server.get('/v1/me').set('Cookie', i % 2 ? `tr.session_token=junk${i}` : unsigned(i)).set(IP, '192.0.2.1')));
      expect(junk.every((r) => r.status === 401)).toBe(true);
      expect(identityCalls.length).toBe(before); // never asked onboard

      const valid = await signUp(small, 'Valid Learner');
      expect((await valid.get('/v1/me').set(IP, '192.0.2.50')).status).toBe(200); // now known-good

      // A classroom behind one NAT signing in at once queues for its client's two slots, briefly, instead of being turned away.
      identityStub.delayMs = 150;
      identityStub.maxActive = 0;
      const classroom = await Promise.all(Array.from({ length: 10 }, () => signUp(small, 'Classroom Learner')));
      const signedIn = await Promise.all(classroom.map((l) => l.get('/v1/me').set(IP, '192.0.2.200')));
      expect(signedIn.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(identityStub.maxActive).toBeLessThanOrEqual(2);

      // Past that wait the client is refused with a short Retry-After (never a 503), while other
      // networks and known sessions still get through.
      IDENTITY_TIMING.clientWaitMs = 0;
      identityStub.delayMs = 400;
      const flood = Promise.all(
        Array.from({ length: 12 }, (_, i) => server.get('/v1/me').set('Cookie', `tr.session_token=${sessionCookieValue(`${'F'.repeat(30)}${String(i).padStart(2, '0')}`)}`).set(IP, '192.0.2.1')),
      );
      await new Promise((r) => setTimeout(r, 100));
      // Another client and a known session both get through while the flood is in flight.
      const other = await signUp(small, 'Other Network');
      const otherRes = other.get('/v1/me').set(IP, '192.0.2.99');
      const knownRes = valid.get('/v1/me').set(IP, '192.0.2.1');
      const [o, k, f] = await Promise.all([otherRes, knownRes, flood]);
      expect(o.status).toBe(200);
      expect(k.status).toBe(200);
      const shed = f.filter((r) => r.status === 429);
      expect(shed.length).toBeGreaterThanOrEqual(8); // at most 2 lookups at a time from 192.0.2.1
      expect(shed[0]!.headers['retry-after']).toBe('1');
      expect(f.filter((r) => r.status === 503)).toHaveLength(0);
    } finally {
      IDENTITY_TIMING.clientWaitMs = wait;
      identityStub.delayMs = 0;
      await small.close();
    }
  });

  it('event streams: a fourth is refused with Retry-After, a closed one frees its slot, sign-out ends them (TR-25)', async () => {
    const agent = await signUp(t, 'Stream Holder');
    const resume = await uploadDocument(t, agent, 'resume', await docxFrom(RESUME_TEXT));
    const jd = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
    const s = await agent.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT });
    expect(s.body.state).toBe('parsing'); // not drained: the streams stay open
    const cookie = (agent as unknown as { _defaults: { fn: string; args: string[] }[] })._defaults.find((d) => d.args[0] === 'Cookie')!.args[1]!;
    const open = () =>
      new Promise<{ status: number; req: http.ClientRequest; res?: http.IncomingMessage; ended: Promise<void> }>((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: `/v1/interviews/${s.body.id}/events`, headers: { cookie } }, (res) => {
          const ended = new Promise<void>((done) => res.on('close', () => done()));
          res.resume();
          resolve({ status: res.statusCode!, req, res, ended });
        });
      });
    const prev = { ...SSE_TIMING };
    SSE_TIMING.identityRecheckMs = 300;
    SSE_TIMING.firstPollMs = 100;
    SSE_TIMING.maxPollMs = 200;
    try {
      const streams = [await open(), await open(), await open()];
      expect(streams.map((x) => x.status)).toEqual([200, 200, 200]);
      const fourth = await open();
      expect(fourth.status).toBe(429);
      expect(Number(fourth.res!.headers['retry-after'])).toBeGreaterThan(0);
      streams[0]!.req.destroy();
      await new Promise((r) => setTimeout(r, 200));
      const again = await open();
      expect(again.status).toBe(200);
      signOutEverywhere(agent);
      await Promise.race([Promise.all([streams[1]!.ended, streams[2]!.ended, again.ended]), new Promise((_, reject) => setTimeout(() => reject(new Error('streams did not end')), 5000))]);
    } finally {
      Object.assign(SSE_TIMING, prev);
    }
  });

  it('documents: the owner lists and deletes them; the file and text are gone; a deleted resume leaves no quotes behind (TR-13, TR-22)', async () => {
    const agent = await signUp(t, 'Doc Owner');
    const resume = await uploadDocument(t, agent, 'resume', await docxFrom(RESUME_TEXT));
    const jd = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
    const s = await agent.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT });
    await drainJobs(t, { only: ['interview.analyse'] });
    const list = await agent.get('/v1/documents');
    expect(list.status).toBe(200);
    expect(list.body.items.map((d: { id: string }) => d.id).sort()).toEqual([resume.id, jd.body.id].sort());
    expect(list.body.items.find((d: { id: string }) => d.id === resume.id)).toMatchObject({ kind: 'resume', inUse: true, fileDeleted: false });
    expect(JSON.stringify(list.body)).not.toContain('Splunk'); // no text in the list
    expect((await agent.delete(`/v1/documents/${resume.id}`).set('Origin', ORIGIN)).status).toBe(409);
    expect((await agent.post(`/v1/interviews/${s.body.id}/cancel`).set('Origin', ORIGIN)).status).toBe(200);

    const { rows: [doc] } = await t.pool.query('SELECT object_key FROM resumes WHERE id = $1', [resume.id]);
    const fs = t.app.get<FilesystemStorageAdapter>(STORAGE_PORT);
    expect(await fs.head(doc.object_key)).not.toBeNull();
    expect((await agent.delete(`/v1/documents/${resume.id}`).set('Origin', ORIGIN)).status).toBe(204);
    expect((await agent.get(`/v1/documents/${resume.id}`)).status).toBe(404);
    expect(await fs.head(doc.object_key)).toBeNull();
    const { rows: [session] } = await t.pool.query('SELECT analysis, plan FROM interview_sessions WHERE id = $1', [s.body.id]);
    expect(JSON.stringify(session.analysis.candidate)).not.toMatch(/Triaged|Splunk alerts|Aero Fintech/);
    expect(session.analysis.candidate.skills.length).toBeGreaterThan(0);
    expect((await agent.get('/v1/documents')).body.items.map((d: { id: string }) => d.id)).toEqual([jd.body.id]);
  });

  it('erasure on account deletion removes the learner\'s data and files but keeps the cost ledger (TR-22)', async () => {
    const agent = await signUp(t, 'Leaving Learner');
    const userId = (await agent.get('/v1/me')).body.id as string;
    const resume = await uploadDocument(t, agent, 'resume', await docxFrom(RESUME_TEXT));
    const jd = await agent.post('/v1/documents/text').set('Origin', ORIGIN).send({ kind: 'jd', text: JD_TEXT });
    await agent.post('/v1/interviews').set('Origin', ORIGIN).send({ resumeDocumentId: resume.id, jdDocumentId: jd.body.id, aiProcessingConsent: CONSENT });
    await drainJobs(t, { only: ['interview.analyse'] });
    const { rows: [doc] } = await t.pool.query('SELECT object_key FROM resumes WHERE id = $1', [resume.id]);
    const server = (await import('supertest')).default(t.app.getHttpServer());
    expect((await server.post(`/internal/v1/users/${userId}/erase`)).status).toBe(401);
    const res = await server.post(`/internal/v1/users/${userId}/erase`).set('Authorization', `Bearer ${process.env.INTERNAL_API_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.erased).toMatchObject({ interviews: 1, resumes: 1, jobDescriptions: 1 });
    for (const table of ['interview_sessions', 'resumes', 'job_descriptions', 'candidate_profiles']) {
      const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]);
      expect(rows[0].n, table).toBe(0);
    }
    expect(await t.app.get<FilesystemStorageAdapter>(STORAGE_PORT).head(doc.object_key)).toBeNull();
    const { rows: ledger } = await t.pool.query('SELECT count(*)::int AS n FROM llm_call_log WHERE user_id = $1', [userId]);
    expect(ledger[0].n).toBeGreaterThan(0);
    const { rows: [u] } = await t.pool.query('SELECT name, email FROM users WHERE id = $1', [userId]);
    expect(u).toMatchObject({ name: 'Deleted user' });
    expect(u.email).not.toMatch(/example\.test/);
  });

  it('the sweeper deletes abandoned uploads and, after 30 days, uploaded files (TR-35, TR-25)', async () => {
    const agent = await signUp(t, 'Sweep Owner');
    const { document, upload } = await signedUpload(agent);
    const target = new URL(upload.url);
    const form = agent.post(`${target.pathname}${target.search}`);
    for (const [k, v] of Object.entries(upload.fields)) form.field(k, v);
    expect((await form.attach('file', Buffer.from('%PDF-1.4 never completed'), 'a.pdf')).status).toBe(204); // uploaded, never completed
    const kept = await uploadDocument(t, agent, 'resume', await docxFrom(RESUME_TEXT));
    const old = await uploadDocument(t, agent, 'resume', await docxFrom(`${RESUME_TEXT}\nOlder copy`));
    const keyOf = async (id: string) => (await t.pool.query('SELECT object_key FROM resumes WHERE id = $1', [id])).rows[0]?.object_key as string | undefined;
    const abandonedKey = (await keyOf(document.id))!;
    const oldKey = (await keyOf(old.id))!;
    await t.pool.query(`UPDATE resumes SET updated_at = now() - interval '2 hours' WHERE id = $1`, [document.id]);
    await t.pool.query(`UPDATE resumes SET updated_at = now() - interval '31 days' WHERE id = $1`, [old.id]);
    const fs = t.app.get<FilesystemStorageAdapter>(STORAGE_PORT);
    // A partial upload body left behind by a cut-off connection, and one still arriving.
    const { mkdir, writeFile, utimes, access } = await import('node:fs/promises');
    await mkdir(fs.incomingDir(), { recursive: true });
    const stalePartial = `${fs.incomingDir()}/stale-partial`;
    const livePartial = `${fs.incomingDir()}/live-partial`;
    await writeFile(stalePartial, 'x');
    await writeFile(livePartial, 'x');
    await utimes(stalePartial, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    process.env.APP_ROLE = 'worker';
    try {
      await t.app.get(JobsService).sweep();
    } finally {
      process.env.APP_ROLE = 'api';
    }
    await expect(access(stalePartial)).rejects.toThrow();
    await expect(access(livePartial)).resolves.toBeUndefined();
    expect((await t.pool.query('SELECT count(*)::int AS n FROM resumes WHERE id = $1', [document.id])).rows[0].n).toBe(0);
    expect(await fs.head(abandonedKey)).toBeNull();
    const { rows: [purged] } = await t.pool.query('SELECT object_key, file_deleted_at, extracted_text FROM resumes WHERE id = $1', [old.id]);
    expect(purged.object_key).toBeNull();
    expect(purged.file_deleted_at).toBeInstanceOf(Date);
    expect(purged.extracted_text).toContain('Splunk'); // the redacted text stays until the learner deletes it
    expect(await fs.head(oldKey)).toBeNull();
    expect(await fs.head((await keyOf(kept.id))!)).not.toBeNull();
    expect((await agent.get('/v1/documents')).body.items.find((d: { id: string }) => d.id === old.id).fileDeleted).toBe(true);
  });

  it('a DOCX bomb is refused before it is unpacked, without growing the process (TR-06)', async () => {
    const { deflateRawSync } = await import('node:zlib');
    const name = Buffer.from('word/document.xml');
    const body = deflateRawSync(Buffer.alloc(100 * 1024 * 1024, 0x20));
    const ct = Buffer.from('[Content_Types].xml');
    const ctBody = deflateRawSync(Buffer.from('<Types/>'));
    const entry = (n: Buffer, b: Buffer, size: number, offset: number) => {
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(b.length, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(n.length, 26);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(8, 10);
      cd.writeUInt32LE(b.length, 20);
      cd.writeUInt32LE(size, 24);
      cd.writeUInt16LE(n.length, 28);
      cd.writeUInt32LE(offset, 42);
      return { local: Buffer.concat([local, n, b]), cd: Buffer.concat([cd, n]) };
    };
    const a = entry(ct, ctBody, 8, 0);
    const b = entry(name, body, 100 * 1024 * 1024, a.local.length);
    const dir = Buffer.concat([a.cd, b.cd]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(2, 8);
    eocd.writeUInt16LE(2, 10);
    eocd.writeUInt32LE(dir.length, 12);
    eocd.writeUInt32LE(a.local.length + b.local.length, 16);
    const bomb = Buffer.concat([a.local, b.local, dir, eocd]);
    expect(bomb.length).toBeLessThan(500 * 1024);
    const agent = await signUp(t, 'Bomb Thrower');
    const rssBefore = process.memoryUsage().rss;
    const doc = await uploadDocument(t, agent, 'resume', bomb);
    // Its directory declares a 100 MB part: refused for size (security patch 2, A4) with the
    // "expands to far more than a resume" warning, before anything is inflated.
    expect(doc).toMatchObject({ status: 'failed', failureCode: 'RESUME_TOO_LARGE' });
    expect(doc.warnings[0]).toMatch(/expands to far more/);
    // The same bomb with the EOCD counting only [Content_Types].xml: mammoth's unzipper still reads the
    // uncounted document.xml record, so the scan must walk every record too (fix-up review of TR-06).
    const undercount = Buffer.from(bomb);
    undercount.writeUInt16LE(1, bomb.length - 22 + 8);
    undercount.writeUInt16LE(1, bomb.length - 22 + 10);
    const doc2 = await uploadDocument(t, agent, 'resume', undercount);
    expect(doc2).toMatchObject({ status: 'failed', failureCode: 'RESUME_UNREADABLE' });
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(100 * 1024 * 1024);
  });

  it('the 3D model has a per-user daily download quota (TR-47) and /v1/platform states the configured data location (TR-13)', async () => {
    const capped = await startApp({ INTERVIEW_MODEL_DOWNLOADS_PER_DAY: '2' });
    try {
      const agent = await signUp(capped, 'Model Viewer');
      const fetchModel = () => agent.get('/v1/assets/interviewer-model').buffer(true).parse((r, cb) => {
        r.on('data', () => undefined);
        r.on('end', () => cb(null, null));
      });
      expect([200, 404]).toContain((await fetchModel()).status);
      expect([200, 404]).toContain((await fetchModel()).status);
      const third = await fetchModel();
      expect(third.status).toBe(429);
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
      const plat = await agent.get('/v1/platform');
      expect(plat.body.dataHandling).toEqual({ storageLocation: null, fileRetentionDays: 30 });
    } finally {
      await capped.close();
    }
    const learner = await signUp(t, 'Consent Reader');
    expect((await learner.get('/v1/platform')).body.dataHandling).toEqual({ storageLocation: 'Singapore', fileRetentionDays: 30 });
  });
});
