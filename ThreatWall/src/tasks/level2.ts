import type { AccessRule, AddressObject, RootState } from '../state/types';
import type { CheckResult, StepDef, TaskDef } from './types';
import { fail, flowIs, form, info, nav, open, orConfirm, pass, save, test } from './dsl';
import { LAB } from '../state/baseline';
import { leases } from '../engine/network';
import { evaluate } from '../engine/traffic';
import { localTime, tsAt } from '../engine/objects';
import { userFor } from './level1';

type S = RootState;
const ok = (b: boolean, good: string, bad: string): CheckResult => (b ? pass(good) : fail(bad));
const iface = (s: S, n: string) => s.config.interfaces.find((i) => i.name === n);
const rule = (s: S, name: string) => s.config.accessRules.find((r) => r.name === name);
const AR = 'policy/rules/access';
const IF = 'network/system/interfaces';
const AD = 'object/match/addresses';

/** Rule matching a field set (name-insensitive check helper). */
const ruleWith = (s: S, want: Partial<AccessRule>) => s.config.accessRules.find((r) => Object.entries(want).every(([k, v]) => r[k as keyof AccessRule] === v));
const addrIs = (s: S, a: Partial<AddressObject> & { name: string }) => s.config.addresses.some((x) => x.name === a.name && Object.entries(a).every(([k, v]) => String(x[k as keyof AddressObject]).toLowerCase() === String(v).toLowerCase()));

/** Three steps to add one address object. */
function addrSteps(id: string, a: Partial<AddressObject> & { name: string }, why?: string): StepDef[] {
  return [
    open(`${id}o`, `Click Add for ${a.name}`, 'addr', AD, '[data-guide="add-address"]', { tab: 'objects', why }),
    form(`${id}f`, `Fill in ${a.name}`, 'addr', a as Record<string, unknown>, AD, '#ad-name', { labels: { name: 'Name', zone: 'Zone', type: 'Type', ip: 'IP Address', ip2: 'Netmask', fqdn: 'FQDN' }, saved: (s) => addrIs(s, a) }),
    save(`${id}s`, 'Click Save', AD, '[data-guide="addr-save"]', (s) => addrIs(s, a)),
  ];
}

/** Three steps to add one access rule. */
function ruleSteps(id: string, want: Partial<AccessRule> & { name: string }, why?: string): StepDef[] {
  const savedOk = (s: S) => !!ruleWith(s, want);
  return [
    open(`${id}o`, `Click Add (rule ${want.name})`, 'rule', AR, '[data-guide="add-rule"]', { why }),
    form(`${id}f`, `Fill in ${want.name}`, 'rule', want as Record<string, unknown>, AR, '#ar-name',
      { labels: { action: 'Action', name: 'Name', fromZone: 'From', toZone: 'To', src: 'Source', dst: 'Destination', service: 'Service', schedule: 'Schedule', usersIncl: 'Users Included', logging: 'Logging', enabled: 'Enable' }, saved: savedOk }),
    save(`${id}s`, 'Click Add', AR, orConfirm('[data-guide="rule-save"]'), savedOk),
  ];
}

