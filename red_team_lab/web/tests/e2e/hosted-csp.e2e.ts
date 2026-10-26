// Hosted-mode browser check: the lab built with `--base /labs/redteam/`, mounted through
// threatready-lab-001/server/hosted.ts behind the gateway's exact Content-Security-Policy, driven in
// headless Chromium. Proves the embedded target browser still works under the strict policy: the
// target page renders (inline styles), an XSS payload executes inside the sandboxed frame (the shim's
// banner is the visible proof), links and forms inside the frame stay in the simulation, the lab page
// itself raises no policy violations, and the whole engagement remains solvable through the hosted API.
// Run: npm run build -- --base /labs/redteam/ && npx tsx tests/e2e/hosted-csp.e2e.ts
import { chromium, Frame } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import express from 'express';

const root = path.resolve(import.meta.dirname, '../..');
const repo = path.resolve(root, '../..');
const labsServer = path.join(repo, 'threatready-lab-001', 'server');
const { createApp: createLabs, loadHostedLabs } = await import(path.join(labsServer, 'app.ts'));
const { Store: LabsStore } = await import(path.join(labsServer, 'store.ts'));
const assert = (c: any, m: string) => { if (!c) throw new Error(`ASSERT: ${m}`); console.log(`  ✓ ${m}`); };

// deploy/gateway.mjs, verbatim.
const GATEWAY_CSP = [
  "default-src 'self'", "script-src 'self' https://challenges.cloudflare.com 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com", "img-src 'self' data: blob: https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
  "connect-src 'self' blob: data:", "worker-src 'self' blob:", "media-src 'self' blob:", 'frame-src https://challenges.cloudflare.com', "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
].join('; ');

// A checkout holding only the built Red Team lab (server linked from this repo), as hosted.ts expects it.
const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-hosted-csp-'));
fs.mkdirSync(path.join(checkout, 'red_team_lab', 'web'), { recursive: true });
fs.symlinkSync(path.join(root, 'dist'), path.join(checkout, 'red_team_lab', 'web', 'dist'));
fs.symlinkSync(path.join(root, 'server'), path.join(checkout, 'red_team_lab', 'web', 'server'));

const httpServer = http.createServer();
await new Promise<void>(r => httpServer.listen(Number(process.env.E2E_PORT) || 0, '127.0.0.1', r)); // E2E_PORT pins it; default any free port
const base = `http://127.0.0.1:${(httpServer.address() as any).port}`;
const identity = async (h: any) => {
  const m = /(?:^|;\s*)tr\.session_token=([^;]+)/.exec(h.cookie || '');
  if (!m) return { ok: false as const, reason: 'signed-out' as const, setCookies: [] };
  return { ok: true as const, user: { id: `u_${m[1]}`, name: m[1], email: null, image: null, isTrial: false, isAdmin: false }, setCookies: [] };
};
const hosted = await loadHostedLabs(checkout, { catalogUrl: `${base}/labs/`, identity, appOrigin: base, onboardUrl: base, redTeamDataFile: path.join(checkout, 'red.json'), internalToken: 'x'.repeat(40) });
assert(hosted.map((h: any) => h.slug).join() === 'redteam', 'hosted.ts found the built Red Team lab');
const labs = createLabs(new LabsStore(null), undefined, { identity, internalToken: 'x'.repeat(40), appOrigin: base, onboardUrl: base, hosted });
const gateway = express();
gateway.disable('x-powered-by');
gateway.use((_req, res, next) => { res.setHeader('Content-Security-Policy', GATEWAY_CSP); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
gateway.get('/labs/lab-nav.js', (_req, res) => res.type('js').send('/* ThreatReady strip stub */')); // served from the labs build in production
gateway.use('/labs', labs);
httpServer.on('request', gateway);

const exe = fs.existsSync('/opt/pw-browsers/chromium') && fs.statSync('/opt/pw-browsers/chromium').isFile() ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath: exe });
const context = await browser.newContext({ viewport: { width: 1460, height: 900 } });
await context.addCookies([{ name: 'tr.session_token', value: 'Asha', url: base }]);
const page = await context.newPage();
await page.addInitScript(() => { (globalThis as any).__name = (globalThis as any).__name || ((fn: any) => fn); });
const errors: string[] = []; const violations: string[] = []; const frameConsole: string[] = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => {
  const text = m.text();
  const inTarget = m.page() === page && (m as any).frame?.() !== page.mainFrame?.();
  if (/Content Security Policy|Refused to/.test(text)) (inTarget ? frameConsole : violations).push(text);
  else if (m.type() === 'error' && !/Failed to load resource/.test(text)) errors.push(text);
});
const targetFrame = async (): Promise<Frame> => {
  const el = page.locator('iframe.bframe');
  await el.waitFor({ timeout: 10000 });
  const handle = await el.elementHandle();
  const f = await handle!.contentFrame();
  if (!f) throw new Error('no content frame');
  return f;
};
const address = () => page.locator('text=Address:').locator('.code2').innerText();

