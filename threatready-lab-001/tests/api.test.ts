import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { Store } from '../server/store';
import { fx, DOCS, auth, makeApp, ORIGIN, INTERNAL_TOKEN, fakeIdentity, Lab, steps } from './helpers';
import { createApp } from '../server/app';
import { onboardIdentity, plausibleSessionCookie } from '../server/identity';
import { startOnboard, sessionCookie } from './helpers';

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
  it('a body the JSON parser refuses is a 4xx, never a 500 with a stack in the log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const post = () => request(app).post(`/api/sessions/${sid}/actions`).set(auth(tokA)).set('Content-Type', 'application/json');
      expect((await post().send(JSON.stringify({ type: 'inspect', pad: 'x'.repeat(70 * 1024) }))).status).toBe(400);
      const enc = await post().set('Content-Encoding', 'compress').send('{}'); expect(enc.status).toBe(415); expect(enc.body.error).toBe('Invalid request body.');
      expect((await post().set('Content-Type', 'application/json; charset=x-unknown').send('{}')).status).toBe(415);
      const param = await request(app).get('/api/sessions/%E0%A4%A/report').set(auth(tokA)); expect(param.status).toBe(400); expect(param.body.error).toBe('Invalid request.');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('prototype names are neither replayed requests nor labs', async () => {
    for (const requestId of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
      const r = await act(tokA, sid, 'incident.acknowledge', {}, requestId);
      expect(r.status).toBe(200); expect(r.body.replayed).toBeUndefined(); expect(r.body.ok).toBe(true);
    }
    // "__proto__" is an ordinary request id: a retry is replayed, not run again, and the session's prototype is untouched.
    const rev = (await request(app).get(`/api/sessions/${sid}`).set(auth(tokA))).body.cloud.rev;
    const again = await act(tokA, sid, 'incident.acknowledge', {}, '__proto__');
    expect(again.body.replayed).toBe(true); expect(again.body.cloud.rev).toBe(rev);
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
    // Express matches routes in any case: every spelling of the lab's API counts, so none slips past the limit.
    for (const u of ['/soc/API/cases', '/soc/Api/cases', '/SOC/api/cases', '/soc/api', '/soc/API']) {
      const x = await request(hosted).get(u).set(auth(tokA));
      expect(x.status, u).toBe(429); expect(x.body.message).toMatch(/Try again in \d+s/);
    }
    expect(hits.filter(u => /^\/api(\/|$)/i.test(u))).toHaveLength(2);
  });
  it('learners behind one NAT address are limited per learner, not as one client; unknown cookies still pay per IP', async () => {
    const onboard = await startOnboard();
    try {
      const identity = onboardIdentity({ identityUrl: onboard.url, internalToken: INTERNAL_TOKEN });
      const hits: string[] = [];
      const nat = createApp(new Store(null), undefined, { identity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', ratePerMin: 120, rateIpPerMin: 100,
        hosted: [{ slug: 'soc', handler: (req, res) => { hits.push(req.url); res.json({ ok: true }); } }] });
      const ip = { 'x-threatready-client-ip': '203.0.113.50' };
      // 40 learners sign in (one session lookup each, paid by the shared address)...
      for (let i = 0; i < 40; i++) expect((await request(nat).get('/api/me').set({ ...ip, Cookie: sessionCookie(`learner${i}`) })).status).toBe(200);
      // ...then work: 10 requests each across the hub and a hosted lab, 400 from one address in all. None is refused.
      const codes: number[] = [];
      for (let round = 0; round < 5; round++) for (let i = 0; i < 40; i++) {
        codes.push((await request(nat).get('/api/labs').set({ ...ip, Cookie: sessionCookie(`learner${i}`) })).status);
        codes.push((await request(nat).get('/soc/api/cases').set({ ...ip, Cookie: sessionCookie(`learner${i}`) })).status);
      }
      expect(codes.filter(c => c !== 200)).toEqual([]);
      expect(onboard.calls.length).toBe(40);
      // Cookies the resolver does not know (random sessions) are charged per IP before any lookup: onboard sees at most the IP budget.
      const before = onboard.calls.length; const junk: number[] = [];
      for (let i = 0; i < 150; i++) junk.push((await request(nat).get(i % 2 ? '/api/labs' : '/soc/api/cases').set({ 'x-threatready-client-ip': '198.51.100.66', Cookie: sessionCookie(`forged${i}`) })).status);
      // (The 100/min bucket refills a little while the test runs.)
      expect(junk.filter(c => c === 429).length).toBeGreaterThanOrEqual(35);
      expect(onboard.calls.length - before).toBeLessThanOrEqual(115);
      expect(onboard.calls.length - before).toBe(junk.filter(c => c !== 429).length);
    } finally { onboard.close(); }
  }, 60_000);
});

