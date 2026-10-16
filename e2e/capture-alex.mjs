// Photographs the 3D interviewer (Alex) for InterviewPrep's 2D photo fallback.
//
//   E2E_USER=… E2E_PASSWORD=… node capture-alex.mjs        # needs the platform running locally with the model
//
// Opens the dev-only /interview-prep/__capture page in Chromium, sets each head/mouth/blink pose and
// saves transparent WebP stills into InterviewPrep/apps/web/public/avatar/alex/. The runtime
// (avatar/InterviewerPhoto.tsx) animates them: lip sync, blinks, head turns. See ASSET_LICENSE.md.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.E2E_BASE ?? 'http://localhost:5173';
const INTERVIEW = process.env.E2E_INTERVIEW ?? 'http://localhost:5174/interview-prep';
const OUT = path.resolve(import.meta.dirname, '../InterviewPrep/apps/web/public/avatar/alex');
const USER = process.env.E2E_USER, PASSWORD = process.env.E2E_PASSWORD;
if (!USER || !PASSWORD) { console.error('Set E2E_USER and E2E_PASSWORD.'); process.exit(2); }

/** The pose grid the runtime expects (keep in sync with InterviewerPhoto.tsx). */
const YAWS = [-1, 0, 1];
const MOUTHS = [0, 0.12, 0.26, 0.42, 0.6];
const BLINKS = [0, 1];

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 700, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(`${BASE}/`);
await page.getByLabel('Username').fill(USER);
await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
await page.getByRole('button', { name: 'Sign in', exact: true }).click();
await page.waitForURL(/\/app$/, { timeout: 20000 });
await page.goto(`${INTERVIEW}/__capture`);
await page.waitForFunction(() => window.__alexCapture?.ready, null, { timeout: 120000 });
await page.waitForTimeout(2500); // textures and environment settle

fs.mkdirSync(OUT, { recursive: true });
const save = async (name, p) => {
  const url = await page.evaluate(async (p) => { window.__alexCapture.set(p); return window.__alexCapture.snap(); }, p);
  const buf = Buffer.from(url.split(',')[1], 'base64');
  fs.writeFileSync(path.join(OUT, `${name}.webp`), buf);
  return buf.length;
};
let total = 0, n = 0;
for (const [yi, yaw] of YAWS.entries()) for (const [mi, mouth] of MOUTHS.entries()) for (const [bi, blink] of BLINKS.entries()) {
  total += await save(`y${yi}_m${mi}_b${bi}`, { yaw, mouth, blink, smile: 0.1 }); n++;
}
total += await save('smile', { yaw: 0, mouth: 0, blink: 0, smile: 0.45 }); n++;
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ version: 1, width: 600, height: 800, yaws: YAWS.length, mouths: MOUTHS.length, blinks: BLINKS.length, smile: true }, null, 2) + '\n');
console.log(`${n} stills, ${(total / 1024).toFixed(0)} KB → ${OUT}`);
await browser.close();
