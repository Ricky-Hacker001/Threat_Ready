import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { Store } from '../server/store';
import { fx, DOCS, auth, makeApp, ORIGIN, INTERNAL_TOKEN, fakeIdentity } from './helpers';
import { createApp } from '../server/app';
import { onboardIdentity } from '../server/identity';

let app: any, tokA: string, tokB: string, sid: string, n = 0;
const rid = () => `req-${Date.now()}-${n++}`;
const act = (t: string, s: string, type: string, params: any = {}, requestId = rid()) => request(app).post(`/api/sessions/${s}/actions`).set(auth(t)).send({ type, params, requestId });
const BPA = { bucket: DOCS, config: { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true } };

beforeEach(async () => {
  app = makeApp(new Store(null));
  tokA = 'Asha';
  tokB = 'Bharat';
  sid = (await request(app).post('/api/labs/TR-CLOUD-001/sessions').set(auth(tokA))).body.session.id;
});

describe('API security', () => {
  it('requires authentication', async () => { expect((await request(app).get(`/api/sessions/${sid}`)).status).toBe(401); expect((await request(app).get(`/api/sessions/${sid}`).set({ Authorization: 'Bearer nope' })).status).toBe(401); });
  it("a learner cannot read or modify another learner's session", async () => {
    expect((await request(app).get(`/api/sessions/${sid}`).set(auth(tokB))).status).toBe(404);
    expect((await act(tokB, sid, 's3.putPublicAccessBlock', BPA)).status).toBe(404);
    expect((await request(app).get(`/api/sessions/${sid}/report`).set(auth(tokB))).status).toBe(404);
    expect((await request(app).post(`/api/sessions/${sid}/reset`).set(auth(tokB)).send({ confirm: 'RESET' })).status).toBe(404);
    const own = await request(app).get(`/api/sessions/${sid}`).set(auth(tokA)); expect(own.body.cloud.s3.buckets[DOCS].blockPublicAccess.restrictPublicBuckets).toBe(false);
  });
  it('forged objective completions and state writes are rejected', async () => {
    for (const type of ['objective.complete', 'finding.verify', 'state.set', 'level.set']) { const r = await act(tokA, sid, type, { id: 'V2.fix', findingId: 'V2', level: 4 }); expect(r.body.ok).toBe(false); expect(r.body.code).toBe('UnknownAction'); }
    const r = await request(app).post(`/api/sessions/${sid}/actions`).set(auth(tokA)).send({ type: 'finding.report', params: { findingId: 'V2', resource: `s3/bucket/${DOCS}`, verified: true, discovered: true }, requestId: rid(), state: { level: 4 }, status: { complete: true } });
    expect(r.body.code).toBe('EvidenceRequired'); expect(r.body.status.level).toBe(1); expect(r.body.status.objectives.filter((o: any) => o.done)).toHaveLength(0);
  });
  it('repeated requests are idempotent and do not corrupt state', async () => {
    const id = rid(); const a = await act(tokA, sid, 'ec2.addIngressRule', { groupId: fx.SG_INT, port: 6379, source: '10.0.0.0/16' }, id); const b = await act(tokA, sid, 'ec2.addIngressRule', { groupId: fx.SG_INT, port: 6379, source: '10.0.0.0/16' }, id);
    expect(a.body.ok).toBe(true); expect(b.body.replayed).toBe(true); expect(b.body.cloud.ec2.securityGroups[fx.SG_INT].inbound).toHaveLength(2); expect(b.body.cloud.rev).toBe(a.body.cloud.rev);
    const c = await act(tokA, sid, 'ec2.addIngressRule', { groupId: fx.SG_INT, port: 6379, source: '10.0.0.0/16' }); expect(c.body.code).toBe('InvalidPermission.Duplicate');
    expect((await request(app).get(`/api/sessions/${sid}/activity`).set(auth(tokA))).body.total).toBe(2);
  });
  it('API responses never contain hidden solutions or secret values', async () => {
    await act(tokA, sid, 'secrets.create', { name: 'a/b', value: 'topsecret-value-123' });
    const bodies = [await request(app).get(`/api/sessions/${sid}`).set(auth(tokA)), await request(app).get('/api/labs/TR-CLOUD-001').set(auth(tokA)), await request(app).get(`/api/sessions/${sid}/activity`).set(auth(tokA)), await request(app).get(`/api/sessions/${sid}/report`).set(auth(tokA))].map(r => JSON.stringify(r.body)).join('');
    for (const leak of ['topsecret-value-123', '"truth"', '"current":"ncpg', 'stolenValue', 'pg_SYNTHETIC_db_master', 'Block Public Access settings neutralise']) expect(bodies).not.toContain(leak);
    expect((await act(tokA, sid, 'secrets.getValue', { name: 'a/b' })).body.result.value).toBe('topsecret-value-123'); // explicit, audited retrieval only
  });
  it('rejects malformed requests', async () => {
    expect((await request(app).post(`/api/sessions/${sid}/actions`).set(auth(tokA)).send({ type: 'inspect' })).status).toBe(400);
    expect((await request(app).post(`/api/sessions/${sid}/actions`).set(auth(tokA)).set('Content-Type', 'application/json').send('{oops')).status).toBe(400);
  });
  it('prototype names are neither replayed requests nor labs', async () => {
    for (const requestId of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
      const r = await act(tokA, sid, 'incident.acknowledge', {}, requestId);
      expect(r.status).toBe(200); expect(r.body.replayed).toBeUndefined(); expect(r.body.ok).toBe(true);
    }
    expect((await request(app).get('/api/labs/constructor').set(auth(tokA))).status).toBe(404);
    expect((await request(app).post('/api/labs/__proto__/sessions').set(auth(tokA))).status).toBe(404);
    const r = await act(tokA, sid, 'iam.simulate', { principal: 'arn:aws:iam::123456789012:user/constructor', action: 's3:GetObject', resource: '*' });
    expect(r.status).toBe(200); expect(r.body.ok).toBe(false);
  });
  it('rate-limits per user and per IP with 429 + Retry-After in the API error shape', async () => {
    const limited = createApp(new Store(null), undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', ratePerMin: 2, rateIpPerMin: 1000 });
    expect((await request(limited).get('/api/labs').set(auth(tokA))).status).toBe(200);
    expect((await request(limited).get('/api/labs').set(auth(tokA))).status).toBe(200);
    const r = await request(limited).get('/api/labs').set(auth(tokA));
    expect(r.status).toBe(429); expect(Number(r.headers['retry-after'])).toBeGreaterThan(0); expect(r.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect((await request(limited).get('/api/labs').set(auth(tokB))).status).toBe(200);
    const byIp = createApp(new Store(null), undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', ratePerMin: 1000, rateIpPerMin: 1 });
    expect((await request(byIp).get('/api/labs').set({ 'x-threatready-client-ip': '203.0.113.1' })).status).toBe(401);
    expect((await request(byIp).get('/api/labs').set({ 'x-threatready-client-ip': '203.0.113.1' })).status).toBe(429);
    expect((await request(byIp).get('/api/labs').set({ 'x-threatready-client-ip': '203.0.113.2' })).status).toBe(401);
  });
  it('hosted labs share the limiter: API calls count, pages and assets do not', async () => {
    const hits: string[] = [];
    const hosted = createApp(new Store(null), undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', ratePerMin: 2, rateIpPerMin: 1000,
      hosted: [{ slug: 'soc', handler: (req, res) => { hits.push(req.url); res.json({ ok: true }); } }] });
    for (let i = 0; i < 5; i++) expect((await request(hosted).get('/soc/assets/app.js').set(auth(tokA))).status).toBe(200);
    expect((await request(hosted).get('/soc/api/cases').set(auth(tokA))).status).toBe(200);
    expect((await request(hosted).get('/soc/api/cases').set(auth(tokA))).status).toBe(200);
    const r = await request(hosted).get('/soc/api/cases').set(auth(tokA));
    expect(r.status).toBe(429); expect(r.body).toMatchObject({ error: 'rate_limited' }); expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(hits.filter(u => u.startsWith('/api/'))).toHaveLength(2);
  });
});

describe('session lifecycle', () => {
  it('reset restores the original scenario and archives the prior run', async () => {
    await act(tokA, sid, 's3.putPublicAccessBlock', BPA);
    expect((await request(app).post(`/api/sessions/${sid}/reset`).set(auth(tokA)).send({})).status).toBe(400);
    const r = await request(app).post(`/api/sessions/${sid}/reset`).set(auth(tokA)).send({ confirm: 'RESET' });
    expect(r.body.session.run).toBe(2); expect(r.body.cloud.s3.buckets[DOCS].blockPublicAccess.restrictPublicBuckets).toBe(false); expect(r.body.cloud.rev).toBe(0);
    const runs = (await request(app).get('/api/labs/TR-CLOUD-001/runs').set(auth(tokA))).body; expect(runs.map((x: any) => x.status)).toEqual(['archived', 'active']);
    expect((await act(tokA, sid, 'incident.acknowledge')).status).toBe(409); // archived runs are read-only
    expect((await request(app).get(`/api/sessions/${sid}/report`).set(auth(tokA))).status).toBe(200);
  });
  it('progress persists across server restarts', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trlab-')), 'store.json');
    let a = makeApp(new Store(file)); const tok = 'Persist';
    const s = (await request(a).post('/api/labs/TR-CLOUD-001/sessions').set(auth(tok))).body.session.id;
    await request(a).post(`/api/sessions/${s}/actions`).set(auth(tok)).send({ type: 'incident.acknowledge', params: {}, requestId: rid() });
    a = makeApp(new Store(file));
    const again = await request(a).post('/api/labs/TR-CLOUD-001/sessions').set(auth(tok)); expect(again.body.session.id).toBe(s); expect(again.body.status.incident.acknowledged).toBe(true);
  });
  it('CloudTrail history is paginated and searchable', async () => {
    const p1 = (await request(app).get(`/api/sessions/${sid}/cloudtrail?size=5`).set(auth(tokA))).body; expect(p1.total).toBe(17); expect(p1.rows).toHaveLength(5); expect(p1.rows[0].name).toBe('StopLogging');
    expect((await request(app).get(`/api/sessions/${sid}/cloudtrail?q=198.51.100.77`).set(auth(tokA))).body.total).toBe(7);
  });
});

describe('platform: identity from onboard, catalog, internal API', () => {
  it('needs a ThreatReady session: none → 401, onboard down → 503, trial → account required', async () => {
    const none = await request(app).get('/api/me'); expect(none.status).toBe(401); expect(none.body.code).toBe('AUTH_REQUIRED');
    const down = await request(app).get('/api/me').set(auth('down')); expect(down.status).toBe(503); expect(down.body.code).toBe('AUTH_PROVIDER_UNAVAILABLE');
    const trial = await request(app).get('/api/labs').set(auth('trial-user')); expect(trial.status).toBe(403); expect(trial.body.code).toBe('AUTH_ACCOUNT_REQUIRED');
    const me = await request(app).get('/api/me').set(auth('Asha')); expect(me.status).toBe(200); expect(me.body).toMatchObject({ id: 'u_asha', name: 'Asha' });
  });
  it('refuses state changes from another origin (cookie sessions need the Origin check)', async () => {
    const r = await request(app).post(`/api/sessions/${sid}/actions`).set({ ...auth('Asha'), Origin: 'https://evil.example' }).send({ type: 'incident.acknowledge', params: {}, requestId: rid() });
    expect(r.status).toBe(403);
    const none = await request(app).post(`/api/sessions/${sid}/actions`).set({ Cookie: 'tr.session_token=Asha' }).send({ type: 'incident.acknowledge', params: {}, requestId: rid() });
    expect(none.status).toBe(403);
  });
  it('lists the catalog with this learner\'s progress', async () => {
    const labs = (await request(app).get('/api/labs').set(auth('Asha'))).body;
    const cloud = labs.find((l: any) => l.id === 'TR-CLOUD-001');
    expect(cloud).toMatchObject({ available: true, progress: { runs: 1, status: 'In progress', level: 1 } });
    expect(labs.filter((l: any) => !l.available).length).toBeGreaterThan(0);
    const other = (await request(app).get('/api/labs').set(auth('Bharat'))).body.find((l: any) => l.id === 'TR-CLOUD-001');
    expect(other.progress).toBeNull();
  });
  describe('internal API', () => {
    const bearer = { Authorization: `Bearer ${INTERNAL_TOKEN}` };
    it('requires the internal token; a browser session is not enough', async () => {
      expect((await request(app).get('/internal/v1/users/u_asha/summary')).status).toBe(401);
      expect((await request(app).get('/internal/v1/users/u_asha/summary').set({ Authorization: 'Bearer wrong' })).status).toBe(401);
      expect((await request(app).get('/internal/v1/users/u_asha/summary').set(auth('Asha'))).status).toBe(401);
    });
    it("summarises one user's runs with links back to the lab", async () => {
      const r = await request(app).get('/internal/v1/users/u_asha/summary').set(bearer);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ app: 'labs', aiUsage: null });
      expect(r.body.items).toHaveLength(1);
      expect(r.body.items[0]).toMatchObject({ id: sid, url: `${ORIGIN}/labs/TR-CLOUD-001` });
      expect(r.body.stats.find((s: any) => s.label === 'Labs started').value).toBe(1);
      const other = await request(app).get('/internal/v1/users/u_bharat/summary').set(bearer);
      expect(other.body.items).toEqual([]);
    });
    it('reports no AI usage (labs make no LLM calls)', async () => {
      const r = await request(app).get('/internal/v1/ai-usage?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z').set(bearer);
      expect(r.body).toEqual({ app: 'labs', users: [], byModel: [], byFeature: [] });
    });
  });
});