describe('completed runs are read-only on the server', () => {
  it('every action on a completed run is refused, and nothing about the run changes', async () => {
    const store = new Store(null); const a = makeApp(store);
    const s = (await request(a).post('/api/labs/TR-CLOUD-001/sessions').set(auth(tokA))).body.session.id;
    // Levels 1-3 done; the report is submitted without reviewing the logs (L4.logs not done).
    const l = new Lab(); steps.level1(l); steps.level2(l); steps.level3(l);
    l.ok('l4.triage', { alertId: 'AL-1', classification: 'blocked-attempt' }); l.ok('l4.triage', { alertId: 'AL-2', classification: 'expected-activity' }); l.ok('l4.triage', { alertId: 'AL-3', classification: 'confirmed-incident' });
    const lv4 = new Lab(); steps.level1(lv4); steps.level2(lv4); steps.level3(lv4); steps.level4(lv4);
    l.ok('l4.submitReport', lv4.state.sim.report.input);
    store.commit(store.session(s)!, l.state, null, null);
    const before = (await request(a).get(`/api/sessions/${s}`).set(auth(tokA))).body;
    expect(before.status.complete).toBe(true); expect(before.status.objectives.find((o: any) => o.id === 'L4.logs').done).toBe(false);
    const summary = async () => (await request(a).get('/internal/v1/users/u_asha/summary').set({ Authorization: `Bearer ${INTERNAL_TOKEN}` })).body.stats.find((x: any) => x.label === 'Best score').value;
    const best = await summary(); const at = store.session(s)!.updatedAt; const stored = JSON.stringify(store.session(s)!.state);
    for (const [type, params] of [['inspect', { key: 'cloudwatch/log/ci/aerocart-storefront-build/build-482#events' }], ['inspect', { key: 'cloudwatch/log//var/log/auth/ac-app-server/sshd#events' }], ['hint.request', { objectiveId: 'L4.logs' }], ['evidence.add', { eventId: 'evt-0001' }], ['s3.accessTest', { bucket: DOCS, key: 'x', principal: 'anonymous', operation: 'GET' }], ['l3.regression', {}], ['s3.putBucketPolicy', { bucket: DOCS, document: null }], ['no.such.action', {}]] as const) {
      const r = await request(a).post(`/api/sessions/${s}/actions`).set(auth(tokA)).send({ type, params, requestId: rid() });
      expect(r.status, type).toBe(200); expect(r.body).toMatchObject({ ok: false, code: 'LabComplete' }); expect(r.body.status.complete).toBe(true);
      expect(r.body.status.minutes).toBe(before.status.minutes); expect(r.body.status.score.total).toBe(before.status.score.total);
    }
    expect(JSON.stringify(store.session(s)!.state)).toBe(stored); expect(store.session(s)!.updatedAt).toBe(at);
    expect(await summary()).toBe(best);
    expect((await request(a).get('/api/labs').set(auth(tokA))).body.find((x: any) => x.id === 'TR-CLOUD-001').progress.score).toBe(before.status.score.total);
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
  it('archived runs drop their replay records (never read again), also from older data files', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trlab-')), 'store.json');
    const store = new Store(file); const a = makeApp(store); const tok = 'Archiver';
    const s = (await request(a).post('/api/labs/TR-CLOUD-001/sessions').set(auth(tok))).body.session.id;
    for (let i = 0; i < 3; i++) await request(a).post(`/api/sessions/${s}/actions`).set(auth(tok)).send({ type: 'incident.acknowledge', params: {}, requestId: rid() });
    expect(Object.keys(store.session(s)!.requests)).toHaveLength(3);
    const next = (await request(a).post(`/api/sessions/${s}/reset`).set(auth(tok)).send({ confirm: 'RESET' })).body.session.id;
    expect(store.session(s)!.requests).toEqual({});
    // A file written before this change still holds them: they are dropped on load.
    const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.sessions[s].requests = { 'req-old-0001': { ok: true } };
    data.sessions[next].requests = { 'req-live-0001': { ok: true } }; fs.writeFileSync(file, JSON.stringify(data));
    const reloaded = new Store(file);
    expect(reloaded.session(s)!.requests).toEqual({}); expect(Object.keys(reloaded.session(next)!.requests)).toEqual(['req-live-0001']);
  });
  it('keeps the most recent runs and the best one; run numbers keep counting', async () => {
    const store = new Store(null);
    const a = createApp(store, undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', maxRunsPerLab: 3 });
    let cur = (await request(a).post('/api/labs/TR-CLOUD-001/sessions').set(auth('Runner'))).body.session.id;
    // Run 1 is the best: acknowledged and level 1 done.
    const l = new Lab(); steps.level1(l); store.commit(store.session(cur)!, l.state, null, null); const bestId = cur;
    for (let i = 0; i < 5; i++) cur = (await request(a).post(`/api/sessions/${cur}/reset`).set(auth('Runner')).send({ confirm: 'RESET' })).body.session.id;
    const runs = (await request(a).get('/api/labs/TR-CLOUD-001/runs').set(auth('Runner'))).body;
    expect(runs.map((r: any) => r.run)).toEqual([1, 5, 6]);
    expect(runs[0].id).toBe(bestId); expect(runs[2]).toMatchObject({ id: cur, status: 'active' });
    expect((await request(a).get('/api/labs/TR-CLOUD-001').set(auth('Runner'))).body.maxRuns).toBe(3);
  });
  it('keeps the best completed run too: an incomplete run that scores higher does not push a completion out', async () => {
    const store = new Store(null);
    const a = createApp(store, undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', maxRunsPerLab: 3 });
    const U = 'Finisher'; const reset = async (s: string) => (await request(a).post(`/api/sessions/${s}/reset`).set(auth(U)).send({ confirm: 'RESET' })).body.session.id as string;
    const completed = async () => (await request(a).get('/internal/v1/users/u_finisher/summary').set({ Authorization: `Bearer ${INTERNAL_TOKEN}` })).body.stats.find((x: any) => x.label === 'Labs completed').value;
    // Run 1 is completed with two hints on every objective (a low score); run 2 clears levels 1-3 cleanly without the report (a higher one).
    const hints = (l: Lab) => { for (const o of l.status.objectives) if (!o.locked && !o.done) { l.do('hint.request', { objectiveId: o.id }); l.do('hint.request', { objectiveId: o.id }); } };
    const l1 = new Lab(); hints(l1); steps.level1(l1); hints(l1); steps.level2(l1); hints(l1); steps.level3(l1); hints(l1); steps.level4(l1);
    const l2 = new Lab(); steps.level1(l2); steps.level2(l2); steps.level3(l2);
    expect(l1.status.complete).toBe(true); expect(l2.status.complete).toBe(false); expect(l2.status.score.total).toBeGreaterThan(l1.status.score.total);
    let cur = (await request(a).post('/api/labs/TR-CLOUD-001/sessions').set(auth(U))).body.session.id; const done = cur;
    store.commit(store.session(cur)!, l1.state, null, null);
    cur = await reset(cur); store.commit(store.session(cur)!, l2.state, null, null); const best = cur;
    expect(await completed()).toBe(1);
    for (let i = 0; i < 4; i++) cur = await reset(cur);
    const runs = (await request(a).get('/api/labs/TR-CLOUD-001/runs').set(auth(U))).body;
    expect(runs.map((r: any) => r.run)).toEqual([1, 2, 6]);
    expect(runs.map((r: any) => r.id)).toEqual([done, best, cur]); expect(runs[0].complete).toBe(true);
    expect(await completed()).toBe(1);
    const report = await request(a).get(`/api/sessions/${done}/report`).set(auth(U)); expect(report.status).toBe(200); expect(report.body.meta.final).toBe(true);
  });
  it('a data file that does not parse is kept aside, not overwritten', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trlab-')); const file = path.join(dir, 'store.json');
    fs.writeFileSync(file, '{"sessions": {"x": '); // cut off mid-write
    const a = makeApp(new Store(file));
    await request(a).post('/api/labs/TR-CLOUD-001/sessions').set(auth('Fresh'));
    const aside = fs.readdirSync(dir).filter(f => f.startsWith('store.json.corrupt-'));
    expect(aside).toHaveLength(1); expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toBe('{"sessions": {"x": ');
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).sessions)).toHaveLength(1);
    fs.writeFileSync(file, '[]'); new Store(file); // valid JSON, but not a store
    expect(fs.readdirSync(dir).filter(f => f.startsWith('store.json.corrupt-')).length).toBe(2);
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
    it('folds in the progress of hosted labs with their own server, and does not wait on a slow one', async () => {
      const item = (id: string, at: string, score: number | null) => ({ id, title: `SOC Simulation · F1 ${id}`, status: 'Passed', score, at, url: `${ORIGIN}/labs/soc/#/case/${id}` });
      const hosted = createApp(new Store(null), undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', hosted: [
        { slug: 'soc', handler: (_q, r) => { r.end(); }, summary: async (u) => (u === 'u_asha' ? { started: true, completed: false, best: 88, inProgress: 1, runs: 3, items: [item('att_1', '2099-01-01T00:00:00.000Z', 88), item('att_0', '2000-01-01T00:00:00.000Z', 40)] } : null) },
        { slug: 'redteam', handler: (_q, r) => { r.end(); }, summary: async () => ({ started: true, completed: true, best: 70, inProgress: 0, runs: 1, findingsVerified: 4, items: [] }) },
        { slug: 'slow', handler: (_q, r) => { r.end(); }, summary: () => new Promise(() => {}) },
        { slug: 'broken', handler: (_q, r) => { r.end(); }, summary: async () => { throw new Error('down'); } },
        { slug: 'static', dir: '/nonexistent' },
      ] });
      await request(hosted).post('/api/labs/TR-CLOUD-001/sessions').set(auth(tokA));
      const t0 = Date.now();
      const r = await request(hosted).get('/internal/v1/users/u_asha/summary').set(bearer);
      expect(r.status).toBe(200); expect(Date.now() - t0).toBeLessThan(3000);
      const stat = (label: string) => r.body.stats.find((x: any) => x.label === label).value;
      expect(stat('Labs started')).toBe(3); expect(stat('Labs completed')).toBe(1); expect(stat('Best score')).toBe('88/100');
      expect(stat('In progress')).toBe(2); expect(stat('Total runs')).toBe(5); expect(stat('Findings verified')).toBe(4);
      expect(r.body.items[0].id).toBe('att_1'); expect(r.body.items[r.body.items.length - 1].id).toBe('att_0');
      // The catalog says where each lab keeps progress: with the account only while it outlives a restart.
      const labs = (await request(hosted).get('/api/labs').set(auth(tokA))).body;
      expect(labs.find((x: any) => x.id === 'TR-CLOUD-001')).toMatchObject({ progressIn: 'server', onProfile: true });
      expect(labs.find((x: any) => x.id === 'TR-SOC-001')).toMatchObject({ progressIn: 'server', onProfile: true });
      let durable = true;
      const mirrored = createApp(new Store(null), undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', durable: () => durable });
      expect((await request(mirrored).get('/api/labs').set(auth(tokA))).body.find((x: any) => x.id === 'TR-CLOUD-001')).toMatchObject({ progressIn: 'account' });
      durable = false; // the launcher's mirror stopped saving: asked per request
      expect((await request(mirrored).get('/api/labs').set(auth(tokA))).body.find((x: any) => x.id === 'TR-CLOUD-001')).toMatchObject({ progressIn: 'server' });
    });
    it('reports no AI usage (labs make no LLM calls)', async () => {
      const r = await request(app).get('/internal/v1/ai-usage?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z').set(bearer);
      expect(r.body).toEqual({ app: 'labs', users: [], byModel: [], byFeature: [] });
    });
  });
});

