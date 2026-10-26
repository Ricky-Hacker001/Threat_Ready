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
await new Promise<void>(r => httpServer.listen(Number(process.env.E2E_PORT) || 0, r)); // E2E_PORT pins it; default any free port
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
    await nav('/download?file=backups/aerocart-db.sql.bak');
    await nav('/download?file=../../../../etc/passwd');
    const snap = await (await fetch(`${base}/lab/api/sessions/${sid}`, { credentials: 'include' })).json();
    // read the weak secret out of the backup we just exfiltrated (as a learner would)
    const backup = snap.view.history.find((h: any) => h.request.path === '/download' && h.request.query.includes('backups'));
    const secret = (backup.response.body.match(/JWT_SIGNING_SECRET='([^']+)'/) || [])[1];
    const tok = (await act(sid, 'terminal.exec', { line: `jwt sign ${secret} {"user":"admin","role":"admin"}` })).result.output.trim();
    await act(sid, 'browser.setCookie', { name: 'ac_admin', value: tok });
    await nav('/admin');
    await nav('/admin/ping?host=127.0.0.1;id');
    await nav('/admin/fetch?url=http://169.254.169.254/');
    // document, remediate, verify, report
    const st0 = (await (await fetch(`${base}/lab/api/sessions/${sid}`, { credentials: 'include' })).json()).status;
    for (const f of st0.findings.filter((f: any) => f.confirmed)) {
      // The learner commits their own rating: the graded reference severity is not sent before (SEC-2).
      const r = await act(sid, 'finding.report', { findingId: f.id, severity: f.severity ?? 'High' });
      if (!r.ok) throw new Error(`finding.report ${f.id}: ${JSON.stringify(r).slice(0, 200)}`);
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
    await act('report.submit', { summary: 'AeroCart exposed nine exploitable web vulnerabilities across injection, broken access control, authentication and SSRF. All were confirmed, remediated and verified during this authorized engagement.' });
  }, { base: origin, sid });
}

