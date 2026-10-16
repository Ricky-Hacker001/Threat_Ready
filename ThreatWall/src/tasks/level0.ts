import type { TaskDef, StepDef } from './types';
import { event, field, info, nav, open, save, pass, fail, flowIs } from './dsl';
import { FACTORY, LAB } from '../state/baseline';
import { hashPassword } from '../lib/hash';
import { inSubnet } from '../lib/ip';
import { parseUrl } from '../auth/browser';

const x0 = (s: Parameters<TaskDef['checks'][number]['test']>[0]) => s.config.interfaces.find((i) => i.name === 'X0')!;
const stepsDone = (s: Parameters<TaskDef['checks'][number]['test']>[0], id: string, n: number) => Object.keys(s.progress.tasks[id]?.stepDoneAt ?? {}).length >= n;
const labStep = (id: string, tab: string, title: string, beginner?: string): StepDef => ({
  id, title, lab: tab, beginner, done: (c) => c.ui.labOpen && c.ui.labTab === tab,
});

/* ------------------------------------------------------------------ 0.1 */
const t01: TaskDef = {
  id: '0.1', level: 0, title: 'Cable the PC and get an address', minutes: 5, difficulty: 'Fresher',
  what: 'A new firewall manages itself on X0 at 192.168.168.168 and hands out addresses 192.168.168.100–.199 to anything plugged in there.',
  whatWeDo: 'Plug ADMIN-PC into X0, let it get a DHCP address, then prove the PC can reach the firewall with ping.',
  why: 'Every later step happens through this cable. If the PC is not in the firewall’s subnet, the management page simply never loads.',
  prerequisites: [],
  expected: [{ label: 'Firewall X0', value: '192.168.168.168/24' }, { label: 'PC address', value: '192.168.168.100–.199 (DHCP)' }],
  steps: [
    labStep('pc', 'pc', 'Open Lab Tools › PC Console', 'Lab Tools is the “physical world” around the firewall: your PC, cables and test traffic. It sits at the bottom of the screen.'),
    { id: 'cable', title: 'Plug the PC’s cable into the firewall’s X0 port', lab: 'pc', target: '[data-guide="pc-cable"]', done: (c) => c.s.session.pc.cabled,
      beginner: 'X0 is the LAN port. On a factory unit it is the only port that answers management traffic.' },
    { id: 'ipconfig', title: 'Run ipconfig to see the address the PC received', expect: 'ipconfig', lab: 'pc', target: '[data-guide="pc-cmd"]',
      done: (c) => c.events.some((e) => e.type === 'console' && e.data.cmd === 'ipconfig' && e.data.ok === true),
      hint: (c) => (!c.s.session.pc.ip && c.events.some((e) => e.type === 'console' && e.data.cmd === 'ipconfig') ? 'The PC has no address yet. Check the cable, or run ipconfig /renew.' : null),
      beginner: 'The firewall’s DHCP server answers the PC’s request with an address, mask, gateway and DNS server. ipconfig shows what it got.' },
    { id: 'ping', title: 'Ping the firewall', expect: `ping ${FACTORY.mgmtIp}`, lab: 'pc', target: '[data-guide="pc-cmd"]',
      done: (c) => c.events.some((e) => e.type === 'console' && e.data.cmd === 'ping' && e.data.ok === true && e.data.dst === x0(c.s).ip),
      why: 'A reply proves layer 1 (cable), layer 2 (ARP) and layer 3 (same subnet) all work before you open a browser.' },
  ],
  checks: [
    { id: 'cabled', label: 'ADMIN-PC is cabled to X0', test: (s) => (s.session.pc.cabled ? pass('Link up on X0') : fail('The PC is not cabled.')) },
    { id: 'addr', label: 'ADMIN-PC has an address in the X0 subnet', test: (s) => (s.session.pc.ip && inSubnet(s.session.pc.ip, x0(s).ip, x0(s).mask) ? pass(`${s.session.pc.ip} is in ${x0(s).ip}/${x0(s).mask}`) : fail(`PC address “${s.session.pc.ip || 'none'}” is not in X0’s subnet (${x0(s).ip}/${x0(s).mask}).`)) },
    { id: 'ping', label: 'The firewall answers ping from ADMIN-PC', test: (s) => flowIs(s, { from: 'admin', to: x0(s).ip, proto: 'ICMP', port: 0 }, ['consumed']) },
  ],
  verify: 'Re-checked from the live lab: cable, PC address and a ping evaluated by the engine.',
  mistakes: ['Pinging before the PC has an address (you get “General failure”).', 'Typing 192.168.1.1 or another vendor’s default address.'],
  troubleshooting: ['ipconfig shows 169.254.x.x: DHCP did not answer — check the cable and run ipconfig /renew.', 'Ping times out: confirm the PC and X0 are in the same /24.'],
};

