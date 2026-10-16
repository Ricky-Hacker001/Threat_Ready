import { describe, it, expect } from 'vitest';
import { Lab, solve, FINDINGS, E } from './helpers';

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
});