/* ------------------------------------------------------------------ 2.1 */
const SVC = 'object/match/services';
const svcOk = (s: S) => s.config.services.some((x) => x.name === 'TCP-8443' && x.protocol === 'TCP' && x.portStart === 8443 && x.portEnd === 8443);
const sgOk = (s: S) => { const g = s.config.serviceGroups.find((x) => x.name === 'SG_SaaS'); return !!g && g.members.includes('TCP-8443') && g.members.includes('HTTPS'); };
const schOk = (s: S) => { const x = s.config.schedules.find((y) => y.name === 'Office-Hours'); return !!x && [1, 2, 3, 4, 5, 6].every((d) => x.days.includes(d)) && !x.days.includes(0) && x.start === '09:00' && x.end === '19:00'; };
const SAAS: Partial<AccessRule> & { name: string } = { action: 'allow', name: 'LAN-SaaS-Office-Hours', fromZone: 'LAN', toZone: 'WAN', src: 'N_LAN-Staff', dst: 'Any', service: 'SG_SaaS', schedule: 'Office-Hours', logging: true, enabled: true };
const tue = (s: S, hhmm: string, day = 2) => tsAt(day, hhmm, s.config.system.timezone, Date.UTC(2026, 9, 13, 6, 0));
const t21: TaskDef = {
  id: '2.1', level: 2, title: 'Service objects and schedules', minutes: 20, difficulty: 'Junior',
  what: 'Service objects name a protocol and port range; groups bundle them. Schedules make a rule active only at certain times.',
  whatWeDo: 'The SaaS tool uses TCP 8443 plus HTTPS and may only be used in office hours (Mon–Sat 09:00–19:00). Build the objects and a scheduled rule, then test at 10:00 and 21:00.',
  why: 'Open only what the business needs, only when it needs it. Outside hours the port is closed — less attack surface, fewer surprises.',
  prerequisites: ['Level 1 complete'],
  expected: [{ label: 'Service', value: 'TCP-8443 = TCP 8443' }, { label: 'Group', value: 'SG_SaaS = TCP-8443 + HTTPS' }, { label: 'Schedule', value: 'Office-Hours: Mon–Sat 09:00–19:00' }, { label: 'Rule', value: 'LAN-SaaS-Office-Hours: LAN→WAN, N_LAN-Staff → Any, SG_SaaS, Office-Hours, Allow' }],
  steps: [
    nav('nav', SVC, ['Match Objects', 'Services']),
    open('so', 'Click Add (Service Objects)', 'service', SVC, '[data-guide="add-service"]', { tab: 'objects' }),
    form('sf', 'Create TCP-8443', 'service', { name: 'TCP-8443', protocol: 'TCP', portStart: 8443, portEnd: 8443 }, SVC, '#sv-name', { labels: { name: 'Name', protocol: 'Protocol', portStart: 'Port start', portEnd: 'Port end' }, saved: svcOk }),
    save('ss', 'Click Save', SVC, '[data-guide="svc-save"]', svcOk),
    open('go', 'On Service Groups, click Add', 'svcgroup', SVC, '[data-guide="add-svcgroup"]', { tab: 'groups' }),
    form('gf', 'Create SG_SaaS with TCP-8443 and HTTPS', 'svcgroup', { name: 'SG_SaaS', members: ['TCP-8443', 'HTTPS'] }, SVC, '#sg-name', { labels: { name: 'Name', members: 'Members' }, saved: sgOk }),
    save('gs', 'Click Save', SVC, '[data-guide="sg-save"]', sgOk),
    nav('sch', 'object/match/schedules', ['Match Objects', 'Schedules']),
    open('co', 'Click Add', 'schedule', 'object/match/schedules', '[data-guide="add-schedule"]'),
    form('cf', 'Create Office-Hours: Mon–Sat, 09:00 to 19:00', 'schedule', { name: 'Office-Hours', days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00' }, 'object/match/schedules', '#sc-name',
      { labels: { name: 'Name', days: 'Days (1=Mon … 6=Sat)', start: 'Start', end: 'End' }, saved: schOk, beginner: 'Times are in the firewall’s time zone (Asia/Kolkata), not your PC’s.' }),
    save('cs', 'Click Save', 'object/match/schedules', '[data-guide="sch-save"]', schOk, (s) => (s.config.schedules.find((x) => x.name === 'Office-Hours')?.days.includes(0) ? 'Sunday is ticked — office hours are Mon–Sat.' : null)),
    nav('ar', AR, ['Rules and Policies', 'Access Rules']),
    ...ruleSteps('r', SAAS),
    test('t10', 'Test HR-PC → saas-tool.example TCP 8443 on Tuesday at 10:00 — allowed', (d) => Number(d.port) === 8443 && d.from === 'hr' && (() => { const t = localTime(Number(d.at), 'Asia/Kolkata'); return t.day >= 1 && t.day <= 6 && t.minutes >= 540 && t.minutes < 1140; })(), ['allowed'],
      { prefill: { from: 'hr', to: 'saas-tool.example', svc: '8443', when: 'at', day: '2', time: '10:00' }, beginner: 'The Lab time field lets you test any day and time without waiting for it.' }),
    test('t21', 'Test the same at 21:00 — the rule is inactive, so it is blocked', (d) => Number(d.port) === 8443 && d.from === 'hr', ['schedule-inactive'], { prefill: { from: 'hr', to: 'saas-tool.example', svc: '8443', when: 'at', day: '2', time: '21:00' } }),
  ],
  checks: [
    { id: 'svc', label: 'TCP-8443 is TCP 8443', test: (s) => ok(svcOk(s), 'TCP 8443', 'TCP-8443 missing or wrong port.') },
    { id: 'sg', label: 'SG_SaaS contains TCP-8443 and HTTPS', test: (s) => ok(sgOk(s), 'group OK', 'SG_SaaS missing or incomplete.') },
    { id: 'sch', label: 'Office-Hours is Mon–Sat 09:00–19:00', test: (s) => ok(schOk(s), 'schedule OK', 'Office-Hours missing or wrong days/times.') },
    { id: 'rule', label: 'LAN-SaaS-Office-Hours uses SG_SaaS and Office-Hours', test: (s) => ok(!!ruleWith(s, SAAS), 'rule OK', 'The scheduled rule is missing or a field differs.') },
    { id: 'in', label: 'TCP 8443 allowed on Tuesday 10:00', test: (s) => flowIs(s, { from: 'hr', to: 'saas-tool.example', proto: 'TCP', port: 8443, user: userFor(s, 'LAN-Web-Out') }, ['allowed'], tue(s, '10:00')) },
    { id: 'out', label: 'TCP 8443 blocked on Tuesday 21:00 and on Sunday', test: (s) => { const a = flowIs(s, { from: 'hr', to: 'saas-tool.example', proto: 'TCP', port: 8443 }, ['schedule-inactive'], tue(s, '21:00')); const b = flowIs(s, { from: 'hr', to: 'saas-tool.example', proto: 'TCP', port: 8443 }, ['schedule-inactive'], tue(s, '10:00', 0)); return a.ok && b.ok ? pass('inactive outside office hours') : a.ok ? b : a; } },
  ],
  verify: 'Objects and rule are read from the configuration; the engine evaluates the same flow at 10:00 and 21:00 in the firewall’s time zone.',
  mistakes: ['Ticking Sunday.', 'Using 7:00 PM as 07:00 — the lab uses 24-hour time.', 'Putting the rule below a broader allow that already permits TCP 8443.'],
  troubleshooting: ['Allowed at 21:00: another rule (above or below) also allows TCP 8443 — check every LAN→WAN rule.', 'Blocked at 10:00: check the time zone and the days in the schedule.'],
};

/* ------------------------------------------------------------------ 2.2 */
const x2Ok = (s: S) => { const i = iface(s, 'X2'); return !!i && i.zone === 'DMZ' && i.mode === 'static' && i.ip === LAB.dmzIp && i.mask === LAB.dmzMask; };
const PUB = { name: 'webserver_public_ip', zone: 'WAN', type: 'host', ip: LAB.publicWeb } as const;
const PRIV = { name: 'webserver_private_ip', zone: 'DMZ', type: 'host', ip: LAB.webServer } as const;
const natOk = (s: S) => s.config.natRules.some((n) => n.enabled && n.origDst === PUB.name && n.transDst === PRIV.name && n.origSvc === 'HTTPS' && (n.inIface === 'X1' || n.inIface === 'Any') && n.transSrc === 'Original');
const WEB: Partial<AccessRule> & { name: string } = { action: 'allow', name: 'WAN-to-WEB-01-HTTPS', fromZone: 'WAN', toZone: 'DMZ', src: 'Any', dst: PUB.name, service: 'HTTPS', logging: true, enabled: true };
const webRule = (s: S) => s.config.accessRules.some((r) => r.enabled && r.action === 'allow' && r.fromZone === 'WAN' && r.toZone === 'DMZ' && (r.dst === PUB.name || r.dst === PRIV.name) && r.service === 'HTTPS');
const t22: TaskDef = {
  id: '2.2', level: 2, title: 'Publish a web server', minutes: 25, difficulty: 'Junior',
  what: 'Publishing = an inbound NAT that maps a public IP to a private server, plus an access rule that allows only the service you publish.',
  whatWeDo: `Put WEB-01 (${LAB.webServer}) in a DMZ on X2 and publish HTTPS on ${LAB.publicWeb}. Nothing else.`,
  why: 'A server reachable from the internet will be attacked. In a DMZ it cannot reach the LAN, and only HTTPS is exposed.',
  prerequisites: ['2.1'],
  expected: [
    { label: 'X2', value: `DMZ, static ${LAB.dmzIp} / ${LAB.dmzMask}` }, { label: 'webserver_public_ip', value: `Host ${LAB.publicWeb}, zone WAN` }, { label: 'webserver_private_ip', value: `Host ${LAB.webServer}, zone DMZ` },
    { label: 'NAT', value: 'webserver_public_ip → webserver_private_ip, HTTPS, inbound X1' }, { label: 'Rule', value: 'WAN→DMZ, Any → webserver_public_ip, HTTPS, Allow' },
  ],
  steps: [
    nav('nav', IF, ['System', 'Interfaces']),
    open('ex2', 'Click Configure on X2', 'iface', IF, '[data-guide="edit:X2"]', { match: (d) => d.name === 'X2' }),
    form('x2', 'Assign X2 to DMZ with a static address', 'iface', { zone: 'DMZ', mode: 'static', ip: LAB.dmzIp, mask: LAB.dmzMask }, IF, '#if-zone', { labels: { zone: 'Zone', mode: 'Mode', ip: 'IP', mask: 'Mask' }, saved: x2Ok }),
    save('x2s', 'Click OK', IF, orConfirm('[data-guide="iface-ok"]'), x2Ok),
    nav('ad', AD, ['Match Objects', 'Addresses']),
    ...addrSteps('pub', PUB, 'The address the internet will use. It is one of the spare addresses in our /29.'),
    ...addrSteps('priv', PRIV, 'Where the traffic really goes after translation.'),
    nav('nat', 'policy/rules/nat', ['Rules and Policies', 'NAT Rules']),
    open('no', 'Click Add', 'nat', 'policy/rules/nat', '[data-guide="add-nat"]'),
    form('nf', 'Build the inbound NAT policy', 'nat', { name: 'Publish-WEB-01-HTTPS', origSrc: 'Any', transSrc: 'Original', origDst: PUB.name, transDst: PRIV.name, origSvc: 'HTTPS', transSvc: 'Original', inIface: 'X1' }, 'policy/rules/nat', '#nat-name',
      { labels: { name: 'Name', origSrc: 'Original Source', transSrc: 'Translated Source', origDst: 'Original Destination', transDst: 'Translated Destination', origSvc: 'Original Service', transSvc: 'Translated Service', inIface: 'Inbound Interface' }, saved: natOk,
        beginner: 'Only the destination is translated. The source stays the real internet client, so logs show who connected.' }),
    save('ns', 'Click Add', 'policy/rules/nat', '[data-guide="nat-save"]', natOk),
    nav('ar', AR, ['Rules and Policies', 'Access Rules']),
    ...ruleSteps('r', WEB, 'NAT only translates. The firewall still needs a rule that allows the traffic.'),
    test('t1', 'From INTERNET-TESTER, test https://203.0.113.11 — allowed', (d) => d.from === 'outside' && d.to === LAB.publicWeb && Number(d.port) === 443, ['allowed'], { prefill: { from: 'outside', to: LAB.publicWeb, svc: 'https' } }),
    test('t2', 'Test HTTP (80) to the same address — refused', (d) => d.from === 'outside' && d.to === LAB.publicWeb && Number(d.port) === 80, ['nat-mismatch', 'no-rule', 'denied', 'invalid-route'], { prefill: { from: 'outside', to: LAB.publicWeb, svc: 'http' } }),
    test('t3', 'Test SSH (22) — refused', (d) => d.from === 'outside' && d.to === LAB.publicWeb && Number(d.port) === 22, ['nat-mismatch', 'no-rule', 'denied', 'invalid-route'], { prefill: { from: 'outside', to: LAB.publicWeb, svc: 'ssh' } }),
  ],
  checks: [
    { id: 'x2', label: 'X2 is DMZ 172.16.10.1/24', test: (s) => ok(x2Ok(s), 'X2 OK', 'X2 is not configured as planned.') },
    { id: 'obj', label: 'webserver_public_ip and webserver_private_ip exist', test: (s) => ok(addrIs(s, PUB) && addrIs(s, PRIV), 'objects OK', 'One of the two objects is missing or wrong.') },
    { id: 'nat', label: 'Inbound NAT for HTTPS only', test: (s) => ok(natOk(s), 'NAT OK', 'No enabled NAT policy maps webserver_public_ip → webserver_private_ip for HTTPS.') },
    { id: 'rule', label: 'WAN→DMZ rule allows HTTPS only', test: (s) => ok(webRule(s) && !s.config.accessRules.some((r) => r.enabled && r.action === 'allow' && r.fromZone === 'WAN' && r.toZone === 'DMZ' && r.service === 'Any'), 'rule OK', 'Missing, or another WAN→DMZ rule allows Any service.') },
    { id: 'https', label: 'HTTPS from the internet reaches WEB-01', test: (s) => flowIs(s, { from: 'outside', to: LAB.publicWeb, proto: 'TCP', port: 443 }, ['allowed']) },
    { id: 'other', label: 'HTTP and SSH from the internet are refused', test: (s) => { const a = flowIs(s, { from: 'outside', to: LAB.publicWeb, proto: 'TCP', port: 80 }, ['nat-mismatch', 'no-rule', 'denied', 'host-offline']); const b = flowIs(s, { from: 'outside', to: LAB.publicWeb, proto: 'TCP', port: 22 }, ['nat-mismatch', 'no-rule', 'denied', 'host-offline']); return a.ok && b.ok ? pass('only HTTPS is published') : !a.ok ? a : b; } },
  ],
  verify: 'Configuration is compared with the plan and the engine sends HTTPS, HTTP and SSH from the internet.',
  mistakes: ['Translating “Any” service — every port on WEB-01 becomes reachable.', 'Using the firewall’s own WAN address (.10) instead of the spare .11.', 'Forgetting the access rule: NAT alone allows nothing.'],
  troubleshooting: ['“NAT mismatch”: the NAT policy exists but not for that service — that is correct for HTTP/SSH.', '“No matching rule” for HTTPS: the WAN→DMZ rule is missing or uses the wrong destination.'],
};

/* ------------------------------------------------------------------ 2.3 */
export const SEEDED: (Partial<AccessRule> & { name: string; hits: number })[] = [
  { name: 'Staff-HTTPS-Legacy', service: 'HTTPS', hits: 1520 },
  { name: 'Block-Proxy-Site', action: 'deny', dst: 'FQDN_unblock-proxy', service: 'HTTPS', hits: 0 },
  { name: 'Allow-NTP', service: 'NTP', hits: 310 },
  { name: 'Temp-Vendor-RDP', service: 'RDP', hits: 0 },
  { name: 'Old-FTP-Out', service: 'FTP', hits: 0 },
  { name: 'Allow-SMTP-Relay', service: 'SMTP', hits: 45 },
  { name: 'Test-Telnet', service: 'Telnet', hits: 0 },
  { name: 'Allow-IMAP', service: 'IMAP', hits: 12 },
  { name: 'Allow-POP3-Legacy', service: 'POP3', hits: 0 },
  { name: 'Allow-DNS-Legacy', service: 'DNS (Name Service)', hits: 88 },
];
export const ZERO_HIT = ['Temp-Vendor-RDP', 'Old-FTP-Out', 'Test-Telnet', 'Allow-POP3-Legacy'];
export function seedRuleset(s: S): S {
  const cfg = s.config;
  const addresses = cfg.addresses.some((a) => a.name === 'FQDN_unblock-proxy') ? cfg.addresses
    : [...cfg.addresses, { id: 'seed-proxy', name: 'FQDN_unblock-proxy', zone: 'WAN', type: 'fqdn' as const, ip: '', ip2: '', fqdn: 'unblock-proxy.example', comment: 'Added by previous admin' }];
  const existing = new Set(cfg.accessRules.map((r) => r.name));
  const now = Date.now();
  const seeded: AccessRule[] = SEEDED.filter((r) => !existing.has(r.name)).map((r, i) => ({
    id: `seed-${i}`, fromZone: 'LAN', toZone: 'WAN', action: 'allow', src: 'Any', dst: 'Any', schedule: 'Always', usersIncl: 'All', usersExcl: 'None', logging: true, enabled: true,
    builtIn: false, auto: null, lastHit: r.hits ? now - 3_600_000 * (i + 1) : null, comment: 'Inherited rule set (previous administrator)', service: 'Any', ...r,
  }));
  const at = cfg.accessRules.findIndex((r) => r.id === 'r-lan-wan');
  const accessRules = at < 0 ? [...cfg.accessRules, ...seeded] : [...cfg.accessRules.slice(0, at), ...seeded, ...cfg.accessRules.slice(at)];
  return { ...s, config: { ...cfg, addresses, accessRules } };
}
const pairRules = (s: S) => s.config.accessRules.filter((r) => r.fromZone === 'LAN' && r.toZone === 'WAN');
/** The block must sit above every enabled allow rule of the pair (other deny rules may share the top, e.g. task 4.5). */
const blockFirst = (s: S) => { const l = pairRules(s); const i = l.findIndex((r) => r.name === 'Block-Proxy-Site'); const firstAllow = l.findIndex((r) => r.enabled && r.action === 'allow'); return i >= 0 && !!l[i].enabled && (firstAllow < 0 || i < firstAllow); };
const zeroOff = (s: S) => ZERO_HIT.every((n) => rule(s, n)?.enabled === false);
const usedOn = (s: S) => SEEDED.filter((r) => r.hits > 0).every((r) => rule(s, r.name)?.enabled !== false);
const t23: TaskDef = {
  id: '2.3', level: 2, title: 'Rule order, shadowing and cleanup', minutes: 25, difficulty: 'Junior',
  what: 'Rules are read top-down and the first match wins. A rule that can never match because a broader one sits above it is “shadowed”.',
  whatWeDo: 'You inherit a 10-rule set from a previous admin. Find why the proxy block never works, fix the order, and disable rules that have never been used.',
  why: 'Most real firewall breaches involve forgotten or mis-ordered rules, not missing features. Cleanup is routine hygiene.',
  prerequisites: ['2.2'],
  scenario: { label: 'Load the inherited rule set: 10 LAN→WAN rules, including a block that never fires and several rules with zero hits.', apply: seedRuleset },
  expected: [{ label: 'Block-Proxy-Site', value: 'priority 1 in LAN→WAN (above every allow rule)' }, { label: 'Disable (0 hits)', value: ZERO_HIT.join(', ') }, { label: 'Keep enabled', value: 'every rule that has hits' }],
  steps: [
    nav('nav', AR, ['Rules and Policies', 'Access Rules']),
    info('look', 'Find Block-Proxy-Site: it has 0 hits and a “shadowed” badge — Staff-HTTPS-Legacy above it matches all HTTPS first', { route: AR, target: '[data-guide="rule:Block-Proxy-Site"]' }),
    test('t1', 'Prove it: test HR-PC → unblock-proxy.example HTTPS (it is allowed — wrong)', (d) => d.from === 'hr' && String(d.to).includes('unblock-proxy'), ['allowed', 'auth-required'], { prefill: { from: 'hr', to: 'unblock-proxy.example', svc: 'https' } }),
    save('move', 'Move Block-Proxy-Site above every allow rule (use the up arrow until it is first)', AR, '[data-guide="up:Block-Proxy-Site"]', blockFirst,
      (s) => { const i = pairRules(s).findIndex((r) => r.name === 'Block-Proxy-Site'); return i > 0 ? `Block-Proxy-Site is at priority ${i + 1}. Every allow rule above it that matches HTTPS wins first.` : null; },
      { noFail: true, why: 'A specific deny must sit above any broader allow that also matches its traffic — including LAN-Web-Out and the SaaS rule.' }),
    test('t2', 'Test again — now denied by Block-Proxy-Site', (d) => d.from === 'hr' && String(d.to).includes('unblock-proxy') && d.rule === 'Block-Proxy-Site', ['denied'], { prefill: { from: 'hr', to: 'unblock-proxy.example', svc: 'https' } }),
    save('zero', `Disable the rules with 0 hits: ${ZERO_HIT.join(', ')}`, AR, () => { const n = ZERO_HIT.find((x) => document.querySelector(`[data-guide="rule:${x}"]:not(.disabled)`)); return n ? `[data-guide="rule:${n}"] .tw-toggle` : null; }, zeroOff,
      (s) => (!usedOn(s) ? 'You disabled a rule that is still used (it has hits). Re-enable it.' : null),
      { why: 'Disable first, delete later: if something breaks, re-enabling is instant. Rules with hits are in use — leave them.' }),
    nav('audit', 'monitor/logs/auditing-logs', ['Logs', 'Auditing Logs']),
    info('log', 'Your moves and disables are listed with time and user — attach this to the change ticket', { route: 'monitor/logs/auditing-logs', target: '.tw-table' }),
  ],
  checks: [
    { id: 'first', label: 'Block-Proxy-Site is above every LAN→WAN allow rule and enabled', test: (s) => ok(blockFirst(s), `priority ${pairRules(s).findIndex((r) => r.name === 'Block-Proxy-Site') + 1}, above all allows`, `Block-Proxy-Site is at priority ${pairRules(s).findIndex((r) => r.name === 'Block-Proxy-Site') + 1}, below an allow rule.`) },
    { id: 'deny', label: 'Proxy site is denied', test: (s) => { const r = evaluate(s, { from: 'hr', to: 'unblock-proxy.example', proto: 'TCP', port: 443, user: userFor(s, 'LAN-Web-Out') }).result; return ok(r.verdict === 'denied' && r.rule === 'Block-Proxy-Site', 'denied by Block-Proxy-Site', `Verdict ${r.verdict}${r.rule ? ` by ${r.rule}` : ''}.`); } },
    { id: 'hits', label: 'Block-Proxy-Site now has hits', test: (s) => ok((rule(s, 'Block-Proxy-Site')?.hits ?? 0) > 0, `${rule(s, 'Block-Proxy-Site')?.hits} hits`, 'No hits yet — send the test again.') },
    { id: 'zero', label: 'Zero-hit rules disabled', test: (s) => ok(zeroOff(s), 'disabled', `Still enabled: ${ZERO_HIT.filter((n) => rule(s, n)?.enabled !== false).join(', ')}`) },
    { id: 'used', label: 'Rules in use are still enabled', test: (s) => ok(usedOn(s), 'kept', `Disabled although in use: ${SEEDED.filter((r) => r.hits > 0 && rule(s, r.name)?.enabled === false).map((r) => r.name).join(', ')}`) },
    { id: 'audit', label: 'Changes are in the audit log', test: (s) => ok(s.audit.some((a) => a.action.includes('Block-Proxy-Site') && /moved|priority/.test(a.action)), 'logged', 'No move recorded in the audit log.') },
  ],
  verify: 'Order, state and hits are read from the configuration; the engine re-evaluates the proxy flow; the audit log is checked for your change.',
  mistakes: ['Moving the block only above Staff-HTTPS-Legacy — LAN-Web-Out above it still wins.', 'Deleting rules instead of disabling them first.', 'Disabling rules that have hits.'],
  troubleshooting: ['Still allowed: look at the rule named in the test result — it is above your block.', 'Hits not increasing: hits count only when traffic is sent (Traffic Tester).'],
};

/* ------------------------------------------------------------------ 2.4 */
const V = LAB.vlans;
const vName = (id: number) => `X0:V${id}`;
const vlanOk = (s: S, v: (typeof V)[number]) => { const i = iface(s, vName(v.id)); return !!i && i.zone === v.zone && i.ip === v.ip && i.mask === '255.255.255.0' && i.mode === 'static'; };
const zoneOk = (s: S, n: string, t: string) => s.config.zones.some((z) => z.name === n && z.securityType === t);
const scopeOk = (s: S, v: (typeof V)[number]) => s.config.dhcp.scopes.some((sc) => sc.enabled && sc.iface === vName(v.id) && sc.start === v.start && sc.end === v.end && sc.gateway === v.ip && sc.dns[0] === LAB.dns1);
const GWEB: Partial<AccessRule> & { name: string } = { action: 'allow', name: 'Guest-Web-Out', fromZone: 'Guest', toZone: 'WAN', src: 'Any', dst: 'Any', service: 'SG_Web-DNS', enabled: true };
const GDENY: Partial<AccessRule> & { name: string } = { action: 'deny', name: 'Guest-to-Finance-Deny', fromZone: 'Guest', toZone: 'Finance', src: 'Any', dst: 'Any', service: 'Any', logging: true, enabled: true };
const zoneSteps = (n: string, t: string): StepDef[] => [
  open(`z${n}o`, `Click Add Zone (${n})`, 'zone', 'object/match/zones', '[data-guide="add-zone"]'),
  form(`z${n}f`, `Create zone ${n} (${t})`, 'zone', { name: n, securityType: t }, 'object/match/zones', '#z-name', { labels: { name: 'Name', securityType: 'Security Type' }, saved: (s) => zoneOk(s, n, t) }),
  save(`z${n}s`, 'Click Save', 'object/match/zones', '[data-guide="zone-save"]', (s) => zoneOk(s, n, t)),
];
const vlanSteps = (v: (typeof V)[number]): StepDef[] => [
  open(`v${v.id}a`, `Click Add Interface (VLAN ${v.id})`, 'vlan', IF, '[data-guide="add-iface"]', { match: () => true }),
  form(`v${v.id}t`, `Parent X0, VLAN Tag ${v.id}, then Next`, 'vlan', { parent: 'X0', tag: String(v.id) }, IF, '#vl-tag', { labels: { parent: 'Parent', tag: 'VLAN Tag' }, saved: (s) => !!iface(s, vName(v.id)) }),
  { id: `v${v.id}n`, title: 'Click Next', route: IF, target: '[data-guide="vlan-next"]', done: (c) => (c.draft<{ name: string }>('iface')?.name === vName(v.id)) || !!iface(c.s, vName(v.id)) },
  form(`v${v.id}c`, `Zone ${v.zone}, static ${v.ip} / 255.255.255.0`, 'iface', { name: vName(v.id), zone: v.zone, ip: v.ip, mask: '255.255.255.0' }, IF, '#if-zone', { labels: { zone: 'Zone', ip: 'IP', mask: 'Mask' }, saved: (s) => vlanOk(s, v) }),
  save(`v${v.id}s`, 'Click OK', IF, orConfirm('[data-guide="iface-ok"]'), (s) => vlanOk(s, v)),
];
const scopeSteps = (v: (typeof V)[number]): StepDef[] => [
  open(`d${v.id}o`, `Click Add Dynamic (scope for VLAN ${v.id})`, 'scope', 'network/system/dhcp', '[data-guide="add-scope"]'),
  form(`d${v.id}f`, `Scope on ${vName(v.id)}: ${v.start}–${v.end}, gateway ${v.ip}, DNS ${LAB.dns1}`, 'scope', { iface: vName(v.id), start: v.start, end: v.end, gateway: v.ip, dns: [LAB.dns1] }, 'network/system/dhcp', '#sc-if',
    { get: (d, k) => (k === 'dns' ? d.dns : d[k]), labels: { iface: 'Interface', start: 'Start', end: 'End', gateway: 'Gateway', dns: 'DNS' }, saved: (s) => scopeOk(s, v) }),
  save(`d${v.id}s`, 'Click OK', 'network/system/dhcp', '[data-guide="scope-save"]', (s) => scopeOk(s, v)),
];
const t24: TaskDef = {
  id: '2.4', level: 2, title: 'VLANs and segmentation', minutes: 35, difficulty: 'Junior',
  what: 'VLAN sub-interfaces split one physical port into separate networks, each in its own zone. The switch port must carry the tags (802.1Q trunk).',
  whatWeDo: 'Add VLAN 10 (staff, LAN), 20 (Finance) and 30 (Guest) on X0 with DHCP, trunk the switch port, let guests reach the internet and block guests from Finance.',
  why: 'A guest phone on the same flat network as the finance PCs is one exploit away from your accounts. Segmentation contains incidents.',
  prerequisites: ['2.3'],
  expected: [
    ...V.map((v) => ({ label: `VLAN ${v.id}`, value: `${vName(v.id)}, zone ${v.zone}, ${v.ip}/24, DHCP ${v.start}–${v.end}` })),
    { label: 'Zones', value: 'Finance (Trusted), Guest (Public)' }, { label: 'Rules', value: 'Guest-Web-Out (Guest→WAN, SG_Web-DNS, Allow), Guest-to-Finance-Deny (Guest→Finance, Deny, log)' },
  ],
  steps: [
    nav('zn', 'object/match/zones', ['Match Objects', 'Zones']),
    ...zoneSteps('Finance', 'Trusted'),
    ...zoneSteps('Guest', 'Public'),
    nav('if', IF, ['System', 'Interfaces']),
    ...V.flatMap(vlanSteps),
    nav('dh', 'network/system/dhcp', ['System', 'DHCP Server']),
    ...V.flatMap(scopeSteps),
    { id: 'trunk', title: 'In Lab Tools › Lab Controls, make the X0 switch port an 802.1Q trunk', lab: 'controls', target: '[data-guide="lab-trunk-btn"]', done: (c) => c.s.lab.trunk,
      beginner: 'Without a trunk the switch drops tagged frames and every VLAN host is silent — a very common real-world mistake.' },
    nav('ar', AR, ['Rules and Policies', 'Access Rules']),
    ...ruleSteps('gw', GWEB),
    ...ruleSteps('gd', GDENY, 'Public zones have no implicit trust, but an explicit, logged deny gives you evidence.'),
    test('t1', 'Test GUEST-PHONE → www.search.example HTTPS — allowed', (d) => d.from === 'guest-phone' && Number(d.port) === 443, ['allowed'], { prefill: { from: 'guest-phone', to: 'www.search.example', svc: 'https' } }),
    test('t2', 'Test GUEST-PHONE → FIN-LAPTOP SMB — denied and logged', (d) => d.from === 'guest-phone' && d.to === 'fin-laptop', ['denied'], { prefill: { from: 'guest-phone', to: 'fin-laptop', svc: 'smb' } }),
  ],
  checks: [
    { id: 'zones', label: 'Zones Finance (Trusted) and Guest (Public)', test: (s) => ok(zoneOk(s, 'Finance', 'Trusted') && zoneOk(s, 'Guest', 'Public'), 'zones OK', 'Zone missing or wrong type.') },
    ...V.map((v) => ({ id: `v${v.id}`, label: `${vName(v.id)} in ${v.zone}, ${v.ip}/24, with DHCP`, test: (s: S) => ok(vlanOk(s, v) && scopeOk(s, v), 'OK', `${vName(v.id)} or its scope is not as planned.`) })),
    { id: 'trunk', label: 'Switch port is a trunk and VLAN hosts get leases', test: (s) => { const got = ['staff-laptop', 'fin-laptop', 'guest-phone'].filter((h) => leases(s).some((l) => l.host === h)); return ok(s.lab.trunk && got.length === 3, '3 VLAN hosts leased', s.lab.trunk ? `Only ${got.join(', ') || 'none'} got a lease.` : 'The switch port is not a trunk.'); } },
    { id: 'gweb', label: 'Guests reach the internet', test: (s) => flowIs(s, { from: 'guest-phone', to: 'www.search.example', proto: 'TCP', port: 443 }, ['allowed']) },
    { id: 'gfin', label: 'Guests cannot reach Finance (denied, logged)', test: (s) => { const r = flowIs(s, { from: 'guest-phone', to: 'fin-laptop', proto: 'TCP', port: 445 }, ['denied']); return r.ok && !ruleWith(s, { fromZone: 'Guest', toZone: 'Finance', action: 'deny', logging: true, enabled: true }) ? fail('Denied, but the deny rule does not log.') : r; } },
  ],
  verify: 'Interfaces, zones, scopes and rules are compared with the plan; the engine sends guest traffic to the internet and to Finance.',
  mistakes: ['Forgetting the trunk: everything looks right on the firewall and nothing works.', 'Putting the Guest VLAN in the LAN zone (trusted) — then it can reach everything.', 'Reusing 192.168.20.0/24 — that is the branch office network in task 3.4.'],
  troubleshooting: ['VLAN host “host offline”: check the trunk and that the VLAN interface is enabled.', 'Guest gets no lease: the scope must be on the VLAN interface (X0:V30), not on X0.'],
};

/* ------------------------------------------------------------------ 2.5 */
const PROFILE_CATS = ['Malware', 'Phishing', 'Adult Content', 'Proxy Avoidance', 'Streaming Media'];
const profOk = (s: S) => { const p = s.config.security.cfs.profiles.find((x) => x.name === 'CFS_Staff'); return !!p && PROFILE_CATS.every((c) => p.blocked.includes(c)) && p.allowList.includes('video.example') && !p.blocked.includes('Search Engines') && !p.blocked.includes('Business'); };
const cfsRuleOk = (s: S) => s.config.security.cfs.rules.some((r) => r.enabled && r.profile === 'CFS_Staff' && (r.srcZone === 'LAN' || r.srcZone === 'Any') && r.users === 'All');
const t25: TaskDef = {
  id: '2.5', level: 2, title: 'Content filtering', minutes: 20, difficulty: 'Junior',
  what: 'The content filter rates every website into a category and blocks the categories your policy forbids, showing a block page.',
  whatWeDo: 'Enable CFS, build a CFS_Staff profile that blocks malware, phishing, adult, proxy-avoidance and streaming (but allows video.example for marketing), and apply it to the LAN.',
  why: 'Most malware arrives through the browser. Blocking known-bad categories stops it before the PC ever downloads anything.',
  prerequisites: ['2.4'],
  expected: [{ label: 'Profile', value: `CFS_Staff blocks ${PROFILE_CATS.join(', ')}` }, { label: 'Allow list', value: 'video.example' }, { label: 'Policy', value: 'CFS-LAN: source LAN, users All, profile CFS_Staff' }],
  steps: [
    nav('nav', 'policy/security/content-filter', ['Security Services', 'Content Filter']),
    save('en', 'Turn on “Enable Content Filtering Service”', 'policy/security/content-filter', '#cfs-enable', (s) => s.config.security.cfs.enabled),
    nav('prof', 'object/profiles/content-filter', ['Profile Objects', 'Content Filter']),
    open('po', 'Click Add', 'cfsprofile', 'object/profiles/content-filter', '[data-guide="add-cfsprofile"]'),
    form('pf', 'Name CFS_Staff, tick the five categories and allow video.example', 'cfsprofile', { name: 'CFS_Staff', blocked: PROFILE_CATS, allowList: ['video.example'] }, 'object/profiles/content-filter', '#cp-name',
      { labels: { name: 'Name', blocked: 'Blocked', allowList: 'Always allow' }, saved: profOk, beginner: 'The allow list overrides categories: marketing needs video.example even though Streaming Media is blocked.' }),
    save('ps', 'Click Save', 'object/profiles/content-filter', '[data-guide="cfsprofile-save"]', profOk),
    nav('rules', 'policy/rules/content-filter', ['Rules and Policies', 'Content Filter Rules']),
    open('ro', 'Click Add', 'cfsrule', 'policy/rules/content-filter', '[data-guide="add-cfsrule"]'),
    form('rf', 'Policy CFS-LAN: source zone LAN, users All, profile CFS_Staff', 'cfsrule', { name: 'CFS-LAN', srcZone: 'LAN', users: 'All', profile: 'CFS_Staff' }, 'policy/rules/content-filter', '#cr-name', { labels: { name: 'Name', srcZone: 'Source Zone', users: 'Users', profile: 'Profile' }, saved: cfsRuleOk }),
    save('rs', 'Click Save', 'policy/rules/content-filter', '[data-guide="cfsrule-save"]', cfsRuleOk),
    test('t1', 'Test HR-PC → malware-test.example HTTPS — blocked with a block page', (d) => d.from === 'hr' && String(d.to).includes('malware-test') && d.security === 'cfs', ['security-blocked'], { prefill: { from: 'hr', to: 'malware-test.example', svc: 'https' } }),
    test('t2', 'Test HR-PC → video.example — allowed by the allow list', (d) => d.from === 'hr' && String(d.to).includes('video.example'), ['allowed'], { prefill: { from: 'hr', to: 'video.example', svc: 'https' } }),
    test('t3', 'Test HR-PC → www.search.example — allowed', (d) => d.from === 'hr' && String(d.to).includes('search.example'), ['allowed'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'https' } }),
  ],
  checks: [
    { id: 'en', label: 'CFS enabled and licensed', test: (s) => ok(s.config.security.cfs.enabled && s.config.licensing.services.some((x) => x.id === 'cfs' && x.status === 'licensed'), 'on', 'CFS is off or unlicensed.') },
    { id: 'prof', label: 'CFS_Staff blocks the five categories and allows video.example', test: (s) => ok(profOk(s), 'profile OK', 'Profile missing, incomplete, or blocks business categories.') },
    { id: 'rule', label: 'CFS policy applies CFS_Staff to the LAN', test: (s) => ok(cfsRuleOk(s), 'policy OK', 'No enabled policy applies CFS_Staff to LAN.') },
    { id: 'mal', label: 'Malware category blocked', test: (s) => flowIs(s, { from: 'hr', to: 'malware-test.example', proto: 'TCP', port: 443, user: userFor(s, 'LAN-Web-Out') }, ['security-blocked']) },
    { id: 'vid', label: 'Allow-listed site works', test: (s) => flowIs(s, { from: 'hr', to: 'video.example', proto: 'TCP', port: 443, user: userFor(s, 'LAN-Web-Out') }, ['allowed']) },
    { id: 'goo', label: 'Ordinary browsing works', test: (s) => flowIs(s, { from: 'hr', to: 'www.search.example', proto: 'TCP', port: 443, user: userFor(s, 'LAN-Web-Out') }, ['allowed']) },
  ],
  verify: 'Settings are read from the configuration; the engine checks a blocked category, the allow list and a normal site.',
  mistakes: ['Enabling CFS but creating no policy — nothing is filtered.', 'Blocking “Business” or “Search Engines” and breaking work.'],
  troubleshooting: ['Nothing blocked: CFS licensed? enabled? a policy for LAN? the profile has the category?', 'Allow list ignored: enter the domain without https:// or paths.'],
};

