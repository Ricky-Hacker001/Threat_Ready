import { describe, it, expect } from 'vitest';
import { Lab, solve, FINDINGS, E } from './helpers';
import { safeRegex } from '../server/terminal';

describe('TR-RED-001 engine — vulnerabilities are reachable and gradable', () => {
  it('each finding is confirmed only by a real exploit, not by reporting', () => {
    const l = new Lab();
    solve.recon(l);
    // Reporting before confirming is refused.
    const r = l.do('finding.report', { findingId: 'V-SQLI', severity: 'Critical' });
    expect(r.ok).toBe(false); expect(r.code).toBe('LAB_ACTION_UNSUPPORTED');
    expect(l.finding('V-SQLI').confirmed).toBe(false);
    solve.exploit(l);
    for (const f of FINDINGS) expect(l.finding(f.id).confirmed, `${f.id} confirmed`).toBe(true);
  });

  it('a full scripted solution completes the engagement with every finding verified', () => {
    const l = new Lab();
    solve.all(l);
    const st = l.status;
    expect(st.complete).toBe(true);
    expect(st.level).toBe(4);
    for (const f of FINDINGS) {
      const fv = l.finding(f.id);
      expect(fv.confirmed, `${f.id} confirmed`).toBe(true);
      expect(fv.reported, `${f.id} reported`).toBe(true);
      expect(fv.verified, `${f.id} verified`).toBe(true);
    }
    expect(st.posture.verified).toBe(FINDINGS.length);
    expect(st.score.total).toBeGreaterThan(0);
    expect(st.score.percent).toBeGreaterThanOrEqual(90);
  });

  it('remediation is not verification: a fix without a passing re-test is unverified', () => {
    const l = new Lab();
    solve.recon(l); solve.exploit(l);
    const correct = FINDINGS[0].options.find(o => o.correct)!.id;
    l.ok('finding.remediate', { findingId: 'V-SQLI', optionId: correct });
    expect(l.finding('V-SQLI').remediated).toBe(true);
    expect(l.finding('V-SQLI').verified).toBe(false);
    l.ok('finding.retest', { findingId: 'V-SQLI' });
    expect(l.finding('V-SQLI').verified).toBe(true);
  });

  it('an incorrect remediation choice is rejected and does not fix the target', () => {
    const l = new Lab();
    solve.recon(l); solve.exploit(l);
    const wrong = FINDINGS.find(f => f.id === 'V-SQLI')!.options.find(o => !o.correct)!.id;
    const r = l.do('finding.remediate', { findingId: 'V-SQLI', optionId: wrong });
    expect(r.ok).toBe(false);
    expect(l.finding('V-SQLI').remediated).toBe(false);
    // The exploit still works.
    const login = l.send({ method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: "username=admin'--&password=x" });
    expect(login.result.response.body).toContain('bypassed');
  });

  it('a verified fix blocks the original exploit (negative test per finding)', () => {
    const l = new Lab();
    solve.recon(l); solve.exploit(l); solve.document(l); solve.remediate(l);
    // All verified, but the report is not yet submitted, so re-testing traffic is allowed.
    // SQLi login bypass now fails
    const login = l.send({ method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: "username=admin'--&password=x" });
    expect(login.result.response.status).toBe(401);
    // Reflected XSS is now encoded
    const search = l.send({ method: 'GET', path: '/search', query: 'q=<script>x</script>' });
    expect(search.result.response.body).not.toContain('<script>x</script>');
    expect(search.result.response.body).toContain('&lt;script&gt;');
    // IDOR is now 403
    expect(l.finding('V-IDOR').verified).toBe(true);
  });

  it('levels gate progression: exploitation unlocks only after recon', () => {
    const l = new Lab();
    expect(l.status.level).toBe(1);
    // A level-2 hint is locked before recon completes.
    const locked = l.do('hint.request', { objectiveId: 'confirm:V-SQLI' });
    expect(locked.ok).toBe(false);
    solve.recon(l);
    expect(l.status.level).toBe(2);
    expect(l.do('hint.request', { objectiveId: 'confirm:V-SQLI' }).ok).toBe(true);
  });

  it('hints reduce the objective score', () => {
    const a = new Lab(); solve.all(a);
    const b = new Lab();
    b.ok('hint.request', { objectiveId: 'L1.map' });
    b.ok('hint.request', { objectiveId: 'L1.map' });
    solve.all(b);
    expect(b.status.score.total).toBeLessThan(a.status.score.total);
  });

  it('guidance modes: beginner gets step-by-step walkthrough, intermediate a tip, advanced nothing', () => {
    const l = new Lab(); // default beginner
    expect(l.status.mode).toBe('beginner');
    const g = l.status.guidance;
    expect(g.mode).toBe('beginner');
    expect(g.steps.length).toBeGreaterThan(10);
    expect(g.currentIndex).toBe(0);
    // steps carry concrete, actionable detail
    expect(g.steps.some((s: any) => /whatweb/.test(s.detail))).toBe(true);

    // switching to intermediate yields a one-line tip, no steps
    l.ok('settings.setMode', { mode: 'intermediate' });
    expect(l.status.guidance.mode).toBe('intermediate');
    expect(l.status.guidance.tip).toMatch(/Recon/);
    expect(l.status.guidance.steps).toBeUndefined();

    // advanced yields no guidance content
    l.ok('settings.setMode', { mode: 'advanced' });
    expect(l.status.guidance.mode).toBe('advanced');
    expect(l.status.guidance.steps).toBeUndefined();
    expect(l.status.guidance.tip).toBeUndefined();
  });

  it('beginner walkthrough advances as the learner progresses', () => {
    const l = new Lab();
    const first = l.status.guidance.currentIndex;
    solve.recon(l);
    expect(l.status.guidance.currentIndex).toBeGreaterThan(first); // recon steps now done
    solve.exploit(l); solve.document(l); solve.remediate(l); solve.report(l);
    expect(l.status.guidance.currentIndex).toBe(-1); // all steps complete
  });

  it('intermediate/advanced never leak the walkthrough payloads to the client projection', () => {
    for (const mode of ['intermediate', 'advanced'] as const) {
      const s = E.createInitialState(mode);
      const blob = JSON.stringify(E.status(s)) + JSON.stringify(E.view(s)) + JSON.stringify(E.definition());
      // the beginner walkthrough's exact payloads must not appear
      for (const leak of ["admin'--", '169.254.169.254', 'jwt sign', '/etc/passwd']) expect(blob).not.toContain(leak);
    }
    // beginner, by contrast, intentionally includes them
    const beginner = JSON.stringify(E.status(E.createInitialState('beginner')));
    expect(beginner).toContain("admin'--");
  });

  it('the terminal runs thin-client tools against the shared target and refuses unsupported flags', () => {
    const l = new Lab(); solve.recon(l);
    const curl = l.term('curl -i ' + 'http://shop.aerocart.lab/products');
    expect(curl.result.output).toContain('200 OK');
    const bad = l.term('curl --cert foo http://shop.aerocart.lab/');
    expect(bad.result.output).toMatch(/not supported/);
    const sqlmap = l.term("sqlmap -u 'http://shop.aerocart.lab/login' --data='username=x&password=y' -p username --batch");
    expect(sqlmap.result.output).toMatch(/injectable/);
    // sqlmap traffic also confirms the SQLi finding (shared state).
    expect(l.finding('V-SQLI').confirmed).toBe(true);
  });

  it('grep and find never hand the regex engine a catastrophic pattern', () => {
    const l = new Lab();
    // Ordinary grep/find keep working.
    expect(l.term('grep -i robots notes.md').result.output).toContain('robots.txt');
    expect(l.term('cat wordlists/common.txt | grep "^a.*"').result.output).toMatch(/admin\n/);
    expect(l.term('grep -v "^#" notes.md').result.output).not.toContain('# Recon');
    expect(l.term('grep "[0-9]+" engagement-brief.txt').result.output).toContain('ENG-2041');
    expect(l.term('find . -name "*.txt"').result.output).toContain('engagement-brief.txt');
    expect(l.term('find / -name "common.???"').result.output).toContain('/home/analyst/wordlists/common.txt');
    // Exponential and polynomial patterns are refused up front, in well under the time they would take to run.
    const t0 = performance.now();
    const r = l.term(`echo ${'a'.repeat(40)} | grep "(a+)+$"`);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(r.result.output).toMatch(/^grep: invalid pattern/);
    // Still refused: quantified (repeated) groups, adjacent unbounded quantifiers on the same text, long
    // optional runs, lookarounds, backreferences, over-length patterns (UX-REG6 keeps these out).
    // Also refused: two unbounded quantifiers a mandatory atom cannot separate (`.` matches the `x`), and
    // a stack of bounded repeats on one atom with no disjoint separator — both go polynomial/worse and
    // were wrongly accepted by the first UX-REG6 pass (`x.+x.+x.+y` ran ~4 s on a single long line).
    for (const p of ['a.*.*b', '\\w*\\w*', 'a?a?a?a?a?a?a?a', '(a|aa)*b', '(a+)+', '(?=a)b', '(a)\\1', 'x'.repeat(129),
                     'x.+x.+x.+y', 'a{1,9}a{1,9}a{1,9}a{1,9}b', '.+x.+', '\\d+\\d+']) expect(l.term(`grep "${p}" notes.md`).result.output, p).toMatch(/^grep: invalid pattern/);
    // The patterns just refused must be refused fast (structural check, never compiled-and-run) — a
    // guard that the refusal, not the matcher, is what's cheap.
    for (const p of ['x.+x.+x.+y', 'a{1,9}a{1,9}a{1,9}a{1,9}b']) { const tr = performance.now(); l.term(`echo ${'x'.repeat(900)} | grep "${p}"`); expect(performance.now() - tr, p).toBeLessThan(50); }
    // Common learner patterns now run instead of being wrongly refused as "unbounded" (UX-REG6).
    const t2 = performance.now();
    for (const p of ['[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}', '\\d+\\.\\d+', '.*password.*', '(https?://)?admin', 'pass(word)?', 'admin|root']) {
      const out = l.term(`grep "${p}" notes.md`).result.output;
      expect(out, p).not.toMatch(/invalid pattern/);
    }
    // ...and a bounded IPv4 scan over 2000 long lines stays well under 5 ms/pattern (linear).
    const bulk = Array.from({ length: 2000 }, () => 'x'.repeat(240) + ' no-match').join('\n');
    const lines = bulk.split('\n');
    for (const p of ['[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}', '.*password.*']) {
      const re = safeRegex(p)!; const ts = performance.now();
      for (const ln of lines) re.test(ln.slice(0, 1000));
      expect(performance.now() - ts, p).toBeLessThan(50);
    }
    expect(performance.now() - t2).toBeLessThan(500);
    // Scans stay bounded even for a fat pipe: one `.*` on a long, non-matching line.
    const t1 = performance.now();
    l.term(`echo ${'b'.repeat(900)} | grep ".*x"`);
    expect(performance.now() - t1).toBeLessThan(100);
    // find -name treats regex metacharacters literally and never throws.
    for (const p of ['(', '[', '*(', 'a{2', '\\\\', '+']) expect(l.term(`find . -name "${p}"`).result.output).toBe('\n');
    expect(l.term(`find . -name "${'*'.repeat(30)}x"`).result.output).toBe('\n');
    // Prototype names are unknown findings/objectives, not server errors.
    expect(l.do('finding.report', { findingId: 'constructor', severity: 'High' }).code).toBe('VALIDATION_FAILED');
    expect(l.do('finding.remediate', { findingId: '__proto__', optionId: 'x' }).code).toBe('VALIDATION_FAILED');
    expect(l.do('hint.request', { objectiveId: 'toString' }).code).toBe('VALIDATION_FAILED');
  });
});