try {
  const pageRes = await page.goto(`${base}/labs/redteam/`);
  const csp = pageRes!.headers()['content-security-policy'];
  assert(csp === GATEWAY_CSP.replace('frame-src ', "frame-src 'self' "), `the hosted page carries the gateway policy plus frame-src 'self' only`);
  const frameRes = await context.request.get(`${base}/labs/redteam/target-frame.html`);
  assert(/sandbox allow-scripts allow-forms$/.test(frameRes.headers()['content-security-policy']) && !frameRes.headers()['content-security-policy'].includes('allow-same-origin'), 'target-frame.html answers with its own sandboxed policy');

  await page.getByRole('heading', { name: 'Web application penetration-testing labs' }).waitFor();
  await page.getByRole('button', { name: 'Start engagement' }).click();
  // exact: the workspace also has a visually-hidden h1 that contains this text (UI/UX).
  await page.getByRole('heading', { name: 'The Breach Files — AeroCart', exact: true }).waitFor();
  await page.getByRole('button', { name: /Acknowledge/ }).click();
  // The tool switcher is a tablist (role="tab"), not plain buttons.
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();

  console.log('Target page renders inside the frame under the strict policy');
  const urlBox = page.getByPlaceholder('/path?query');
  await urlBox.fill('/products'); await page.getByRole('button', { name: 'Go', exact: true }).click();
  let f = await targetFrame();
  await f.waitForSelector('a[href="/product?id=101"]', { timeout: 10000 });
  const styled = await f.evaluate(() => { const a = document.querySelector('a[href="/login"]') as HTMLElement | null; return a ? getComputedStyle(a).color : null; });
  assert(styled === 'rgb(205, 212, 227)', `inline styles apply in the target (nav link colour ${styled})`);

  console.log('Links inside the frame stay in the simulation');
  await f.click('a[href="/product?id=101"]');
  await page.waitForFunction(() => document.body.innerText.includes('/product?id=101'), null, { timeout: 10000 });
  assert((await address()).includes('/product?id=101'), 'a link click in the frame navigated the simulated browser');

  console.log('Reflected XSS executes inside the sandboxed frame (visible banner), not on the lab page');
  await urlBox.fill('/search?q=<script>alert(document.domain)</script>'); await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('/search?q='), null, { timeout: 10000 });
  f = await targetFrame();
  await f.waitForFunction(() => document.body && document.body.innerText.includes('script executed in your session'), null, { timeout: 10000 });
  const banner = await f.evaluate(() => document.body.innerText.match(/script executed in your session: [^\n]*/)?.[0]);
  assert(/alert\(/.test(banner || ''), `the payload ran in the frame: "${banner}"`);
  assert(await f.evaluate(() => location.origin === 'null' || (() => { try { return !document.cookie && window.origin === 'null'; } catch { return true; } })()), 'the frame is an opaque origin (no cookies, no same-origin access)');
  const confirmed = await page.evaluate(async (b) => { const r = await fetch(`${b}/labs/redteam/api/catalog`, { credentials: 'include' }); return r.ok; }, base);
  assert(confirmed, 'the lab API is still reachable from the page');

  console.log('Forms inside the frame stay in the simulation');
  await urlBox.fill('/login'); await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('Address: /login') || /Address:\s*\/login/.test(document.body.innerText), null, { timeout: 10000 });
  f = await targetFrame();
  await f.waitForSelector('form[action="/login"]', { timeout: 10000 });
  await f.fill('form[action="/login"] input[name="username"]', "admin'--");
  await f.fill('form[action="/login"] input[name="password"]', 'x');
  await f.evaluate(() => (document.querySelector('form[action="/login"]') as HTMLFormElement).requestSubmit());
  await page.getByRole('tab', { name: /^Proxy/ }).click();
  await page.locator('.htable tr', { hasText: 'POST' }).filter({ hasText: '/login' }).first().waitFor({ timeout: 10000 });
  assert(true, 'a form submit in the frame became a simulated POST /login (visible in the Proxy history)');

  console.log('Stored XSS: the saved payload runs when the ticket is opened');
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();
  await page.locator(".bchrome select.wl-select").selectOption("POST");
  await urlBox.fill('/support/ticket');
  await page.locator('textarea.wl-area').first().fill('subject=hi&body=<script>alert(1)</script>');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.waitForFunction(() => /Address:\s*\/support\/ticket/.test(document.body.innerText), null, { timeout: 10000 });
  await page.locator(".bchrome select.wl-select").selectOption("GET");
  await urlBox.fill('/support/ticket?id=9002'); await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('id=9002'), null, { timeout: 10000 });
  f = await targetFrame();
  await f.waitForFunction(() => document.body && /script executed in your session: alert\(1\)/.test(document.body.innerText), null, { timeout: 10000 });
  assert(true, 'the stored payload executed in the frame when the ticket was opened');

  console.log('The full engagement is solvable through the hosted API; the SPA renders the report');
  const sid = await page.evaluate(async (b) => {
    const rid = () => 'rq-' + Math.random().toString(36).slice(2);
    const start = await (await fetch(`${b}/labs/redteam/api/labs/TR-RED-001/sessions`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const sid = start.session.id;
    const act = async (type: string, params: any = {}) => (await fetch(`${b}/labs/redteam/api/sessions/${sid}/actions`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, params, requestId: rid() }) })).json();
    const nav = (url: string, method = 'GET', body?: string) => act('browser.navigate', { url, method, body });
    for (const u of ['/', '/products', '/robots.txt', '/search', '/login', '/product?id=101', '/sitemap.xml', '/api/order?id=5001', '/admin']) await nav(u);
    await act('proxy.send', { request: { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: "username=admin'--&password=x" } });
    await nav('/login', 'POST', "username=admin'--&password=x");
    await nav('/api/order?id=5001'); await nav('/download?file=backups/aerocart-db.sql.bak'); await nav('/download?file=../../../../etc/passwd');
    const snap = await (await fetch(`${b}/labs/redteam/api/sessions/${sid}`, { credentials: 'include' })).json();
    const backup = snap.view.history.find((h: any) => h.request.path === '/download' && h.request.query.includes('backups'));
    const secret = (backup.response.body.match(/JWT_SIGNING_SECRET='([^']+)'/) || [])[1];
    const tok = (await act('terminal.exec', { line: `jwt sign ${secret} {"user":"admin","role":"admin"}` })).result.output.trim();
    await act('browser.setCookie', { name: 'ac_admin', value: tok });
    await nav('/admin'); await nav('/admin/ping?host=127.0.0.1;id'); await nav('/admin/fetch?url=http://169.254.169.254/');
    let st = (await (await fetch(`${b}/labs/redteam/api/sessions/${sid}`, { credentials: 'include' })).json()).status;
    // The learner commits their own rating: the graded reference severity is not sent before (SEC-2).
    for (const f of st.findings.filter((f: any) => f.confirmed)) await act('finding.report', { findingId: f.id, severity: f.severity ?? 'High' });
    const hist = (await (await fetch(`${b}/labs/redteam/api/sessions/${sid}`, { credentials: 'include' })).json()).view.history;
    for (const h of hist.slice(0, 4)) await act('evidence.add', { historyId: h.id });
    st = (await (await fetch(`${b}/labs/redteam/api/sessions/${sid}`, { credentials: 'include' })).json()).status;
    for (const f of st.findings.filter((f: any) => f.confirmed)) {
      for (const o of f.options) { const r = await act('finding.remediate', { findingId: f.id, optionId: o.id }); if (r.ok) break; }
      await act('finding.retest', { findingId: f.id });
    }
    await act('report.submit', { summary: 'AeroCart exposed nine exploitable web vulnerabilities across injection, broken access control, authentication and SSRF. All were confirmed, remediated and verified during this authorized engagement.' });
    return (await (await fetch(`${b}/labs/redteam/api/sessions/${sid}`, { credentials: 'include' })).json()).status;
  }, base);
  assert(sid.complete === true && sid.findings.filter((f: any) => f.confirmed).length === 9, `all nine findings confirmed and the run completed (score ${sid.score.total}/${sid.score.max})`);
  // The run resumes straight into the workspace (UX-10), no catalog step.
  await page.goto(`${base}/labs/redteam/`);
  await page.getByRole('tab', { name: 'Report' }).click();
  await page.getByRole('heading', { name: 'Penetration-Test Report' }).waitFor();
  assert(/Verified fixed/.test(await page.locator('.report').innerText()), 'the completed report renders in the hosted SPA');

  assert(violations.length === 0, `no policy violations on the lab page (${violations.join(' | ')})`);
  assert(errors.length === 0, `no uncaught page errors (${errors.join(' | ')})`);
  console.log('\nHOSTED CSP E2E PASSED');
} catch (e) {
  console.error('\nHOSTED CSP E2E FAILED:', e);
  console.error('violations:', violations, 'errors:', errors, 'frame console:', frameConsole);
  process.exitCode = 1;
} finally {
  await browser.close(); httpServer.close();
}
