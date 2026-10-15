// Browser end-to-end test. Starts the real server (serving the built client) on a temporary data
// file and drives it like a learner: dev login → start engagement → acknowledge → recon in the
// terminal → exploit/remediate/report through the real HTTP API in the page → the SPA shows the
// completed report. Run: npm run build && npm run test:e2e  (needs Chromium: npx playwright install chromium)
import { chromium, Page } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createApp } from '../../server/app';
import { devIdentity } from '../../server/identity';
import { Store } from '../../server/store';

const root = path.resolve(import.meta.dirname, '../..');
const assert = (c: any, m: string) => { if (!c) throw new Error(`ASSERT: ${m}`); console.log(`  ✓ ${m}`); };

const SECRET = 'e2e-secret-e2e-secret';
const httpServer = http.createServer();
await new Promise<void>(r => httpServer.listen(0, r));
const base = `http://localhost:${(httpServer.address() as any).port}`;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tr-web-e2e-')), 'store.json');
// Mount the lab under /lab, exactly as server/index.ts does (the client is built with base '/lab/').
const parent = express();
parent.use('/lab', createApp(new Store(dataFile), path.join(root, 'dist'), { identity: devIdentity(SECRET), appOrigin: base, devLogin: true, devSecret: SECRET }));
parent.get('/', (_req, res) => res.redirect(302, '/lab/'));
httpServer.on('request', parent);

const exe = fs.existsSync('/opt/pw-browsers/chromium') && fs.statSync('/opt/pw-browsers/chromium').isFile() ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath: exe });
const context = await browser.newContext({ viewport: { width: 1460, height: 900 } });
const page = await context.newPage();
// tsx/esbuild annotates named functions with a __name() helper; shim it so page.evaluate bodies run.
await page.addInitScript(() => { (globalThis as any).__name = (globalThis as any).__name || ((fn: any) => fn); });
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

// Drive the full campaign through the real API from inside the page (same-origin, credentialed).
async function solveViaApi(p: Page, origin: string) {
  return await p.evaluate(async (base) => {
    const rid = () => 'rq-' + Math.random().toString(36).slice(2);
    const act = async (sid: string, type: string, params: any = {}) => {
      const r = await fetch(`${base}/lab/api/sessions/${sid}/actions`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, params, requestId: rid() }) });
      return r.json();
    };
    const start = await (await fetch(`${base}/lab/api/labs/TR-RED-001/sessions`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const sid = start.session.id;
    const nav = (url: string, method = 'GET', body?: string) => act(sid, 'browser.navigate', { url, method, body });
    await act(sid, 'engagement.acknowledge');
    for (const u of ['/', '/products', '/robots.txt', '/search', '/login', '/product?id=101', '/sitemap.xml']) await nav(u);
    await nav('/api/order?id=5001'); await nav('/admin');
    await act(sid, 'proxy.send', { request: { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: "username=admin'--&password=x" } });
    await nav('/search?q=<script>alert(document.domain)</script>');
    await nav('/support/ticket', 'POST', 'subject=hi&body=<script>alert(1)</script>');
    await nav('/support/ticket?id=9002');
    await nav('/login', 'POST', "username=admin'--&password=x");
    await nav('/api/order?id=5001');
    await nav('/download?file=backups/novacart-db.sql.bak');
    await nav('/download?file=../../../../etc/passwd');
    const snap = await (await fetch(`${base}/lab/api/sessions/${sid}`, { credentials: 'include' })).json();
    // read the weak secret out of the backup we just exfiltrated (as a learner would)
    const backup = snap.view.history.find((h: any) => h.request.path === '/download' && h.request.query.includes('backups'));
    const secret = (backup.response.body.match(/JWT_SIGNING_SECRET='([^']+)'/) || [])[1];
    const tok = (await act(sid, 'terminal.exec', { line: `jwt sign ${secret} {"user":"admin","role":"admin"}` })).result.output.trim();
    await act(sid, 'browser.setCookie', { name: 'nc_admin', value: tok });
    await nav('/admin');
    await nav('/admin/ping?host=127.0.0.1;id');
    await nav('/admin/fetch?url=http://169.254.169.254/');
    // document, remediate, verify, report
    const st0 = (await (await fetch(`${base}/lab/api/sessions/${sid}`, { credentials: 'include' })).json()).status;
    for (const f of st0.findings.filter((f: any) => f.confirmed)) {
      await act(sid, 'finding.report', { findingId: f.id, severity: f.severity });
    }
    const hist = (await (await fetch(`${base}/lab/api/sessions/${sid}`, { credentials: 'include' })).json()).view.history;
    for (const h of hist.slice(0, 4)) await act(sid, 'evidence.add', { historyId: h.id });
    return sid;
  }, origin);
}

