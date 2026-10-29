// UI regression sweep from the Oct 2026 UI/UX audit (docs/THREATREADY_COMPREHENSIVE_UI_UX_AUDIT.md §12.3):
// every route at the eight audit viewports, with no sideways scrolling, consoles that fit the viewport under the
// lab strip, and axe-core WCAG 2.1 AA (critical and serious fail the run). Chromium only; run cross-browser.mjs
// for engine coverage.
//
//   E2E_USER=asha.rao E2E_PASSWORD=… node ui-audit.mjs          # signed-in apps + the marketing site
//   E2E_SITE=http://localhost:8090 node ui-audit.mjs             # marketing site only (no account needed)
//   E2E_VIEWPORTS=375x812,1366x768 E2E_AXE=0 node ui-audit.mjs   # quicker pass
//   E2E_BASE=… E2E_INTERVIEW=… E2E_LABS=… E2E_AR=…              # other hosts (defaults: local dev)
//   E2E_BROWSER_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" …   # installed Chrome instead
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = process.env.E2E_SITE;
const BASE = process.env.E2E_BASE ?? 'http://localhost:5173';
const INTERVIEW = process.env.E2E_INTERVIEW ?? 'http://localhost:5174/interview-prep';
const LABS = (process.env.E2E_LABS ?? 'http://localhost:5175/labs/').replace(/\/?$/, '/');
const AR = (process.env.E2E_AR ?? 'http://localhost:5176/ar/').replace(/\/?$/, '/');
const USER = process.env.E2E_USER;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN_AXE = process.env.E2E_AXE !== '0';
const VIEWPORTS = (process.env.E2E_VIEWPORTS ?? '320x568,375x812,430x932,768x1024,1024x768,1366x768,1440x900,1920x1080')
  .split(',').map((s) => s.trim().split('x').map(Number));
const AXE_AT = new Set(['375x812', '1440x900']);
const axeSource = fs.readFileSync(path.join(here, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');

if (!SITE && !(USER && PASSWORD)) {
  console.error('Set E2E_SITE (marketing site) and/or E2E_USER + E2E_PASSWORD (a verified test account).');
  process.exit(2);
}

// fit: the page is a full-height console, so the document must not be taller than the viewport.
const routes = [];
if (SITE) {
  const siteDir = path.join(here, '..', 'Landing_Page-main');
  for (const f of fs.readdirSync(siteDir).filter((n) => n.endsWith('.html'))) routes.push({ name: `site ${f}`, url: `${SITE.replace(/\/$/, '')}/${f}` });
}
if (USER && PASSWORD) {
  routes.push(
    { name: 'onboard home', url: `${BASE}/app` },
    { name: 'onboard profile', url: `${BASE}/app/profile` },
    { name: 'InterviewPrep dashboard', url: INTERVIEW },
    { name: 'InterviewPrep new interview', url: `${INTERVIEW}/new` },
    { name: 'InterviewPrep history', url: `${INTERVIEW}/history` },
    { name: 'Labs catalog', url: LABS },
    ...['cloud-security', 'blue-team', 'red-team', 'network-security'].map((t) => ({ name: `Labs track ${t}`, url: `${LABS}tracks/${t}` })),
    { name: 'TR-CLOUD-001 console', url: `${LABS}TR-CLOUD-001`, fit: true, minWidth: 768 },
    { name: 'SOC simulation', url: `${LABS}soc/` },
    { name: 'DevSecOps lab', url: `${LABS}devsecops/` },
    { name: 'ThreatReady Firewall', url: `${LABS}threatwall/` },
    { name: 'Red Team lab', url: `${LABS}redteam/` },
    { name: 'AI Security Lab', url: `${LABS}aisec/` },
    { name: 'Attack Reasoning domains', url: AR },
    { name: 'Attack Reasoning domain', url: `${AR}domains/cloud-security` },
    { name: 'Attack Reasoning history', url: `${AR}history` },
  );
}

const failures = [];
let checks = 0;
const fail = (route, vp, msg) => { failures.push(`${route} @ ${vp}: ${msg}`); console.log(`  ✗ ${route} @ ${vp} — ${msg}`); };

// Static: the site checker owns the rules (FUNC-01, BIZ-01): every sign-in / sign-up / labs link uses the
// one platform URL in tools/sync_shell.py, no link goes to another app host (onboard./labs. subdomains,
// threatready.io/app), plan copy promises nothing the platform lacks, wide tables scroll by keyboard.
// --offline: the DNS lookup of the platform host is CI's job (python3 tools/check_site.py).
if (SITE) {
  const r = spawnSync('python3', [path.join(here, '..', 'Landing_Page-main', 'tools', 'check_site.py'), '--offline'], { encoding: 'utf8' });
  checks++;
  if (r.error) fail('site', 'source', `could not run tools/check_site.py (${r.error.code ?? r.error.message})`);
  else if (r.status !== 0 || r.signal) {
    // A checker that crashed (traceback on stderr, nothing on stdout) is a failure too, never a pass.
    const lines = (r.stdout ?? '').trim().split('\n').filter(Boolean);
    if (lines.length) for (const line of lines) fail('site', 'source', line);
    else fail('site', 'source', `tools/check_site.py ${r.signal ? `was stopped (${r.signal})` : `exited ${r.status}`}: ${(r.stderr ?? '').trim().split('\n').pop() || 'no output'}`);
  }
}

// E2E_BROWSER_PATH: a Chromium-based browser installed on this machine (Chrome, Edge, Brave).
const browser = await chromium.launch(process.env.E2E_BROWSER_PATH ? { executablePath: process.env.E2E_BROWSER_PATH } : {});
let storageState;
if (USER && PASSWORD) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/app$/, { timeout: 15000 });
  storageState = await context.storageState();
  await context.close();
}

