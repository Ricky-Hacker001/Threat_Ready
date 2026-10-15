// Edge cases for the guided demo, through the real UI.
// Optional real-browser check. Not part of `npm test`, because Playwright is
// not a dependency of this project. To run it:
//   npm start                       (in another terminal)
//   npm install --no-save playwright && npx playwright install chromium
//   node tests/ui/edge-cases.mjs
// Environment: BASE (default http://localhost:4000), OUT (screenshot folder,
// default tests/ui/shots), PLAYWRIGHT (module path, default 'playwright'),
// SOC_SIM_DATA (the server's case store file, to count demo sessions).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const base = process.env.BASE || 'http://localhost:4000';
const out = process.env.OUT || fileURLToPath(new URL('./shots', import.meta.url));
fs.mkdirSync(out, { recursive: true });
const DATA = process.env.SOC_SIM_DATA || fileURLToPath(new URL('../../data/cases.json', import.meta.url));
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const T = (k, extra = '') => `[data-tour~="${k}"]${extra}`;
const R = {};
const step = () => page.locator('.gt-panel').getAttribute('data-step');
const primary = () => page.locator('.gt-foot .btn-primary');
const demos = async () => { await page.waitForTimeout(500); try { return Object.values(JSON.parse(fs.readFileSync(DATA, 'utf8')).cases).filter((c) => c.kind === 'demo').length; } catch { return 0; } };
const next = async (n = 1) => { for (let i = 0; i < n; i++) { await primary().click(); await page.waitForTimeout(450); } };

// 1. Normal simulation is usable without opening either guide.
await page.goto(base + '/#/');
await page.waitForSelector(T('home-level'));
R.homeHasBothEntries = (await page.locator(T('home-demo-start')).count()) === 1 && (await page.locator(T('home-tour-start')).count()) === 1;
R.noTourByDefault = (await page.locator('.gt-panel').count()) === 0;

// 2. Rapid double click on Start creates one demo session.
const before = await demos();
await page.click(T('home-demo-start'));
await page.waitForSelector(T('demo-begin'));
await page.locator(T('demo-begin')).dblclick();
await page.waitForSelector('.gt-panel');
R.oneSessionFromDoubleClick = (await demos()) - before;
const url1 = page.url();

// 3. Required task cannot be skipped; later steps are locked.
await next(5); // 1-console, 1-tiers, 2-ticketbar, 2-tabs, 2-workflow -> 2-terms
R.atTask = await step();
R.skipOfferedOnTask = await page.locator('.gt-foot .link:has-text("Skip this step")').count();
R.primaryOnTask = (await primary().textContent()).trim();
await primary().click(); await page.waitForTimeout(600);
R.emptyCheckStays = await step();
R.emptyCheckMessage = (await page.locator('.gt-result-wrap').textContent()).slice(0, 60);
await page.click('.gt-tools .gt-tool:has-text("Steps")');
R.lockedSteps = await page.locator('.gt-steps button:disabled').count();
R.stepStatuses = (await page.locator('.gt-steps .gt-step-status').allTextContents()).slice(0, 4);
await page.screenshot({ path: `${out}/e-steps.png` });
await page.click('.gt-tools .gt-tool:has-text("Steps")');
// Skipping an explanation is allowed: go back to one and skip it.
await page.click('.gt-foot .btn:has-text("Back")'); await page.waitForTimeout(400);
R.skipOfferedOnInfo = await page.locator('.gt-foot .link:has-text("Skip this step")').count();
await page.click('.gt-foot .link:has-text("Skip this step")'); await page.waitForTimeout(500);
R.afterSkip = await step();

// 4. API failure on a check: message shown, nothing lost, retry works.
for (const [q, t] of [['q1', 'Event'], ['q2', 'Alert'], ['q3', 'Case'], ['q4', 'Incident']]) await page.locator(`.gq-q[data-q="${q}"] label.option`, { hasText: t }).first().click();
await page.route('**/api/demo/*/check', (r) => r.abort());
await primary().click(); await page.waitForTimeout(700);
R.apiFailureNotice = (await page.locator('.gt-body [role="alert"]').textContent().catch(() => null))?.slice(0, 70);
R.stillOnTaskAfterFailure = await step();
await page.screenshot({ path: `${out}/e-api-failure.png` });
await page.unroute('**/api/demo/*/check');
await primary().click(); await page.waitForSelector('.gt-result.gt-ok');
R.retryAfterFailure = 'ok';
await next(); // -> 2-ack
await page.waitForSelector(T('ack'), { timeout: 15000 });
await page.click(T('ack')); await page.waitForSelector('.gt-result.gt-ok');
await next(); // -> 3-feed

// 5. Missing target: the learner leaves the tab the step points at.
R.beforeLeave = await page.locator('.gt-panel').getAttribute('data-target');
await page.click(T('tab-history'));
await page.waitForSelector('.gt-missing', { timeout: 6000 });
R.missingShown = (await page.locator('.gt-missing p').textContent()).slice(0, 60);
R.ringWhileMissing = await page.locator('.gt-ring').count();
await page.screenshot({ path: `${out}/e-missing.png` });
await page.click('.gt-missing .btn:has-text("Take me there")');
await page.waitForSelector('.gt-ring', { timeout: 6000 });
R.recoveredTarget = await page.locator('.gt-panel').getAttribute('data-target');

// 6. Refresh mid-demo resumes at the same step with progress kept.
const at = await step();
await page.reload();
await page.waitForSelector('.gt-panel');
await page.waitForTimeout(600);
R.refreshSameStep = (await step()) === at ? at : `was ${at} now ${await step()}`;
R.refreshSameSession = page.url() === url1;

