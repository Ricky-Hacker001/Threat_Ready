// Cross-browser journeys across every ThreatReady app: sign-in, home, theme, menus, profile, admin,
// InterviewPrep (incl. the 2D interviewer), Lab Simulations (tracks and every live lab) and Attack Reasoning — in Chromium,
// Firefox and WebKit (Safari's engine), at desktop and phone width.
//
//   E2E_USER=asha.rao E2E_PASSWORD=… node cross-browser.mjs            # all installed browsers
//   E2E_BROWSERS=firefox node cross-browser.mjs                         # one browser
//   E2E_BROWSERS=chromium E2E_BROWSER_PATH=/usr/bin/brave-browser …      # Brave/Edge/Chrome itself
//   E2E_BASE=… E2E_INTERVIEW=… E2E_LABS=… E2E_AR=…                    # other hosts (defaults: local dev)
//
// The account must exist and be verified; give it the admin role to cover the admin console.
import { chromium, firefox, webkit } from 'playwright';

const BASE = process.env.E2E_BASE ?? 'http://localhost:5173';
const INTERVIEW = process.env.E2E_INTERVIEW ?? 'http://localhost:5174/interview-prep';
const LABS = process.env.E2E_LABS ?? 'http://localhost:5175/labs/';
const AR = process.env.E2E_AR ?? 'http://localhost:5176/ar/';
const USER = process.env.E2E_USER;
const PASSWORD = process.env.E2E_PASSWORD;
if (!USER || !PASSWORD) {
  console.error('Set E2E_USER and E2E_PASSWORD (a verified test account).');
  process.exit(2);
}
const ENGINES = { chromium, firefox, webkit };
const wanted = (process.env.E2E_BROWSERS ?? 'chromium,firefox,webkit').split(',').map((s) => s.trim());

