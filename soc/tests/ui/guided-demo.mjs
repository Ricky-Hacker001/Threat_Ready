// Drives Newbie Demo Mode end to end through the real UI.
// Optional real-browser check. Not part of `npm test`, because Playwright is
// not a dependency of this project. To run it:
//   npm start                       (in another terminal)
//   npm install --no-save playwright && npx playwright install chromium
//   node tests/ui/guided-demo.mjs [width height tag]
// Environment: BASE (default http://localhost:4000), OUT (screenshot folder,
// default tests/ui/shots), PLAYWRIGHT (module path, default 'playwright').
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const base = process.env.BASE || 'http://localhost:4000';
const out = process.env.OUT || fileURLToPath(new URL('./shots', import.meta.url));
fs.mkdirSync(out, { recursive: true });
const [,, W = '1440', H = '900', tag = 'd', stopAt = ''] = process.argv;
const ATK = '203.0.113.253';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: +W, height: +H } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const mobile = +W < 761;
const log = [];
const T = (k, extra = '') => `[data-tour~="${k}"]${extra}`;
const panel = () => page.locator('.gt-panel');
const stepId = () => panel().getAttribute('data-step');
const primary = () => page.locator('.gt-foot .btn-primary');
const hide = async () => { if (mobile && !(await page.$('.gt-panel.gt-min'))) await page.click('.gt-tools .gt-tool:has-text("Hide")'); };
const show = async () => { if (await page.$('.gt-panel.gt-min')) await page.click('.gt-tools .gt-tool:has-text("Show")'); };
const wf = (sel) => page.locator(`${T('workflow')} ${sel}`);
const fldRadio = (fld, text) => page.locator(`${T('fld')}[data-fld="${fld}"] label.option`, { hasText: text }).first().click();
const quizRadio = (q, text) => page.locator(`.gq-q[data-q="${q}"] label.option`, { hasText: text }).first().click();
const tab = (k) => page.click(T(`tab-${k}`));
const search = async (q, chip) => {
  await tab('search');
  await page.fill(T('search-input'), q);
  await page.click(T('search-run'));
  if (chip) await page.locator(`${T('search-sources')} .chip`, { hasText: chip }).click();
  await page.waitForTimeout(700);
};
const runTool = async (tool, input) => {
  await tab('tools');
  await page.click(`${T('tool')}[data-tool="${tool}"]`);
  if (input !== undefined) await page.locator(`${T('tool-form')} .tool-inputs input`).first().fill(input);
  await page.locator(`${T('tool-form')} button[type=submit]`).click();
  await page.waitForTimeout(600);
};
const act = async (type, target, kind) => {
  await page.selectOption('#act-type', type);
  if (kind === 'text') await page.fill(`${T('composer')} input[aria-label="Target"]`, target);
  else await page.locator(`${T('composer')} select`).nth(1).selectOption(target);
  const n = await page.locator(`${T('action-log')} ol.actions > li`).count();
  await page.locator(`${T('composer')} button[type=submit]`).click();
  await page.waitForFunction((k) => document.querySelectorAll('[data-tour~="action-log"] ol.actions > li').length > k, n, { timeout: 8000 });
  await page.waitForTimeout(300);
};
const pinRow = async (rowSel) => {
  const row = page.locator(rowSel).first();
  await row.scrollIntoViewIfNeeded();
  const btn = row.locator(T('pin'));
  if ((await btn.textContent()).trim() === 'Pin') await btn.click();
  await page.waitForTimeout(350);
};
const visibleRows = (extra = '') => `.main .panel:visible tr${T('log-row')}${extra}`;
const snap = async (name) => page.screenshot({ path: `${out}/${tag}-demo-${name}.png` });
const state = async () => page.evaluate(() => {
  const p = document.querySelector('.gt-panel');
  const pr = p.getBoundingClientRect();
  const r = document.querySelector('.gt-ring')?.getBoundingClientRect();
  const ov = r ? Math.max(0, Math.min(pr.right, r.right) - Math.max(pr.left, r.left)) * Math.max(0, Math.min(pr.bottom, r.bottom) - Math.max(pr.top, r.top)) : 0;
  return { id: p.dataset.step, target: p.dataset.target, ring: !!r, arrow: !!document.querySelector('.gt-arrow line'), overlapPct: r ? Math.round((ov / (r.width * r.height)) * 100) : 0, eyebrow: document.querySelector('.gt-eyebrow')?.textContent };
});
const waitOk = async (ms = 9000) => page.waitForSelector('.gt-result.gt-ok, .gt-result.gt-warn', { timeout: ms });
const check = async () => { await show(); await primary().click(); await page.waitForFunction(() => !/Checking/.test(document.querySelector('.gt-foot .btn-primary')?.textContent || ''), null, { timeout: 8000 }); await page.waitForTimeout(250); };
const resultText = async () => (await page.locator('.gt-result-wrap').textContent().catch(() => '')) || '';