/* ------------------------------------------------------------------ 0.2 */
const t02: TaskDef = {
  id: '0.2', level: 0, title: 'Open the management page', minutes: 5, difficulty: 'Fresher',
  what: 'The firewall’s web GUI listens on HTTPS. A new unit uses a self-signed certificate, so the browser warns you once.',
  whatWeDo: 'Browse to https://192.168.168.168, check the warning is for the address you expect, and proceed to the login page.',
  why: 'You must know the difference between an expected self-signed warning on a box you just cabled and a real interception warning.',
  prerequisites: ['0.1'],
  expected: [{ label: 'URL', value: `https://${FACTORY.mgmtIp}` }],
  steps: [
    { id: 'url', title: 'Type the management address in the browser and press Enter', expect: `https://${FACTORY.mgmtIp}`, target: '[data-guide="url"]',
      done: (c) => { const u = parseUrl(c.s.session.browserUrl); return !!u && u.scheme === 'https' && u.host === x0(c.s).ip && (c.ui.route === 'browser:cert' || c.s.session.certAccepted); },
      hint: (c) => {
        const ev = [...c.events].reverse().find((e) => e.type === 'browse');
        if (!ev) return null;
        if (ev.data.scheme !== 'https') return 'Use https:// — management over plain HTTP is off.';
        if (ev.data.host !== x0(c.s).ip) return `That is not the firewall’s address. X0 is ${x0(c.s).ip}.`;
        return null;
      },
      beginner: 'The address bar at the top of the screen is the browser on ADMIN-PC. Type the full URL including https://.' },
    { id: 'adv', title: 'Read the warning, then click Advanced', route: 'browser:cert', target: '[data-guide="cert-advanced"]',
      done: (c) => !!c.draft<{ advanced: boolean }>('cert')?.advanced || c.s.session.certAccepted,
      beginner: 'NET::ERR_CERT_AUTHORITY_INVALID means the certificate was not issued by an authority your PC trusts. A factory firewall signs its own.' },
    { id: 'proceed', title: `Check the address is ${FACTORY.mgmtIp}, then click “Proceed (unsafe)”`, route: 'browser:cert', target: '[data-guide="cert-proceed"]',
      done: (c) => c.s.session.certAccepted, why: 'Only accept this warning for an appliance you control and just cabled. Task 4.4 replaces the certificate.' },
  ],
  checks: [
    { id: 'cert', label: 'Certificate warning accepted for the firewall', test: (s) => (s.session.certAccepted || s.session.loggedIn ? pass(`Proceeded to https://${s.session.connectedIp}`) : fail('The certificate warning has not been accepted.')) },
    { id: 'https', label: 'HTTPS management answers ADMIN-PC', test: (s) => flowIs(s, { from: 'admin', to: s.session.connectedIp, proto: 'TCP', port: s.config.system.httpsPort }, ['consumed']) },
  ],
  verify: 'The engine re-checks that ADMIN-PC reaches the firewall’s HTTPS management on the address in use.',
  mistakes: ['Using http:// — the appliance does not serve management over HTTP.', 'Clicking “Back to safety” and assuming the firewall is broken.'],
  troubleshooting: ['“This site can’t be reached”: go back to task 0.1 — the PC address or cable is wrong.', '“Refused to connect”: HTTPS management is off on that interface.'],
};

