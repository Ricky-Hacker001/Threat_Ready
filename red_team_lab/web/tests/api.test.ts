import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Store } from '../server/store';
import { makeApp, auth, ORIGIN } from './helpers';

let app: any, sid: string, n = 0;
const rid = () => `req-${Date.now()}-${n++}`;
const act = (user: string, s: string, type: string, params: any = {}, requestId = rid()) => request(app).post(`/api/sessions/${s}/actions`).set(auth(user)).send({ type, params, requestId });

beforeEach(async () => {
  app = makeApp(new Store(null));
  sid = (await request(app).post('/api/labs/TR-RED-001/sessions').set(auth('Asha'))).body.session.id;
});

describe('API security', () => {
  it('requires authentication', async () => {
    expect((await request(app).get(`/api/sessions/${sid}`)).status).toBe(401);
    expect((await request(app).get(`/api/sessions/${sid}`).set({ Cookie: 'test_user=' })).status).toBe(401);
  });

  it("a learner cannot read or modify another learner's session", async () => {
    expect((await request(app).get(`/api/sessions/${sid}`).set(auth('Bharat'))).status).toBe(404);
    expect((await act('Bharat', sid, 'browser.navigate', { url: '/products' })).status).toBe(404);
    expect((await request(app).get(`/api/sessions/${sid}/report`).set(auth('Bharat'))).status).toBe(404);
    expect((await request(app).post(`/api/sessions/${sid}/reset`).set(auth('Bharat')).send({ confirm: 'RESET' })).status).toBe(404);
  });

  it('forged state writes and unknown actions are rejected', async () => {
    for (const type of ['objective.complete', 'finding.verify', 'state.set', 'level.set']) {
      const r = await act('Asha', sid, type, { id: 'x', level: 4 });
      expect(r.body.ok).toBe(false); expect(r.body.code).toBe('LAB_ACTION_UNSUPPORTED');
    }
    // A finding cannot be marked confirmed by passing extra fields.
    const r = await act('Asha', sid, 'finding.report', { findingId: 'V-SQLI', severity: 'Critical', confirmed: true, verified: true });
    expect(r.body.ok).toBe(false);
    expect(r.body.status.findings.find((f: any) => f.id === 'V-SQLI').confirmed).toBe(false);
  });

  it('state-changing actions require the app Origin', async () => {
    const r = await request(app).post(`/api/sessions/${sid}/actions`).set(auth('Asha')).set('Origin', 'https://evil.example').send({ type: 'browser.navigate', params: { url: '/' }, requestId: rid() });
    expect(r.status).toBe(403);
  });

  it('repeated requests are idempotent', async () => {
    const id = rid();
    const a = await act('Asha', sid, 'browser.navigate', { url: '/products' }, id);
    const b = await act('Asha', sid, 'browser.navigate', { url: '/products' }, id);
    expect(a.body.ok).toBe(true); expect(b.body.replayed).toBe(true);
    expect(b.body.view.rev).toBe(a.body.view.rev);
    // history did not double up for the replay
    expect((await request(app).get(`/api/sessions/${sid}`).set(auth('Asha'))).body.view.history.length).toBe(a.body.view.history.length);
  });

  it('API responses never contain answer keys, unrequested hints or raw secrets', async () => {
    const bodies = [
      await request(app).get('/api/labs/TR-RED-001').set(auth('Asha')),
      await request(app).get(`/api/sessions/${sid}`).set(auth('Asha')),
    ].map(r => JSON.stringify(r.body)).join('');
    // Remediation answer-key flags must not leak.
    expect(bodies).not.toContain('"correct"');
    // The weak JWT signing secret must not appear until it is earned (via exploitation/download).
    const snap = await request(app).get(`/api/sessions/${sid}`).set(auth('Asha'));
    const secret = (snap.body as any); // we can't read server secret directly; assert common seed markers absent
    for (const leak of ['jwtSecret', 'remediation":"Use parameterised', 'TRAVERSAL FLAG']) expect(bodies).not.toContain(leak);
    // Hints are hidden until requested.
    const obj = snap.body.status.objectives.find((o: any) => o.id === 'L1.map');
    expect(obj.hints.length).toBe(0);
  });

  it('rejects malformed action requests', async () => {
    expect((await request(app).post(`/api/sessions/${sid}/actions`).set(auth('Asha')).send({ type: 'browser.navigate' })).status).toBe(400);
    expect((await request(app).post(`/api/sessions/${sid}/actions`).set(auth('Asha')).set('Content-Type', 'application/json').send('{oops')).status).toBe(400);
  });

  it('a completed run archives on reset and starts a fresh one', async () => {
    const reset = await request(app).post(`/api/sessions/${sid}/reset`).set(auth('Asha')).send({ confirm: 'RESET' });
    expect(reset.status).toBe(200);
    expect(reset.body.session.id).not.toBe(sid);
    expect(reset.body.status.level).toBe(1);
    expect((await request(app).get(`/api/sessions/${sid}`).set(auth('Asha'))).body.session.status).toBe('archived');
  });
});
