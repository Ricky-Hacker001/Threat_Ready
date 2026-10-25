/**
 * Inside ThreatReady (SEC-1 / BIZ-04 / TR-27): when /labs/api/me cannot confirm the account, the lab keeps progress
 * in the tab only and says so, never touching the shared key; the next user starts empty; a short 429 is retried.
 * Usage: npx vite build --base /labs/threatwall/ --outDir <dir>, then: node e2e/platform.mjs <dir>
 * (PLAYWRIGHT_MODULE=<path to playwright/index.mjs> to use another Playwright install.)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const DIST = path.resolve(process.argv[2] ?? 'dist');
const PORT = Number(process.env.TW_E2E_PORT ?? 4985);
const LAB = `http://127.0.0.1:${PORT}/labs/threatwall/`;
if (!fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').includes('/labs/threatwall/')) throw new Error(`No /labs/threatwall/ build in ${DIST}`);

let me = [];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, LAB);
  if (url.pathname === '/labs/api/me') {
    const r = (me.length > 1 ? me.shift() : me[0]) ?? { status: 200, body: { id: 'user-a' } };
    if (r === 'hang') return;
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
    res.end(JSON.stringify(r.body ?? { error: 'rate_limited' }));
    return;
  }
  let file = path.join(DIST, decodeURIComponent(url.pathname.replace(/^\/labs\/threatwall\//, '')));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch();
const labKeys = (p) => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('threatwall') || k.startsWith('tw-last-route')).sort());
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').slice(0, 5).join('\n     ')}`); }
}

await check('a /me failure: tab-only progress with a notice, nothing in localStorage; the next user starts empty', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const p = await ctx.newPage();
  me = [{ status: 429, headers: { 'Retry-After': '30' } }];
  await p.goto(LAB);
  const note = p.locator('.tr-notice').filter({ hasText: "Progress won't be saved" });
  await note.waitFor({ timeout: 8000 });
  assert.match(await note.innerText(), /about 30 seconds/);
  assert.match(await p.locator('.tr-honesty').innerText(), /kept in this tab only/);
  await p.fill('.tr-name input', 'Learner A');
  await p.click('[data-guide="start-lab"]');
  await p.locator('.tw-id-notice').waitFor();
  await p.waitForTimeout(600);
  assert.deepEqual(await labKeys(p), [], 'nothing written to localStorage');
  me = [{ status: 200, body: { id: 'user-b', name: 'B' } }];
  await p.goto(LAB + '#/start');
  await p.reload();
  await p.locator('.tr-name input').waitFor();
  assert.equal(await p.locator('.tr-name input').inputValue(), '', "user B does not see A's learner name");
  assert.equal(await p.getByText("Progress won't be saved").count(), 0);
  assert.match(await p.locator('.tr-honesty').innerText(), /not recorded on your ThreatReady profile/);
  await p.waitForTimeout(400);
  assert.ok((await labKeys(p)).every((k) => k.includes(':u:user-b') || k === 'threatwall:legacy-migrated'), String(await labKeys(p)));
  await ctx.close();
});

await check('a short 429 is retried once, then the lab opens for the user', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  me = [{ status: 503, headers: { 'Retry-After': '1' } }, { status: 200, body: { id: 'user-c' } }];
  await p.goto(LAB);
  await p.getByText('ThreatReady is busy. Trying again in 1 second…', { exact: true }).waitFor({ timeout: 4000 });
  await p.locator('.tr-name input').waitFor({ timeout: 8000 });
  assert.equal(await p.getByText("Progress won't be saved").count(), 0);
  await p.waitForTimeout(400);
  assert.ok((await labKeys(p)).includes('threatwall:lab-state:u:user-c'));
  await ctx.close();
});

await check('a 429 that persists through the retry says to reload in about 1 second (singular)', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  me = [{ status: 429, headers: { 'Retry-After': '1' } }];
  await p.goto(LAB);
  const note = p.locator('.tr-notice').filter({ hasText: "Progress won't be saved" });
  await note.waitFor({ timeout: 9000 });
  const text = await note.innerText();
  assert.match(text, /Reload in about 1 second to try again\./);
  assert.doesNotMatch(text, /1 seconds/);
  await ctx.close();
});

await check("a local user's hash from an older save is upgraded on a simulated login (Lab Tools)", async () => {
  const fnv = (pw) => {
    let h = 0x811c9dc5;
    const str = `threatwall:${pw}`;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };
  const KEY = 'threatwall:lab-state:u:user-h';
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const p = await ctx.newPage();
  me = [{ status: 200, body: { id: 'user-h' } }];
  await p.goto(LAB);
  await p.fill('.tr-name input', 'Learner H');
  await p.click('[data-guide="start-lab"]');
  await p.locator('[data-guide="labtools"]').waitFor();
  await p.waitForFunction((k) => !!localStorage.getItem(k), KEY);
  // An older save: local user "legacy" with the pre-PBKDF2 FNV digest (written before the app loads).
  await ctx.addInitScript(([k, hash]) => {
    if (sessionStorage.getItem('legacy-seeded')) return;
    const st = JSON.parse(localStorage.getItem(k));
    st.config.users.local.push({ id: 'u-legacy', name: 'legacy', passwordHash: hash, groups: ['Everyone', 'Staff'], otp: false, vpnAccess: [], comment: '' });
    localStorage.setItem(k, JSON.stringify(st));
    sessionStorage.setItem('legacy-seeded', '1');
  }, [KEY, fnv('Practice#Pass1')]);
  await p.reload();
  const stored = () => p.evaluate((k) => JSON.parse(localStorage.getItem(k)).config.users.local.find((u) => u.id === 'u-legacy')?.passwordHash, KEY);
  await p.locator('[data-guide="labtools"]').waitFor();
  assert.equal(await stored(), fnv('Practice#Pass1'));
  if (!(await p.$('.tw-lab.open'))) await p.click('[data-guide="labtools"]');
  await p.click('[data-guide="labtab:controls"]');
  await p.fill('[data-guide="lab-auth-user"]', 'legacy');
  await p.fill('[data-guide="lab-auth"] input[type=password]', 'Practice#Pass1');
  await p.click('[data-guide="lab-auth-login"]');
  await p.waitForFunction((k) => /^pbkdf2-sha256\$/.test(JSON.parse(localStorage.getItem(k)).config.users.local.find((u) => u.id === 'u-legacy')?.passwordHash ?? ''), KEY, { timeout: 8000 });
  assert.equal(await p.locator('[data-guide="lab-auth"]').getByText('Login failed').count(), 0);
  // The upgraded hash still accepts the same password.
  await p.fill('[data-guide="lab-auth"] input[type=password]', 'Practice#Pass1');
  await p.click('[data-guide="lab-auth-login"]');
  await p.waitForTimeout(1200);
  assert.equal(await p.locator('[data-guide="lab-auth"]').getByText('Login failed').count(), 0);
  await ctx.close();
});

for (const width of [320, 375]) {
  await check(`no sideways scroll at ${width} px with the notice shown; dark colour scheme on the training layer`, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 812 } });
    const p = await ctx.newPage();
    me = [{ status: 429, headers: { 'Retry-After': '30' } }];
    await p.goto(LAB);
    await p.locator('.tr-notice').waitFor({ timeout: 8000 });
    const m = await p.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, scheme: getComputedStyle(document.documentElement).colorScheme }));
    assert.ok(m.overflow <= 0, `home scrolls sideways by ${m.overflow}px`);
    assert.equal(m.scheme, 'dark');
    await p.click('[data-guide="start-lab"]');
    await p.locator('.tw-id-notice').waitFor();
    assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
    await ctx.close();
  });
}

// axe scrollable-region-focusable, in the page: every element that scrolls takes keyboard focus or holds something that does.
const unreachableScrollers = (p) => p.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => {
  const cs = getComputedStyle(el);
  const scrolls = (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) || (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1);
  const focusable = (n) => n.tabIndex >= 0 && !n.disabled && n.getClientRects().length > 0;
  return scrolls && !focusable(el) && ![...el.querySelectorAll('*')].some(focusable);
}).map((el) => (el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`)));

await check('UI-8 at 375 px the training record tables are named regions that scroll sideways from the keyboard', async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const p = await ctx.newPage();
  me = [{ status: 200, body: { id: 'user-r' } }];
  await p.goto(LAB + '#/record');
  await p.getByRole('heading', { name: 'Training record' }).waitFor({ timeout: 8000 });
  for (const name of ['Results by level', 'Task history']) {
    const region = p.getByRole('region', { name, exact: true });
    assert.equal(await region.getAttribute('tabindex'), '0', `${name}: the scroll area takes keyboard focus`);
    assert.ok(await region.evaluate((el) => el.scrollWidth > el.clientWidth), `${name}: the table is wider than the phone (the case under test)`);
    await region.focus();
    for (let i = 0; i < 4; i++) await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(400);
    assert.ok((await region.evaluate((el) => el.scrollLeft)) > 0, `${name}: the arrow keys scroll the table`);
  }
  assert.deepEqual(await unreachableScrollers(p), [], 'regions that scroll without keyboard access');
  await ctx.close();
});

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall platform checks passed');
process.exit(failed ? 1 : 0);