describe('onboard identity resolver', () => {
  const startOnboard = () => new Promise<{ url: string; calls: string[]; release: () => void; close: () => void }>((resolve) => {
    const calls: string[] = []; let pending: (() => void)[] = [];
    const server = http.createServer((req, res) => {
      const cookie = String(req.headers.cookie || '');
      calls.push(cookie);
      const answer = () => {
        if (cookie.includes('good')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ user: { id: 'u_good', name: 'Good', isTrial: false } })); }
        else { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}'); }
      };
      if (cookie.includes('slow')) pending.push(answer); else answer();
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, calls, release: () => { for (const p of pending) p(); pending = []; }, close: () => server.close() }));
  });
  it('caches negative answers for a while, coalesces identical lookups and caps in-flight lookups', async () => {
    const onboard = await startOnboard();
    try {
      const identity = onboardIdentity({ identityUrl: onboard.url, internalToken: INTERNAL_TOKEN, maxInFlight: 5 });
      // A bad cookie hits onboard once, then is answered from the negative cache.
      for (let i = 0; i < 5; i++) expect((await identity({ cookie: 'tr.session_token=bad' })).ok).toBe(false);
      expect(onboard.calls.filter(c => c.includes('bad'))).toHaveLength(1);
      // A good cookie is cached positively.
      for (let i = 0; i < 3; i++) expect((await identity({ cookie: 'tr.session_token=good' })).ok).toBe(true);
      expect(onboard.calls.filter(c => c.includes('good'))).toHaveLength(1);
      // Concurrent lookups for one cookie share a single request; beyond the in-flight cap callers get "unavailable" instead of queueing.
      const same = Promise.all(Array.from({ length: 4 }, () => identity({ cookie: 'tr.session_token=slow-a' })));
      const others = Promise.all(Array.from({ length: 6 }, (_, i) => identity({ cookie: `tr.session_token=slow-${i}` })));
      await new Promise(r => setTimeout(r, 50));
      onboard.release();
      expect((await same).every(r => r.ok === false && r.reason === 'signed-out')).toBe(true);
      const o = await others;
      expect(o.filter(r => r.ok === false && r.reason === 'unavailable').length).toBeGreaterThanOrEqual(1);
      expect(onboard.calls.filter(c => c.includes('slow-a'))).toHaveLength(1);
      expect(onboard.calls.filter(c => c.includes('slow')).length).toBeLessThanOrEqual(5);
    } finally { onboard.close(); }
  });
});
