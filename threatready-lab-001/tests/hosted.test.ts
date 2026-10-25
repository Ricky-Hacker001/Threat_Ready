// The hosted labs as they run inside ThreatReady: the real SOC simulation and Red Team lab mounted by
// loadHostedLabs behind the labs gate. Skipped when those labs are not built next to this app.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../server/store';
import { createApp, loadHostedLabs } from '../server/app';
import express from 'express';
import { SANDBOX_CSP, withoutSocSession } from '../server/hosted';
import { auth, fakeIdentity, INTERNAL_TOKEN, ORIGIN } from './helpers';

const root = path.resolve(import.meta.dirname, '../..');
const socIndex = path.join(root, 'soc', 'server', 'index.js');
const built = fs.existsSync(path.join(root, 'soc', 'client', 'dist', 'index.html')) && fs.existsSync(path.join(root, 'red_team_lab', 'web', 'dist', 'index.html'));
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
/** A soc_session cookie value as the SOC signs it (soc/server/auth.js sessionValue). */
const socCookie = (uid: string, secret: string) => { const body = b64u(JSON.stringify({ uid, name: uid, iat: Math.floor(Date.now() / 1000), h: 8 })); return `${body}.${b64u(crypto.createHmac('sha256', secret).update(body).digest())}`; };

describe('the SOC cookie strip reads names exactly as the SOC does', () => {
  it('drops every pair the SOC would read as soc_session, keeps the rest', () => {
    expect(withoutSocSession('a=1; soc_session=x; b=2')).toBe('a=1; b=2');
    for (const c of ['soc_session =x', ' soc_session=x', 'soc_session\t=x', '\tsoc_session  =x=y']) expect(withoutSocSession(`tr.session_token=t; ${c}`)).toBe('tr.session_token=t');
    expect(withoutSocSession('soc_sessionx=1;SOC_SESSION=2;=3;plain')).toBe('soc_sessionx=1;SOC_SESSION=2;=3;plain');
    expect(withoutSocSession(undefined)).toBe('');
  });
});

