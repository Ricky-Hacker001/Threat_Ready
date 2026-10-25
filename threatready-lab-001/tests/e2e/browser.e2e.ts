// Browser end-to-end test. Starts the real server on a temporary data file and drives the catalog and the
// console like a learner: track → lab → briefing → fix and verify a finding → report → reset → previous runs.
// Run: npm run build && npm run test:e2e
// axe-core (WCAG 2.1 AA, critical and serious) runs on the runs dialog and an archived report when it is
// installed: AXE_CORE=<axe.min.js>, else the platform's e2e/node_modules copy; without it those checks are skipped.
import { chromium, Page, Locator } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { makeApp } from '../helpers';
import { Store } from '../../server/store';

const root = path.resolve(import.meta.dirname, '../..');
const shots = process.env.SHOTS_DIR; let n = 0;
const shot = async (page: Page, name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${String(++n).padStart(2, '0')}-${name}.png`) }); } };
const assert = (c: any, m: string) => { if (!c) throw new Error(`ASSERT: ${m}`); console.log(`  ✓ ${m}`); };
const axePath = process.env.AXE_CORE || path.join(root, '..', 'e2e', 'node_modules', 'axe-core', 'axe.min.js');
const axeSource = fs.existsSync(axePath) ? fs.readFileSync(axePath, 'utf8') : null;

// The app checks Origin against its own public origin, so the port is fixed before the app is built.
const server = http.createServer(); await new Promise<void>(r => server.listen(Number(process.env.E2E_PORT) || 0, r)); // E2E_PORT pins it; default any free port
const base = `http://localhost:${(server.address() as any).port}`;
// Mounted under /labs as the gateway does: the client is built with base '/labs/'.
server.on('request', express().use('/labs', makeApp(new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tr-e2e-')), 'store.json')), path.join(root, 'dist'), base)));
const exe = fs.existsSync('/opt/pw-browsers/chromium') && fs.statSync('/opt/pw-browsers/chromium').isFile() ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath: exe });
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
// Signed in on onboard: the shared ThreatReady session cookie (resolved by the test identity stub).
await context.addCookies([{ name: 'tr.session_token', value: encodeURIComponent('E2E Learner'), url: base }]);
// tsx (esbuild, keepNames) wraps named helpers in __name(); functions run in the page by evaluate() need it there too.
await context.addInitScript('globalThis.__name = (f) => f;');
const page = await context.newPage();
// The test server has no onboard behind it: the shared header's onboard calls (/api/... outside /labs) fail by design.
const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text() + ' @ ' + (m.location()?.url || '')); });
page.on('response', r => { const u = new URL(r.url()); if (r.status() >= 500 && u.pathname.startsWith('/labs/')) errors.push(`${r.status()} ${u.pathname}`); });
const confirm = async (label: string) => page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
const toast = async (text: string | RegExp) => page.locator('.toast', { hasText: text }).first().waitFor();
const menu = async (item: string) => { await page.getByRole('button', { name: /E2E Learner.*account and lab menu/ }).click(); await page.locator('.ddmenu').getByRole('button', { name: item, exact: true }).click(); };
const enterConsole = async () => { await page.getByRole('dialog', { name: 'Incident briefing' }).waitFor(); await page.getByRole('button', { name: /Next: rules/ }).click(); await page.getByRole('button', { name: 'Enter the console' }).click(); };
/** WCAG 2.1 AA violations (critical and serious) inside one element, or null when axe-core is not installed. */
const axe = async (scope: Locator) => {
  if (!axeSource) return null;
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ content: axeSource });
  return scope.evaluate(async (el) => ((await (window as any).axe.run(el, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] })).violations as any[])
    .filter(v => v.impact === 'critical' || v.impact === 'serious').map(v => `${v.id} ×${v.nodes.length} (${v.nodes[0].target.join(' ')})`));
};
const axeClean = async (scope: Locator, what: string) => { const v = await axe(scope); if (v === null) console.log(`  - axe-core not installed (${axePath}): ${what} not scanned`); else assert(v.length === 0, `axe: no serious or critical WCAG 2.1 AA issues in ${what}${v.length ? ` — ${v.join('; ')}` : ''}`); };