const results = [];
const record = (browser, viewport, name, ok, detail = '') => {
  results.push({ browser, viewport, name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function check(browser, viewport, name, fn) {
  try {
    const detail = await fn();
    record(browser, viewport, name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    record(browser, viewport, name, false, String(err?.message ?? err).split('\n')[0].slice(0, 200));
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** No sideways scrolling: the page fits the viewport width. */
async function noOverflow(page) {
  const [client, scroll] = await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]);
  assert(scroll <= client + 1, `horizontal overflow: ${scroll}px content in ${client}px`);
}

async function run(name, engine) {
  let browser;
  try {
    // E2E_BROWSER_PATH: a Chromium-based browser installed on this machine (Brave, Edge, Chrome).
    browser = await engine.launch(name === 'chromium' && process.env.E2E_BROWSER_PATH ? { executablePath: process.env.E2E_BROWSER_PATH } : {});
  } catch (err) {
    console.log(`\n${name}: could not launch (${String(err.message).split('\n')[0]}) — skipped`);
    results.push({ browser: name, viewport: '-', name: 'launch', ok: false, detail: 'browser could not start on this host' });
    return;
  }
  console.log(`\n${name} ${browser.version()}`);
  // Sign in once per browser and reuse the session: onboard rate-limits sign-ins (5/min per IP).
  let storageState;
  for (const vp of [{ label: 'desktop', width: 1280, height: 860 }, { label: 'phone', width: 375, height: 812 }]) {
    console.log(` [${vp.label} ${vp.width}px]`);
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, storageState });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message} @ ${page.url()}`));
    // Requests cancelled by navigating to the next page are not failures.
    page.on('requestfailed', (r) => { if (/woff2?|font/.test(r.url()) && !/ABORTED|cancelled/i.test(r.failure()?.errorText ?? '')) errors.push(`font request failed (${r.failure()?.errorText}): ${r.url().split('/').pop()}`); });
    page.on('console', async (m) => {
      if (m.type() !== 'error') return;
      // Object arguments print as "JSHandle@object"; resolve them so failures are readable.
      const where = m.location()?.url ? ` (${m.location().url.split('/').pop()}:${m.location().lineNumber})` : '';
      const parts = await Promise.all(m.args().map((a) => a.evaluate((v) => (v instanceof Error ? `${v.name}: ${v.message}` : typeof v === 'object' ? JSON.stringify(v)?.slice(0, 200) : String(v))).catch(() => null)));
      const t = (parts.every((p) => p !== null) && parts.length ? parts.join(' ') : m.text()) + where;
      // Expected: the 3D model is absent on some hosts; resource 4xx are reported by fetch callers.
      if (/Failed to load resource|interviewer-model|status of 40[14]/i.test(t)) return;
      // Firefox reports a font download cancelled by navigation as an error; real failures surface via requestfailed.
      if (/downloadable font: download failed/i.test(t)) return;
      // three.js reports a texture whose blob was released because the page was left while the 3D model decoded.
      if (/THREE\.GLTFLoader: Couldn't load texture blob:/.test(t)) return;
      errors.push(`console: ${t.slice(0, 160)} @ ${page.url()}`);
    });
    const c = (label, fn) => check(name, vp.label, label, fn);
    // Diagnostics: the Labs catalog list must be an array.
    page.on('response', async (r) => {
      if (!/\/labs\/api\/labs$/.test(new URL(r.url()).pathname)) return;
      const cache = r.headers()['cache-control'] ?? '';
      if (!/no-store/.test(cache)) errors.push(`labs list is cacheable (cache-control: ${cache || 'none'})`);
      if (r.status() !== 200) return;
      const body = await r.text().catch(() => null); // unreadable once the page has navigated away
      if (body && !body.trim().startsWith('[')) errors.push(`labs list response ${r.status()} ${r.headers()['content-type']}: ${body.slice(0, 160)}`);
    });

    await c(storageState ? 'signed in (session reused)' : 'sign in on onboard', async () => {
      if (storageState) {
        await page.goto(`${BASE}/app`);
      } else {
        await page.goto(`${BASE}/`);
        await page.getByLabel('Username').fill(USER);
        await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.waitForURL(/\/app$/, { timeout: 15000 });
      }
      await page.getByRole('heading', { name: /welcome back/i }).waitFor({ timeout: 15000 });
      storageState = await context.storageState();
      await noOverflow(page);
    });

    await c('home: continue strip and products', async () => {
      await page.getByRole('heading', { name: /continue where you left off/i }).waitFor();
      const products = await page.locator('.feature').count();
      assert(products === 3, `expected 3 products, saw ${products}`);
    });

    await c('theme toggle (shared across apps)', async () => {
      const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      await page.locator('.tr-theme-btn').first().click();
      const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      assert(before !== after, 'theme did not change');
      await page.goto(LABS);
      await page.getByRole('heading', { name: /work the incident/i }).waitFor({ timeout: 15000 });
      const labsTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      assert(labsTheme === after, `Lab Simulations theme ${labsTheme} ≠ ${after}`);
      await page.goto(`${BASE}/app`);
      await page.locator('.tr-theme-btn').first().click(); // restore
    });

    await c('account menu lists every app', async () => {
      await page.locator('.tr-menu-btn').click();
      await page.locator('.tr-menu-pop').waitFor();
      const items = await page.locator('.tr-menu-pop .tr-menu-item').allInnerTexts();
      for (const want of ['Profile and progress', 'Sign out']) assert(items.some((t) => t.includes(want)), `menu lacks ${want}`);
      if (vp.width < 900) for (const want of ['InterviewPrep', 'Lab Simulations', 'Attack Reasoning Lab']) assert(items.some((t) => t.includes(want)), `phone menu lacks ${want}`);
      await page.keyboard.press('Escape');
      assert((await page.locator('.tr-menu-pop').count()) === 0, 'Escape did not close the menu');
    });

    await c('profile: progress from every app', async () => {
      await page.goto(`${BASE}/app/profile`);
      await page.locator('.app-card').nth(2).waitFor({ timeout: 15000 });
      await page.waitForFunction(() => !document.querySelector('.tr-skel'), null, { timeout: 15000 });
      const unavailable = await page.locator('.app-card-error').count();
      assert(unavailable === 0, `${unavailable} app card(s) could not load`);
      await noOverflow(page);
    });

    await c('admin console', async () => {
      await page.goto(`${BASE}/app/admin`);
      await page.getByRole('heading', { name: 'Admin console' }).waitFor({ timeout: 15000 });
      await page.locator('.tile').first().waitFor({ timeout: 15000 });
      await noOverflow(page);
    });

    await c('InterviewPrep: shared shell and sub-navigation', async () => {
      await page.goto(INTERVIEW);
      await page.locator('.tr-nav').waitFor({ timeout: 20000 });
      await page.locator('.subnav').getByText('History').waitFor();
      await page.getByRole('heading', { name: /welcome back/i }).waitFor();
      await noOverflow(page);
    });

    await c('InterviewPrep: 2D interviewer animates', async () => {
      // Tell InterviewPrep the 3D model is unavailable, so the 2D interviewer renders from the start.
      await page.addInitScript(() => sessionStorage.setItem('tr-ivw-model-unavailable', '1'));
      await page.goto(INTERVIEW);
      // The dashboard shows the interviewer as decoration (aria-hidden), so select the element itself.
      await page.locator('svg.ivw-portrait').first().waitFor({ timeout: 20000 });
      if (await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)) return 'reduced motion: static';
      const sample = () => page.evaluate(() => ['.ivw-p-head', '.ivw-p-lids', '.ivw-p-lips'].map((s) => {
        const el = document.querySelector(s);
        return `${el?.style.transform ?? ''}${el?.getAttribute('d') ?? ''}`;
      }).join('|'));
      const seen = new Set([await sample()]);
      for (let i = 0; i < 6 && seen.size < 2; i++) { await page.waitForTimeout(300); seen.add(await sample()); }
      assert(seen.size > 1, 'no motion in the 2D interviewer');
    });

    await c('InterviewPrep: new-interview flow opens', async () => {
      await page.goto(`${INTERVIEW}/new`);
      await page.getByRole('heading', { name: /start with your resume/i }).waitFor({ timeout: 15000 });
      await noOverflow(page);
    });

    await c('Lab Simulations: tracks, a track and a lab', async () => {
      await page.goto(LABS);
      await page.getByRole('heading', { name: /work the incident/i }).waitFor({ timeout: 15000 });
      const tracks = await page.locator('.lab-track h3').allInnerTexts();
      assert(['Cloud Security', 'Blue Team', 'Red Team', 'Network Security'].every((t) => tracks.includes(t)), `tracks: ${tracks.join(', ')}`);
      await noOverflow(page);
      await page.getByRole('link', { name: 'Cloud Security', exact: true }).click();
      await page.getByRole('heading', { name: 'Cloud Security labs' }).waitFor();
      await noOverflow(page);
      await page.locator('.tr-card', { hasText: 'The Compromised Startup' }).getByRole('button', { name: /(start|continue|review) lab/i }).click();
      await page.waitForURL(/\/labs\/TR-CLOUD-001/);
      await page.locator('.top').waitFor({ timeout: 20000 }); // the AWS-style console (kept as is by design)
    });

    await c('Lab Simulations: SOC, DevSecOps, Firewall and Red Team labs open signed in', async () => {
      const open = async (slug, lab) => {
        await page.goto(`${LABS}tracks/${slug}`);
        await page.locator('.tr-card', { hasText: lab }).getByRole('link', { name: 'Open lab' }).click();
        await page.waitForLoadState('load');
      };
      await open('blue-team', 'SOC Simulation');
      // Signed in with the ThreatReady account (no name sign-in), with a way back to the catalog.
      await page.locator('.name-chip').getByRole('link', { name: 'All labs' }).waitFor({ timeout: 20000 });
      await open('cloud-security', 'DevSecOps Lab');
      await page.waitForFunction(() => document.title.includes('DevSecOps') && document.getElementById('root')?.childElementCount, null, { timeout: 20000 });
      await open('network-security', 'ThreatReady Firewall');
      await page.waitForFunction(() => document.title.includes('Firewall') && document.getElementById('root')?.childElementCount, null, { timeout: 20000 });
      await open('red-team', 'AeroCart');
      await page.getByRole('link', { name: 'All labs' }).first().waitFor({ timeout: 20000 });
    });

    await c('Attack Reasoning: filter and scenario page', async () => {
      await page.goto(AR);
      await page.getByRole('heading', { name: /think like a defender/i }).waitFor({ timeout: 15000 });
      await page.getByRole('button', { name: 'Cloud Security', exact: true }).click();
      await page.getByText(/in Cloud Security/).waitFor();
      await page.locator('.ar-card-link').first().click();
      await page.getByRole('heading', { name: 'The situation' }).waitFor();
      await noOverflow(page);
    });

    await c('no script errors on any page', async () => {
      assert(errors.length === 0, errors.slice(0, 3).join(' || '));
    });
    await context.close();
  }
  await browser.close();
}

for (const name of wanted) {
  if (!ENGINES[name]) continue;
  await run(name, ENGINES[name]);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  ✗ [${f.browser} ${f.viewport}] ${f.name}: ${f.detail}`);
process.exit(failed.length ? 1 : 0);