describe('a lab that runs learner code: only its sandbox.html may eval (TR-16)', () => {
  // A built lab with a sandbox (as DevSecOps-Simulation/dist), behind the gateway's page policy or none.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trlab-sandbox-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head></head><body>lab</body></html>');
  fs.writeFileSync(path.join(dir, 'sandbox.html'), '<!doctype html><html><body>sandbox</body></html>');
  const GATEWAY_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'";
  const labs = createApp(new Store(null), undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', hosted: [{ slug: 'devsecops', dir, allowEval: true }, { slug: 'plain', dir }], rateIpPerMin: 0, ratePerMin: 0 });
  const gateway = express().use((_req, res, next) => { res.setHeader('Content-Security-Policy', GATEWAY_CSP); next(); }, labs);
  const page = { ...auth('Asha'), Accept: 'text/html' };

  it('the lab page keeps the gateway policy, with same-origin frames and no eval', async () => {
    const r = await request(gateway).get('/devsecops/').set(page);
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain("frame-src 'self' https://challenges.cloudflare.com");
    expect(r.headers['content-security-policy']).not.toContain("'unsafe-eval'");
  });

  it('sandbox.html is sandboxed under every spelling, with or without a policy in front', async () => {
    for (const app of [gateway, labs]) {
      for (const p of ['/devsecops/sandbox.html', '/devsecops//sandbox.html', '/devsecops/sandbox%2Ehtml', '/devsecops/sandbox%2ehtml']) {
        const r = await request(app).get(p).set(page);
        expect(r.status, p).toBe(200);
        const csp = String(r.headers['content-security-policy']);
        expect(csp, p).toBe(SANDBOX_CSP);
        expect(csp).toContain("default-src 'none'"); expect(csp).toContain('sandbox allow-scripts'); expect(csp).toContain("frame-ancestors 'self'");
        expect(csp).not.toContain('allow-same-origin');
      }
    }
  });

  it('a lab that runs no learner code never gets the eval policy', async () => {
    const r = await request(gateway).get('/plain/sandbox.html').set(page);
    expect(r.headers['content-security-policy']).toBe(GATEWAY_CSP);
  });
});

describe.skipIf(!built)('hosted SOC and Red Team behind the labs gate', () => {
  let app: any; let soc: any;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trlab-hosted-'));
  beforeAll(async () => {
    // The SOC reads its configuration once, at import: development defaults, no test hooks.
    Object.assign(process.env, { SOC_SESSION_SECRET: '', SIM_SESSION_SECRET: '', DEV_USER: '', SOC_SIM_TEST: '', SOC_SIM_FAST: '1', TR_SIM_SECRET: '' });
    const hosted = await loadHostedLabs(root, { catalogUrl: `${ORIGIN}/labs/`, socDataFile: path.join(dir, 'soc', 'cases.json'), redTeamDataFile: path.join(dir, 'redteam.json'), identity: fakeIdentity, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', internalToken: INTERNAL_TOKEN });
    soc = await import(pathToFileURL(socIndex).href); // the same module instance the labs server mounted
    app = createApp(new Store(path.join(dir, 'labs.json')), undefined, { identity: fakeIdentity, internalToken: INTERNAL_TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', hosted, rateIpPerMin: 0, ratePerMin: 0 });
  }, 60_000);

  it('a SOC session cookie, issued by the SOC itself or forged, never replaces the platform user', async () => {
    // A genuine SOC-signed cookie from the standalone name sign-in (what the hosted route used to issue).
    const issued = await request(soc.app).post('/api/session/local').send({ name: 'Detached' });
    expect(issued.status).toBe(200);
    const value = decodeURIComponent(/soc_session=([^;]+)/.exec(String(issued.headers['set-cookie']))![1]);
    expect((await request(soc.app).get('/api/me').set('Cookie', `soc_session=${encodeURIComponent(value)}`)).body.uid).toMatch(/^local_/);
    const forged = socCookie('tr_victim999', 'dev-only-session-secret-change-me'); // valid for the SOC's development secret
    for (const c of [`soc_session=${value}`, `soc_session =${value}`, `soc_session\t=${value}`, ` soc_session = ${value}`, `soc_session =${forged}`, `soc_session=${forged}`]) {
      const me = await request(app).get('/soc/api/me').set({ ...auth('Asha'), Cookie: `${auth('Asha').Cookie}; ${c}` });
      expect(me.status, c).toBe(200); expect(me.body.uid, c).toBe('tr_u_asha');
    }
  });

  it('inside ThreatReady the SOC issues no session of its own', async () => {
    for (const p of ['/soc/api/session/local', '/soc/api/session', '/soc/api/session/logout']) {
      const r = await request(app).post(p).set(auth('Asha')).send({ name: 'Second identity', token: 'x' });
      expect(r.status, p).toBe(404); expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect((await request(app).get('/soc/api/session/info').set(auth('Asha'))).body).toMatchObject({ signedIn: true, hosted: true, dailyWipe: false });
    // The per-user open-attempt cap holds across cookie replays.
    const u = auth('Capped'); const cookie = `${u.Cookie}; soc_session =${socCookie('local_other', 'dev-only-session-secret-change-me')}`;
    for (const sid of ['F1', 'F2', 'F3']) expect((await request(app).post('/soc/api/attempts').set(u).send({ scenarioId: sid })).status).toBe(201);
    const fourth = await request(app).post('/soc/api/attempts').set({ ...u, Cookie: cookie }).send({ scenarioId: 'F4' });
    expect(fourth.status).toBe(409); expect(fourth.body.error).toBe('too_many_open');
  }, 60_000);

  it('the Red Team page may frame its own sandboxed target document (TR-44), nothing else is relaxed', async () => {
    const GATEWAY_CSP = "default-src 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'";
    const gw = express().use((_req, res, next) => { res.setHeader('Content-Security-Policy', GATEWAY_CSP); next(); }, app);
    const r = await request(gw).get('/redteam/').set({ ...auth('Asha'), Accept: 'text/html' });
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toBe("default-src 'self'; frame-src 'self' https://challenges.cloudflare.com; frame-ancestors 'none'");
    const soc = await request(gw).get('/soc/').set({ ...auth('Asha'), Accept: 'text/html' });
    expect(soc.headers['content-security-policy']).toBe(GATEWAY_CSP);
  });

  it('the SOC API is not reachable under another spelling', async () => {
    const r = await request(app).get('/soc/API/me').set({ ...auth('Asha'), Accept: 'application/json' });
    expect(String(r.text)).not.toContain('tr_u_asha');
    expect((await request(app).get('/soc/api/me').set(auth('Asha'))).body.uid).toBe('tr_u_asha');
  });

  it('SOC and Red Team progress shows in the labs summary (profile and admin)', async () => {
    const u = auth('Summary');
    const a = await request(app).post('/soc/api/attempts').set(u).send({ scenarioId: 'F1' });
    expect(a.status).toBe(201);
    const rt = await request(app).post('/redteam/api/labs/TR-RED-001/sessions').set(u).send({});
    expect(rt.status).toBe(200);
    const r = await request(app).get('/internal/v1/users/u_summary/summary').set({ Authorization: `Bearer ${INTERNAL_TOKEN}` });
    expect(r.status).toBe(200);
    const stat = (label: string) => r.body.stats.find((x: any) => x.label === label).value;
    expect(stat('Labs started')).toBe(2); expect(stat('In progress')).toBeGreaterThanOrEqual(2); expect(stat('Total runs')).toBe(2);
    const soc = r.body.items.find((i: any) => i.id === a.body.attemptId);
    expect(soc).toMatchObject({ status: 'In progress', url: `${ORIGIN}/labs/soc/#/case/${a.body.caseId}` }); expect(soc.title).toMatch(/^SOC Simulation · /);
    expect(r.body.items.find((i: any) => i.id === rt.body.session.id)).toMatchObject({ url: `${ORIGIN}/labs/redteam/` });
    // Another learner's summary has neither.
    const other = await request(app).get('/internal/v1/users/u_nobody/summary').set({ Authorization: `Bearer ${INTERNAL_TOKEN}` });
    expect(other.body.items).toEqual([]);
    // Where progress is kept, per catalog card: with the account while the launcher keeps it across
    // restarts (TR_STATE_DURABLE=1, read per request), otherwise on the lab server.
    expect((await request(app).get('/api/labs').set(u)).body.find((l: any) => l.id === 'TR-SOC-001')).toMatchObject({ progressIn: 'server' });
    expect((await request(app).get('/soc/api/session/info').set(u)).body).toMatchObject({ hosted: true, durable: false });
    process.env.TR_STATE_DURABLE = '1';
    let labs: any[];
    try {
      labs = (await request(app).get('/api/labs').set(u)).body;
      expect((await request(app).get('/soc/api/session/info').set(u)).body).toMatchObject({ hosted: true, durable: true });
      expect((await request(app).get('/soc/api/report').set(u)).body.notes.reset).toBe('Practice records are saved to your ThreatReady account.');
    } finally { delete process.env.TR_STATE_DURABLE; }
    expect((await request(app).get('/soc/api/report').set(u)).body.notes.reset).toBe('Practice records are kept on the ThreatReady lab server.');
    expect(labs.find((l: any) => l.id === 'TR-SOC-001')).toMatchObject({ available: true, progressIn: 'account', onProfile: true });
    expect(labs.find((l: any) => l.id === 'TR-RED-001')).toMatchObject({ available: true, progressIn: 'account', onProfile: true });
    const devsecops = labs.find((l: any) => l.id === 'TR-DEVSECOPS-001');
    if (devsecops.available) expect(devsecops).toMatchObject({ progressIn: 'browser', onProfile: false });
  }, 60_000);
});