const SUMMARY = 'What happened: fourteen failed logons and then a success for r.delgado on WEB01 from 203.0.113.253. It is malicious: threat intelligence reports the address and it is not a company address. Evidence: pinned 4625 and 4624 events and firewall lines. Likely cause: a guessable password with no lockout. Impact: about 22 MB of data transferred from the portal. Still not known: exactly which records were viewed.';

const tasks = {
  '2-terms': async () => {
    await quizRadio('q1', 'Alert'); await quizRadio('q2', 'Alert'); await quizRadio('q3', 'Case'); await quizRadio('q4', 'Incident');
    await check(); log.push(['2-terms wrong', (await resultText()).slice(0, 90)]); await snap('02-terms-wrong');
    await quizRadio('q1', 'Event');
    await check();
  },
  '2-ack': async () => { await hide(); await page.waitForSelector(T('ack'), { timeout: 15000 }); await snap('02-ack'); await page.click(T('ack')); },
  '3-open': async () => { await hide(); await page.locator(`${T('alert-matched')} ${T('row-toggle')}`).nth(3).click(); await check(); },
  '4-fields': async () => {
    await page.click('.gq-modes button:has-text("Show me an example")'); await page.waitForTimeout(200); await snap('04-example');
    await page.click('.gq-modes button:has-text("Try it myself")');
    for (const [q, v] of [['who', 'target_user'], ['from', 'host'], ['what', 'event_id'], ['result', 'failure_reason']]) await page.selectOption(`.gq-q[data-q="${q}"] select`, v);
    await check(); log.push(['4-fields wrong', (await page.locator('.gq-q[data-q="from"] .gq-note').textContent()).slice(0, 110)]); await snap('04-fields-wrong');
    await page.selectOption('.gq-q[data-q="from"] select', 'src_ip');
    await check();
  },
  '5-task': async () => {
    await hide(); await search('event_id:4625'); await check(); log.push(['5-task broad', (await resultText()).slice(0, 110)]); await snap('05-broad');
    await hide(); await search(`event_id:4625 src_ip:${ATK}`); await check();
  },
  '6-compare': async () => {
    await quizRadio('typo', 'Pattern A'); await quizRadio('inv', 'Both equally');
    for (const t of ['Many failures in a row', 'evenly spaced', 'not a company computer', 'account name appears']) await page.locator('.gq-q[data-q="obs"] label.option', { hasText: t }).click();
    await check(); log.push(['6 wrong', (await page.locator('.gq-q[data-q="obs"] .gq-note').textContent()).slice(0, 110)]); await snap('06-wrong');
    await quizRadio('inv', 'Pattern B'); await page.locator('.gq-q[data-q="obs"] label.option', { hasText: 'account name appears' }).click();
    await check();
  },
  '7-open': async () => { await hide(); await page.locator(`${T('alert-matched')} tr[data-event="4624"] ${T('row-toggle')}`).first().click(); await check(); },
  '7-facts': async () => {
    await page.fill('.gq-q[data-q="who"] input', 'r.delgado'); await page.fill('.gq-q[data-q="from"] input', ATK);
    await quizRadio('to', 'WEB01'); await quizRadio('result', 'succeeded'); await quizRadio('noise', 'logon_id');
    await check();
  },
  '8-intel': async () => { await hide(); await runTool('reputation', ATK); await snap('08-intel'); },
  '8-directory': async () => { await hide(); await runTool('user', 'r.delgado'); await runTool('change'); },
  '8-classify': async () => {
    await hide();
    await page.fill('#f-source', ATK); await page.selectOption('#f-account', 'r.delgado');
    await fldRadio('verdict', 'Benign true positive'); await fldRadio('severity', 'Medium');
    await check(); log.push(['8-classify wrong', (await resultText()).slice(0, 260)]); await snap('08-classify-wrong');
    await hide(); await fldRadio('verdict', 'True positive: malicious'); await fldRadio('severity', 'High');
    await check();
  },
  '9-pin': async () => { await hide(); await tab('alert'); await pinRow(`${T('alert-matched')} tr[data-event="4625"]`); await pinRow(`${T('alert-matched')} tr[data-event="4624"]`); },
  '9-select': async () => {
    await hide();
    const boxes = page.locator(`${T('fld')}[data-fld="evidence"] input[type=checkbox]`);
    for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check();
    await check();
  },
  '10-decide': async () => {
    await hide(); await fldRadio('decision', 'Close as benign'); await page.fill('#f-note', 'Fourteen failed logons then a success for r.delgado on WEB01 from an outside address reported for password guessing.');
    await wf(T('submit')).click(); await page.waitForTimeout(900);
    log.push(['10 wrong decision', (await page.locator(`${T('fld')}[data-fld="decision"] .fld-msg`).textContent()).slice(0, 120)]); await snap('10-returned');
    await fldRadio('decision', 'Escalate to Tier 2'); await wf(T('submit')).click();
  },
  '10-handoff': async () => {
    await hide(); await page.selectOption('#f-host', 'WEB01');
    await page.locator(`${T('fld')}[data-fld="iocs"] button:has-text("Add indicator")`).click();
    await page.locator(`${T('fld')}[data-fld="iocs"] select`).selectOption('ip');
    await page.locator(`${T('fld')}[data-fld="iocs"] input`).fill(ATK);
    await fldRadio('priority', 'P2'); await page.fill('#f-summary', 'Outside address guessed the password of r.delgado on WEB01 and signed in. Needs scoping and containment by Tier 2.');
    await wf(T('submit')).click();
  },
  '11-sweep': async () => { await hide(); await runTool('sweep', ATK); await snap('11-sweep'); },
  '11-correlate': async () => {
    await hide(); await search(`src_ip:${ATK} bytes>1000000`); await pinRow(visibleRows('[data-source="firewall"]'));
    await search('event_id:4624 host:WEB01 target_user:*r.delgado');
    await pinRow(`.main .panel:visible tr${T('log-row')}:has-text("10.20.30.19")`);
  },
  '11-findings': async () => {
    await hide();
    await fldRadio('pattern', 'Many passwords tried'); await page.fill('#f-count', '14'); await page.selectOption('#f-baseline', 'WS-SAL-007');
    await fldRadio('after', 'stayed signed in'); await fldRadio('benign', 'No: not a company address');
    const link = async (fld, text) => {
      const f = page.locator(`${T('fld')}[data-fld="${fld}"]`);
      await f.locator('.linker > button').click();
      await f.locator('.linker li', { hasText: text }).first().locator('input').check();
    };
    await link('pattern', 'event_id=4625'); await link('count', 'event_id=4625'); await link('baseline', 'src_ip=10.20.30.19'); await link('after', 'action=allow');
    await snap('11-findings'); await wf(T('submit')).click();
  },
  '12-summary': async () => {
    await hide(); await page.fill('#f-summary', 'An outside address signed in as r.delgado after many failed attempts. This needs incident response to act on it as soon as possible please.');
    await check(); log.push(['12 summary weak', (await resultText()).slice(0, 200)]); await snap('12-summary-weak');
    await hide(); await page.fill('#f-summary', SUMMARY); await check();
  },
  '12-signoff': async () => {
    await hide(); await fldRadio('scope', 'One user account is compromised');
    const want = ['Normal sign-in', 'Repeated failed', 'Successful logon', 'Large transfers'];
    for (let pass = 0; pass < 6; pass++) {
      const labels = await page.locator(`${T('fld')}[data-fld="sequence"] ol.order li .grow`).allTextContents();
      const idx = labels.map((l) => want.findIndex((w) => l.startsWith(w)));
      const bad = idx.findIndex((v, i) => i < idx.length - 1 && v > idx[i + 1]);
      if (bad < 0) break;
      await page.locator(`${T('fld')}[data-fld="sequence"] ol.order li`).nth(bad).locator('button[aria-label="Move later"]').click();
    }
    await fldRadio('severity', 'High'); await fldRadio('declare', 'Declare a security incident');
    await wf(T('submit')).click();
  },
  '13-contain': async () => { await hide(); await act('reset_credentials', 'r.delgado'); await act('block_ip', ATK, 'text'); },
  '13-notify': async () => { await hide(); await act('notify', 'ir_lead'); await act('notify', 'user_mgr'); await snap('13-state'); },
  '13-declare': async () => { await hide(); await page.click(`${T('declare')} button`); await page.click(`${T('declare')} .btn-primary`); },
  '14-negative': async () => {
    await hide();
    for (let i = 0; i < 12; i++) {
      await search(`src_ip:${ATK} action:deny`);
      if (await page.locator(visibleRows()).count()) break;
      if (i === 0) { await check(); log.push(['14-negative early', (await resultText()).slice(0, 140)]); await hide(); }
      await page.waitForTimeout(6000);
    }
    await pinRow(visibleRows());
  },
  '14-positive': async () => {
    await hide();
    for (let i = 0; i < 14; i++) {
      await search('event_id:4624 host:WEB01 target_user:*r.delgado');
      await pinRow(`.main .panel:visible tr${T('log-row')}:has-text("10.20.30.19")`);
      await page.waitForTimeout(800);
      if (await page.$('.gt-result.gt-ok')) break;
      if (i === 0) { await check(); log.push(['14-positive early', (await resultText()).slice(0, 160)]); await hide(); }
      await page.waitForTimeout(7000);
    }
  },
  '14-record': async () => {
    await hide();
    const f1 = page.locator(`${T('fld')}[data-fld="blocked_proof"] li`, { hasText: 'action=deny' }).first();
    await f1.locator('input').check();
    const f2 = page.locator(`${T('fld')}[data-fld="legit_proof"] li`, { hasText: 'src_ip=10.20.30.19' });
    await f2.last().locator('input').check();
    await page.locator(`${T('fld')}[data-fld="residual"] label.option`, { hasText: 'Portal data' }).click();
    await page.locator(`${T('fld')}[data-fld="residual"] label.option`, { hasText: 'same password' }).click();
    await snap('14-record'); await wf(T('submit')).click();
  },
  '15-close': async () => {
    await hide(); await fldRadio('disposition', 'True positive, confirmed'); await fldRadio('root_cause', 'A guessable password');
    for (const t of ['Lock or slow', 'second factor', 'Alert on repeated']) await page.locator(`${T('fld')}[data-fld="lessons"] label.option`, { hasText: t }).click();
    await page.fill('#f-summary', 'An outside address guessed a staff password on the customer portal and took data. The password was reset and the address blocked.');
    await wf(T('submit')).click();
  },
};

