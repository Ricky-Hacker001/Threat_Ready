// Test harness: boots the real Express app on a random port and drives it
// over HTTP. The "solver" reads each scenario's server-side answer key to
// produce a perfect run, which proves the keys, the generated logs and the
// grading logic agree with each other.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soc-sim-test-'));
process.env.SOC_SIM_DATA = path.join(dir, 'cases.json');
process.env.SOC_SIM_NO_LISTEN = '1';
process.env.SOC_SIM_FAST = '1';
process.env.SOC_SIM_TEST = '1';
process.env.DEV_USER = 'test.default';
process.env.TR_SIM_SECRET = 'test-secret-for-tokens';

const { app } = await import('../server/index.js');
export const engine = await import('../server/engine/cases.js');
const registry = await import('../server/scenarios/index.js');
export const repo = (await import('../server/repo.js')).repo;
// v1 tests name the original modules; in v2 they are F3 and E1.
const LEGACY = { 's01-beacon': 'E1', 's02-authfail': 'F3' };
export const getScenario = (id) => registry.getScenario(LEGACY[id] || id);
export const { LogStream } = await import('../server/engine/logstream.js');

let server;
let base;
export async function start() {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}
export const baseUrl = () => base;
export async function stop() {
  await new Promise((resolve) => server.close(resolve));
}

// Every response body seen while a case is still open, for the leak scan.
export const seen = [];
let recording = true;
export const record = (on) => { recording = on; };

// Which test user owns which case (v1 tests used one analyst name per case).
const owner = new Map();
export const registerOwner = (caseId, uid) => owner.set(caseId, uid);
export function grantLevels(uid, levels = ['foundations', 'intermediate']) {
  for (const level of levels) {
    if (repo.listAwards(uid).some((b) => b.level === level)) continue;
    repo.addAward({ badgeId: `bdg_T${uid}${level}`, userId: uid, level, earnedAt: new Date().toISOString(), average: 80, passedCount: 10, internal: true });
  }
}

export async function api(method, url, body, opts = {}) {
  // v1 route: POST /api/cases with an analyst name starts a canonical
  // (unrenamed) attempt for that analyst, as a separate user.
  if (method === 'POST' && url === '/api/cases' && body && LEGACY[body.scenarioId] && !body.kind) {
    const uid = `t.${body.analyst || 'analyst'}`;
    grantLevels(uid);
    const r = await api('POST', '/api/attempts', { scenarioId: LEGACY[body.scenarioId], canonical: true }, { user: uid });
    if (r.status !== 201) return r;
    owner.set(r.body.caseId, uid);
    const c = await api('GET', `/api/cases/${r.body.caseId}`);
    return { status: 201, body: c.body };
  }
  let user = opts.user;
  if (!user) { const m = url.match(/\/api\/cases\/([a-z0-9]+)/); if (m && owner.has(m[1])) user = owner.get(m[1]); }
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (user) headers['x-test-user'] = user;
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await fetch(base + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (recording) seen.push({ url: `${method} ${url}`, json });
  return { status: res.status, body: json, headers: res.headers };
}

const FORBIDDEN_KEYS = new Set(['key', 'secret', '_tags', '_lc', 'explain', 'accept', 'support', 'hint', 'objectives', 'evaluation', 'truth', 'groups']);
export function findLeaks(value, trail = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => findLeaks(v, `${trail}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) out.push(`${trail}.${k}`);
      findLeaks(v, `${trail}.${k}`, out);
    }
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForAlert(id) {
  for (let i = 0; i < 40; i++) {
    const { body } = await api('GET', `/api/cases/${id}`);
    if (body.alert) return body;
    await sleep(500);
  }
  throw new Error('alert never fired');
}

const NOTE = 'Recorded by the automated walkthrough: observations, affected assets and the reasoning behind this decision are captured here for the next tier.';

// Build perfect answers for the current form stage, pinning and linking
// whatever evidence each field needs.
export async function solveStage(caseId, scenario, stageId) {
  const def = scenario.stages.find((s) => s.id === stageId);
  const c = engine.getCase(caseId);
  const stream = engine.streamFor(c);
  const byTag = (tags) => stream.events.find((e) => (e._tags || []).some((t) => tags.includes(t)));
  const pin = async (ev) => {
    if (!engine.getCase(caseId).pins.some((p) => p.eventId === ev.id)) await api('POST', `/api/cases/${caseId}/pins`, { eventId: ev.id, note: 'auto' });
    return ev.id;
  };
  // Renamed attempts: the solver types what the analyst would see.
  const alias = engine.aliasFor(c);
  for (const [tool, input] of scenario._test?.tools?.[stageId] || []) await api('POST', `/api/cases/${caseId}/tools/${tool}`, { input: alias.out(input) });
  const values = {};
  const links = {};
  for (const f of def.fields) {
    const k = f.key || {};
    switch (f.type) {
      case 'single': case 'host': case 'account':
        values[f.id] = typeof k.accept === 'string' ? k.accept : Object.entries(k.accept).find(([, cr]) => cr >= 1)[0];
        break;
      case 'multi': case 'hosts': case 'accounts': values[f.id] = [...k.set]; break;
      case 'text': values[f.id] = k.accept[0]; break;
      case 'longtext': values[f.id] = NOTE; break;
      case 'order': values[f.id] = [...k.order]; break;
      case 'pins': {
        const ids = [];
        for (const tags of Object.values(k.groups)) {
          const evs = stream.events.filter((e) => (e._tags || []).some((t) => tags.includes(t))).slice(0, 2);
          for (const ev of evs) ids.push(await pin(ev));
        }
        values[f.id] = [...new Set(ids)];
        break;
      }
      case 'pin_one': {
        const best = Object.entries(k.accept).sort((a, b) => b[1] - a[1])[0][0];
        values[f.id] = await pin(byTag([best]));
        break;
      }
      case 'ioc_list':
        values[f.id] = [...k.must, ...k.valid.filter((v) => !k.must.includes(v)).slice(0, k.wantExtra ?? 2)].map((value) => ({ type: 'domain', value }));
        break;
      default: break;
    }
    if (f.linkable) links[f.id] = [await pin(byTag(k.support))];
  }
  return { values: alias.outDeep(values), links };
}
