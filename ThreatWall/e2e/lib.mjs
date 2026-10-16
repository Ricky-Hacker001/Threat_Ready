/** Playwright helpers for the ThreatWall end-to-end walkthrough. */
import { chromium } from 'playwright';
export async function start(url = 'http://localhost:4173/') {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
  const W = (ms=300) => p.waitForTimeout(ms);
  const h = {
    b, p, errs, W, url,
    cmd: async (c) => { await h.lab('pc'); await p.fill('[data-guide="pc-cmd"]', c); await p.press('[data-guide="pc-cmd"]', 'Enter'); await W(); },
    lab: async (tab) => { if (!(await p.$('.tw-lab.open'))) await p.click('[data-guide="labtools"]'); await p.click(`[data-guide="labtab:${tab}"]`); await W(150); },
    go: async (path) => { await p.evaluate((x) => { location.hash = '/' + x; }, path); await W(350); },
    status: async () => p.evaluate(() => { const s = JSON.parse(localStorage.getItem('threatwall:lab-state')); return Object.fromEntries(Object.entries(s.progress.tasks).filter(([,v]) => v.status !== 'locked').map(([k, v]) => [k, v.status + ':' + v.step])); }),
    cur: async () => p.evaluate(() => document.querySelector('.tw-step.cur .tw-step-title')?.textContent ?? '(none)'),
    fail: async () => p.evaluate(() => document.querySelector('.tw-fail')?.textContent ?? ''),
    gotIt: async () => { await p.click('button:has-text("Got it")'); await W(400); },
    sel: async (s, v) => { await p.selectOption(s, v); await W(80); },
    send: async (pre) => { await h.lab('traffic'); await p.selectOption('#lt-src', pre.from); await p.fill('#lt-dst', pre.to); await p.selectOption('#lt-svc', pre.svc ?? 'https'); if (pre.app !== undefined) await p.selectOption('#lt-app', pre.app); if (pre.payload) await p.selectOption('#lt-payload', pre.payload); await p.click('[data-guide="lt-send"]'); await W(400); return p.evaluate(() => document.querySelector('.tw-verdict')?.textContent); },
    state: async () => p.evaluate(() => JSON.parse(localStorage.getItem('threatwall:lab-state'))),
  };
  return h;
}
export async function level0(h) {
  const { p, W, cmd } = h;
  await p.goto(h.url); await W();
  await p.click('[data-guide="start-lab"]'); await W();
  await h.lab('pc'); await p.click('[data-guide="pc-cable"]'); await W(500);
  await cmd('ipconfig'); await cmd('ping 192.168.168.168'); await W(500);
  await p.fill('[data-guide="url"]', 'https://192.168.168.168'); await p.press('[data-guide="url"]', 'Enter'); await W();
  await p.click('[data-guide="cert-advanced"]'); await W(); await p.click('[data-guide="cert-proceed"]'); await W(500);
  await p.fill('#tw-user', 'admin'); await p.fill('#tw-pass', 'password'); await p.click('[data-guide="login-submit"]'); await W();
  await p.click('[data-guide="wiz-next"]'); await W();
  await p.fill('#wz-pw', 'Lab-Firewall#2026'); await p.fill('#wz-pw2', 'Lab-Firewall#2026'); await W(); await p.click('[data-guide="wiz-next"]'); await W();
  await p.fill('#wz-host', 'AERO-HQ-FW'); await W();
  for (let i=0;i<5;i++) { await p.click('[data-guide="wiz-next"]'); await W(); }
  await p.fill('#tw-user', 'admin'); await p.fill('#tw-pass', 'Lab-Firewall#2026'); await p.click('[data-guide="login-submit"]'); await W(700);
  await h.gotIt();
  for (const r of ['home/dashboard/topology','monitor/realtime/system-monitor','device/settings/administration','network/system/interfaces','object/match/addresses','policy/rules/access','monitor/logs/system-logs']) await h.go(r);
  await h.gotIt();
  await h.go('device/settings/licenses'); await p.click('[data-guide="register"]'); await W();
  const sys = (await h.state()).config.system;
  await p.fill('#rg-email', 'admin@aero.example'); await p.fill('#rg-serial', sys.serial); await p.fill('#rg-auth', sys.authCode); await W();
  await p.click('[data-guide="register-submit"]'); await W(); await h.gotIt();
  await h.go('device/settings/firmware'); await p.click('[data-guide="create-backup"]'); await W(); await p.click('[data-guide="backup-create"]'); await W();
  await p.click('[data-guide="export-config"]'); await W(500);
  await h.go('device/settings/administration'); await p.click('[data-guide="tab:login"]'); await p.fill('#ad-timeout', '10'); await W(); await p.click('[data-guide="accept"]'); await W();
  await h.go('monitor/logs/auditing-logs'); await h.gotIt();
}
import fs from 'node:fs';
export async function dump(h, file) { fs.writeFileSync(file, JSON.stringify(await h.state())); }
export async function load(h, file) {
  const st = fs.readFileSync(file, 'utf8');
  await h.p.addInitScript((s) => { if (!sessionStorage.getItem('tw-loaded')) { localStorage.setItem('threatwall:lab-state', s); sessionStorage.setItem('tw-loaded', '1'); } }, st);
  await h.p.goto(h.url); await h.W(600);
  await h.p.click('[data-guide="start-lab"]'); await h.W(400);
}