describe('TR-RED-001 engine — scoring integrity (TR-28, SEC-2/BIZ-02)', () => {
  const SEV = /\((Critical|High|Medium|Low)\)/;

  it('TR-28: incorrect remediation attempts are penalised on the committed state', () => {
    const l = new Lab();
    solve.recon(l); solve.exploit(l);
    const wrong = FINDINGS.find(f => f.id === 'V-SQLI')!.options.find(o => !o.correct)!.id;
    // Each wrong fix is refused, but its penalty counter must survive the failure it raises (the bug was
    // that dispatch re-cloned the pre-mutation state, discarding wrongFixes).
    for (let i = 0; i < 3; i++) expect(l.do('finding.remediate', { findingId: 'V-SQLI', optionId: wrong }).ok).toBe(false);
    expect(l.finding('V-SQLI').remediated).toBe(false);
    const pen = l.status.score.penalties.find((p: any) => p.label === 'Incorrect remediation attempts');
    expect(pen?.points).toBe(3);
    expect(l.status.failedActions).toBeGreaterThanOrEqual(3);
  });

  it('TR-28: documenting an unconfirmed finding is refused and the penalty persists', () => {
    const l = new Lab();
    solve.recon(l);
    for (let i = 0; i < 2; i++) expect(l.do('finding.report', { findingId: 'V-SQLI', severity: 'Critical' }).ok).toBe(false);
    expect(l.finding('V-SQLI').confirmed).toBe(false);
    const pen = l.status.score.penalties.find((p: any) => p.label === 'Unsupported finding reports');
    expect(pen?.points).toBe(2);
  });

  it('TR-28: guidance-mode switches are recorded (timeline + report), lowest mode kept', () => {
    const l = new Lab(); // starts in beginner
    l.ok('settings.setMode', { mode: 'advanced' });
    l.ok('settings.setMode', { mode: 'intermediate' });
    l.ok('settings.setMode', { mode: 'intermediate' }); // no-op: same mode, not counted
    const rep = E.report(l.state, { learner: 'x', run: 1, sessionId: 's' });
    expect(rep.performance.modeSwitches).toBe(2);
    expect(rep.performance.lowestGuidanceMode).toBe('beginner'); // beginner is the most-assisted mode reached
    expect(rep.performance.guidanceMode).toBe('intermediate');
    expect(l.status.timeline.some((e: any) => /Guidance mode changed/.test(e.text))).toBe(true);
  });

  it('SEC-2/BIZ-02: the reference severity never reaches the learner before they document', () => {
    const l = new Lab(); // beginner: the most verbose guidance
    expect(SEV.test(JSON.stringify(l.status))).toBe(false);
    solve.recon(l); solve.exploit(l); // every finding confirmed, Level 3, nothing documented yet
    expect(l.status.level).toBe(3);
    expect(l.status.findings.filter((f: any) => f.reported).length).toBe(0);
    // No reference severity anywhere in the projection, and none in the beginner walkthrough steps.
    expect(SEV.test(JSON.stringify(l.status))).toBe(false);
    expect(l.status.guidance.steps.some((s: any) => SEV.test(s.detail))).toBe(false);
    expect(l.status.findings.some((f: any) => f.severity)).toBe(false);
  });

  it('SEC-2/BIZ-02: a documented severity is committed — re-documenting is refused, grading uses the first rating', () => {
    const l = new Lab();
    solve.recon(l); solve.exploit(l);
    expect(l.ok('finding.report', { findingId: 'V-SQLI', severity: 'Low' }).ok).toBe(true);
    // The reference severity is revealed only now (after the learner committed their own rating).
    expect(l.finding('V-SQLI').severity).toBe('Critical');
    const r = l.do('finding.report', { findingId: 'V-SQLI', severity: 'Critical' });
    expect(r.ok).toBe(false); expect(r.code).toBe('LAB_ACTION_UNSUPPORTED');
    expect(l.finding('V-SQLI').reportedSeverity).toBe('Low');
    expect(l.state.sim.wrongReports).toBe(0); // a committed re-report is not a "wrong report"
  });

  it('SEC-2/BIZ-02: report.submit cannot override committed severities', () => {
    const l = new Lab();
    solve.recon(l); solve.exploit(l);
    for (const f of FINDINGS) l.ok('finding.report', { findingId: f.id, severity: 'Low' });
    for (const h of l.view.history.slice(0, 4)) l.ok('evidence.add', { historyId: h.id });
    solve.remediate(l);
    const refs = Object.fromEntries(l.status.findings.map((f: any) => [f.id, f.severity]));
    l.ok('report.submit', { summary: 'AeroCart exposed nine exploitable web vulnerabilities; all were confirmed, remediated and verified during this engagement.', severities: refs });
    const sev = l.state.sim.report.score.breakdown.find((b: any) => b.label === 'Severity accuracy');
    expect(sev.got).toBe(0); // still graded on the committed all-Low ratings, not the passed references
  });

  it('SEC-3: a finding.report that fails validation documents nothing, so a corrected report still works', () => {
    const l = new Lab();
    solve.recon(l); solve.exploit(l);
    const before = JSON.stringify(l.state.sim.findings['V-SQLI']);
    for (const bad of [{ note: 'x'.repeat(2001) }, { affectedRoute: '/'.repeat(121) }, { note: 42 }]) {
      const r = l.do('finding.report', { findingId: 'V-SQLI', severity: 'Low', ...bad });
      expect(r.ok).toBe(false); expect(r.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(l.state.sim.findings['V-SQLI'])).toBe(before); // not documented, no severity stored
      expect(l.finding('V-SQLI').reported).toBe(false);
      expect(l.finding('V-SQLI').severity).toBeUndefined(); // the graded reference is still withheld
    }
    expect(l.state.sim.wrongReports).toBe(0); // invalid input is not an unsupported report
    expect(l.state.sim.timeline.some((e: any) => /Documented finding V-SQLI/.test(e.text))).toBe(false);
    // The learner fixes the note and documents the finding once, with the severity they choose now.
    l.ok('finding.report', { findingId: 'V-SQLI', severity: 'Critical', note: 'x'.repeat(2000) });
    expect(l.finding('V-SQLI').reportedSeverity).toBe('Critical');
    expect(l.finding('V-SQLI').note.length).toBe(2000);
  });

  it('SEC-3: a failed action commits the pre-action state plus only its penalty counters', () => {
    const l = new Lab();
    solve.recon(l); solve.exploit(l);
    const strip = (s: any) => { const c = structuredClone(s); delete c.events; delete c.eventSeq; c.sim.failedActions = 0; c.sim.wrongReports = 0; c.sim.wrongFixes = 0; c.sim.timeline = c.sim.timeline.filter((e: any) => e.kind !== 'warn'); return JSON.stringify(c); };
    const before = strip(l.state);
    const wrong = FINDINGS.find(f => f.id === 'V-SQLI')!.options.find(o => !o.correct)!.id;
    const failing: Array<[string, any]> = [
      ['finding.report', { findingId: 'V-SQLI', severity: 'High', note: 'x'.repeat(5000) }],
      ['finding.remediate', { findingId: 'V-SQLI', optionId: wrong }],
      ['browser.navigate', { url: '/', body: 'b'.repeat(9000) }],
      ['proxy.send', { request: { method: 'TRACE', path: '/' } }],
      ['evidence.add', { historyId: 'h-9999' }],
      ['report.submit', { summary: 'too short' }],
      ['no.such.action', {}],
    ];
    for (const [type, params] of failing) expect(l.do(type, params).ok, type).toBe(false);
    expect(strip(l.state)).toBe(before);
    expect(l.state.sim.failedActions).toBe(failing.length);
    expect(l.state.sim.wrongFixes).toBe(1); // the one penalty raised above survived its own failure
    expect(l.state.sim.timeline.filter((e: any) => /did not address the root cause/.test(e.text)).length).toBe(1);
  });

  it('BIZ-05: changing guidance mode after delivery leaves the delivered report as it was', () => {
    const l = new Lab();
    l.state = E.createInitialState('advanced');
    solve.all(l);
    const meta = { learner: 'x', run: 1, sessionId: 's' };
    const strip = (r: any) => { const c = structuredClone(r); delete c.meta.generatedAt; return JSON.stringify(c); };
    const delivered = E.report(l.state, meta);
    expect(delivered.performance).toMatchObject({ guidanceMode: 'advanced', lowestGuidanceMode: 'advanced', modeSwitches: 0 });
    // Beginner to read the walkthrough after delivery: allowed, and the UI preference changes...
    expect(l.do('settings.setMode', { mode: 'beginner' }).ok).toBe(true);
    expect(l.status.mode).toBe('beginner');
    // ...plus inspection and refused edits, none of which may re-stamp the delivered report.
    l.ok('inspect', { key: 'headers' });
    expect(l.do('hint.request', { objectiveId: 'L1.map' }).ok).toBe(false);
    l.ok('settings.setMode', { mode: 'intermediate' });
    expect(strip(E.report(l.state, meta))).toBe(strip(delivered));
    expect(E.report(l.state, meta).meta.final).toBe(true);
  });

  it('BIZ-05: a report delivered before the guidance record was frozen keeps its record on the first change', () => {
    const l = new Lab();
    l.state = E.createInitialState('advanced');
    solve.all(l);
    delete l.state.sim.report.final; // as stored by the previous engine version
    const meta = { learner: 'x', run: 1, sessionId: 's' };
    l.ok('settings.setMode', { mode: 'beginner' });
    expect(E.report(l.state, meta).performance).toMatchObject({ guidanceMode: 'advanced', lowestGuidanceMode: 'advanced', modeSwitches: 0 });
  });

  it('SEC-2/BIZ-02: a delivered report is read-only and its score is frozen', () => {
    const l = new Lab(); solve.all(l);
    const before = l.status.score.total;
    const refused: Array<[string, any]> = [
      ['finding.report', { findingId: 'V-SQLI', severity: 'Low' }],
      ['evidence.add', { historyId: l.view.history[10].id }],
      ['evidence.remove', { historyId: l.state.sim.evidence[0] }],
      ['hint.request', { objectiveId: 'L1.map' }],
      ['browser.navigate', { url: '/' }],
      ['finding.retest', { findingId: 'V-SQLI' }],
    ];
    for (const [type, params] of refused) expect(l.do(type, params).ok, type).toBe(false);
    expect(l.status.score.total).toBe(before);
    // Guidance mode and inspection stay available for reviewing the delivered report.
    expect(l.do('settings.setMode', { mode: 'advanced' }).ok).toBe(true);
    expect(l.do('inspect', { key: 'headers' }).ok).toBe(true);
  });
});