/* ------------------------------------------------------------------ 0.3 */
type Wiz = { step: number; hostname: string; timezone: string; pwOk: boolean; confirmOk: boolean; wanMode: string };
const t03: TaskDef = {
  id: '0.3', level: 0, title: 'Run the Setup Guide', minutes: 10, difficulty: 'Fresher',
  what: 'The factory login (admin / password) is published in every manual. The Setup Guide forces a new password and sets the basics.',
  whatWeDo: 'Sign in with the factory credentials, replace the password, name the firewall, keep WAN on DHCP for now, apply, and sign in again.',
  why: 'A firewall left on its default password belongs to whoever tries it first. Changing it is always step one.',
  prerequisites: ['0.2'],
  expected: [{ label: 'Factory login', value: `${FACTORY.adminUser} / ${FACTORY.adminPassword}` }, { label: 'Firewall name', value: LAB.hostname }, { label: 'Time zone', value: 'Asia/Kolkata' }, { label: 'New password', value: '12+ chars, upper, lower, digit, symbol' }],
  steps: [
    { id: 'login', title: 'Sign in with the factory credentials', expect: `${FACTORY.adminUser} / ${FACTORY.adminPassword}`, route: 'browser:login', target: '[data-guide="login-user"]',
      done: (c) => c.ui.route === 'browser:wizard' || c.s.config.system.setupComplete || c.events.some((e) => e.type === 'login' && e.data.ok === true),
      beginner: 'The Setup Guide opens automatically because the appliance is still on factory defaults.' },
    { id: 'welcome', title: 'Read the Welcome page, then click Next', route: 'browser:wizard', target: '[data-guide="wiz-next"]',
      done: (c) => (c.draft<Wiz>('wizard')?.step ?? 0) >= 1 || c.s.config.system.setupComplete },
    { id: 'pw', title: 'Enter and confirm a new administrator password', expect: '12+ characters with upper, lower, digit, symbol', route: 'browser:wizard', target: '[data-guide="wiz-pw"]',
      done: (c) => { const d = c.draft<Wiz>('wizard'); return (!!d?.pwOk && !!d?.confirmOk) || (d?.step ?? 0) >= 2 || c.s.config.system.setupComplete; },
      why: 'Long and mixed passwords resist guessing. In this lab use a practice password, never a real one.' },
    { id: 'next1', title: 'Click Next', route: 'browser:wizard', target: '[data-guide="wiz-next"]', done: (c) => (c.draft<Wiz>('wizard')?.step ?? 0) >= 2 || c.s.config.system.setupComplete },
    field('host', 'Set the firewall name', 'wizard', (d) => d.hostname, LAB.hostname, 'browser:wizard', '#wz-host', { expect: LAB.hostname, saved: (s) => s.config.system.hostname === LAB.hostname,
      beginner: 'The name appears in logs, alerts and VPN peers so you always know which box you are looking at.' }),
    field('tz', 'Check the time zone', 'wizard', (d) => d.timezone, 'Asia/Kolkata', 'browser:wizard', '#wz-tz', { expect: 'Asia/Kolkata', saved: (s) => s.config.system.setupComplete && s.config.system.timezone === 'Asia/Kolkata',
      why: 'Schedules (task 2.1) and log timestamps use the firewall’s time zone.' }),
    { id: 'next2', title: 'Click Next through WAN (keep DHCP) and LAN', route: 'browser:wizard', target: '[data-guide="wiz-next"]', done: (c) => (c.draft<Wiz>('wizard')?.step ?? 0) >= 5 || c.s.config.system.setupComplete,
      beginner: 'Task 1.1 sets the static WAN address, so DHCP is fine here.' },
    save('apply', 'Review the summary and click Apply', 'browser:wizard', '[data-guide="wiz-next"]', (s) => s.config.system.setupComplete),
    { id: 'relogin', title: 'Click Done and sign in with your new password', route: 'browser:login', target: '[data-guide="login-pass"]', done: (c) => c.s.session.loggedIn && c.s.config.system.setupComplete },
  ],
  checks: [
    { id: 'setup', label: 'Setup Guide applied', test: (s) => (s.config.system.setupComplete ? pass('Setup complete') : fail('Setup Guide not applied.')) },
    { id: 'pw', label: 'Factory password no longer works', test: (s) => (s.config.system.adminPasswordHash !== hashPassword(FACTORY.adminPassword) && !s.config.system.defaultPassword ? pass('admin / password is rejected') : fail('The administrator password is still the factory default.')) },
    { id: 'tz', label: 'Time zone is Asia/Kolkata', test: (s) => (s.config.system.timezone === 'Asia/Kolkata' ? pass('Asia/Kolkata') : fail(`Time zone is ${s.config.system.timezone}.`)) },
  ],
  verify: 'Checked against the saved configuration: setup flag, password hash and time zone.',
  mistakes: ['Reusing a real password in a lab.', 'Changing X0 here — that is task 1.1 and it drops your session.'],
  troubleshooting: ['Login keeps failing: after five failures the login locks for 30 seconds.', 'Forgot the new password: Reset the lab from the user menu (it clears all progress).'],
};

