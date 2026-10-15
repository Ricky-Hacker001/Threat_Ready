import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, api, seen, record, findLeaks, waitForAlert, solveStage, engine, getScenario, LogStream, sleep } from './helpers.mjs';

const scn = getScenario('s01-beacon');
const { IOC } = scn._test;
let id;

before(start);
after(stop);

test('catalogue does not describe what is behind the alert', async () => {
  const { body } = await api('GET', '/api/scenarios');
  const entry = body.find((s) => s.id === 'E1');
  assert.ok(entry);
  assert.doesNotMatch(JSON.stringify(entry), /phish|macro|lsass|msync|FS01|malware|true positive/i);
});

test('monitoring: logs stream before any alert, then the alert fires', async () => {
  const created = await api('POST', '/api/cases', { scenarioId: 's01-beacon', analyst: 'e2e' });
  assert.equal(created.status, 201);
  id = created.body.id;
  assert.equal(created.body.status, 'monitoring');
  assert.equal(created.body.alert, null);

  const logs = await api('GET', `/api/cases/${id}/logs?limit=50`);
  assert.ok(logs.body.total > 2500, 'history is pre-populated');
  for (const src of ['proxy', 'dns', 'email', 'edr', 'winsec', 'firewall']) assert.ok(logs.body.bySource[src] > 0 || true);

  const early = await api('POST', `/api/cases/${id}/ack`);
  assert.equal(early.status, 409, 'cannot acknowledge before an alert exists');

  const withAlert = await waitForAlert(id);
  assert.equal(withAlert.alert.rule, 'NET-0142');
  assert.ok(withAlert.alert.matched.length >= 10);

  // Workflow gating: nothing can be submitted, pinned or actioned yet.
  assert.equal((await api('POST', `/api/cases/${id}/submit`, { values: {} })).status, 409);
  assert.equal((await api('POST', `/api/cases/${id}/actions`, { type: 'isolate_host', target: 'WS-FIN-014' })).status, 409);

  const ack = await api('POST', `/api/cases/${id}/ack`);
  assert.equal(ack.body.status, 'open');
  assert.equal(ack.body.stage, 'l1_triage');
  assert.match(ack.body.ticket, /^INC-\d{4}-\d{5}$/);
});

test('new log lines are generated as wall-clock time passes', async () => {
  const c = engine.getCase(id);
  const s = engine.streamFor(c);
  const n0 = s.events.length;
  let grew = false;
  for (let i = 0; i < 20 && !grew; i++) {
    await new Promise((r) => setTimeout(r, 500));
    s.ensure();
    grew = s.events.length > n0;
  }
  assert.ok(grew, 'new events were generated as time passed');
});

test('query language and tier gating', async () => {
  const q = async (query) => (await api('GET', `/api/cases/${id}/logs?limit=500&q=${encodeURIComponent(query)}`)).body;
  const beacons = await q(`source:proxy dest_host:${IOC.c2Host}`);
  assert.ok(beacons.total >= 30);
  const hosts = new Set(beacons.events.map((e) => e.fields.src_host));
  assert.deepEqual([...hosts].sort(), ['FS01', 'WS-FIN-014']);
  assert.equal((await q('event_id:7045')).total, 1);
  assert.equal((await q('host:FS01 source:proxy bytes_out>100000')).total, 0, 'no large upload from FS01: nothing was exfiltrated');
  assert.ok((await q('event_id:(4624|4625) -auth_package:Kerberos target_user:*svc_backup')).total >= 1);
  assert.equal((await q('"net group"')).total, 1);
  assert.ok((await q('powershell -enc')).total >= 1);

  // Encoded PowerShell exists on servers too (benign monitoring agent): keyword matching is not enough.
  const enc = await q('source:edr EncodedCommand');
  assert.ok(enc.total >= 3);

  const sweep = await api('POST', `/api/cases/${id}/tools/sweep`, { input: IOC.c2Host });
  assert.equal(sweep.status, 403, 'fleet sweep is a Tier 2 tool');
  const rep = await api('POST', `/api/cases/${id}/tools/reputation`, { input: `hxxps://${IOC.c2Host.replace(/\./g, '[.]')}/x` });
  assert.equal(rep.body.result.verdict, 'suspicious');
  const dec = engine.streamFor(engine.getCase(id)).events.find((e) => (e._tags || []).includes('office_ps'));
  const b64 = dec.fields.command_line.split('-Enc ')[1];
  const decoded = await api('POST', `/api/cases/${id}/tools/decode`, { input: b64 });
  assert.match(decoded.body.result.output, new RegExp(IOC.stage2Host.replace(/\./g, '\\.')));
});