/* ------------------------------------------------------------------ 2.6 */
const acOk = (s: S) => { const a = s.config.security.appControl; return a.enabled && a.categories.P2P === 'block' && a.categories['Proxy-Access'] === 'block' && a.categories['Social Networking'] === 'log'; };
const t26: TaskDef = {
  id: '2.6', level: 2, title: 'Application control', minutes: 15, difficulty: 'Junior',
  what: 'App Control identifies applications by their traffic patterns, whatever port they use, and can block or log them by category.',
  whatWeDo: 'Block P2P and proxy/anonymiser apps, and log (not block) social networking so HR can see usage.',
  why: 'Tools like UltraSurf tunnel over HTTPS on port 443 to dodge port-based rules and the content filter. Only application identification catches them.',
  prerequisites: ['2.5'],
  expected: [{ label: 'App Control', value: 'Enabled' }, { label: 'P2P', value: 'Block' }, { label: 'Proxy-Access', value: 'Block' }, { label: 'Social Networking', value: 'Log' }],
  steps: [
    nav('nav', 'policy/security/app-control', ['Security Services', 'App Control']),
    form('f', 'Enable App Control and set the category actions', 'appcontrol', { enabled: true, P2P: 'block', 'Proxy-Access': 'block', 'Social Networking': 'log' }, 'policy/security/app-control', '#ac-enable',
      { get: (d, k) => (k === 'enabled' ? d.enabled : (d.categories as Record<string, string>)[k]), labels: { enabled: 'Enable' }, saved: acOk }),
    save('s', 'Click Accept', 'policy/security/app-control', '[data-guide="accept"]', acOk),
    test('t1', 'Test HR-PC using UltraSurf (Application) to www.search.example — blocked', (d) => d.from === 'hr' && d.app === 'ultrasurf', ['security-blocked'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'https', app: 'ultrasurf' },
      beginner: 'The port is 443 like normal HTTPS, so access rules and CFS let it through — App Control recognises the application itself.' }),
    test('t2', 'Test HR-PC using the social network app — allowed but logged', (d) => d.from === 'hr' && d.app === 'social', ['allowed'], { prefill: { from: 'hr', to: 'social.example', svc: 'https', app: 'social' } }),
    nav('logs', 'monitor/logs/system-logs', ['Logs', 'System Logs']),
    info('ev', 'Find “Application Control Detection Alert” for the social app', { route: 'monitor/logs/system-logs', target: '[data-guide="logs-search"]' }),
  ],
  checks: [
    { id: 'cfg', label: 'App Control on: P2P block, Proxy-Access block, Social log', test: (s) => ok(acOk(s), 'settings OK', 'App Control settings differ from the plan.') },
    { id: 'proxy', label: 'UltraSurf is blocked', test: (s) => { const r = evaluate(s, { from: 'hr', to: 'www.search.example', proto: 'TCP', port: 443, app: 'ultrasurf', user: userFor(s, 'LAN-Web-Out') }).result; return ok(r.verdict === 'security-blocked' && r.security?.kind === 'app', 'blocked by App Control', `${r.verdict}: ${r.reason}`); } },
    { id: 'social', label: 'Social networking is allowed and logged', test: (s) => { const r = evaluate(s, { from: 'hr', to: 'social.example', proto: 'TCP', port: 443, app: 'social', user: userFor(s, 'LAN-Web-Out') }).result; return ok(r.verdict === 'allowed' && r.security?.kind === 'app' && !r.security.blocked, 'allowed + logged', `${r.verdict}: ${r.security?.detail ?? 'not detected'}`); } },
  ],
  verify: 'Settings are read from the configuration; the engine runs an anonymiser and a social app through the policy.',
  mistakes: ['Blocking Social Networking when the brief says log — HR wanted visibility, not a ban.', 'Forgetting App Control is per zone (LAN/WAN have it on by default).'],
  troubleshooting: ['Not blocked: is App Control licensed, enabled, and on for the LAN and WAN zones?'],
};

