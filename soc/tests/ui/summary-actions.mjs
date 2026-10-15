// Learning-summary actions: review a step, open the normal simulation, replay.
// Needs a finished demo session, so run guided-demo.mjs first.
// Optional real-browser check. Not part of `npm test`, because Playwright is
// not a dependency of this project. Run it like the other scripts in this folder.
// Environment: BASE, OUT, PLAYWRIGHT, SOC_SIM_DATA (the server's case store file).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const base = process.env.BASE || 'http://localhost:4000';
const out = process.env.OUT || fileURLToPath(new URL('./shots', import.meta.url));
const DATA = process.env.SOC_SIM_DATA || fileURLToPath(new URL('../../data/cases.json', import.meta.url));
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
const store = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const done = Object.values(store.cases).filter((c) => c.kind === 'demo' && c.status === 'closed').pop();
const R = { session: done.ticket };
await page.goto(`${base}/#/demo/${done.id}/summary`);
await page.waitForSelector('[data-tour~="summary-actions"]');
await page.waitForTimeout(2500);
R.noAutoRedirect = page.url().endsWith('/summary');
await page.click('button:has-text("Review a specific step")');
await page.locator('.demo-pick button', { hasText: 'Search and filtering' }).click();
await page.waitForSelector('.gt-panel'); await page.waitForTimeout(1500);
R.reviewLandsOn = await page.locator('.gt-panel').getAttribute('data-step');
R.reviewTarget = await page.locator('.gt-panel').getAttribute('data-target');
R.reviewShowsPassedResult = await page.locator('.gt-foot .btn-primary').textContent();
await page.locator('.gt-foot .btn-primary').click(); await page.waitForTimeout(900);
R.reviewNext = await page.locator('.gt-panel').getAttribute('data-step');
R.reviewPastResult = (await page.locator('.gt-result-wrap').textContent().catch(() => '')).slice(0, 40);
await page.screenshot({ path: `${out}/e-review.png` });
// A review of a closed demo keeps it completed.
R.statusAfterReview = (await (await fetch(`${base}/api/demo/${done.id}`)).json()).progress.status;
await page.goto(`${base}/#/demo/${done.id}/summary`);
await page.waitForSelector('[data-tour~="summary-actions"]');
await page.click('button:has-text("Open normal simulation")');
await page.waitForSelector('[data-tour~="home-level"]'); await page.waitForTimeout(300);
// Scrolled to the levels, or as far towards it as a short page allows.
R.openNormal = page.url().endsWith('#/') && await page.evaluate(() => document.getElementById('your-levels').getBoundingClientRect().top < 200 || scrollY >= document.documentElement.scrollHeight - innerHeight - 2);
await page.click('[data-tour~="home-demo-start"]');
await page.waitForSelector('[data-tour~="demo-resume"]');
R.finishedCard = await page.locator('[data-tour~="demo-resume"] h2').textContent();
await page.locator('[data-tour~="demo-resume"] .btn-primary').click();
await page.waitForSelector('[data-tour~="summary-actions"]');
const normalBefore = (await (await fetch(`${base}/api/cases`)).json()).map((c) => c.id + c.status + c.score).join();
await page.click('button:has-text("Replay demo")');
await page.waitForSelector('.gt-panel'); await page.waitForTimeout(600);
R.replayStep = await page.locator('.gt-panel').getAttribute('data-step');
R.replayNewSession = !page.url().includes(done.id);
R.oldGone = (await fetch(`${base}/api/demo/${done.id}`)).status;
R.normalCasesUntouched = normalBefore === (await (await fetch(`${base}/api/cases`)).json()).map((c) => c.id + c.status + c.score).join();
console.log(JSON.stringify({ R, errors }, null, 1));
await b.close();