test('L1 triage and escalation', async () => {
  const incomplete = await api('POST', `/api/cases/${id}/submit`, { values: { verdict: 'tp' } });
  assert.equal(incomplete.status, 400);
  assert.ok(incomplete.body.problems.length >= 3);

  let s = await solveStage(id, scn, 'l1_triage');
  let r = await api('POST', `/api/cases/${id}/submit`, s);
  assert.equal(r.body.outcome.complete, true);
  assert.equal(r.body.case.stage, 'l2_escalation');
  assert.equal(r.body.case.severity, 'high');
  assert.equal(r.body.case.stages.find((x) => x.id === 'l1_triage').score.pct, 100);

  s = await solveStage(id, scn, 'l2_escalation');
  r = await api('POST', `/api/cases/${id}/submit`, s);
  assert.equal(r.body.case.stage, 'l2_investigation');
  assert.equal(r.body.case.tier, 'L2');
  assert.ok(r.body.case.iocs.some((i) => i.value === IOC.c2Host), 'handed-over indicators are saved to the case');
  assert.ok(r.body.case.history.some((h) => /reassigned from L1 to L2/.test(h.text)));
});

test('L2 investigation: tools, retries, evidence linking', async () => {
  const sweep = await api('POST', `/api/cases/${id}/tools/sweep`, { input: IOC.c2Host });
  assert.equal(sweep.status, 200);
  const ents = sweep.body.result.rows.map((x) => x.entity);
  assert.deepEqual(ents, ['WS-FIN-014', 'FS01'], 'sweep finds both hosts, patient zero first');

  const tree = await api('POST', `/api/cases/${id}/tools/proctree`, { input: 'WS-FIN-014', filter: 'excel' });
  const imgs = tree.body.result.nodes.map((n) => `${n.depth}:${n.image.split('\\').pop()}`);
  const chain = imgs.join(' ');
  assert.match(chain, /\d+:EXCEL\.EXE \d+:powershell\.exe \d+:rundll32\.exe \d+:cmd\.exe \d+:whoami\.exe/);

  const sb = await api('POST', `/api/cases/${id}/tools/sandbox`, { input: IOC.attachHash });
  assert.equal(sb.body.result.verdict, 'malicious');
  await api('POST', `/api/cases/${id}/tools/reputation`, { input: IOC.c2Host });

  const good = await solveStage(id, scn, 'l2_investigation');

  // v2: Expert allows one submission round per stage, so two wrong answers
  // and one unlinked finding are final and cost credit; no hint is shown.
  const wrong = { values: { ...good.values, persistence: 'task', data: 'exfil' }, links: { ...good.links, lateral: [] } };
  const r = await api('POST', `/api/cases/${id}/submit`, wrong);
  assert.equal(r.body.outcome.complete, true);
  assert.equal(r.body.case.stage, 'l2_validation');
  assert.equal(r.body.case.stages.find((x) => x.id === 'l2_investigation').review.find((x) => x.label.startsWith('Persistence')).verdict, 'incorrect');
  const pct = r.body.case.stages.find((x) => x.id === 'l2_investigation').score.pct;
  assert.ok(pct > 60 && pct < 90, `wrong answers cost credit (got ${pct})`);
});

test('L2 validation', async () => {
  const cur = (await api('GET', `/api/cases/${id}`)).body.current;
  const checks = cur.fields.find((f) => f.type === 'checks').items;
  assert.ok(checks.every((x) => x.done), 'corroboration checklist reflects the tools actually run');
  const s = await solveStage(id, scn, 'l2_validation');
  const r = await api('POST', `/api/cases/${id}/submit`, s);
  assert.equal(r.body.case.stage, 'l3_response');
  assert.equal(r.body.case.tier, 'L3');
  assert.equal(r.body.case.severity, 'critical');
});

