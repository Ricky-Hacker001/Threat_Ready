import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import type { IdentityResolver } from '../server/identity';
import { SCENARIOS } from '../server/scenarios';

const ORIGIN = 'http://localhost:5176';
const TOKEN = 'test-internal-token-test-internal-token-0123';
/** Stand-in for onboard: cookie tr.session_token=<name>; "down" = unreachable; "trial…" = no-account trial. */
const identity: IdentityResolver = async (h) => {
  const m = /(?:^|;\s*)tr\.session_token=([^;]+)/.exec(h.cookie || '');
  if (!m) return { ok: false, reason: 'signed-out', setCookies: [] };
  const name = decodeURIComponent(m[1]!);
  if (name === 'down') return { ok: false, reason: 'unavailable' };
  return { ok: true, user: { id: `u_${name}`, name, email: `${name}@example.test`, image: null, isTrial: name.startsWith('trial'), isAdmin: false }, setCookies: [] };
};
const app = createApp(undefined, { identity, internalToken: TOKEN, appOrigin: ORIGIN, onboardUrl: 'http://localhost:5173', apps: async () => [{ key: 'reasoning', title: 'Attack Reasoning', url: ORIGIN, status: 'live' }] });
const as = (name: string) => ({ Cookie: `tr.session_token=${name}`, Origin: ORIGIN });

describe('identity from onboard', () => {
  it('needs a session: none → 401, onboard down → 503, trial → account required', async () => {
    expect((await request(app).get('/api/scenarios')).status).toBe(401);
    expect((await request(app).get('/api/scenarios').set(as('down'))).status).toBe(503);
    const trial = await request(app).get('/api/scenarios').set(as('trial-1'));
    expect(trial.status).toBe(403); expect(trial.body.code).toBe('AUTH_ACCOUNT_REQUIRED');
    expect((await request(app).get('/api/me').set(as('asha'))).body).toMatchObject({ id: 'u_asha', name: 'asha' });
  });
  it('refuses state changes from another origin', async () => {
    expect((await request(app).post('/api/scenarios').set({ ...as('asha'), Origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('scenarios', () => {
  it('lists every scenario without the briefs, with levels and the published dimensions', async () => {
    const r = await request(app).get('/api/scenarios').set(as('asha'));
    expect(r.body.scenarios).toHaveLength(SCENARIOS.length);
    expect(r.body.scenarios[0].brief).toBeUndefined();
    expect(r.body.levels.map((l: any) => l.level)).toEqual(['Beginner', 'Intermediate', 'Advanced', 'Expert']);
    expect(r.body.dimensions.map((d: any) => d.code)).toEqual(['TI', 'CR', 'AB', 'CQ', 'FA']);
  });
  it('serves a dedicated page per scenario, 404 for an unknown id', async () => {
    const r = await request(app).get(`/api/scenarios/${SCENARIOS[0]!.id}`).set(as('asha'));
    expect(r.body.scenario).toMatchObject({ id: SCENARIOS[0]!.id, available: false });
    expect(r.body.scenario.brief.length).toBeGreaterThan(20);
    expect((await request(app).get('/api/scenarios/NOPE-1').set(as('asha'))).status).toBe(404);
  });
  it('uses real ATT&CK technique ids', () => {
    for (const s of SCENARIOS) for (const t of s.techniques) expect(t.id).toMatch(/^T\d{4}(\.\d{3})?$/);
  });
});

describe('internal API for onboard', () => {
  const bearer = { Authorization: `Bearer ${TOKEN}` };
  it('requires the internal token; a browser session is not enough', async () => {
    expect((await request(app).get('/internal/v1/users/u_asha/summary')).status).toBe(401);
    expect((await request(app).get('/internal/v1/users/u_asha/summary').set(as('asha'))).status).toBe(401);
  });
  it('reports the summary and no AI usage yet', async () => {
    const s = await request(app).get('/internal/v1/users/u_asha/summary').set(bearer);
    expect(s.body).toMatchObject({ app: 'reasoning', items: [] });
    expect(s.body.aiUsage.calls).toBe(0);
    const u = await request(app).get('/internal/v1/ai-usage?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z').set(bearer);
    expect(u.body).toEqual({ app: 'reasoning', users: [], byModel: [], byFeature: [] });
  });
});