await page.goto(base + '/#/');
await page.click(T('home-demo-start'));
await page.waitForSelector(T('demo-begin'));
await snap('00-intro');
await page.click(T('demo-begin'));
await page.waitForSelector('.gt-panel');
const seen = [];
let guard = 0;
while (guard++ < 80) {
  if (/summary/.test(page.url())) break;
  await page.waitForSelector('.gt-panel');
  await page.waitForTimeout(700);
  await show();
  await page.waitForTimeout(250);
  const st = await state();
  if (seen[seen.length - 1]?.id !== st.id) {
    // settle: give target lookup time
    if (st.target === 'searching') await page.waitForTimeout(1200);
    const s2 = await state();
    seen.push(s2);
    await snap(`${String(seen.length).padStart(2, '0')}-${s2.id}`);
  }
  if (stopAt && st.id === stopAt) break;
  const label = (await primary().textContent()).trim();
  if (tasks[st.id] && !/^Next$/.test(label)) {
    await tasks[st.id]();
    await show();
    await waitOk(st.id.startsWith('14') ? 20000 : 9000).catch(async () => { await check(); await waitOk(6000); });
    log.push([st.id, (await resultText()).slice(0, 110)]);
    await snap(`${String(seen.length).padStart(2, '0')}-${st.id}-ok`);
  }
  await show();
  await primary().click();
  await page.waitForTimeout(350);
}
let summary = null;
if (/summary/.test(page.url())) {
  await page.waitForSelector(T('summary-actions'));
  await page.screenshot({ path: `${out}/${tag}-demo-99-summary.png`, fullPage: true });
  summary = await page.evaluate(() => ({ h1: document.querySelector('h1').textContent, disclaimer: document.querySelector('[data-tour~="summary-disclaimer"]').textContent.slice(0, 90), metrics: [...document.querySelectorAll('.demo-metrics div')].map((d) => d.textContent), buttons: [...document.querySelectorAll('[data-tour~="summary-actions"] button')].map((x) => x.textContent) }));
}
console.log(JSON.stringify({ url: page.url(), beats: seen.length, seen: seen.map((s) => `${s.id}|${s.target}|ring:${s.ring ? 1 : 0}|arrow:${s.arrow ? 1 : 0}|cover:${s.overlapPct}%`), log, summary, errors }, null, 1));
await b.close();