/* ------------------------------------------------------------------ 2.7 */
const UL = 'device/users/local';
const staffOk = (s: S) => s.config.users.groups.some((g) => g.name === 'Staff');
const userOk = (s: S, n: string) => s.config.users.local.some((u) => u.name === n && u.groups.includes('Staff') && !!u.passwordHash);
const authRule = (s: S) => rule(s, 'LAN-Web-Out')?.usersIncl === 'Staff';
const userSteps = (n: string): StepDef[] => [
  open(`u${n}o`, `Click Add User (${n})`, 'user', UL, '[data-guide="add-user"]', { tab: 'users' }),
  form(`u${n}f`, `User ${n}, a practice password, member of Staff`, 'user', { name: n, groups: ['Staff'], pwSet: true, pwMatch: true }, UL, '#us-name', { labels: { name: 'Name', groups: 'Member of', pwSet: 'Password set', pwMatch: 'Passwords match' }, saved: (s) => userOk(s, n) }),
  save(`u${n}s`, 'Click Save', UL, '[data-guide="user-save"]', (s) => userOk(s, n)),
];
const t27: TaskDef = {
  id: '2.7', level: 2, title: 'Local users and authentication', minutes: 20, difficulty: 'Junior',
  what: 'Rules can match users, not just addresses. Unauthenticated users are redirected to the firewall’s login page first.',
  whatWeDo: 'Create the Staff group and two users, require Staff on LAN-Web-Out, then prove an anonymous PC is redirected and a logged-in user browses.',
  why: 'IP addresses change hands; people are accountable. User-based rules and logs say who did what.',
  prerequisites: ['2.6'],
  expected: [{ label: 'Group', value: 'Staff' }, { label: 'Users', value: `${LAB.users.join(', ')} (members of Staff, practice passwords)` }, { label: 'LAN-Web-Out', value: 'Users Included: Staff' }],
  steps: [
    nav('nav', UL, ['Users', 'Local Users & Groups']),
    open('go', 'On Local Groups, click Add Group', 'ugroup', UL, '[data-guide="add-ugroup"]', { tab: 'groups' }),
    form('gf', 'Name the group Staff', 'ugroup', { name: 'Staff' }, UL, '#ug-name', { labels: { name: 'Name' }, saved: staffOk }),
    save('gs', 'Click Save', UL, '[data-guide="ugroup-save"]', staffOk),
    ...LAB.users.flatMap(userSteps),
    nav('ar', AR, ['Rules and Policies', 'Access Rules']),
    open('eo', 'Click Configure on LAN-Web-Out', 'rule', AR, '[data-guide="edit:LAN-Web-Out"]', { match: (d) => d.name === 'LAN-Web-Out' }),
    form('ef', 'On the Users tab, set Users Included to Staff', 'rule', { name: 'LAN-Web-Out', usersIncl: 'Staff' }, AR, '#ar-uin', { tab: 'users', labels: { usersIncl: 'Users Included' }, saved: authRule }),
    save('es', 'Click Save', AR, orConfirm('[data-guide="rule-save"]'), authRule),
    test('t1', 'Test HR-PC → www.search.example HTTP with User “(nobody)” — redirected to login', (d) => d.from === 'hr' && Number(d.port) === 80 && d.user === null, ['auth-required'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'http', user: '-' } }),
    { id: 'login', title: `In Lab Tools › Lab Controls, log ${LAB.users[0]} in on HR-PC`, lab: 'controls', target: '[data-guide="lab-auth-user"]', expect: `HR-PC · ${LAB.users[0]} · the password you set`,
      done: (c) => c.s.lab.authSessions.some((a) => a.host === 'hr' && a.user === LAB.users[0]) },
    test('t2', 'Test HR-PC → www.search.example HTTP again (whoever is logged in) — allowed', (d) => d.from === 'hr' && Number(d.port) === 80, ['allowed'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'http', user: '' } }),
    nav('st', 'device/users/status', ['Users', 'Status']),
    info('who', `See ${LAB.users[0]} logged in on HR-PC`, { route: 'device/users/status', target: '.tw-table' }),
  ],
  checks: [
    { id: 'grp', label: 'Group Staff exists', test: (s) => ok(staffOk(s), 'Staff', 'No Staff group.') },
    { id: 'users', label: `${LAB.users.join(' and ')} are in Staff`, test: (s) => ok(LAB.users.every((n) => userOk(s, n)), 'users OK', `Missing or not in Staff: ${LAB.users.filter((n) => !userOk(s, n)).join(', ')}`) },
    { id: 'rule', label: 'LAN-Web-Out requires Staff', test: (s) => ok(authRule(s), 'Users Included: Staff', `Users Included is ${rule(s, 'LAN-Web-Out')?.usersIncl ?? 'n/a'}.`) },
    { id: 'anon', label: 'Anonymous browsing is redirected to login', test: (s) => flowIs(s, { from: 'hr', to: 'www.search.example', proto: 'TCP', port: 80, user: null }, ['auth-required']) },
    { id: 'staff', label: 'A Staff user can browse', test: (s) => flowIs(s, { from: 'hr', to: 'www.search.example', proto: 'TCP', port: 80, user: LAB.users[0] }, ['allowed']) },
  ],
  verify: 'Users, group and rule are read from the configuration; the engine runs the same flow without and with a Staff user.',
  mistakes: ['Adding users but not to Staff.', 'Requiring a group on the deny rule instead of the allow rule.', 'Using a real password — this is a lab.'],
  troubleshooting: ['Never redirected: another LAN→WAN allow rule without users matches first (check order).', 'Login fails: wrong password; reset it by editing the user.'],
};

export const LEVEL2: TaskDef[] = [t21, t22, t23, t24, t25, t26, t27];