for (const [width, height] of VIEWPORTS) {
  const vp = `${width}x${height}`;
  console.log(`\n${vp}`);
  const context = await browser.newContext({ viewport: { width, height }, storageState, bypassCSP: true, isMobile: width < 768, hasTouch: width < 768 });
  for (const r of routes) {
    const page = await context.newPage();
    try {
      await page.goto(r.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(600);
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const sw = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
        const clips = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return true; return false; };
        const off = [];
        for (const el of document.querySelectorAll('body *')) {
          const b = el.getBoundingClientRect();
          if (b.width && b.height && b.right > de.clientWidth + 1 && !clips(el)) off.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''}`);
          if (off.length >= 3) break;
        }
        const noindex = !!document.querySelector('meta[name="robots"][content*="noindex"]');
        return { cw: de.clientWidth, sw, sh: de.scrollHeight, ih: innerHeight, off, title: document.title.trim(), noindex };
      });
      checks++;
      if (m.sw > m.cw + 1) fail(r.name, vp, `horizontal overflow ${m.sw}px in ${m.cw}px (${m.off.join(', ') || 'body'})`);
      else if (m.off.length) fail(r.name, vp, `content past the right edge, clipped: ${m.off.join(', ')}`);
      // Every screen names itself in the tab (WCAG 2.4.2: never the bare "ThreatReady"), and every app shell
      // asks not to be indexed (the gateway sends X-Robots-Tag too; the meta covers previews and static hosts).
      checks++;
      if (!m.title || (!r.name.startsWith('site ') && m.title === 'ThreatReady')) fail(r.name, vp, `generic tab title "${m.title}"`);
      if (!r.name.startsWith('site ')) {
        checks++;
        if (!m.noindex) fail(r.name, vp, 'no <meta name="robots" content="noindex"> in the app shell');
      }
      if (r.fit && width >= (r.minWidth ?? 0)) {
        checks++;
        if (m.sh > m.ih + 1) fail(r.name, vp, `console taller than the viewport: ${m.sh}px in ${m.ih}px`);
      }
      if (RUN_AXE && AXE_AT.has(vp)) {
        await page.addScriptTag({ content: axeSource });
        const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] }))
          .violations.filter((x) => x.impact === 'critical' || x.impact === 'serious')
          .map((x) => `${x.id} ×${x.nodes.length} (${x.nodes[0].target.join(' ').slice(0, 60)})`));
        checks++;
        if (v.length) fail(r.name, vp, `axe: ${v.join('; ')}`);
      }
    } catch (err) {
      fail(r.name, vp, String(err?.message ?? err).split('\n')[0].slice(0, 160));
    }
    await page.close();
  }
  await context.close();
}
await browser.close();

console.log(`\n${checks - failures.length}/${checks} checks passed`);
process.exit(failures.length ? 1 : 0);