// 7. Pause, see the resume card, resume.
await page.click('.gt-tools .gt-tool:has-text("Exit")');
await page.screenshot({ path: `${out}/e-exit-menu.png` });
await page.click('.gt-menu-item:has-text("Pause and return home")');
await page.waitForSelector(T('home-level'));
R.pausedToHome = page.url().endsWith('#/');
R.demoNotInCasesList = await page.locator(`${T('home-cases')} tbody tr`).count();
await page.click(T('home-demo-start'));
await page.waitForSelector(T('demo-resume'));
R.resumeCard = (await page.locator(`${T('demo-resume')} p`).first().textContent()).slice(0, 80);
await page.screenshot({ path: `${out}/e-resume.png` });
await page.click(`${T('demo-resume')} .btn-primary`);
await page.waitForSelector('.gt-panel'); await page.waitForTimeout(500);
R.resumedAt = await step();

// 8. Exit midway, then use the normal simulation.
await page.click('.gt-tools .gt-tool:has-text("Exit")');
await page.click('.gt-menu-item:has-text("Exit the demo")');
await page.waitForSelector(T('home-level'));
await page.locator(`${T('home-level')} button:has-text("Open level")`).first().click();
await page.waitForSelector('.scenario');
await page.locator('.scenario .sc-actions button:text-is("Start")').first().click();
await page.waitForSelector('.topbar');
R.normalCaseOpens = /#\/case\//.test(page.url());
R.normalCaseHasNoGuide = (await page.locator('.gt-panel').count()) === 0;
R.normalCaseHasNoDemoTag = (await page.locator('.kind-tag:not(.level-tag)').count()) === 0;
await page.waitForSelector(T('ack'), { timeout: 15000 });
await page.click(T('ack')); await page.waitForSelector(T('stage-form'));
R.normalTicket = (await page.locator('.ticket').textContent()).trim();
R.normalFinaliseRule = await page.locator(`${T('workflow')} .wf-intro`).textContent().then((t) => !/guided demo/i.test(t));
await page.click('.topbar .back');
R.backGoesToLevel = /#\/level\/foundations/.test(page.url());
await page.goto(`${base}/#/`);
await page.waitForSelector(`${T('home-cases')} tbody tr`);
R.casesListed = await page.locator(`${T('home-cases')} tbody tr`).count();

// 9. Restart after partial completion: clean state, new session, old one gone.
await page.click(T('home-demo-start'));
await page.waitForSelector(T('demo-resume'));
const oldId = url1.split('/demo/')[1];
await page.locator(`${T('demo-resume')} .btn`).nth(1).click();
await page.waitForSelector('.gt-panel'); await page.waitForTimeout(500);
R.restartNewSession = page.url() !== url1;
R.restartAtFirstStep = await step();
R.oldSessionGone = (await fetch(`${base}/api/demo/${oldId}`)).status;
R.normalCaseSurvivesRestart = (await (await fetch(`${base}/api/cases`)).json()).length;

// 10. Invalid or expired demo session.
await page.goto(`${base}/#/demo/ffffffffffff`);
await page.waitForSelector('.demo-card');
R.expired = (await page.locator('.demo-card h1').textContent());
await page.screenshot({ path: `${out}/e-expired.png` });
await page.goto(`${base}/#/demo/ffffffffffff/summary`);
await page.waitForSelector('.demo-card');
R.expiredSummary = (await page.locator('.demo-card h1').textContent());
await page.click('.demo-card .btn:has-text("Return home")');
await page.waitForSelector(T('home-level'));

// 11. Walkthrough: start, skip, restart, exit; survives a refresh; never blocks the simulation.
await page.click(T('home-tour-start'));
await page.waitForSelector('.gt-panel');
R.tourFirstButton = (await primary().textContent()).trim();
await primary().click(); await page.waitForTimeout(300);
await page.click('.gt-foot .link:has-text("Skip this step")'); await page.waitForTimeout(300);
R.tourAfterSkip = await step();
await page.reload(); await page.waitForSelector('.gt-panel'); await page.waitForTimeout(400);
R.tourAfterRefresh = await step();
await page.click('.gt-tools .gt-tool:has-text("Exit")');
await page.click('.gt-menu-item:has-text("Restart from the first step")'); await page.waitForTimeout(300);
R.tourRestart = await step();
// The page underneath stays usable while the tour is open.
await page.locator(`${T('home-level')} button:has-text("Open level")`).first().click();
R.homeUsableDuringTour = /#\/level\//.test(page.url());
await page.click('.gt-tools .gt-tool:has-text("Exit")');
await page.click('.gt-menu-item:has-text("Exit the walkthrough")');
await page.waitForTimeout(300);
R.tourClosed = (await page.locator('.gt-panel').count()) === 0;
await page.goto(`${base}/#/`); await page.waitForSelector(T('home-level'));
// Keyboard: Escape collapses the panel; controls are reachable by Tab.
await page.click(T('home-tour-start')); await page.waitForSelector('.gt-panel');
R.focusOnHeading = await page.evaluate(() => document.activeElement?.id);
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
R.escapeCollapses = (await page.locator('.gt-panel.gt-min').count()) === 1;
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
await page.keyboard.press('Tab');
R.tabReaches = await page.evaluate(() => document.activeElement?.textContent);
console.log(JSON.stringify({ R, errors }, null, 1));
await b.close();
