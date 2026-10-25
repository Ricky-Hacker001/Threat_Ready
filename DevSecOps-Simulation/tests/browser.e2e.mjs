// Browser checks of a build served the way ThreatReady serves it (under /labs/devsecops/, the gateway's CSP, the
// sandbox.html policy from threatready-lab-001/server/hosted.ts, a mocked /labs/api/me). Run after
//   npx vite build --base /labs/devsecops/ [--outDir <dir>]
// with: node tests/browser.e2e.mjs [<dir>]   (Playwright from ../e2e/node_modules, or PLAYWRIGHT_MODULE=<path>)
// Covers: TR-16 (learner code runs at an opaque origin with no network, never reaching the session), UX-REG8 (typing
// does not load a sandbox per keystroke), UI-1 (the tool panel is usable at 320-720 px), SEC-1/BIZ-04 (a failed
// account lookup keeps progress in the tab and shows a notice; the next user starts empty), TR-64 (dark-only).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.argv[2] ?? path.join(here, '..', 'dist'));
const PORT = Number(process.env.DSO_E2E_PORT ?? 4981);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SECRET = 'SESSION-SECRET-7f3a';

const pwPath = process.env.PLAYWRIGHT_MODULE ?? path.join(here, '..', '..', 'e2e', 'node_modules', 'playwright', 'index.mjs');
const { chromium, firefox, webkit } = await import(pathToFileURL(pwPath).href);
if (!fs.existsSync(path.join(DIST, 'index.html')) || !fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').includes('/labs/devsecops/')) {
  console.error(`No build for /labs/devsecops/ in ${DIST}`);
  process.exit(2);
}

// The production page policy (deploy/gateway.mjs) as hosted.ts narrows it for a lab with a sandbox.
let GATEWAY_CSP;
try {
  ({ CONTENT_SECURITY_POLICY: GATEWAY_CSP } = await import(pathToFileURL(path.join(here, '..', '..', 'deploy', 'gateway.mjs')).href));
} catch {
  GATEWAY_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
}
const PAGE_CSP = GATEWAY_CSP.replace(/frame-src (?!'self')/, "frame-src 'self' ");
// The policy hosted.ts sends for sandbox.html (read from the source, so the test follows the server).
let SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; sandbox allow-scripts";
try {
  const hosted = fs.readFileSync(path.join(here, '..', '..', 'threatready-lab-001', 'server', 'hosted.ts'), 'utf8');
  SANDBOX_CSP = /"(default-src 'none';[^"]*'unsafe-eval'[^"]*sandbox allow-scripts[^"]*)"/.exec(hosted)?.[1] ?? SANDBOX_CSP;
} catch {
  /* standalone checkout: use the copy above */
}

/** What /labs/api/me does next: { status, body, headers } or 'hang'; a list is consumed one reply at a time. */
let me = [];
const meReply = () => (me.length > 1 ? me.shift() : me[0]) ?? { status: 200, body: { id: 'user-a', name: 'A' } };
const hits = { sandbox: 0, session: [] };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === '/api/auth/get-session') {
    hits.session.push({ origin: req.headers.origin ?? null, cookie: req.headers.cookie ?? '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(/tr_session=1/.test(req.headers.cookie ?? '') ? { token: SECRET } : null));
    return;
  }
  if (url.pathname === '/labs/api/me') {
    const r = meReply();
    if (r === 'hang') return; // never answers
    res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(r.headers ?? {}) });
    res.end(JSON.stringify(r.body ?? { error: 'rate_limited', message: 'Too many requests.' }));
    return;
  }
  if (!url.pathname.startsWith('/labs/devsecops/')) {
    res.writeHead(404).end();
    return;
  }
  const rel = decodeURIComponent(url.pathname.slice('/labs/devsecops/'.length));
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (rel === 'sandbox.html') hits.sandbox++;
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': rel === 'sandbox.html' ? SANDBOX_CSP : PAGE_CSP });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').slice(0, 6).join('\n     ')}`);
  }
}

const LAB = `${ORIGIN}/labs/devsecops/`;
const seedMode = (uid, mode = 'guided') => ({ key: `devsecops-lab:u:${uid}:progress:v1`, value: JSON.stringify({ mode, results: {} }) });

async function openLab(browser, { viewport = { width: 1366, height: 900 }, seed = [seedMode('user-a')], route = '#/lab/red-build' } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name: 'tr_session', value: '1', url: ORIGIN, httpOnly: true, sameSite: 'Lax' }]);
  await ctx.addInitScript((items) => {
    if (sessionStorage.getItem('seeded')) return;
    for (const { key, value } of items) localStorage.setItem(key, value);
    sessionStorage.setItem('seeded', '1');
  }, seed);
  const page = await ctx.newPage();
  await page.goto(LAB + route);
  return { ctx, page };
}
// axe scrollable-region-focusable, in the page: every element that scrolls takes keyboard focus or holds something that does.
const unreachableScrollers = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .filter((el) => {
        const cs = getComputedStyle(el);
        const scrolls = (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) || (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1);
        const focusable = (n) => n.tabIndex >= 0 && !n.disabled && n.getClientRects().length > 0;
        return scrolls && !focusable(el) && ![...el.querySelectorAll('*')].some(focusable);
      })
      .map((el) => (el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`)),
  );