try {
  console.log('Pick a track from the catalog, then the lab, then read the briefing');
  await page.goto(`${base}/labs/`); await page.getByRole('heading', { level: 1, name: 'Work the incident, not the quiz.' }).waitFor(); await shot(page, 'catalog');
  const tracks = page.locator('.lab-tracks');
  assert(await tracks.locator('.lab-track', { hasText: 'Network Security' }).locator('.lab-track-list li', { hasText: 'Flat Network' }).innerText().then(t => t.includes('V1.2')), 'unreleased labs are listed in their track with their release');
  await tracks.getByRole('link', { name: 'Cloud Security', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Cloud Security labs' }).waitFor();
  assert(new URL(page.url()).pathname === '/labs/tracks/cloud-security', 'a track opens on its own URL');
  const card = page.locator('.tr-card', { hasText: 'The Compromised Startup' });
  // No state mirror here (TR_STATE_DURABLE unset), so progress is kept on the lab server, and the card says so.
  assert(await card.innerText().then(t => t.includes('Progress is kept on the ThreatReady lab server')), 'the lab card says where its progress is kept');
  await card.getByRole('button', { name: 'Start lab' }).click();
  await page.getByRole('dialog', { name: 'Incident briefing' }).waitFor();
  assert(new URL(page.url()).pathname === '/labs/TR-CLOUD-001', 'the lab opens on its own URL'); await shot(page, 'briefing');
  await page.getByRole('button', { name: /Next: rules/ }).click(); await page.getByRole('button', { name: 'Enter the console' }).click();
  assert(await page.locator('.simbar').innerText().then(t => t.includes('SIMULATION ENVIRONMENT')), 'persistent simulation banner is shown');
  await shot(page, 'home');

  console.log('Acknowledge the ticket');
  await page.getByRole('navigation', { name: 'Services' }).getByRole('button', { name: 'Incident Center' }).click();
  await page.getByRole('button', { name: 'Acknowledge ticket' }).click(); await toast(/acknowledged/);

  console.log('Navigate to a resource and collect evidence');
  await page.getByRole('navigation', { name: 'Services' }).getByRole('button', { name: 'S3', exact: true }).click();
  await page.getByRole('link', { name: 'aerocart-internal-docs' }).click();
  await page.getByRole('tab', { name: 'Permissions' }).click(); await shot(page, 's3-permissions');
  const vuln = page.locator('.side').getByRole('tab', { name: /Vulnerabilities/ }); await vuln.click();
  assert((await page.locator('.vulnlist li.found, .vulnlist li.done').count()) === 0, 'opening the page did not mark anything as found');

  console.log('Demonstrate the exposure, then report the finding');
  await page.getByRole('button', { name: 'Send request' }).click(); await page.locator('.note', { hasText: '200 OK' }).waitFor();
  await page.getByRole('button', { name: 'Report finding' }).click(); await page.getByRole('radio', { name: /Publicly exposed S3 bucket/ }).check(); await page.getByRole('button', { name: 'Submit finding' }).click(); await toast(/Finding V2 recorded/);
  assert((await page.locator('.vulnlist li.found').count()) === 1, 'the vulnerability list marks the finding as found');

  console.log('Change the configuration, confirm, and verify');
  await page.locator('.panel', { hasText: 'Block public access (bucket settings)' }).getByRole('button', { name: 'Edit' }).click();
  for (const box of await page.locator('.panel', { hasText: 'Block public access (bucket settings)' }).getByRole('checkbox').all()) await box.check();
  await page.getByRole('button', { name: 'Save changes' }).click(); await page.getByRole('dialog').getByText('Potential operational impact').waitFor(); await shot(page, 'confirm'); await confirm('Confirm'); await toast(/Block Public Access settings updated/);
  await page.locator('.side').getByRole('tab', { name: 'Objectives' }).click();
  assert(await page.locator('.objs li', { hasText: 'Remediate and verify: Publicly exposed S3 bucket' }).innerText().then(t => t.includes('run a verification test')), 'fix alone is not counted as verified');
  await page.getByRole('button', { name: 'Send request' }).click(); await page.locator('.note', { hasText: /Blocked by S3 Block Public Access|AccessDenied/ }).waitFor();
  await page.getByLabel('Requester').selectOption({ label: 'role/ac-app-server-role' }); await page.getByRole('button', { name: 'Send request' }).click(); await page.locator('.note', { hasText: '200 OK' }).waitFor();
  await page.locator('.objs li.done', { hasText: 'Remediate and verify: Publicly exposed S3 bucket' }).waitFor(); assert(true, 'objective completes after passing verification tests'); await shot(page, 'verified');

  console.log('A denied destructive action gives meaningful feedback');
  await page.getByRole('button', { name: 'Delete', exact: true }).click(); await confirm('Delete bucket'); await page.locator('.toast', { hasText: 'Access denied' }).waitFor(); assert(true, 'destructive action denied by learner permissions');

  console.log('Other consoles render and progress persists across reload');
  for (const [svc, text] of [['IAM', 'svc-storefront-app'], ['EC2', 'ac-app-server'], ['VPC', 'Network exposure map'], ['CloudTrail', 'StopLogging'], ['CloudWatch', 'ac-app-cpu-high'], ['Lambda', 'ac-order-processor'], ['KMS', 'alias/aerocart-data'], ['Secrets Manager', 'aerocart/prod/db-master'], ['Governance', 'Organization structure'], ['Security Findings', 'Publicly exposed S3 bucket'], ['Lab Objectives', 'Level 1']] as const) {
    await page.getByRole('navigation', { name: 'Services' }).getByRole('button', { name: svc, exact: true }).click(); await page.locator('#main').getByText(text).first().waitFor(); if (['VPC', 'CloudTrail', 'IAM'].includes(svc)) await shot(page, svc.toLowerCase());
  }
  assert(true, 'all eleven service consoles and lab pages render');
  await page.reload(); await page.locator('.side').getByRole('tab', { name: /Vulnerabilities 1\/10/ }).waitFor(); assert(true, 'session progress survives a reload');
  await page.locator('.dock').getByRole('tab', { name: 'Activity' }).click(); await page.locator('.dock', { hasText: 's3.putPublicAccessBlock' }).waitFor(); assert(true, 'activity history lists the accepted actions');
  await menu('Incident report'); await page.getByText('(draft)').waitFor(); await page.locator('tr', { hasText: 'V2' }).getByText('Root cause remediated and verified by test.').waitFor(); await shot(page, 'report'); assert(true, 'draft report reflects the verified finding');
  await page.getByRole('button', { name: 'Back to console' }).click();

  console.log('Reset archives the run; Previous runs opens its report, read-only');
  await menu('Reset lab…');
  const resetDlg = page.getByRole('dialog', { name: 'Reset lab' });
  assert(await resetDlg.innerText().then(t => /Up to 5 runs are kept: your best run, your best completed run and the most recent ones/.test(t)), 'the reset dialog says which runs are kept');
  await resetDlg.getByLabel('Type RESET to confirm').fill('RESET'); await resetDlg.getByRole('button', { name: 'Reset lab', exact: true }).click();
  await toast(/Run 2 started/); await enterConsole();
  await page.locator('.side').getByRole('tab', { name: /Vulnerabilities 0\/10/ }).waitFor(); assert(true, 'the new run starts from the vulnerable environment');
  await menu('Previous runs…');
  const runsDlg = page.getByRole('dialog', { name: 'Previous runs' });
  await runsDlg.locator('tbody tr').nth(1).waitFor(); await shot(page, 'previous-runs');
  assert(await runsDlg.locator('tbody tr').count() === 2, 'both runs are listed');
  // WCAG 2.5.3 Label in Name: the button is named by the words it shows, so "click Draft report" works by voice.
  const run1 = runsDlg.getByRole('button', { name: 'Draft report for run 1', exact: true });
  assert((await run1.innerText()).trim() === 'Draft report', 'the report button\'s accessible name starts with its visible text');
  await axeClean(runsDlg, 'the Previous runs dialog');
  await run1.click();
  await page.getByRole('heading', { level: 1, name: /Incident report — INC-2041 · run 1/ }).waitFor(); await shot(page, 'archived-report');
  await page.locator('tr', { hasText: 'V2' }).getByText('Root cause remediated and verified by test.').waitFor(); assert(true, 'the archived report keeps run 1\'s verified finding');
  const crumb = await page.locator('.crumbs a', { hasText: 'Incident Center' }).evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = (c: string) => { const [r, g, b] = rgb(c).slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    let bg = 'rgb(255, 255, 255)'; for (let p: Element | null = el; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; const a = rgb(c)[3]; if (a === undefined || a > 0) { bg = c; break; } }
    const [x, y] = [lum(getComputedStyle(el).color), lum(bg)]; const cs = getComputedStyle(el);
    return { ratio: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05), underline: cs.textDecorationLine.includes('underline') };
  });
  assert(crumb.ratio >= 4.5, `the breadcrumb link has at least 4.5:1 contrast (${crumb.ratio.toFixed(2)}:1)`);
  assert(crumb.underline, 'the breadcrumb link is underlined, not told apart from the crumb text by colour alone');
  await axeClean(page.locator('#main'), 'the archived incident report');
  assert(await page.locator('#main .note', { hasText: 'Archived run 1.' }).innerText().then(t => t.includes('It is read-only')), 'the archived report says the run is read-only');
  await page.getByRole('button', { name: 'Back to console' }).click();

  console.log('On a phone, Console Home wraps the account line at spaces and hyphens only');
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#main h1', { hasText: 'Console Home' }).waitFor();
  const breaks = await page.locator('#main .desc').first().evaluate((el) => {
    const t = el.firstChild as Text; const text = t.textContent || ''; const r = document.createRange(); const bad: string[] = []; let top: number | null = null;
    for (let i = 0; i < text.length; i++) { r.setStart(t, i); r.setEnd(t, i + 1); const rect = r.getClientRects()[0]; if (!rect) continue; if (top !== null && rect.top > top + 2 && !/[\s-]/.test(text[i - 1])) bad.push(`${text.slice(Math.max(0, i - 6), i)}|${text.slice(i, i + 6)}`); top = rect.top; }
    return { text, bad };
  });
  assert(breaks.text.includes('ap-south-1') && breaks.bad.length === 0, `the account line is not split inside a word (${breaks.bad.join(', ') || 'no mid-word breaks'})`);
  await shot(page, 'phone-home');
  assert(errors.length === 0, `no browser errors (${errors.join(' | ') || 'none'})`);
  console.log('\nBrowser E2E passed');
} catch (e) { if (shots) await page.screenshot({ path: path.join(shots, 'FAILURE.png') }).catch(() => {}); console.error(e, errors); process.exitCode = 1; }
finally { await browser.close(); server.close(); }
