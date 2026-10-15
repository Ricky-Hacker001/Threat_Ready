// Renders the learning notebook (#/notebook) to an A4 PDF in public/notebook/.
// Usage: npm run build && npm run preview   (in one terminal)
//        npm run notebook:pdf               (in another; NB_URL overrides the address)
// Then run `npm run build` again so dist/ contains the fresh PDF.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.env.NB_URL || 'http://localhost:4173/';
const out = 'public/notebook/ThreatReady-Firewall-Learning-Notebook.pdf';
mkdirSync('public/notebook', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${base.replace(/\/?$/, '/')}#/notebook`, { waitUntil: 'networkidle' });
await page.waitForSelector('.nb-paper');
await page.evaluate(() => document.fonts.ready);
await page.emulateMedia({ media: 'print' });
const footer = `<div style="font-family: 'IBM Plex Sans', Arial, sans-serif; font-size: 7.5px; color: #64748b; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between;">
  <span>ThreatReady Firewall · Learning notebook · Aerovant Technologies</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
await page.pdf({
  path: out, format: 'A4', printBackground: true, displayHeaderFooter: true,
  headerTemplate: '<span></span>', footerTemplate: footer,
  margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
});
await browser.close();
console.log(`Wrote ${out}`);
