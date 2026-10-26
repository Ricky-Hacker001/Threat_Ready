import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Store } from '../server/store';
import { makeApp, auth, ORIGIN, fakeIdentity, Lab, solve } from './helpers';
import { createApp } from '../server/app';
import type { IdentityResolver, PlatformUser } from '../server/identity';

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

  it('terminal patterns that break the regex engine answer 200 with a grep/find error, never 500', async () => {
    const t0 = performance.now();
    const grep = await act('Asha', sid, 'terminal.exec', { line: `echo ${'a'.repeat(40)} | grep "(a+)+$"` });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(grep.status).toBe(200); expect(grep.body.ok).toBe(true); expect(grep.body.result.output).toMatch(/^grep: invalid pattern/);
    for (const line of ["find . -name '('", "find / -name '[a-'", "grep '[' notes.md", "grep '(a' notes.md"]) {
      const r = await act('Asha', sid, 'terminal.exec', { line });
      expect(r.status, line).toBe(200); expect(r.body.ok).toBe(true);
    }
    expect((await act('Asha', sid, 'terminal.exec', { line: "find . -name '*.txt'" })).body.result.output).toContain('engagement-brief.txt');
  });

  it('prototype names are neither replayed requests, labs nor findings', async () => {
    for (const requestId of ['constructor', '__proto__', 'hasOwnProperty']) {
      const r = await act('Asha', sid, 'engagement.acknowledge', {}, requestId);
      expect(r.status).toBe(200); expect(r.body.replayed).toBeUndefined();
    }
    expect((await request(app).get('/api/labs/constructor').set(auth('Asha'))).status).toBe(404);
    expect((await request(app).post('/api/labs/__proto__/sessions').set(auth('Asha'))).status).toBe(404);
    const f = await act('Asha', sid, 'finding.report', { findingId: 'constructor', severity: 'High' });
    expect(f.status).toBe(200); expect(f.body.code).toBe('VALIDATION_FAILED');
  });

  it('LAB-REG1: a "__proto__" requestId is a working idempotency key (second call replays, no re-run)', async () => {
    const a = await act('Asha', sid, 'browser.navigate', { url: '/products' }, '__proto__');
    const b = await act('Asha', sid, 'browser.navigate', { url: '/products' }, '__proto__');
    expect(a.body.ok).toBe(true);
    expect(b.body.replayed).toBe(true);
    expect(b.body.view.rev).toBe(a.body.view.rev);
    // The action ran exactly once: history did not double up on the replay.
    expect((await request(app).get(`/api/sessions/${sid}`).set(auth('Asha'))).body.view.history.length).toBe(a.body.view.history.length);
  });

  it('rate-limits per user with 429 + Retry-After in the API error shape', async () => {
    const limited = createApp(new Store(null), undefined, { identity: fakeIdentity, appOrigin: ORIGIN, devLogin: false, ratePerMin: 2, rateIpPerMin: 1000 });
    expect((await request(limited).get('/api/catalog').set(auth('Asha'))).status).toBe(200);
    expect((await request(limited).get('/api/catalog').set(auth('Asha'))).status).toBe(200);
    const r = await request(limited).get('/api/catalog').set(auth('Asha'));
    expect(r.status).toBe(429); expect(Number(r.headers['retry-after'])).toBeGreaterThan(0); expect(r.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect((await request(limited).get('/api/catalog').set(auth('Bharat'))).status).toBe(200);
    const byIp = createApp(new Store(null), undefined, { identity: fakeIdentity, appOrigin: ORIGIN, devLogin: false, ratePerMin: 1000, rateIpPerMin: 1 });
    expect((await request(byIp).get('/api/catalog').set({ 'x-threatready-client-ip': '203.0.113.1' })).status).toBe(401);
    expect((await request(byIp).get('/api/catalog').set({ 'x-threatready-client-ip': '203.0.113.1' })).status).toBe(429);
  });

  it('UX-REG0/IP-REG1: signed-in learners sharing one IP are not throttled as one client; junk cookies still pay the per-IP bucket', async () => {
    // A resolver that recognises `u=<name>` cookies and can answer from cache synchronously (peek).
    const user = (name: string): PlatformUser => ({ id: 'u_' + name, name, email: null, image: null, isTrial: false, isAdmin: false });
    const peeking = Object.assign(
      async (h: any) => { const m = /(?:^|;\s*)u=([^;]+)/.exec(h.cookie || ''); return m ? { ok: true, user: user(m[1]), setCookies: [] } : { ok: false, reason: 'signed-out', setCookies: [] }; },
      { peek: (h: any) => { const m = /(?:^|;\s*)u=([^;]+)/.exec(h.cookie || ''); return m ? user(m[1]) : null; } },
    ) as IdentityResolver;
    const napp = createApp(new Store(null), undefined, { identity: peeking, appOrigin: ORIGIN, devLogin: false, ratePerMin: 1000, rateIpPerMin: 3 });
    const IP = { 'x-threatready-client-ip': '203.0.113.9' };
    // 30 distinct signed-in learners behind one NAT, several requests each: a recognised learner skips
    // the per-IP bucket, so none are throttled although the IP budget is only 3/min.
    for (let u = 0; u < 30; u++) for (let k = 0; k < 3; k++) {
      expect((await request(napp).get('/api/catalog').set({ ...IP, Cookie: `u=L${u}` })).status, `learner ${u}`).toBe(200);
    }
    // Junk cookies from the same IP are unauthenticated and still pay the per-IP bucket (which protects
    // the identity lookup from floods), so they are 429'd once the 3-token budget is spent.
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await request(napp).get('/api/catalog').set({ ...IP, Cookie: `junk=${i}` })).status);
    expect(codes.filter(c => c === 429).length).toBeGreaterThan(0);
  });

  it('TR-44: the vulnerable target document is served with its own relaxed, sandboxed CSP', async () => {
    const r = await request(app).get('/target-frame.html');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    const csp = r.headers['content-security-policy'] || '';
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval'"); // XSS payloads must execute here
    expect(csp).toContain('sandbox allow-scripts');                    // forced opaque origin
    expect(csp).toContain("connect-src 'none'");                       // but it can reach nothing
    // The header replaces the gateway policy, so it keeps the platform's framing rule: only the lab's
    // own pages may frame it (the gateway default is frame-ancestors 'none'), never another site.
    expect(csp).toMatch(/(^|;\s*)frame-ancestors 'self'(;|$)/);
    // The in-document <meta> copy omits both: browsers ignore them there and log the ignored sandbox
    // as a console error on every load.
    const meta = (r.text.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
    expect(meta).toContain("connect-src 'none'");
    expect(meta).not.toMatch(/sandbox|frame-ancestors/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    // the bootstrap that reports ready and renders the posted target HTML
    expect(r.text).toContain("type: 'ready'");
    expect(r.text).toContain("d.type !== 'render'");
  });

  it('TR-26: the /internal/v1 summary is served with the hub internalToken and refused without it', async () => {
    const TOKEN = 'redteam-internal-token-redteam-internal-token';
    const iapp = createApp(new Store(null), undefined, { identity: fakeIdentity, appOrigin: ORIGIN, devLogin: false, internalToken: TOKEN });
    // Seed a run for Asha so the summary has something to report.
    await request(iapp).post('/api/labs/TR-RED-001/sessions').set(auth('Asha'));
    const uid = 'u_asha';
    expect((await request(iapp).get(`/internal/v1/users/${uid}/summary`)).status).toBe(401);
    expect((await request(iapp).get(`/internal/v1/users/${uid}/summary`).set('Authorization', 'Bearer nope')).status).toBe(401);
    const ok = await request(iapp).get(`/internal/v1/users/${uid}/summary`).set('Authorization', `Bearer ${TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.body.app).toBe('web-pentest');
    const started = ok.body.stats.find((x: any) => x.label === 'Engagements started');
    expect(started?.value).toBeGreaterThanOrEqual(1);
    expect(ok.body.items[0].url).toContain('/lab/'); // link back to this lab's mount (hub rewrites to /labs/redteam/)
  });

  it('BIZ-06: the run cap keeps the best completed run and the best-scoring run through a reset loop', async () => {
    const TOKEN = 'redteam-internal-token-redteam-internal-token';
    const store = new Store(null);
    const iapp = createApp(store, undefined, { identity: fakeIdentity, appOrigin: ORIGIN, devLogin: false, internalToken: TOKEN, ratePerMin: 0, rateIpPerMin: 0 });
    const summary = async () => (await request(iapp).get('/internal/v1/users/u_asha/summary').set('Authorization', `Bearer ${TOKEN}`)).body.totals;
    const reset = async (sid: string) => (await request(iapp).post(`/api/sessions/${sid}/reset`).set(auth('Asha')).send({ confirm: 'RESET' })).body.session.id as string;
    // Run 1: completed, but with two hints on every objective (a low score). Run 2: a cleaner run that
    // scores higher but never delivers its report. Both states come from the scripted solution.
    const hints = (l: Lab) => { for (const o of l.status.objectives) if (!o.locked) for (let i = 0; i < 2; i++) l.do('hint.request', { objectiveId: o.id }); };
    const done = new Lab(); solve.recon(done); solve.exploit(done); hints(done); solve.document(done); solve.remediate(done); hints(done); solve.report(done);
    const open = new Lab(); solve.recon(open); solve.exploit(open); solve.document(open); solve.remediate(open);
    expect(done.status.complete && !open.status.complete && open.status.score.percent > done.status.score.percent).toBe(true);
    const run1 = (await request(iapp).post('/api/labs/TR-RED-001/sessions').set(auth('Asha'))).body.session.id;
    store.commit(store.session(run1)!, done.state, null, null);
    const run2 = await reset(run1);
    store.commit(store.session(run2)!, open.state, null, null);
    let cur = await reset(run2);
    const before = await summary();
    expect(before).toMatchObject({ completed: 1, best: open.status.score.percent });
    for (let i = 0; i < 25; i++) cur = await reset(cur);
    const runs = store.sessionsOf('u_asha', 'TR-RED-001');
    expect(runs.length).toBe(20); // the cap still holds
    expect(runs.map(r => r.id).slice(0, 2)).toEqual([run1, run2]); // the best completed and the best run survive
    expect(await summary()).toMatchObject({ completed: 1, best: before.best });
    expect((await request(iapp).get(`/api/sessions/${run1}/report`).set(auth('Asha'))).body.meta.final).toBe(true);
  });

  it('a completed run archives on reset and starts a fresh one', async () => {
    const reset = await request(app).post(`/api/sessions/${sid}/reset`).set(auth('Asha')).send({ confirm: 'RESET' });
    expect(reset.status).toBe(200);
    expect(reset.body.session.id).not.toBe(sid);
    expect(reset.body.status.level).toBe(1);
    expect((await request(app).get(`/api/sessions/${sid}`).set(auth('Asha'))).body.session.status).toBe('archived');
  });
});