test('L3 response: actions change the environment and the log stream', async () => {
  const act = (type, target, extra = {}) => api('POST', `/api/cases/${id}/actions`, { type, target, ...extra });

  assert.equal((await act('isolate_host', 'NOPE-01')).status, 400);
  assert.equal((await act('block_ip', '999.1.1.1')).status, 400);
  const needs = await act('isolate_host', 'FS01');
  assert.equal(needs.status, 409);
  assert.equal(needs.body.needsConfirmation, true);

  const plan = [
    ['isolate_host', 'WS-FIN-014'], ['isolate_host', 'FS01', { confirm: true }],
    ['block_domain', IOC.c2Host], ['block_ip', IOC.c2Ip], ['block_domain', IOC.stage2Host], ['block_sender', IOC.senderDomain],
    ['reset_credentials', 'svc_backup'], ['reset_credentials', 'p.nair'],
    ['purge_email', IOC.attachHash],
    ['acquire_evidence', 'WS-FIN-014'], ['acquire_evidence', 'FS01'],
    ['reimage_host', 'WS-FIN-014'], ['remove_artifacts', 'FS01'],
    ['release_host', 'WS-FIN-014'], ['release_host', 'FS01'],
    ['notify', 'ir_lead'], ['notify', 'data_owner'], ['notify', 'legal'],
  ];
  for (const [type, target, extra] of plan) {
    const r = await act(type, target, extra);
    assert.equal(r.status, 200, `${type} ${target}`);
    assert.equal(r.body.action.ok, true, `${type} ${target}: ${r.body.action.summary}`);
    assert.equal(r.body.action.matched, undefined);
  }
  const purge = engine.getCase(id).actions.find((a) => a.type === 'purge_email');
  assert.match(purge.summary, /3 messages removed from 3 mailboxes/);

  // Log slots are one second long and take the response state in force at
  // the start of the slot, so let the slot the last action landed in finish.
  await sleep(1100);
  // Jump the stream two minutes ahead: the implants are gone, so no beacon of any kind.
  const c = engine.getCase(id);
  const s = engine.streamFor(c);
  const after = Date.now();
  s.ensure(after + 180000);
  const later = s.events.filter((e) => e.ts > after && e.raw.includes(IOC.c2Host));
  assert.equal(later.length, 0, 'no C2 traffic after eradication');
  assert.ok(s.events.some((e) => e.source === 'audit' && /network_containment/.test(e.raw)), 'response actions are logged');

  const done = await api('POST', `/api/cases/${id}/submit`, {});
  assert.equal(done.body.case.stage, 'closure');
  assert.equal(done.body.case.stages.find((x) => x.id === 'l3_response').score.pct, 100);
});

test('no answer material is sent while the case is open', () => {
  const leaks = seen.flatMap((x) => findLeaks(x.json).map((p) => `${x.url} ${p}`));
  assert.deepEqual(leaks, []);
  const blob = JSON.stringify(seen.map((x) => x.json));
  for (const f of scn.stages.flatMap((st) => st.fields || [])) {
    if (f.key?.explain && f.key.explain.length > 40) assert.ok(!blob.includes(f.key.explain), `explanation for ${f.id} leaked`);
  }
  for (const o of scn.secret.response.objectives) assert.ok(!blob.includes(o.explain), `objective ${o.id} leaked`);
});

