// Browser checks of a build served the way ThreatReady serves it (under /labs/aisec/, with a mocked /labs/api/me).
// Run after
//   npx vite build --base /labs/aisec/ [--outDir <dir>]
// with: node tests/browser.e2e.mjs [<dir>]   (Playwright from ../e2e/node_modules, or PLAYWRIGHT_MODULE=<path>)
// Covers: SEC-1 (a failed account lookup keeps progress in the tab and says when to retry; the next user starts
// empty), the one short retry on 429/503, TR-27 (progress wording matches the labs catalog), TR-20 (the PDF export
// still works on jsPDF 4 / DOMPurify 3), TR-64 (dark-only) and TR-55 (no sideways scroll on a phone).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.argv[2] ?? path.join(here, '..', 'dist'));
const PORT = Number(process.env.AISEC_E2E_PORT ?? 4983);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const LAB = `${ORIGIN}/labs/aisec/`;

const pwPath = process.env.PLAYWRIGHT_MODULE ?? path.join(here, '..', '..', 'e2e', 'node_modules', 'playwright', 'index.mjs');
const { chromium, firefox } = await import(pathToFileURL(pwPath).href);
if (!fs.existsSync(path.join(DIST, 'index.html')) || !fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').includes('/labs/aisec/')) {
  console.error(`No build for /labs/aisec/ in ${DIST}`);
  process.exit(2);
}

/** What /labs/api/me does next: { status, body, headers }; a list is consumed one reply at a time. */
let me = [];
const meReply = () => (me.length > 1 ? me.shift() : me[0]) ?? { status: 200, body: { id: 'user-a', name: 'Ada' } };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === '/labs/api/me') {
    const r = meReply();
    res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(r.headers ?? {}) });
    res.end(JSON.stringify(r.body ?? { error: 'rate_limited', message: 'Too many requests.' }));
    return;
  }
  if (!url.pathname.startsWith('/labs/aisec/')) {
    res.writeHead(404).end();
    return;
  }
  const rel = decodeURIComponent(url.pathname.slice('/labs/aisec/'.length));
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
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
const labKeys = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('aeropay-lab')).sort());
const mission = (page) => page.getByRole('heading', { name: 'Mission Control' });

for (const [label, type] of [['chromium', chromium], ['firefox', firefox]]) {
  let browser;
  try {
    browser = await type.launch();
  } catch (e) {
    console.log(`skip ${label}: ${String(e.message).split('\n').find((l) => /\w/.test(l) && !/^browserType\.launch:\s*$/.test(l))?.trim() ?? 'cannot launch'}`);
    continue;
  }

  await check(`${label}: SEC-1 a /me failure keeps progress in the tab only, with a notice; the next user starts empty`, async () => {
    me = [{ status: 429, headers: { 'Retry-After': '30' } }];
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(LAB);
    const note = page.getByRole('status').filter({ hasText: "Progress won't be saved" });
    await note.waitFor({ timeout: 8000 });
    assert.match(await note.innerText(), /about 30 seconds/);
    await page.getByLabel('Your name').fill('Learner A');
    await page.getByRole('button', { name: 'Enter the lab' }).click();
    await mission(page).waitFor();
    await page.getByRole('button', { name: 'Start Newbie Demo' }).click();
    await page.waitForTimeout(500);
    assert.deepEqual(await labKeys(page), [], 'nothing written to localStorage');
    // Next page load: a different, confirmed user starts with nothing of the failed session.
    me = [{ status: 200, body: { id: 'user-b', name: 'Bea' } }];
    await page.reload();
    await mission(page).waitFor({ timeout: 8000 });
    assert.equal(await page.getByText("Progress won't be saved").count(), 0);
    assert.equal(await page.getByText('In progress:').count(), 0, "user B does not see A's attempt");
    assert.match(await page.locator('main').innerText(), /Welcome back, Bea/);
    const keys = await labKeys(page);
    assert.ok(keys.length > 0 && keys.every((k) => k.endsWith(':user-b')), `keys: ${keys}`);
    await ctx.close();
  });

  await check(`${label}: a short 429 is retried once; TR-27 wording matches the labs catalog`, async () => {
    me = [{ status: 503, headers: { 'Retry-After': '1' } }, { status: 200, body: { id: 'user-c', name: 'Cy' } }];
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(LAB);
    await page.getByText('ThreatReady is busy. Trying again in 1 second…', { exact: true }).waitFor({ timeout: 4000 });
    await mission(page).waitFor({ timeout: 8000 });
    assert.equal(await page.getByText("Progress won't be saved").count(), 0);
    await page.getByText('Progress is kept in this browser and is not recorded on your ThreatReady profile.').waitFor();
    await ctx.close();
  });

  await check(`${label}: a 429 that persists through the retry says to reload in about 1 second (singular)`, async () => {
    me = [{ status: 429, headers: { 'Retry-After': '1' } }];
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(LAB);
    const note = page.getByRole('status').filter({ hasText: "Progress won't be saved" });
    await note.waitFor({ timeout: 9000 });
    const text = await note.innerText();
    assert.match(text, /Reload in about 1 second to try again\./);
    assert.doesNotMatch(text, /1 seconds/);
    await ctx.close();
  });

  await check(`${label}: TR-20 the learning-notebook PDF still exports (jsPDF 4)`, async () => {
    me = [{ status: 200, body: { id: 'user-d', name: 'Dee' } }];
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(LAB);
    await mission(page).waitFor({ timeout: 8000 });
    await page.getByRole('button', { name: /Learning Notebook/ }).click();
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: /Download PDF/ }).click()]);
    const file = await download.path();
    const pdf = fs.readFileSync(file);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.length > 20000, `PDF is ${pdf.length} bytes`);
    assert.match(pdf.toString('latin1'), /\/Subtype \/Image/, 'the logo image is embedded');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await check(`${label}: TR-64 dark colour scheme; TR-55 no sideways scroll at 320 and 375 px`, async () => {
    for (const width of [320, 375]) {
      me = [{ status: 429, headers: { 'Retry-After': '30' } }];
      const ctx = await browser.newContext({ viewport: { width, height: 812 } });
      const page = await ctx.newPage();
      await page.goto(LAB);
      await page.getByText("Progress won't be saved").first().waitFor({ timeout: 8000 });
      const m = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, scheme: getComputedStyle(document.documentElement).colorScheme }));
      assert.ok(m.overflow <= 0, `${width}px: page scrolls sideways by ${m.overflow}px`);
      assert.equal(m.scheme, 'dark');
      await ctx.close();
    }
  });

  await browser.close();
}

server.close();
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
