// Randomised attempts (Build specification, section 6.2).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, api, seen, record, findLeaks, solveStage, engine, getScenario, LogStream, registerOwner } from './helpers.mjs';

before(start);
after(stop);
const scn = getScenario('F3');
const CANON = ['SCAN01', '10.10.0.60', 'CHG-4471', 'DC01', 'p.nair', 'Priya Nair', 'WS-FIN-014', 'plugins.vulnscan-cloud'];

async function openF3(user) {
  const a = await api('POST', '/api/attempts', { scenarioId: 'F3' }, { user });
  registerOwner(a.body.caseId, user);
  const id = a.body.caseId;
  for (let i = 0; i < 40; i++) { if ((await api('GET', `/api/cases/${id}`)).body.alert) break; await new Promise((r) => setTimeout(r, 400)); }
  await api('POST', `/api/cases/${id}/ack`);
  return { ...a.body, id };
}

test('two attempts get different names, addresses and identifiers', async () => {
  const x = await openF3('var.one');
  const y = await openF3('var.two');
  const cx = (await api('GET', `/api/cases/${x.id}`)).body;
  const cy = (await api('GET', `/api/cases/${y.id}`)).body;
  assert.notEqual(cx.alert.entity.ip, cy.alert.entity.ip);
  assert.notDeepEqual(cx.directory.hosts.map((h) => h.name), cy.directory.hosts.map((h) => h.name));
  assert.notDeepEqual(cx.directory.accounts.map((a) => a.sam), cy.directory.accounts.map((a) => a.sam));
  const ch = await api('POST', `/api/cases/${x.id}/tools/change`, { input: '' });
  const ids = ch.body.result.items.map((i) => i.id);
  assert.ok(!ids.includes('CHG-4471') && ids.some((i) => /^CHG-\d{4}$/.test(i)));
  // option order differs between attempts for at least one question, ids stay the same
  const fx = cx.current.fields.filter((f) => f.options);
  const fy = cy.current.fields.filter((f) => f.options);
  assert.ok(fx.some((f, i) => f.options.map((o) => o.value).join() !== fy[i].options.map((o) => o.value).join()), 'option order is shuffled');
  for (const [i, f] of fx.entries()) assert.deepEqual(f.options.map((o) => o.value).sort(), fy[i].options.map((o) => o.value).sort());
});

test('the same seed always produces byte-identical logs', () => {
  const c = { id: 'det', seed: '123456', t0: Date.UTC(2026, 9, 14, 9), actions: [], injected: [], status: 'open', variant: { seed: 123456 }, level: 'foundations' };
  const { buildAlias } = engine.__alias;
  const a1 = buildAlias(123456, scn.entities);
  const a2 = buildAlias(123456, scn.entities);
  assert.deepEqual(a1.pairs, a2.pairs);
  const s1 = new LogStream(c, scn, a1);
  const s2 = new LogStream(c, scn, a2);
  s1.ensure(c.t0 + 60000);
  s2.ensure(c.t0 + 60000);
  const cut = (s) => JSON.stringify(s.events.filter((e) => e.ts < c.t0 + 60000).map((e) => [e.id, e.raw, e._lca]));
  assert.ok(cut(s1) === cut(s2), 'same seed, same logs');
  const s3 = new LogStream({ ...c, seed: '654321', variant: { seed: 654321 } }, scn, buildAlias(654321, scn.entities));
  s3.ensure(c.t0 + 60000);
  assert.ok(cut(s1) !== cut(s3), 'different seed, different logs');
});

test('renaming round-trips; canonical names typed directly are not accepted', () => {
  const a = engine.__alias.buildAlias(42, scn.entities);
  for (const t of ['SCAN01', '10.10.0.60', 'CHG-4471', 'p.nair', 'WS-FIN-014', 'AEROFREIGHT\\svc_scan']) assert.equal(a.in(a.out(t)), t);
  assert.notEqual(a.in('SCAN01'), 'SCAN01');
  const h = 'a'.repeat(64);
  assert.equal(a.in(a.out(h)), h);
  assert.notEqual(a.out(h), h);
  assert.equal(a.out('10.10.0.1 and 10.10.0.10'), `${a.out('10.10.0.1')} and ${a.out('10.10.0.10')}`);
});

test('a perfect run typed with the renamed values scores 100, and the review is renamed too', async () => {
  const x = await openF3('var.perfect');
  const c = engine.getCase(x.id);
  const alias = engine.aliasFor(c);
  let r = await api('POST', `/api/cases/${x.id}/submit`, await solveStage(x.id, scn, 'l1_triage'));
  assert.equal(r.body.case.stages.find((s) => s.id === 'l1_triage').score.pct, 100);
  r = await api('POST', `/api/cases/${x.id}/submit`, await solveStage(x.id, scn, 'closure'));
  assert.equal(r.body.case.status, 'closed');
  assert.equal(r.body.attempt.score, 100);
  const text = JSON.stringify(r.body);
  for (const t of CANON) assert.ok(!text.includes(t), `canonical ${t} leaked into the review`);
  assert.ok(text.includes(alias.out('SCAN01')), 'the review uses the renamed host');
  assert.ok(text.includes(alias.out('CHG-4471')));
});

test('searching and sweeping use the names the analyst sees', async () => {
  const x = await openF3('var.search');
  const alias = engine.aliasFor(engine.getCase(x.id));
  const ip = alias.out('10.10.0.60');
  const q = await api('GET', `/api/cases/${x.id}/logs?limit=5&q=${encodeURIComponent(`event_id:4625 src_ip:${ip}`)}`);
  assert.equal(q.status, 200, JSON.stringify(q.body).slice(0, 300));
  assert.ok(q.body.total >= 6);
  const as = await api('POST', `/api/cases/${x.id}/tools/asset`, { input: alias.out('SCAN01') });
  assert.equal(as.body.result.found, true);
  assert.equal(as.body.result.title, alias.out('SCAN01'));
  record(false); // the echo of a typed canonical name is not a leak
  const asCanon = await api('POST', `/api/cases/${x.id}/tools/asset`, { input: 'SCAN01' });
  const canonQ = await api('GET', `/api/cases/${x.id}/logs?limit=5&q=${encodeURIComponent('src_ip:10.10.0.60')}`);
  record(true);
  assert.equal(canonQ.body.total, 0);
  assert.equal(asCanon.body.result.found, false, 'canonical names are unknown in a renamed attempt');
  // Sweeps match the renamed text too.
  const c = engine.getCase(x.id);
  const { runTool } = await import('../server/engine/tools.js');
  const r = runTool({ c, scenario: scn, stream: engine.streamFor(c), tier: 2, visibleInput: alias.out('SCAN01') }, 'sweep', { input: 'SCAN01' });
  assert.ok(r.result.total > 0);
});

test('no answer key, tag, canonical name or alias map leaves the server before closure', () => {
  const pre = seen.filter((s) => !(s.json && s.json.case && s.json.case.status === 'closed') && !String(s.url).includes('/abandon'));
  assert.deepEqual(pre.flatMap((x) => findLeaks(x.json)), []);
  const text = pre.filter((s) => /\/api\/cases\//.test(s.url)).map((s) => JSON.stringify(s.json)).join('\n');
  for (const t of CANON) assert.ok(!text.includes(t), `canonical ${t} leaked before closure`);
  assert.ok(!/aliasMap|"pairs"|hashKey|"variant"|"seed"/.test(text), 'alias map or seed leaked');
});