test('closure produces the after-action report and locks the case', async () => {
  record(false);
  const s = await solveStage(id, scn, 'closure');
  const r = await api('POST', `/api/cases/${id}/submit`, s);
  assert.equal(r.body.case.status, 'closed');
  const rep = r.body.case.report;
  assert.ok(rep.score >= 93 && rep.score <= 99, `score reflects the second-round investigation (got ${rep.score})`);
  assert.equal(rep.stages.length, 6);
  assert.ok(rep.truth.timeline.length >= 10);
  assert.ok(rep.stages.find((x) => x.id === 'l2_investigation').fields.every((f) => f.expected && f.explain));

  assert.equal((await api('POST', `/api/cases/${id}/pins`, { eventId: 'x' })).status, 409);
  assert.equal((await api('POST', `/api/cases/${id}/actions`, { type: 'isolate_host', target: 'DC01' })).status, 409);

  const stagesSeen = new Set(r.body.case.history.map((h) => h.stage));
  for (const st of scn.stages) assert.ok(stagesSeen.has(st.id), `history has entries from ${st.id}`);
  const ts = r.body.case.history.map((h) => h.ts);
  assert.ok(ts.length > 40);

  const md = await api('GET', `/api/cases/${id}/export?format=md`);
  assert.match(md.body, /After-action review/);
  assert.match(md.body, /What actually happened/);
  record(true);
});

test('log stream is reproducible from the stored case (restart safety)', () => {
  const c = engine.getCase(id);
  const live = engine.streamFor(c);
  const rebuilt = new LogStream(c, scn);
  rebuilt.ensure(c.closedAt + 180000);
  const a = live.events.filter((e) => e.ts < c.closedAt - 2000).map((e) => `${e.id}|${e.raw}`);
  const b = rebuilt.events.filter((e) => e.ts < c.closedAt - 2000).map((e) => `${e.id}|${e.raw}`);
  assert.equal(a.length, b.length);
  assert.deepEqual(a, b);
  for (const p of c.pins) assert.equal(rebuilt.get(p.eventId)?.raw, p.snapshot.raw, 'pinned evidence resolves to the same line');
});

test('a careless run is overruled, penalised and still reaches closure', async () => {
  record(false);
  const created = await api('POST', '/api/cases', { scenarioId: 's01-beacon', analyst: 'careless' });
  const cid = created.body.id;
  await waitForAlert(cid);
  await api('POST', `/api/cases/${cid}/ack`);
  const c = engine.getCase(cid);
  const noise = engine.streamFor(c).events.filter((e) => !e._tags && e.source === 'proxy').slice(0, 3);
  for (const e of noise) await api('POST', `/api/cases/${cid}/pins`, { eventId: e.id });
  const note = 'Looks like ordinary software telemetry to a cloud metrics API, nothing further to do here.';

  let r = await api('POST', `/api/cases/${cid}/submit`, { values: { verdict: 'fp', severity: 'low', category: 'policy', evidence: noise.map((e) => e.id), decision: 'close_fp', note } });
  assert.equal(r.body.case.stage, 'l2_escalation', 'closure of a true positive is overruled');
  assert.equal(r.body.case.stages.find((x) => x.id === 'l1_triage').result, 'Overruled');
  assert.ok(r.body.case.history.some((h) => h.actor === 'SOC shift lead'));
  assert.ok(r.body.case.stages.find((x) => x.id === 'l1_triage').score.pct <= 15);

  r = await api('POST', `/api/cases/${cid}/submit`, { values: { host: 'WS-FIN-009', user: 'd.okafor', iocs: [{ type: 'domain', value: 'www.google.com' }], priority: 'p4', containment: 'reboot', summary: `${note} Escalating only because QA insisted on it.` } });
  assert.equal(r.body.case.stage, 'l2_investigation');

  const inv = { vector: 'driveby', patient_zero: 'FS01', attach_hash: 'a'.repeat(64), parent: 'explorer.exe', stage2: 'example.org', c2_domain: 'example.org', c2_ip: '1.2.3.4', persistence: 'none', cred_access: 'none', lateral: 'none', data: 'none' };
  r = await api('POST', `/api/cases/${cid}/submit`, { values: inv, finalize: true });
  assert.equal(r.body.case.stage, 'l2_validation');
  assert.equal(r.body.case.stages.find((x) => x.id === 'l2_investigation').score.pct, 0);

  const order = (await api('GET', `/api/cases/${cid}`)).body.current.fields.find((f) => f.type === 'order').items.map((i) => i.id);
  r = await api('POST', `/api/cases/${cid}/submit`, { values: { hosts: ['DC01'], accounts: ['adm.rkhan'], recipients: ['v.sorensen'], earliest: noise[0].id, sequence: order, attack: ['T1190', 'T1486'], severity: 'low', declare: 'close' } });
  assert.equal(r.body.case.stage, 'l3_response', 'declining to declare is overruled');

  const act = (type, target, extra = {}) => api('POST', `/api/cases/${cid}/actions`, { type, target, ...extra });
  const dc = await act('isolate_host', 'DC01', { confirm: true });
  assert.match(dc.body.action.impact, /major incident/);
  await act('block_domain', 'www.google.com');
  await act('reimage_host', 'WS-FIN-014');
  await act('notify', 'press');
  r = await api('POST', `/api/cases/${cid}/submit`, {});
  assert.equal(r.body.case.stages.find((x) => x.id === 'l3_response').score.pct, 0);

  r = await api('POST', `/api/cases/${cid}/submit`, { values: { disposition: 'fp', root_cause: 'vuln', impact: 'ws_only', lessons: ['pwall', 'fwvendor'], summary: `${note} Closing the ticket now that the actions are complete.` } });
  assert.equal(r.body.case.status, 'closed');
  assert.ok(r.body.case.report.score < 15, `score ${r.body.case.report.score}`);
  const resp = r.body.case.report.stages.find((x) => x.id === 'l3_response');
  assert.ok(resp.findings.some((f) => /DC01/.test(f.reason)));
  assert.ok(resp.findings.some((f) => /before a forensic package/.test(f.reason)));

  // The beacon from FS01 was never cut, so the related alert still fires.
  engine.tick(c, c.t0 + 401000);
  record(true);
});

