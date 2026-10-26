// Hosted base path check, through a real browser: built with `--base /labs/soc/` and mounted under
// /labs/soc/ (as threatready-lab-001/server/hosted.ts does), the case console's live stream
// (EventSource), the case-file downloads and the record export must all resolve under the base, never
// at the origin root. Optional real-browser check, not part of `npm test` (Playwright is not a
// dependency of this project). To run it:
//   npm run build -- --base /labs/soc/
//   npm install --no-save playwright && npx playwright install chromium     (or PLAYWRIGHT=<module path>)
//   node tests/ui/base-path.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const index = fs.readFileSync(path.join(root, 'client/dist/index.html'), 'utf8');
if (!index.includes('/labs/soc/assets/')) { console.error('client/dist is not built with --base /labs/soc/'); process.exit(1); }
process.env.SOC_SIM_DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soc-base-')), 'cases.json');
process.env.SOC_SIM_NO_LISTEN = '1'; process.env.SOC_SIM_FAST = '1'; process.env.SOC_SIM_TEST = '1'; process.env.DEV_USER = 'base.tester';
const { app: soc } = await import('../../server/index.js');
const { repo } = await import('../../server/repo.js');
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');

const host = express();
host.use('/labs/soc', soc);
host.use((req, res) => res.status(404).type('text').send(`origin-root miss: ${req.method} ${req.url}`));
const server = host.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const exe = fs.existsSync('/opt/pw-browsers/chromium') && fs.statSync('/opt/pw-browsers/chromium').isFile() ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath: exe });
const results = {};
try {
  // Start an attempt as the dev user so a case exists.
  for (const level of ['foundations', 'intermediate']) repo.addAward({ badgeId: `bdg_${level}`, userId: 'base.tester', level, earnedAt: new Date().toISOString(), average: 80, passedCount: 10, internal: true });
  const started = await fetch(`${base}/labs/soc/api/attempts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenarioId: 'F3', canonical: true }) }).then((r) => r.json());
  const page = await browser.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const misses = [];
  page.on('response', (r) => { if (r.status() === 404) misses.push(r.url()); });
  await page.goto(`${base}/labs/soc/#/case/${started.caseId}`);
  await page.waitForFunction(() => document.body.innerText.length > 200, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const stream = requests.filter((u) => /\/api\/cases\/[^/]+\/stream$/.test(u));
  results.streamUnderBase = stream.length > 0 && stream.every((u) => u.startsWith(`${base}/labs/soc/api/cases/`));
  results.noRootApiRequests = !requests.some((u) => u.startsWith(`${base}/api/`));
  results.no404 = misses.length === 0;
  // The record export on the report page navigates to the API: it must land under the base too.
  await page.goto(`${base}/labs/soc/#/report`);
  await page.getByRole('button', { name: 'Download my record (JSON)' }).waitFor({ timeout: 15000 });
  const [exportReq] = await Promise.all([page.waitForRequest((r) => /\/api\/me\/export$/.test(r.url()), { timeout: 10000 }), page.getByRole('button', { name: 'Download my record (JSON)' }).click()]);
  results.recordExportUnderBase = exportReq.url() === `${base}/labs/soc/api/me/export`;
  // Case-file download links (rendered once a case is closed) are built by the same helper; check it from the bundle.
  const bundle = fs.readdirSync(path.join(root, 'client/dist/assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, 'client/dist/assets', f), 'utf8')).join('\n');
  results.noDirectApiLiterals = !/(EventSource\(|href:|location\.href=)["'`]\/api/.test(bundle);
  await page.close();
} finally {
  await browser.close(); server.close();
}
console.log(JSON.stringify(results, null, 2));
const failed = Object.entries(results).filter(([, v]) => v === false);
if (failed.length) { console.error('FAILED:', failed.map(([k]) => k).join(', ')); process.exit(1); }
console.log('base-path check passed');
process.exit(0);