/* ------------------------------------------------------------------ 0.4 */
const tourSteps: StepDef[] = [
  info('dash', 'Look at HOME › Dashboard: model, serial, firmware, interfaces and alerts', { route: 'home/dashboard/system', target: '.tw-page',
    beginner: 'The dashboard is where you start every troubleshooting session: is the box up, which ports have link, what changed?' }),
  nav('topo', 'home/dashboard/topology', ['Dashboard', 'Topology'], 'Topology shows which zone and subnet sits behind each port.'),
  nav('mon', 'monitor/realtime/system-monitor', ['Real-Time Charts', 'System Monitor'], 'MONITOR is read-only: charts, logs and capture tools.'),
  nav('admin', 'device/settings/administration', ['Settings', 'Administration'], 'DEVICE holds the appliance itself: name, admins, licences, firmware.'),
  nav('ifaces', 'network/system/interfaces', ['System', 'Interfaces'], 'NETWORK holds addressing: interfaces, DHCP, DNS, VPN.'),
  nav('addr', 'object/match/addresses', ['Match Objects', 'Addresses'], 'OBJECT holds the reusable names that rules refer to.'),
  nav('rules', 'policy/rules/access', ['Rules and Policies', 'Access Rules'], 'POLICY holds what is allowed: access rules, NAT, routing, security services.'),
  nav('logs', 'monitor/logs/system-logs', ['Logs', 'System Logs'], 'Logs are your evidence for every later task.'),
  info('crumbs', 'Note the breadcrumb (host › view › group › page) and that pages save only when you click Accept or OK', { route: 'monitor/logs/system-logs', target: '.tw-crumbs' }),
];
const t04: TaskDef = {
  id: '0.4', level: 0, title: 'Learn the GUI layout', minutes: 10, difficulty: 'Fresher',
  what: 'The GUI has six views across the top — HOME, MONITOR, DEVICE, NETWORK, OBJECT, POLICY — each with its own left menu.',
  whatWeDo: 'Visit the pages you will use most so you can find them without thinking.',
  why: 'In an outage you will not have time to hunt for the logs page.',
  prerequisites: ['0.3'],
  expected: [{ label: 'Views', value: 'HOME · MONITOR · DEVICE · NETWORK · OBJECT · POLICY' }],
  steps: tourSteps,
  checks: [{ id: 'tour', label: 'Visited every view and the key pages', test: (s) => (stepsDone(s, '0.4', tourSteps.length) ? pass('All pages visited') : fail('Some pages were not visited.')) }],
  verify: 'Each page visit was recorded as you navigated.',
  mistakes: ['Looking for routes under NETWORK — in Classic mode they are under POLICY › Rules and Policies › Routing Rules.'],
  troubleshooting: ['Lost? Use the search icon (top right) and type a page name or a task number.'],
};