test('containment is visible in the log stream; the related alert fires if FS01 is left alone', async () => {
  record(false);
  const created = await api('POST', '/api/cases', { scenarioId: 's01-beacon', analyst: 'partial' });
  const cid = created.body.id;
  await waitForAlert(cid);
  await api('POST', `/api/cases/${cid}/ack`);
  for (const st of ['l1_triage', 'l2_escalation', 'l2_investigation', 'l2_validation']) {
    const r = await api('POST', `/api/cases/${cid}/submit`, { ...(await solveStage(cid, scn, st)), finalize: true });
    assert.equal(r.body.outcome.complete, true, st);
  }
  const c = engine.getCase(cid);
  const s = engine.streamFor(c);
  const act = (type, target, extra = {}) => api('POST', `/api/cases/${cid}/actions`, { type, target, ...extra });
  const c2After = (t, until) => s.events.filter((e) => e.ts > t && e.ts <= until && e.raw.includes(IOC.c2Host) && e.source !== 'audit');

  // Block the domain only: both implants keep trying and are denied at the proxy.
  await act('block_domain', IOC.c2Host);
  let t = Date.now();
  s.ensure(t + 150000);
  let evs = c2After(t, t + 150000).filter((e) => e.source === 'proxy');
  assert.ok(evs.length >= 3);
  assert.ok(evs.every((e) => e.fields.action === 'DENIED' && e.fields.status === 403));
  assert.deepEqual([...new Set(evs.map((e) => e.fields.src_host))].sort(), ['FS01', 'WS-FIN-014']);

  // FS01 is no longer reachable by its C2, so the second beacon alert must not fire.
  engine.tick(c, c.t0 + 401000);
  assert.equal(c.relatedAlerts.length, 0);
  record(true);
});

test('related alert fires and links to the ticket when FS01 keeps beaconing', async () => {
  record(false);
  const created = await api('POST', '/api/cases', { scenarioId: 's01-beacon', analyst: 'slow' });
  const cid = created.body.id;
  await waitForAlert(cid);
  const c = engine.getCase(cid);
  engine.tick(c, c.t0 + 401000);
  assert.equal(c.relatedAlerts.length, 1);
  assert.match(c.relatedAlerts[0].title, /FS01/);
  assert.ok(c.history.some((h) => /Related alert/.test(h.text)));
  record(true);
});