describe('onboard identity resolver', () => {
  it('caches negative answers for a while, coalesces identical lookups and caps in-flight lookups', async () => {
    const onboard = await startOnboard();
    try {
      const identity = onboardIdentity({ identityUrl: onboard.url, internalToken: INTERNAL_TOKEN, maxInFlight: 5, maxPerClient: 0 });
      // A bad cookie hits onboard once, then is answered from the negative cache.
      for (let i = 0; i < 5; i++) expect((await identity({ cookie: sessionCookie('bad') })).ok).toBe(false);
      expect(onboard.calls.filter(c => c.includes('bad'))).toHaveLength(1);
      // A good cookie is cached positively, and peek() then answers without a lookup.
      expect(identity.peek!({ cookie: sessionCookie('good') })).toBeNull();
      for (let i = 0; i < 3; i++) expect((await identity({ cookie: sessionCookie('good') })).ok).toBe(true);
      expect(onboard.calls.filter(c => c.includes('good'))).toHaveLength(1);
      expect(identity.peek!({ cookie: sessionCookie('good') })).toMatchObject({ id: 'u_good' });
      expect(identity.peek!({ cookie: sessionCookie('bad') })).toBeNull();
      // Concurrent lookups for one cookie share a single request; beyond the in-flight cap callers get "unavailable" instead of queueing.
      const same = Promise.all(Array.from({ length: 4 }, () => identity({ cookie: sessionCookie('slow-a') })));
      const others = Promise.all(Array.from({ length: 6 }, (_, i) => identity({ cookie: sessionCookie(`slow-${i}`) })));
      // Release once every admitted lookup has reached onboard (a loaded machine may take a while).
      for (let i = 0; i < 200 && onboard.active() < 5; i++) await new Promise(r => setTimeout(r, 10));
      await new Promise(r => setTimeout(r, 50));
      onboard.release();
      expect((await same).every(r => r.ok === false && r.reason === 'signed-out')).toBe(true);
      const o = await others;
      expect(o.filter(r => r.ok === false && r.reason === 'unavailable').length).toBeGreaterThanOrEqual(1);
      expect(onboard.calls.filter(c => c.includes('slow-a'))).toHaveLength(1);
      expect(onboard.calls.filter(c => c.includes('slow')).length).toBeLessThanOrEqual(5);
    } finally { onboard.close(); }
  });
  it('answers cookies that cannot hold a session without asking onboard', async () => {
    const onboard = await startOnboard();
    try {
      const identity = onboardIdentity({ identityUrl: onboard.url, internalToken: INTERNAL_TOKEN });
      const junk = ['', 'theme=dark', 'tr.session_token=good', 'tr.session_token=good.short=', `tr.session_token=good.${'A'.repeat(44)}`, `other=good.${'A'.repeat(43)}=`, `tr.session_token=%E0%A4%A.${'A'.repeat(43)}=`, `tr.session_token=go od.${'A'.repeat(43)}=`];
      for (const cookie of junk) expect(await identity({ cookie })).toMatchObject({ ok: false, reason: 'signed-out' });
      expect(onboard.calls).toHaveLength(0);
      expect(plausibleSessionCookie(sessionCookie('good'))).toBe(true);
      expect(plausibleSessionCookie(`theme=light; __Secure-tr.session_token=${encodeURIComponent(`abc.${'x'.repeat(43)}=`)}`)).toBe(true);
      expect((await identity({ cookie: `theme=light; ${sessionCookie('good')}` })).ok).toBe(true);
      expect(onboard.calls).toHaveLength(1);
    } finally { onboard.close(); }
  });
  it('one client cannot fill the global lookup cap: its extra lookups wait, others still resolve', async () => {
    const onboard = await startOnboard();
    try {
      const identity = onboardIdentity({ identityUrl: onboard.url, internalToken: INTERNAL_TOKEN, maxInFlight: 6, maxPerClient: 2 });
      // A flood of distinct, well-formed cookies from one address: at most two of its lookups run at once.
      const flood = Promise.all(Array.from({ length: 10 }, (_, i) => identity({ cookie: sessionCookie(`slow-f${i}`) }, '198.51.100.9')));
      for (let i = 0; i < 200 && onboard.active() < 2; i++) await new Promise(r => setTimeout(r, 10));
      await new Promise(r => setTimeout(r, 50));
      expect(onboard.calls.filter(c => c.includes('slow-f'))).toHaveLength(2);
      // Another learner is not refused for want of a slot.
      expect(await identity({ cookie: sessionCookie('good') }, '203.0.113.7')).toMatchObject({ ok: true, user: { id: 'u_good' } });
      let settled = false; flood.then(() => { settled = true; });
      for (let i = 0; i < 300 && !settled; i++) { onboard.release(); await new Promise(r => setTimeout(r, 10)); }
      const r = await flood;
      expect(onboard.peak()).toBeLessThanOrEqual(3);
      expect(r.filter(x => x.ok === false && x.reason === 'signed-out')).toHaveLength(10);
    } finally { onboard.close(); }
  });
  it('a classroom behind one NAT address opening the labs together (cold caches) gets no 503s', async () => {
    const onboard = await startOnboard({ latencyMs: 300 });
    try {
      // Default caps, the real app and a 300 ms onboard: 40 learners each load the catalog page, which
      // asks /api/me and /api/labs (and the shell /api/platform) at once.
      const identity = onboardIdentity({ identityUrl: onboard.url, internalToken: INTERNAL_TOKEN });
      const nat = createApp(new Store(null), undefined, { identity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173' });
      const ip = { 'x-threatready-client-ip': '203.0.113.50' };
      const calls = Array.from({ length: 40 }, (_, i) => ['/api/me', '/api/labs', '/api/platform'].map(u => request(nat).get(u).set({ ...ip, Cookie: sessionCookie(`learner${i}`) }))).flat();
      const codes = (await Promise.all(calls)).map(r => r.status);
      expect(codes.filter(c => c !== 200)).toEqual([]);
      // One lookup per learner: same-session calls share it, even while it waits for a slot.
      expect(onboard.calls).toHaveLength(40);
      expect(onboard.peak()).toBeLessThanOrEqual(16);
    } finally { onboard.close(); }
  }, 30_000);
  it('a junk-cookie flood from one address cannot fill the global cap; known sessions are never shed', async () => {
    const onboard = await startOnboard();
    try {
      const identity = onboardIdentity({ identityUrl: onboard.url, internalToken: INTERNAL_TOKEN, cacheSeconds: 0.05, maxInFlight: 20, maxPerClient: 4 });
      const flooder = '198.51.100.9';
      // A learner on the flooding address signs in first (confirmed by onboard).
      expect(await identity({ cookie: sessionCookie('good') }, flooder)).toMatchObject({ ok: true });
      // Hundreds of distinct, well-formed cookies that onboard never answers: 4 run, the rest wait or are refused.
      const flood = Array.from({ length: 200 }, (_, i) => identity({ cookie: sessionCookie(`slow-j${i}`) }, flooder));
      for (let i = 0; i < 200 && onboard.active() < 4; i++) await new Promise(r => setTimeout(r, 10));
      await new Promise(r => setTimeout(r, 80));
      expect(onboard.active()).toBe(4);
      // The cache entry has expired: the known learner's re-check is not shed behind the flood, even from that address.
      expect(await identity({ cookie: sessionCookie('good') }, flooder)).toMatchObject({ ok: true, user: { id: 'u_good' } });
      // Another address's new learner still finds a slot.
      expect(await identity({ cookie: sessionCookie('learner-x') }, '203.0.113.7')).toMatchObject({ ok: true });
      // Past the queue bound the flood is answered at once (a retryable 503), not kept waiting.
      const early = await Promise.race([Promise.all(flood.slice(4 + 4 * 16)), new Promise(r => setTimeout(() => r('timeout'), 100))]);
      expect(early).not.toBe('timeout');
      expect((early as any[]).every(x => x.ok === false && x.reason === 'unavailable')).toBe(true);
      // Onboard answers: the queued ones then run, four at a time; nothing is left hanging.
      let settled = false; const all = Promise.all(flood).then(r => { settled = true; return r; });
      for (let i = 0; i < 200 && !settled; i++) { onboard.release(); await new Promise(r => setTimeout(r, 10)); }
      const r = await all;
      expect(r.filter(x => x.ok === false && x.reason === 'signed-out').length).toBe(4 + 4 * 16);
      expect(onboard.peak()).toBeLessThanOrEqual(6);
    } finally { onboard.close(); }
  }, 30_000);
  it('keys the cache on the session token, not on the other cookies sent with it', async () => {
    const onboard = await startOnboard();
    try {
      const identity = onboardIdentity({ identityUrl: onboard.url, internalToken: INTERNAL_TOKEN });
      for (const extra of ['', 'tr-theme=dark; ', 'tr-theme=light; _ga=1; ']) expect(await identity({ cookie: `${extra}${sessionCookie('good')}` })).toMatchObject({ ok: true });
      expect(onboard.calls).toHaveLength(1);
      expect(identity.peek!({ cookie: `other=1; ${sessionCookie('good')}` })).toMatchObject({ id: 'u_good' });
      expect(await identity({ cookie: sessionCookie('good2') })).toMatchObject({ ok: true });
      expect(onboard.calls).toHaveLength(2);
    } finally { onboard.close(); }
  });
});