/* ------------------------------------------------------------------ 0.5 */
type Reg = { email: string; serial: string; authCode: string };
const t05: TaskDef = {
  id: '0.5', level: 0, title: 'Register and license', minutes: 5, difficulty: 'Fresher',
  what: 'Security services (content filter, IPS, anti-virus, DPI-SSL, SSL VPN, HA) only run once the appliance is registered and licensed.',
  whatWeDo: 'Register the serial number and authentication code from the dashboard, then confirm every service shows Licensed.',
  why: 'Unlicensed services look configured but do nothing — a dangerous illusion of protection.',
  prerequisites: ['0.4'],
  expected: [{ label: 'Serial / auth code', value: 'as shown on HOME › Dashboard and DEVICE › Licenses' }, { label: 'Account e-mail', value: 'any lab address, e.g. admin@aero.example' }],
  steps: [
    nav('nav', 'device/settings/licenses', ['Settings', 'Licenses']),
    open('open', 'Click Register', 'register', 'device/settings/licenses', '[data-guide="register"]'),
    { id: 'email', title: 'Enter a lab account e-mail address', expect: 'admin@aero.example', route: 'device/settings/licenses', target: '#rg-email',
      done: (c) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.draft<Reg>('register')?.email ?? '') || c.s.config.licensing.registered,
      beginner: 'In the lab no e-mail is sent anywhere. On real kit this is your vendor portal account.' },
    { id: 'serial', title: 'Enter the serial number exactly as shown on this page', route: 'device/settings/licenses', target: '#rg-serial',
      done: (c) => (c.draft<Reg>('register')?.serial ?? '').trim().toUpperCase() === c.s.config.system.serial || c.s.config.licensing.registered },
    { id: 'auth', title: 'Enter the authentication code', route: 'device/settings/licenses', target: '#rg-auth',
      done: (c) => (c.draft<Reg>('register')?.authCode ?? '').trim().toUpperCase() === c.s.config.system.authCode || c.s.config.licensing.registered },
    save('submit', 'Click Register', 'device/settings/licenses', '[data-guide="register-submit"]', (s) => s.config.licensing.registered),
    info('check', 'Confirm every service in the table now shows Licensed with an expiry date', { route: 'device/settings/licenses', target: '.tw-table' }),
  ],
  checks: [
    { id: 'reg', label: 'Appliance registered', test: (s) => (s.config.licensing.registered ? pass(`Registered to ${s.config.licensing.account}`) : fail('Not registered.')) },
    { id: 'lic', label: 'All security services licensed', test: (s) => { const bad = s.config.licensing.services.filter((x) => x.status !== 'licensed'); return bad.length ? fail(`Not licensed: ${bad.map((x) => x.name).join(', ')}`) : pass(`${s.config.licensing.services.length} services licensed`); } },
  ],
  verify: 'Checked against the saved licensing table.',
  mistakes: ['Typing the letter O instead of zero in the serial.', 'Assuming a service works because its page has an Enable box.'],
  troubleshooting: ['“Must match”: copy the serial and code from the top of the Licenses page.'],
};

/* ------------------------------------------------------------------ 0.6 */
const t06: TaskDef = {
  id: '0.6', level: 0, title: 'Back up before changes', minutes: 5, difficulty: 'Fresher',
  what: 'A local backup is a snapshot stored on the appliance; an export is a file you keep somewhere else.',
  whatWeDo: 'Create a local backup labelled “Before changes”, then export the configuration file.',
  why: 'Every change from task 1.1 onwards can lock you out. A backup turns a disaster into a two-minute restore.',
  prerequisites: ['0.5'],
  expected: [{ label: 'Backup comment', value: 'Before changes' }],
  steps: [
    nav('nav', 'device/settings/firmware', ['Settings', 'Firmware and Settings']),
    open('open', 'Click Create Backup', 'backup', 'device/settings/firmware', '[data-guide="create-backup"]'),
    { id: 'comment', title: 'Give it a comment that says why', expect: 'Before changes', route: 'device/settings/firmware', target: '#bk-c',
      done: (c) => /before/i.test(c.draft<{ comment: string }>('backup')?.comment ?? '') || c.s.config.backups.length > 0 },
    save('create', 'Click Create', 'device/settings/firmware', '[data-guide="backup-create"]', (s) => s.config.backups.length > 0),
    event('export', 'Click Export Configuration to keep a copy off the appliance', 'export', () => true, { route: 'device/settings/firmware', target: '[data-guide="export-config"]',
      beginner: 'The lab export downloads a JSON file with lab-only values. It contains no real secrets.' }),
  ],
  checks: [
    { id: 'backup', label: 'At least one local backup exists', test: (s) => (s.config.backups.length ? pass(`${s.config.backups.length} backup(s); latest “${s.config.backups[0].comment}”`) : fail('No local backup.')) },
    { id: 'export', label: 'Configuration exported', test: (s) => (s.audit.some((a) => a.action === 'Configuration exported') || stepsDone(s, '0.6', 5) ? pass('Export recorded in the audit log') : fail('No export recorded.')) },
  ],
  verify: 'Backups are read from the saved configuration; the export from the audit log.',
  mistakes: ['Skipping the comment — six months later nobody knows which backup is good.'],
  troubleshooting: ['Restore needs a reboot on real kit; the lab applies it at once and logs you out of nothing.'],
};