const termRun = async (page, cmd) => {
  const input = page.locator('input[aria-label="Terminal command"]');
  await input.click();
  await input.fill(cmd);
  await input.press('Enter');
};

// WebKit is skipped (with a note) where the host lacks its libraries.
for (const [label, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
  let browser;
  try {
    browser = await type.launch();
  } catch (e) {
    console.log(`skip ${label}: ${String(e.message).split('\n').find((l) => /\w/.test(l) && !/^browserType\.launch:\s*$/.test(l))?.trim() ?? 'cannot launch'}`);
    continue;
  }

  await check(`${label}: TR-16 learner cart.js runs at an opaque origin and cannot reach the session`, async () => {
    me = [{ status: 200, body: { id: 'user-a', name: 'A' } }];
    const { ctx, page } = await openLab(browser);
    await page.locator('textarea[aria-label^="Code editor"]').waitFor();
    // Control: the page itself (same origin, with the cookie) can read the session.
    assert.ok((await page.evaluate(() => fetch('/api/auth/get-session').then((r) => r.text()))).includes(SECRET));
    hits.session = [];
    const hostile = [
      "let leak = 'none';",
      `try { const x = new XMLHttpRequest(); x.open('GET', '${ORIGIN}/api/auth/get-session', false); x.withCredentials = true; x.send(); leak = 'read:' + x.responseText; } catch (e) { leak = 'blocked ' + e.name; }`,
      "try { fetch('/api/auth/get-session', { credentials: 'include' }).catch(() => {}); } catch (e) {}",
      "let cookie = 'n/a'; try { cookie = String(document.cookie); } catch (e) { cookie = 'blocked'; }",
      "module.exports = { cartTotal: () => 'ORIGIN=' + self.origin + '|' + leak + '|cookie=' + cookie, applyCoupon: () => 0 };",
    ].join('\n');
    await page.locator('textarea[aria-label^="Code editor"]').fill(hostile);
    await page.waitForTimeout(700);
    await termRun(page, 'npm test');
    await page.locator('.term').getByText('ORIGIN=').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    const out = await page.locator('.term').innerText();
    assert.match(out, /ORIGIN=null\|blocked/);
    assert.ok(!out.includes(SECRET), 'the session token never reaches learner code');
    assert.ok(!out.includes('read:'), 'the synchronous request was blocked');
    assert.equal(hits.session.filter((h) => h.cookie.includes('tr_session')).length, 0, `no credentialed request from the sandbox: ${JSON.stringify(hits.session)}`);
    await ctx.close();
  });

  await check(`${label}: TR-16 sandbox.html opened directly is still an opaque origin`, async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${LAB}sandbox.html`);
    assert.equal(await page.evaluate(() => self.origin), 'null');
    await ctx.close();
  });

  await check(`${label}: UX-REG8 typing in cart.js does not load a sandbox per keystroke`, async () => {
    me = [{ status: 200, body: { id: 'user-a', name: 'A' } }];
    const { ctx, page } = await openLab(browser);
    const ed = page.locator('textarea[aria-label^="Code editor"]');
    await ed.waitFor();
    await page.waitForTimeout(1500); // start-up warm-up done
    const before = hits.sandbox;
    await ed.click();
    await page.keyboard.press('End');
    await page.keyboard.type('// twenty-seven characters!', { delay: 25 });
    await page.waitForTimeout(1500);
    assert.ok(hits.sandbox - before <= 1, `sandbox.html loaded ${hits.sandbox - before} times while typing`);
    assert.ok((await page.locator('iframe[sandbox]').count()) <= 1);
    await termRun(page, 'npm test');
    await page.locator('.term').getByText('Tests:').first().waitFor({ timeout: 10000 });
    await ctx.close();
  });

  await check(`${label}: UX-REG8 without a Worker in the sandbox, one cart.js version's globals never reach the next`, async () => {
    me = [{ status: 200, body: { id: 'user-a', name: 'A' } }];
    const { ctx, page } = await openLab(browser);
    // Force sandbox.html's inline fallback (learner code on the frame's own thread).
    await ctx.addInitScript(() => {
      if (self.origin === 'null') {
        try { self.Worker = undefined; } catch {}
      }
    });
    await page.reload();
    const ed = page.locator('textarea[aria-label^="Code editor"]');
    await ed.waitFor();
    const run = async (src) => {
      await ed.fill(src);
      await page.waitForTimeout(700);
      await termRun(page, 'clear');
      await termRun(page, 'npm test');
      await page.locator('.term').getByText('Received:').first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(300);
      return page.locator('.term').innerText();
    };
    const where = "(typeof WorkerGlobalScope !== 'undefined' ? 'worker' : 'frame')";
    const first = await run(`globalThis.__leak = 1; module.exports = { cartTotal: () => 'ctx:' + ${where}, applyCoupon: () => 0 };`);
    assert.match(first, /ctx:frame/, 'the inline fallback was used');
    const second = await run(`module.exports = { cartTotal: () => 'leakSeen:' + (typeof __leak === 'undefined' ? 'none' : __leak), applyCoupon: () => 0 };`);
    assert.match(second, /leakSeen:none/);
    assert.ok((await page.locator('iframe[sandbox]').count()) <= 1);
    await ctx.close();
  });

  for (const width of [320, 375, 430, 720]) {
    await check(`${label}: UI-1 the tool panel is usable at ${width} px`, async () => {
      me = [{ status: 200, body: { id: 'user-a', name: 'A' } }];
      const { ctx, page } = await openLab(browser, { viewport: { width, height: 812 } });
      const input = page.locator('input[aria-label="Terminal command"]');
      await input.waitFor({ state: 'attached' });
      await input.scrollIntoViewIfNeeded();
      const m = await page.evaluate(() => {
        const i = document.querySelector('input[aria-label="Terminal command"]');
        const r = i.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { body: document.querySelector('.tabbody').getBoundingClientRect().height, hit: hit === i, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      assert.ok(m.body > 200, `tool panel body is ${m.body}px tall`);
      assert.ok(m.hit, 'the terminal input is the element under its own centre');
      assert.ok(m.overflow <= 0, `page scrolls sideways by ${m.overflow}px`);
      await termRun(page, 'help');
      await page.locator('.term').getByText('gitleaks').first().waitFor({ timeout: 5000 });
      for (const tab of ['Findings', 'Pipeline', 'Git', 'Activity']) {
        await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
        assert.ok((await page.locator('.tabbody').boundingBox()).height > 200);
      }
      await ctx.close();
    });

    await check(`${label}: UI-8 at ${width} px every tool panel scrolls from the keyboard; the Git panel does not scroll sideways`, async () => {
      me = [{ status: 200, body: { id: 'user-a', name: 'A' } }];
      const { ctx, page } = await openLab(browser, { viewport: { width, height: 812 } });
      await page.locator('input[aria-label="Terminal command"]').waitFor({ state: 'attached' });
      const panel = page.locator('#ws-tabpanel');
      for (const tab of ['Terminal', 'Findings', 'Pipeline', 'Git', 'Activity']) {
        await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
        assert.equal(await panel.getAttribute('tabindex'), '0', `${tab}: the tab panel takes keyboard focus`);
        assert.deepEqual(await unreachableScrollers(page), [], `${tab}: regions that scroll without keyboard access`);
      }
      // Tab from the selected tab reaches the panel.
      await page.getByRole('tab', { name: /^Git/ }).click();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'ws-tabpanel');
      // The long origin URL wraps instead of pushing the sync status off the side of the panel.
      const m = await page.evaluate(() => {
        const p = document.getElementById('ws-tabpanel');
        const sync = p.querySelector('.scanhdr .fresh, .scanhdr .stale');
        return { side: p.scrollWidth - p.clientWidth, syncRight: sync.getBoundingClientRect().right, panelRight: p.getBoundingClientRect().right };
      });
      assert.ok(m.side <= 0, `the Git panel scrolls sideways by ${m.side}px`);
      assert.ok(m.syncRight <= m.panelRight, `the sync status ends ${m.syncRight - m.panelRight}px past the panel`);
      await ctx.close();
    });
  }

  await check(`${label}: SEC-1 a /me failure keeps progress in the tab only, with a notice; the next user starts empty`, async () => {
    me = [{ status: 429, headers: { 'Retry-After': '30' } }];
    const { ctx, page } = await openLab(browser, { seed: [], route: '#/start' });
    const note = page.getByRole('status').filter({ hasText: "Progress won't be saved" });
    await note.waitFor({ timeout: 8000 });
    assert.match(await note.innerText(), /about 30 seconds/);
    await page.locator('.modes button').first().click();
    await page.getByRole('button', { name: /Continue to my labs/ }).click();
    await page.getByRole('heading', { name: 'My DevSecOps labs' }).waitFor();
    assert.match(await page.locator('.dashhead').innerText(), /kept in this tab only/);
    await page.waitForTimeout(500);
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('devsecops-lab')));
    assert.deepEqual(keys, [], `nothing saved to localStorage: ${keys}`);
    // Next page load: a different user, confirmed, starts with nothing of the failed session.
    me = [{ status: 200, body: { id: 'user-b', name: 'B' } }];
    await page.goto(LAB + '#/');
    await page.reload();
    await page.getByRole('button', { name: /get started/ }).first().waitFor({ timeout: 8000 });
    assert.equal(await page.getByRole('button', { name: /My labs|Continue where I left off/ }).count(), 0, 'user B has no progress');
    assert.equal(await page.getByText("Progress won't be saved").count(), 0);
    const after = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('devsecops-lab')));
    assert.ok(after.every((k) => k.startsWith('devsecops-lab:u:user-b:') || k === 'devsecops-lab:legacy-migrated'), `keys: ${after}`);
    await ctx.close();
  });

  await check(`${label}: SEC-1 with /me failing, the shared pre-namespacing key is neither read nor written`, async () => {
    me = [{ status: 503, headers: { 'Retry-After': '20' } }];
    const legacy = JSON.stringify({ mode: 'expert', results: { 'red-build': { score: 99, max: 130, mode: 'expert', minutes: 1, completedAt: 1 } } });
    const { ctx, page } = await openLab(browser, { seed: [{ key: 'devsecops-lab:progress:v1', value: legacy }], route: '#/' });
    await page.getByText("Progress won't be saved").first().waitFor({ timeout: 8000 });
    assert.equal(await page.getByRole('button', { name: /My labs|Continue where I left off/ }).count(), 0, 'the shared progress is not shown');
    assert.equal(await page.evaluate(() => localStorage.getItem('devsecops-lab:progress:v1')), legacy);
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ['devsecops-lab:progress:v1']);
    await ctx.close();
  });

  await check(`${label}: a short 429 is retried once and the lab opens for the user`, async () => {
    me = [{ status: 429, headers: { 'Retry-After': '1' } }, { status: 200, body: { id: 'user-c', name: 'C' } }];
    const { ctx, page } = await openLab(browser, { seed: [seedMode('user-c')], route: '#/labs' });
    await page.getByText('ThreatReady is busy. Trying again in 1 second…', { exact: true }).waitFor({ timeout: 4000 });
    await page.getByRole('heading', { name: 'My DevSecOps labs' }).waitFor({ timeout: 8000 });
    assert.equal(await page.getByText("Progress won't be saved").count(), 0);
    // Same wording as the ThreatReady labs catalog card.
    assert.match(await page.locator('.dashhead').innerText(), /Progress is kept in this browser and is not recorded on your ThreatReady profile/);
    await ctx.close();
  });

  await check(`${label}: a 429 that persists through the retry says to reload in about 1 second (singular)`, async () => {
    me = [{ status: 429, headers: { 'Retry-After': '1' } }];
    const { ctx, page } = await openLab(browser, { route: '#/' });
    const note = page.getByRole('status').filter({ hasText: "Progress won't be saved" });
    await note.waitFor({ timeout: 9000 });
    const text = await note.innerText();
    assert.match(text, /Reload in about 1 second to try again\./);
    assert.doesNotMatch(text, /1 seconds/);
    await ctx.close();
  });

  await check(`${label}: a /me that never answers ends in the tab-only notice, not a blank page`, async () => {
    me = ['hang'];
    const { ctx, page } = await openLab(browser, { route: '#/' });
    await page.getByText("We couldn't reach ThreatReady").waitFor({ timeout: 9000 });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
    await ctx.close();
  });

  await browser.close();
}

server.close();
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