async function remediateViaApi(p: Page, origin: string, sid: string) {
  await p.evaluate(async ({ base, sid }) => {
    const rid = () => 'rq-' + Math.random().toString(36).slice(2);
    const act = async (type: string, params: any = {}) => (await fetch(`${base}/lab/api/sessions/${sid}/actions`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, params, requestId: rid() }) })).json();
    const st = (await (await fetch(`${base}/lab/api/sessions/${sid}`, { credentials: 'include' })).json()).status;
    for (const f of st.findings.filter((f: any) => f.confirmed)) {
      // try each option until one is accepted (answer key is server-side)
      for (const o of f.options) { const r = await act('finding.remediate', { findingId: f.id, optionId: o.id }); if (r.ok) break; }
      await act('finding.retest', { findingId: f.id });
    }
    await act('report.submit', { summary: 'NovaCart exposed nine exploitable web vulnerabilities across injection, broken access control, authentication and SSRF. All were confirmed, remediated and verified during this authorized engagement.' });
  }, { base: origin, sid });
}

try {
  console.log('Dev login and start the engagement');
  await page.goto(`${base}/lab/`);
  await page.getByPlaceholder('Your name').fill('E2E Tester');
  await page.getByRole('button', { name: 'Enter the lab' }).click();
  await page.getByRole('heading', { name: 'Web application penetration-testing labs' }).waitFor();
  assert(true, 'catalog loads after dev login');

  await page.getByRole('button', { name: 'Start engagement' }).click();
  await page.getByRole('heading', { name: 'The Breach Files — NovaCart' }).waitFor();
  await page.getByRole('button', { name: /Acknowledge/ }).click();
  assert(await page.getByText('Simulation').first().isVisible(), 'workspace shows the simulation banner');

  console.log('Recon in the terminal (xterm) — effect visible in the shared Proxy history');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('whatweb http://shop.novacart.lab/');
  await page.keyboard.press('Enter');
  // xterm renders to a canvas (text not in the DOM); prove the command ran by its effect on shared state.
  await page.getByRole('button', { name: /^Proxy/ }).click();
  await page.locator('.htable', { hasText: 'whatweb' }).first().waitFor({ timeout: 8000 });
  assert(true, 'terminal command drove a real request visible in the Proxy history');

  console.log('Run the full engagement through the API, then verify in the UI');
  const sid = await solveViaApi(page, base);
  await remediateViaApi(page, base, sid);

  // Reload the SPA and confirm the run resumes with completion + report render.
  await page.goto(`${base}/lab/`);
  await page.getByRole('button', { name: 'Start engagement' }).click();  // resumes the active (completed) run
  await page.getByRole('button', { name: 'Report' }).click();
  await page.getByRole('heading', { name: 'Penetration-Test Report' }).waitFor();
  assert(true, 'the completed report renders in the SPA');
  const body = await page.locator('.report').innerText();
  assert(/Verified fixed/.test(body), 'the report shows verified-fixed findings');

  assert(errors.length === 0, `no uncaught page errors (${errors.join(' | ')})`);
  console.log('\nE2E PASSED');
} catch (e) {
  console.error('\nE2E FAILED:', e);
  process.exitCode = 1;
} finally {
  await browser.close(); httpServer.close();
}