/* ------------------------------------------------------------------ 0.7 */
const t07: TaskDef = {
  id: '0.7', level: 0, title: 'Admin session basics', minutes: 5, difficulty: 'Fresher',
  what: 'DEVICE › Settings › Administration holds the firewall name and how long an idle admin session stays open.',
  whatWeDo: `Set the name to ${LAB.hostname} (if not already) and the idle timeout to 10 minutes, then find your change in the audit log.`,
  why: 'An unattended admin session is an open door. A clear name makes every log and alert unambiguous.',
  prerequisites: ['0.6'],
  expected: [{ label: 'Firewall name', value: LAB.hostname }, { label: 'Log out after inactivity', value: '10 minutes' }],
  steps: [
    nav('nav', 'device/settings/administration', ['Settings', 'Administration']),
    field('host', 'Set Firewall Name', 'admin', (d) => d.hostname, LAB.hostname, 'device/settings/administration', '#ad-host', { expect: LAB.hostname, saved: (s) => s.config.system.hostname === LAB.hostname }),
    field('timeout', 'Set “Log out the administrator after inactivity of” to 10 minutes', 'admin', (d) => String(d.adminTimeoutMin), '10', 'device/settings/administration', '#ad-timeout', { tab: 'login', expect: '10', saved: (s) => s.config.system.adminTimeoutMin === 10 }),
    save('accept', 'Click Accept', 'device/settings/administration', '[data-guide="accept"]', (s) => s.config.system.hostname === LAB.hostname && s.config.system.adminTimeoutMin === 10,
      (s) => (s.config.system.adminTimeoutMin !== 10 ? `Saved timeout is ${s.config.system.adminTimeoutMin} minutes, expected 10.` : s.config.system.hostname !== LAB.hostname ? `Saved name is ${s.config.system.hostname}.` : null)),
    nav('audit', 'monitor/logs/auditing-logs', ['Logs', 'Auditing Logs'], 'Every saved change is recorded with who, when and what. This is your change log.'),
    info('find', 'Find your Administration change at the top of the audit log', { route: 'monitor/logs/auditing-logs', target: '.tw-table' }),
  ],
  checks: [
    { id: 'host', label: `Firewall name is ${LAB.hostname}`, test: (s) => (s.config.system.hostname === LAB.hostname ? pass(LAB.hostname) : fail(`Name is ${s.config.system.hostname}.`)) },
    { id: 'timeout', label: 'Admin idle timeout is 10 minutes', test: (s) => (s.config.system.adminTimeoutMin === 10 ? pass('10 minutes') : fail(`Timeout is ${s.config.system.adminTimeoutMin} minutes.`)) },
  ],
  verify: 'Checked against the saved Administration settings.',
  mistakes: ['Editing the field and navigating away without clicking Accept.'],
  troubleshooting: ['Accept is greyed out: nothing changed compared with the saved values.'],
};

export const LEVEL0: TaskDef[] = [t01, t02, t03, t04, t05, t06, t07];
