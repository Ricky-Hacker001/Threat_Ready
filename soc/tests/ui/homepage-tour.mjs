// Walks the 13-step homepage walkthrough and reports highlight and arrow status per step.
// Optional real-browser check. Not part of `npm test`, because Playwright is
// not a dependency of this project. To run it:
//   npm start                       (in another terminal)
//   npm install --no-save playwright && npx playwright install chromium
//   node tests/ui/homepage-tour.mjs [width height tag]
// Environment: BASE (default http://localhost:4000), OUT (screenshot folder,
// default tests/ui/shots), PLAYWRIGHT (module path, default 'playwright').
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const base = process.env.BASE || 'http://localhost:4000';
const out = process.env.OUT || fileURLToPath(new URL('./shots', import.meta.url));
fs.mkdirSync(out, { recursive: true });
const [,, W = '1440', H = '900', tag = 'd'] = process.argv;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: +W, height: +H } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const before = await (await fetch(base + '/api/cases')).json();
await page.goto(base + '/#/');
await page.waitForSelector('[data-tour~="home-learn"]');
await page.screenshot({ path: `${out}/${tag}-home.png` });
await page.click('[data-tour~="home-tour-start"]');
const report = [];
for (let i = 0; i < 13; i++) {
  await page.waitForSelector('.gt-panel');
  await page.waitForTimeout(i >= 3 && i <= 11 ? 2600 : 900);
  const info = await page.evaluate(() => {
    const p = document.querySelector('.gt-panel').getBoundingClientRect();
    const r = document.querySelector('.gt-ring')?.getBoundingClientRect();
    const ov = r ? Math.max(0, Math.min(p.right, r.right) - Math.max(p.left, r.left)) * Math.max(0, Math.min(p.bottom, r.bottom) - Math.max(p.top, r.top)) : 0;
    return {
      title: document.querySelector('#gt-title').textContent,
      eyebrow: document.querySelector('.gt-eyebrow').textContent,
      ring: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null,
      arrow: !!document.querySelector('.gt-arrow line'),
      missing: !!document.querySelector('.gt-missing'),
      notice: document.querySelector('.gt-result.gt-bad')?.textContent || null,
      overlap: Math.round(ov), ringArea: r ? Math.round(r.width * r.height) : 0,
      inView: r ? r.top >= -6 && r.left >= -6 && r.top < innerHeight : null,
      hash: location.hash,
    };
  });
  report.push(info);
  await page.screenshot({ path: `${out}/${tag}-tour-${String(i + 1).padStart(2, '0')}.png` });
  const btn = page.locator('.gt-foot .btn-primary');
  await btn.click();
}
await page.waitForTimeout(500);
const after = await (await fetch(base + '/api/cases')).json();
console.log(JSON.stringify({ report, panelGone: !(await page.$('.gt-panel')), hash: await page.evaluate(() => location.hash), casesBefore: before.length, casesAfter: after.length, errors }, null, 1));
await b.close();