try {
  console.log('UI-1: the lab server not answering (/api/me 503 from the ThreatReady gateway) shows a retry, not the display-name form');
  {
    const down = await browser.newContext();
    const dp = await down.newPage();
    // The exact body the gateway sends under /labs while the labs child restarts (deploy/gateway.mjs errorBody).
    const text = 'The Web Pentest Lab is briefly unavailable. Try again in 5 seconds.';
    await dp.route('**/lab/api/me', r => r.fulfill({ status: 503, headers: { 'retry-after': '5' }, contentType: 'application/json', body: JSON.stringify({ error: text, message: text, code: 'UPSTREAM_UNAVAILABLE', retryable: true, requestId: 'e2e' }) }));
    await dp.goto(`${base}/lab/`);
    await dp.getByRole('heading', { name: "Can't open the Web Pentest Lab" }).waitFor({ timeout: 10000 });
    assert(await dp.getByRole('alert').getByText(text).isVisible(), 'the gateway message is shown as text');
    assert(!(await dp.getByText('[object Object]').count()), 'never "[object Object]"');
    assert(!(await dp.getByPlaceholder('Your name').count()), 'no standalone display-name form while the server is down');
    await dp.unroute('**/lab/api/me');
    await dp.getByRole('button', { name: 'Try again' }).click();
    await dp.getByPlaceholder('Your name').waitFor({ timeout: 10000 });
    assert(true, 'Try again asks the server again (here: standalone, not signed in → the display-name form)');
    await down.close();
  }

  console.log('Dev login and start the engagement');
  await page.goto(`${base}/lab/`);
  await page.getByPlaceholder('Your name').fill('E2E Tester');
  await page.getByRole('button', { name: 'Enter the lab' }).click();
  await page.getByRole('heading', { name: 'Web application penetration-testing labs' }).waitFor();
  assert(true, 'catalog loads after dev login');

  await page.getByRole('button', { name: 'Start engagement' }).click();
  // exact, so this matches only the briefing dialog's title (the workspace also has a visually-hidden
  // h1 "ThreatReady Web Pentest Lab — The Breach Files — AeroCart" that contains this text).
  await page.getByRole('heading', { name: 'The Breach Files — AeroCart', exact: true }).waitFor();
  await page.getByRole('button', { name: /Acknowledge/ }).click();
  assert(await page.getByText('Simulation').first().isVisible(), 'workspace shows the simulation banner');

  console.log('SEC-5: with no target frame mounted, the browser tool ignores navigation messages from other windows');
  {
    // Before the first page the tool shows a placeholder card (no frame), so there is no legitimate
    // sender at all. Any window may post to this one then. The served target document is also refused
    // here, for the fallback check below.
    const lp = await context.newPage();
    await lp.route('**/target-frame.html', r => r.abort());
    await lp.goto(`${base}/lab/`);
    await lp.locator('.card', { hasText: 'Enter a path and press Go to load a page' }).waitFor({ timeout: 10000 });
    await lp.evaluate(() => window.postMessage({ __trlab: 1, type: 'nav', method: 'GET', url: '/sec5-probe' }, '*'));
    await lp.waitForTimeout(1500);
    const hist = await lp.evaluate(async (b) => (await (await fetch(`${b}/lab/api/labs/TR-RED-001/sessions`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).view.history, base);
    assert(!hist.some((h: any) => h.request.path === '/sec5-probe'), 'a message from a window that is not the target frame drove no request');

    console.log('TR-44 fallback: when the served target document cannot load, the page renders inline with a note');
    await lp.getByPlaceholder('/path?query').fill('/products');
    await lp.getByRole('button', { name: 'Go', exact: true }).click();
    await lp.locator('iframe[title="target"][srcdoc]').waitFor({ timeout: 10000 });
    await lp.frameLocator('iframe[title="target"][srcdoc]').locator('a[href="/product?id=101"]').first().waitFor({ timeout: 5000 });
    assert(await lp.getByRole('note').filter({ hasText: "Scripts on the target page can't run in this view" }).isVisible(), 'the inline fallback shows the page and says scripts do not run there');
    await lp.close();
  }

  console.log('TR-44: a reflected-XSS payload executes inside the served sandbox frame');
  // The target renders in /lab/target-frame.html (its own sandboxed CSP), not a srcdoc that inherits
  // the page policy, so the learner's script really runs there — shown by the frame's banner.
  await page.getByPlaceholder('/path?query').fill('/search?q=<script>alert(document.domain)</script>');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  const target = page.frameLocator('iframe[title="target"][src$="target-frame.html"]');
  await target.getByText('script executed in your session').first().waitFor({ timeout: 8000 });
  assert(true, 'the payload ran in the sandboxed target frame (alert banner shown)');

  console.log('Recon in the terminal (xterm) — effect visible in the shared Proxy history');
  // The tool switcher is a tablist (role="tab"), not plain buttons.
  await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('whatweb http://shop.aerocart.lab/');
  await page.keyboard.press('Enter');
  // xterm renders to a canvas (text not in the DOM); prove the command ran by its effect on shared state.
  await page.getByRole('tab', { name: /^Proxy/ }).click();
  await page.locator('.htable', { hasText: 'whatweb' }).first().waitFor({ timeout: 8000 });
  assert(true, 'terminal command drove a real request visible in the Proxy history');

  console.log('Run the full engagement through the API, then verify in the UI');
  const sid = await solveViaApi(page, base);

  // After the API run (objectives done, evidence saved), so both toggles carry a count.
  console.log('UI-2/UI-7: on phones the Mission/Activity drawer toggles are tappable and named by their visible label');
  {
    const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, storageState: await context.storageState() });
    const pp = await phone.newPage();
    pp.on('pageerror', e => errors.push(`phone: ${e.message}`));
    await pp.goto(`${base}/lab/`);
    await pp.locator('.rt-right').waitFor();
    for (const w of [320, 375, 430, 600]) {
      await pp.setViewportSize({ width: w, height: 812 });
      // Every column of both toggles must hit the toggle itself, not a tool tab painted over it.
      // The beginner guide sits above the tab row on a phone, so bring the row into view first.
      await pp.locator('.wl-tabs').evaluate(el => el.scrollIntoView({ block: 'center' }));
      const missed = await pp.evaluate(() => ['.wl-tabs .railtoggle:not(.rt-right)', '.rt-right'].map(sel => {
        const b = document.querySelector(sel)!.getBoundingClientRect(); const y = b.top + b.height / 2; let miss = 0;
        for (let x = Math.ceil(b.left) + 1; x < b.right - 1; x += 2) if (!document.elementFromPoint(x, y)?.closest(sel)) miss++;
        return miss;
      }));
      assert(missed[0] === 0 && missed[1] === 0, `${w}px: the Mission and Activity toggles are fully hittable (misses ${missed.join('/')})`);
      const b = (await pp.locator('.rt-right').boundingBox())!;
      await pp.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      await pp.locator('.wl-rail.right.open').waitFor({ timeout: 3000 });
      await pp.getByRole('button', { name: 'Close Activity panel' }).click();
      await pp.locator('.wl-rail.right.open').waitFor({ state: 'detached', timeout: 3000 });
    }
    assert(true, 'a tap on Activity opens the Evidence, findings and story drawer at 320-600 px');
    // The last tool tab is reachable inside the scrolling tab row.
    await pp.getByRole('tab', { name: 'Report' }).click();
    assert(await pp.getByRole('tab', { name: 'Report' }).getAttribute('aria-selected') === 'true', 'the Report tab is reachable in the scrolling tab row');
    // WCAG 2.5.3: each accessible name starts with the visible label (incl. its count), as axe's
    // label-content-name-mismatch compares them (letters and digits only).
    const norm = (x: string) => x.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
    for (const [sel, rest] of [['.wl-tabs .railtoggle:not(.rt-right)', 'objectives and hints'], ['.rt-right', 'evidence findings and story']]) {
      const visible = await pp.locator(sel).evaluate(el => { const c = el.cloneNode(true) as HTMLElement; c.querySelectorAll('.tr-sr').forEach(n => n.remove()); return c.textContent || ''; });
      const name = (/^- button "(.*)"/m.exec(await pp.locator(sel).ariaSnapshot()) || [])[1] || '';
      assert(norm(visible).length > 0 && norm(name).startsWith(norm(visible)) && norm(name).endsWith(rest), `toggle name "${name}" starts with its visible label "${visible.trim()}"`);
    }
    await phone.close();
  }

  await remediateViaApi(page, base, sid);

  // Reload the SPA and confirm the run resumes straight into the workspace (UX-10), no catalog step.
  await page.goto(`${base}/lab/`);
  await page.getByRole('tab', { name: 'Report' }).click();
  await page.getByRole('heading', { name: 'Penetration-Test Report' }).waitFor();
  assert(true, 'the completed report renders in the SPA');
  const body = await page.locator('.report').innerText();
  assert(/Verified fixed/.test(body), 'the report shows verified-fixed findings');

  assert(errors.length === 0, `no uncaught page errors (${errors.join(' | ')})`);
  console.log('\nE2E PASSED');
} catch (e) {
  console.error('\nE2E FAILED:', e);
  try { const p = path.join(os.tmpdir(), 'rt-e2e-fail.png'); await page.screenshot({ path: p, fullPage: true }); console.error('  screenshot:', p); console.error('  url:', page.url()); console.error('  buttons:', await page.getByRole('button').allInnerTexts().catch(() => [])); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close(); httpServer.close();
}
