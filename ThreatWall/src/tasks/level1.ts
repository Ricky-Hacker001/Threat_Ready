import type { AddressObject, RootState } from '../state/types';
import type { CheckResult, StepDef, TaskDef } from './types';
import { event, fail, flowIs, form, info, nav, open, orConfirm, pass, save, test } from './dsl';
import { LAB } from '../state/baseline';
import { builtInRoutes, leases } from '../engine/network';
import { firewallDns } from '../engine/traffic';
import { fwLookup, fwPing } from '../engine/diag';
import { userInGroup } from '../engine/rules';
import { inSubnet } from '../lib/ip';
import { parseUrl } from '../auth/browser';

type S = RootState;
const iface = (s: S, n: string) => s.config.interfaces.find((i) => i.name === n)!;
const ok = (b: boolean, good: string, bad: string): CheckResult => (b ? pass(good) : fail(bad));
const sameMac = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A user who satisfies the rule's "Users Included" (task 2.7 later adds authentication to LAN→WAN). */
export function userFor(s: S, ruleName: string): string | undefined {
  const r = s.config.accessRules.find((x) => x.name === ruleName);
  if (!r || r.usersIncl === 'All') return undefined;
  return s.config.users.local.find((u) => userInGroup(s.config, u.name, r.usersIncl))?.name;
}

/* ------------------------------------------------------------------ 1.1 */
const IF = 'network/system/interfaces';
const x1ok = (s: S) => { const i = iface(s, 'X1'); return i.zone === 'WAN' && i.mode === 'static' && i.ip === LAB.wanIp && i.mask === LAB.wanMask && i.gateway === LAB.wanGw && i.dns[0] === LAB.dns1 && i.dns[1] === LAB.dns2; };
const x1mgmt = (s: S) => { const m = iface(s, 'X1').mgmt; return m.ping && !m.https && !m.http && !m.ssh && !m.snmp; };
const x0ok = (s: S) => { const i = iface(s, 'X0'); return i.ip === LAB.lanIp && i.mask === LAB.lanMask && i.mgmt.https && i.mgmt.ping && i.mgmt.ssh; };
const ifDraft = (name: string) => (d: Record<string, unknown>) => d.name === name;
const ifGet = (d: Record<string, unknown>, k: string) => {
  if (k === 'dns1') return (d.dns as string[])[0];
  if (k === 'dns2') return (d.dns as string[])[1];
  if (k.startsWith('m.')) return (d.mgmt as Record<string, boolean>)[k.slice(2)];
  return d[k];
};

const t11: TaskDef = {
  id: '1.1', level: 1, title: 'Interfaces and zones', minutes: 15, difficulty: 'Fresher',
  what: 'Each port belongs to a zone (LAN, WAN, DMZ…) and has an address. Zones decide which rules apply; the address decides which subnet the port serves.',
  whatWeDo: `Give X1 the ISP’s static address with Ping-only management, then move X0 to the office subnet ${LAB.lanIp}/24 and reconnect to it.`,
  why: 'A WAN that answers HTTPS or SSH invites attacks from the whole internet. The office plan uses 192.168.10.0/24, not the factory subnet.',
  prerequisites: ['Level 0 complete'],
  expected: [
    { label: 'X1 (WAN)', value: `${LAB.wanIp} / ${LAB.wanMask}` }, { label: 'X1 gateway', value: LAB.wanGw }, { label: 'X1 DNS', value: `${LAB.dns1}, ${LAB.dns2}` },
    { label: 'X1 management', value: 'Ping only' }, { label: 'X0 (LAN)', value: `${LAB.lanIp} / ${LAB.lanMask}` }, { label: 'X0 management', value: 'HTTPS, Ping, SSH' },
  ],
  steps: [
    nav('nav', IF, ['System', 'Interfaces'], undefined, 'The table lists every port: its zone, address, link and which management protocols it answers.'),
    open('ex1', 'Click Configure (pencil) on X1', 'iface', IF, '[data-guide="edit:X1"]', { match: ifDraft('X1') }),
    form('x1addr', 'Set X1 to Static with the ISP’s address', 'iface', { mode: 'static', ip: LAB.wanIp, mask: LAB.wanMask, gateway: LAB.wanGw }, IF, '#if-mode',
      { get: ifGet, labels: { mode: 'IP Assignment', ip: 'IP Address', mask: 'Subnet Mask', gateway: 'Default Gateway' }, saved: x1ok,
        beginner: '/29 (255.255.255.248) gives 6 usable addresses: .9 is the ISP router, .10 is ours, .11 is spare for a published server (task 2.2).' }),
    form('x1dns', 'Enter the DNS servers', 'iface', { dns1: LAB.dns1, dns2: LAB.dns2 }, IF, '#if-dns0', { get: ifGet, labels: { dns1: 'DNS Server 1', dns2: 'DNS Server 2' }, saved: x1ok }),
    form('x1mgmt', 'Under Management, leave only Ping ticked on X1', 'iface', { 'm.ping': true, 'm.https': false, 'm.ssh': false, 'm.http': false, 'm.snmp': false }, IF, '#if-m-https',
      { get: ifGet, labels: { 'm.ping': 'Ping', 'm.https': 'HTTPS', 'm.ssh': 'SSH', 'm.http': 'HTTP', 'm.snmp': 'SNMP' }, saved: (s) => x1ok(s) && x1mgmt(s),
        why: 'Ping helps your ISP and you test reachability. Admin protocols on the WAN are the most attacked surface of any firewall.' }),
    save('x1save', 'Click OK to save X1', IF, orConfirm('[data-guide="iface-ok"]'), (s) => x1ok(s) && x1mgmt(s),
      (s) => (!x1ok(s) ? 'X1 address, gateway or DNS do not match the expected values.' : !x1mgmt(s) ? 'X1 still allows a management protocol other than Ping.' : null)),
    open('ex0', 'Click Configure on X0 — the port your PC is plugged into', 'iface', IF, '[data-guide="edit:X0"]', { match: ifDraft('X0'), why: 'You are about to change the address you are managing the firewall through. Expect to be disconnected.' }),
    form('x0addr', 'Change X0 to the office subnet', 'iface', { ip: LAB.lanIp, mask: LAB.lanMask, 'm.https': true, 'm.ping': true, 'm.ssh': true }, IF, '#if-ip',
      { get: ifGet, labels: { ip: 'IP Address', mask: 'Subnet Mask', 'm.https': 'HTTPS', 'm.ping': 'Ping', 'm.ssh': 'SSH' }, saved: x0ok }),
    save('x0save', 'Click OK, read the warning, then “Save and disconnect”', IF, orConfirm('[data-guide="iface-ok"]'), x0ok),
    { id: 'pcaddr', title: 'Give ADMIN-PC an address in the new subnet (Lab Tools › PC Console › static)', lab: 'pc', target: '[data-guide="pc-mode-static"]',
      expect: `${LAB.adminPc} / ${LAB.lanMask}, gateway ${LAB.lanIp}, DNS ${LAB.dns1}`,
      done: (c) => !!c.s.session.pc.ip && inSubnet(c.s.session.pc.ip, LAB.lanIp, LAB.lanMask) && c.s.session.pc.gateway === LAB.lanIp,
      hint: (c) => (c.s.session.pc.ip && !inSubnet(c.s.session.pc.ip, LAB.lanIp, LAB.lanMask) ? `ADMIN-PC is still ${c.s.session.pc.ip}. The DHCP scope still hands out the old subnet until task 1.3, so set a static address.` : null),
      beginner: 'Your PC and the firewall must share a subnet to talk. The DHCP scope is fixed in task 1.3, so use a static address for now.' },
    { id: 'browse', title: 'Type the new management address in the browser', expect: `https://${LAB.lanIp}`, target: '[data-guide="url"]',
      done: (c) => { const u = parseUrl(c.s.session.browserUrl); return !!u && u.host === LAB.lanIp && u.scheme === 'https'; } },
    { id: 'relogin', title: 'Accept the certificate warning again and sign in', route: 'browser:login', target: '[data-guide="cert-proceed"], [data-guide="login-user"]',
      done: (c) => c.s.session.loggedIn && c.s.session.connectedIp === LAB.lanIp },
  ],
  checks: [
    { id: 'x1', label: 'X1 is WAN, static 203.0.113.10/29, gateway .9, DNS 1.1.1.1 + 8.8.8.8', test: (s) => ok(x1ok(s), 'X1 matches the ISP plan', `X1 is ${iface(s, 'X1').mode} ${iface(s, 'X1').ip}/${iface(s, 'X1').mask} gw ${iface(s, 'X1').gateway}`) },
    { id: 'x1m', label: 'X1 answers Ping only (no HTTPS/HTTP/SSH/SNMP)', test: (s) => ok(x1mgmt(s), 'Ping only', 'X1 allows an admin protocol on the WAN.') },
    { id: 'wanmgmt', label: 'HTTPS management from the internet is refused', test: (s) => flowIs(s, { from: 'outside', to: LAB.wanIp, proto: 'TCP', port: 443 }, ['mgmt-denied', 'no-rule', 'nat-mismatch']) },
    { id: 'x0', label: 'X0 is 192.168.10.1/24 with HTTPS, Ping, SSH', test: (s) => ok(x0ok(s), 'X0 matches', `X0 is ${iface(s, 'X0').ip}/${iface(s, 'X0').mask}`) },
    { id: 'reach', label: 'ADMIN-PC manages the firewall at 192.168.10.1', test: (s) => flowIs(s, { from: 'admin', to: LAB.lanIp, proto: 'TCP', port: s.config.system.httpsPort }, ['consumed']) },
  ],
  verify: 'Saved interface values are compared with the plan, and the engine proves HTTPS works from the LAN and is refused from the internet.',
  mistakes: ['Typing 255.255.255.0 for the WAN mask — the ISP gave a /29.', 'Leaving HTTPS ticked on X1 “just for now”.', 'Changing X0 and then not knowing why the GUI stopped answering.'],
  troubleshooting: ['Lost the GUI after saving X0: set ADMIN-PC to 192.168.10.5/24 gateway 192.168.10.1 and browse to https://192.168.10.1.', 'Completely locked out: the disconnected screen offers serial-console recovery.'],
};

/* ------------------------------------------------------------------ 1.2 */
const diagOk = (tool: string, target: string) => (c: Parameters<StepDef['done']>[0]) => c.events.some((e) => e.type === 'diag' && e.data.tool === tool && String(e.data.target).toLowerCase() === target && e.data.ok === true);
const diagHint = (tool: string, target: string) => (c: Parameters<StepDef['done']>[0]) => {
  const ev = [...c.events].reverse().find((e) => e.type === 'diag' && e.data.tool === tool && String(e.data.target).toLowerCase() === target);
  return ev && !ev.data.ok ? `It failed: ${String(ev.data.reason)}` : null;
};
const dnsOk = (s: S) => { const d = firewallDns(s); return d.includes(LAB.dns1) && d.includes(LAB.dns2); };
const t12: TaskDef = {
  id: '1.2', level: 1, title: 'Default route and DNS', minutes: 10, difficulty: 'Fresher',
  what: 'The default route sends everything not local to the ISP router. DNS turns names into addresses for the firewall and, through its proxy, for clients.',
  whatWeDo: 'Confirm the default route via X1, make sure the firewall uses 1.1.1.1 and 8.8.8.8, then prove it from DEVICE › Diagnostics.',
  why: 'When “the internet is down”, the first questions are always: is there a route, does the gateway answer, does DNS resolve?',
  prerequisites: ['1.1'],
  expected: [{ label: 'Default route', value: `0.0.0.0/0 via X1, gateway ${LAB.wanGw}` }, { label: 'DNS', value: `${LAB.dns1}, ${LAB.dns2}` }],
  steps: [
    nav('nav', 'policy/rules/routing', ['Rules and Policies', 'Routing Rules'], 'In Classic mode routes live under POLICY, not NETWORK.'),
    info('route', `Find “Default Route (X1)”: destination 0.0.0.0/0, gateway ${LAB.wanGw}. It was built automatically from X1’s gateway.`, { route: 'policy/rules/routing', target: '[data-guide="route:Default Route (X1)"]' }),
    nav('dnsnav', 'network/dns/settings', ['DNS', 'DNS Settings']),
    save('dns', `Make sure “Servers in use” shows ${LAB.dns1} and ${LAB.dns2} (inherit from WAN, or specify them and click Accept)`, 'network/dns/settings', '[data-guide="dns-inherit"]', dnsOk,
      (s) => `The firewall currently uses: ${firewallDns(s).join(', ') || 'no DNS servers'}.`, { expect: `${LAB.dns1}, ${LAB.dns2}` }),
    nav('dnav', 'device/diagnostics/tools', ['Diagnostics', 'Diagnostic Tools']),
    { id: 'pgw', title: 'Ping the ISP gateway from the firewall', expect: `Ping ${LAB.wanGw}`, route: 'device/diagnostics/tools', target: '[data-guide="diag-target"]', done: diagOk('ping', LAB.wanGw), hint: diagHint('ping', LAB.wanGw),
      beginner: 'If the gateway does not answer, nothing beyond it will. Check the X1 address, mask and gateway first.' },
    { id: 'p8', title: 'Ping a public address', expect: 'Ping 8.8.8.8', route: 'device/diagnostics/tools', target: '[data-guide="diag-target"]', done: diagOk('ping', '8.8.8.8'), hint: diagHint('ping', '8.8.8.8') },
    { id: 'lk', title: 'Resolve a name', expect: 'DNS Name Lookup www.search.example', route: 'device/diagnostics/tools', target: '[data-guide="diag-tool"]', done: diagOk('dns', 'www.search.example'), hint: diagHint('dns', 'www.search.example'),
      why: 'Ping by IP working while names fail is the classic DNS fault.' },
    event('pc', 'From ADMIN-PC, run nslookup www.search.example in the PC Console', 'console', (d) => d.cmd === 'nslookup' && d.ok === true, { lab: 'pc', target: '[data-guide="pc-cmd"]', expect: 'nslookup www.search.example' }),
  ],
  checks: [
    { id: 'route', label: 'Default route via X1 to 203.0.113.9', test: (s) => ok(builtInRoutes(s.config).some((r) => r.name === 'Default Route (X1)' && r.gateway === LAB.wanGw), 'Default Route (X1) present', 'No default route via X1 with gateway 203.0.113.9.') },
    { id: 'dns', label: 'Firewall DNS servers are 1.1.1.1 and 8.8.8.8', test: (s) => ok(dnsOk(s), firewallDns(s).join(', '), `DNS servers: ${firewallDns(s).join(', ') || 'none'}`) },
    { id: 'gw', label: 'The ISP gateway answers the firewall', test: (s) => { const r = fwPing(s, LAB.wanGw); return ok(r.ok, `${LAB.wanGw} is alive`, r.reason); } },
    { id: 'name', label: 'The firewall resolves www.search.example', test: (s) => { const r = fwLookup(s, 'www.search.example'); return ok(r.ok, `www.search.example → ${r.ip}`, r.reason); } },
  ],
  verify: 'Route and DNS are read from the configuration; gateway ping and name lookup are re-run by the simulator from the firewall.',
  mistakes: ['Adding a second “default route” policy with a wrong gateway — the more specific or earlier route wins and breaks things.', 'Testing only by IP and declaring the internet working.'],
  troubleshooting: ['Gateway does not answer: compare X1’s gateway with the ISP sheet (203.0.113.9).', 'Names fail but IPs work: the firewall has no DNS, or LAN rules block UDP/TCP 53.'],
};

/* ------------------------------------------------------------------ 1.3 */
const DH = 'network/system/dhcp';
const scopeOk = (s: S) => s.config.dhcp.enabled && s.config.dhcp.scopes.some((sc) => sc.enabled && sc.iface === 'X0' && sc.start === LAB.poolStart && sc.end === LAB.poolEnd && sc.gateway === LAB.lanIp && sc.leaseMin === 1440 && sc.dns[0] === LAB.dns1 && sc.dns[1] === LAB.dns2);
const resOk = (s: S) => s.config.dhcp.statics.some((r) => r.enabled && r.name === 'PRINTER-01' && r.ip === LAB.printer && sameMac(r.mac, LAB.macs.printer));
const t13: TaskDef = {
  id: '1.3', level: 1, title: 'DHCP server and reservations', minutes: 10, difficulty: 'Fresher',
  what: 'The DHCP server leases addresses from a range (scope). A reservation always gives one MAC the same address.',
  whatWeDo: `Move the X0 scope to ${LAB.poolStart}–${LAB.poolEnd} with the right gateway and DNS, and reserve ${LAB.printer} for PRINTER-01.`,
  why: 'After task 1.1 the old scope no longer matches X0, so new devices get nothing. Printers and servers need addresses that never change.',
  prerequisites: ['1.2'],
  expected: [{ label: 'Range', value: `${LAB.poolStart} – ${LAB.poolEnd}` }, { label: 'Lease', value: '1440 minutes (1 day)' }, { label: 'Gateway', value: LAB.lanIp }, { label: 'DNS', value: `${LAB.dns1}, ${LAB.dns2}` }, { label: 'PRINTER-01', value: `${LAB.printer} ↔ ${LAB.macs.printer}` }],
  steps: [
    nav('nav', DH, ['System', 'DHCP Server']),
    info('bad', 'Notice the X0 scope shows “not serving”: its range is still 192.168.168.x but X0 is now 192.168.10.1/24', { route: DH, target: '[data-guide="scope:X0"]' }),
    open('edit', 'Click Configure on the X0 scope', 'scope', DH, '[data-guide="edit-scope:X0"]'),
    form('range', 'Set the range, lease time and gateway', 'scope', { start: LAB.poolStart, end: LAB.poolEnd, leaseMin: 1440, gateway: LAB.lanIp }, DH, '#sc-start',
      { labels: { start: 'Range Start', end: 'Range End', leaseMin: 'Lease Time', gateway: 'Default Gateway' }, saved: scopeOk, beginner: 'Addresses .2–.99 stay free for static devices like the printer and your PC (.5).' }),
    form('dns', 'Set the DNS servers clients will use', 'scope', { dns: [LAB.dns1, LAB.dns2] }, DH, '#sc-dns0', { get: (d) => d.dns, labels: { dns: 'DNS servers' }, saved: scopeOk }),
    save('save', 'Click OK', DH, '[data-guide="scope-save"]', scopeOk, () => 'The saved scope does not match yet — check every value.'),
    open('add', 'Click Add Static', 'static', DH, '[data-guide="add-static"]'),
    form('res', 'Reserve the printer’s address', 'static', { name: 'PRINTER-01', ip: LAB.printer, mac: LAB.macs.printer }, DH, '#st-name',
      { labels: { name: 'Entry Name', ip: 'Static IP', mac: 'MAC' }, saved: resOk, beginner: 'The MAC is on the printer’s label — in the lab, see Lab Tools › Lab Hosts.' }),
    save('ressave', 'Click OK', DH, '[data-guide="static-save"]', resOk),
    info('leases', 'Open “Current DHCP Leases” and confirm PRINTER-01 has 192.168.10.50 (Static)', { route: DH, tab: 'leases', target: '[data-guide="lease:printer"]' }),
  ],
  checks: [
    { id: 'scope', label: 'X0 scope 192.168.10.100–.199, 1440 min, gateway .1, DNS 1.1.1.1/8.8.8.8', test: (s) => ok(scopeOk(s), 'Scope matches', 'The X0 scope does not match the plan.') },
    { id: 'res', label: 'PRINTER-01 reserved at 192.168.10.50', test: (s) => ok(resOk(s), 'Reservation present', 'No matching reservation for PRINTER-01.') },
    { id: 'lease', label: 'PRINTER-01 actually receives 192.168.10.50', test: (s) => { const l = leases(s).find((x) => x.host === 'printer'); return ok(l?.ip === LAB.printer, `Lease ${l?.ip}`, l ? `The printer got ${l.ip}.` : 'The printer got no lease.'); } },
  ],
  verify: 'The scope and reservation are read from the configuration and the simulator recomputes the printer’s lease.',
  mistakes: ['Making the range include .1 or .50.', 'Typing the gateway as 192.168.168.168 out of habit.'],
  troubleshooting: ['“not serving”: the range must sit inside the interface subnet.', 'Printer gets a pool address: the MAC in the reservation has a typo.'],
};

/* ------------------------------------------------------------------ 1.4 */
const AS = 'network/system/mac-ip-anti-spoof';
const cached = (s: S, ip: string, mac: string, black = false) => s.config.antiSpoof.cache.some((c) => c.iface === 'X0' && c.ip === ip && sameMac(c.mac, mac) && c.blacklisted === black);
const rogueBlack = (s: S) => s.config.antiSpoof.cache.some((c) => sameMac(c.mac, LAB.macs.rogue) && c.blacklisted);
const x0spoof = (s: S) => { const a = s.config.antiSpoof.ifaces.X0; return !!a && a.enabled && a.enforceIngress && a.spoofDetection && a.arpLock; };
const entry = (id: string, who: string, ip: string, mac: string): StepDef[] => [
  open(`${id}o`, `Click Add (cache entry for ${who})`, 'spoofentry', AS, '[data-guide="spoof-add"]', { tab: 'cache', match: () => true }),
  form(`${id}f`, `Enter ${who}’s pair`, 'spoofentry', { iface: 'X0', ip, mac }, AS, '#se-ip', { labels: { iface: 'Interface', ip: 'IP', mac: 'MAC' }, saved: (s) => cached(s, ip, mac) }),
  save(`${id}s`, 'Click OK', AS, '[data-guide="spoofentry-save"]', (s) => cached(s, ip, mac)),
];
const t14: TaskDef = {
  id: '1.4', level: 1, title: 'MAC-IP anti-spoof', minutes: 15, difficulty: 'Fresher',
  what: 'Anti-spoof keeps a cache of known IP↔MAC pairs per interface and can drop anything that does not match, or anything from a blacklisted MAC.',
  whatWeDo: `An unknown laptop has taken FIN-PC’s address ${LAB.finPc}. Prove the problem, record the real pairs from the asset register, blacklist the laptop and enforce on X0.`,
  why: 'Anyone who can plug in can claim any IP. Without binding, the last device to answer ARP gets the traffic — that is both an outage and an attack.',
  prerequisites: ['1.3'],
  expected: [{ label: 'ADMIN-PC', value: `${LAB.adminPc} ↔ ${LAB.macs.admin}` }, { label: 'HR-PC', value: `${LAB.hrPc} ↔ ${LAB.macs.hr}` }, { label: 'FIN-PC', value: `${LAB.finPc} ↔ ${LAB.macs.fin}` }, { label: 'Blacklist', value: `${LAB.macs.rogue} (unknown laptop)` }, { label: 'X0 flags', value: 'Enable, DHCP Server, ARP Lock, Enforce, Spoof Detection, Allow Management' }],
  steps: [
    test('t1', 'Send a test from FIN-PC to www.search.example (HTTPS) and see it fail', (d) => d.from === 'fin', ['arp-conflict'], { prefill: { from: 'fin', to: 'www.search.example', svc: 'https' },
      beginner: 'The Traffic Tester runs the packet through the simulated firewall and explains each stage.' }),
    nav('arp', 'network/system/arp', ['System', 'ARP']),
    info('arpinfo', `Find ${LAB.finPc}: it maps to ${LAB.macs.rogue} (vendor UNKNOWN), not FIN-PC’s ${LAB.macs.fin}`, { route: 'network/system/arp', target: `[data-guide="arp:${LAB.finPc}"]` }),
    // 'asnav', not 'as': entry('a', …) below already produces the step id 'as' (ADMIN-PC save), and step ids must be unique.
    nav('asnav', AS, ['System', 'MAC IP Anti-Spoof']),
    ...entry('a', 'ADMIN-PC', LAB.adminPc, LAB.macs.admin),
    ...entry('h', 'HR-PC', LAB.hrPc, LAB.macs.hr),
    ...entry('f', 'FIN-PC', LAB.finPc, LAB.macs.fin),
    open('ro', 'Click Add for the unknown laptop', 'spoofentry', AS, '[data-guide="spoof-add"]', { tab: 'cache', match: () => true }),
    form('rf', 'Enter the laptop’s MAC with Blacklisted on', 'spoofentry', { iface: 'X0', ip: LAB.finPc, mac: LAB.macs.rogue, blacklisted: true }, AS, '#se-mac', { labels: { iface: 'Interface', ip: 'IP', mac: 'MAC', blacklisted: 'Blacklisted' }, saved: rogueBlack }),
    save('rs', 'Click OK', AS, '[data-guide="spoofentry-save"]', rogueBlack),
    open('xo', 'On the Settings tab, click Configure for X0', 'spoofif', AS, '[data-guide="spoof-edit:X0"]', { tab: 'settings', match: (d) => d.iface === 'X0' }),
    form('xf', 'Turn on Enable, DHCP Server, ARP Lock, Enforce (Ingress), Spoof Detection and keep Allow Management', 'spoofif',
      { enabled: true, dhcpServer: true, arpLock: true, enforceIngress: true, spoofDetection: true, allowMgmt: true }, AS, '#as-enabled',
      { labels: { enabled: 'Enable', dhcpServer: 'DHCP Server', arpLock: 'ARP Lock', enforceIngress: 'Enforce', spoofDetection: 'Spoof Detection', allowMgmt: 'Allow Management' }, saved: x0spoof,
        why: 'DHCP Server trusts pairs the firewall handed out itself; ARP Lock stops the rogue overwriting FIN-PC’s entry; Allow Management keeps you from locking yourself out.' }),
    save('xs', 'Click OK', AS, '[data-guide="spoofif-save"]', x0spoof),
    test('t2', 'Test again from the unknown laptop — it must be dropped', (d) => d.from === 'rogue', ['spoof-blocked'], { prefill: { from: 'rogue', to: 'www.search.example', svc: 'https' } }),
    test('t3', 'Test from FIN-PC — it must work now', (d) => d.from === 'fin', ['allowed'], { prefill: { from: 'fin', to: 'www.search.example', svc: 'https' } }),
    nav('logs', 'monitor/logs/system-logs', ['Logs', 'System Logs']),
    info('alert', 'Find the “MAC-IP anti-spoof” alert for the blacklisted MAC — this is your evidence', { route: 'monitor/logs/system-logs', target: '[data-guide="logs-search"]' }),
  ],
  checks: [
    { id: 'pairs', label: 'Cache holds ADMIN-PC, HR-PC and FIN-PC pairs', test: (s) => { const miss = [['ADMIN-PC', LAB.adminPc, LAB.macs.admin], ['HR-PC', LAB.hrPc, LAB.macs.hr], ['FIN-PC', LAB.finPc, LAB.macs.fin]].filter(([, i, m]) => !cached(s, i, m)); return ok(!miss.length, '3 trusted pairs', `Missing: ${miss.map((x) => x[0]).join(', ')}`); } },
    { id: 'black', label: 'Unknown laptop MAC blacklisted', test: (s) => ok(rogueBlack(s), LAB.macs.rogue, 'The rogue MAC is not blacklisted.') },
    { id: 'flags', label: 'X0 enforcement on (Enable, ARP Lock, Enforce, Spoof Detection)', test: (s) => ok(x0spoof(s), 'X0 enforced', 'X0 anti-spoof flags incomplete.') },
    { id: 'rogue', label: 'Unknown laptop is dropped', test: (s) => flowIs(s, { from: 'rogue', to: LAB.lanIp, proto: 'ICMP', port: 0 }, ['spoof-blocked']) },
    { id: 'fin', label: 'FIN-PC works again', test: (s) => flowIs(s, { from: 'fin', to: LAB.lanIp, proto: 'ICMP', port: 0 }, ['consumed']) },
    { id: 'admin', label: 'You still manage the firewall from ADMIN-PC', test: (s) => flowIs(s, { from: 'admin', to: s.session.connectedIp, proto: 'TCP', port: s.config.system.httpsPort }, ['consumed']) },
  ],
  verify: 'The cache and flags are read from the configuration; the engine re-runs the rogue, FIN-PC and ADMIN-PC flows.',
  mistakes: ['Enforcing before your own PC is in the cache, with Allow Management off — instant lockout.', 'Blacklisting by IP instead of MAC: the rogue just picks another address.'],
  troubleshooting: ['FIN-PC still broken: ARP Lock pins FIN’s pair, or Enforce drops the rogue — you need at least one with FIN’s correct pair cached.', 'Locked out: the disconnected screen offers console recovery.'],
};

/* ------------------------------------------------------------------ 1.5 */
const AD = 'object/match/addresses';
const has = (s: S, a: Partial<AddressObject> & { name: string }) => s.config.addresses.some((x) => x.name === a.name && Object.entries(a).every(([k, v]) => String(x[k as keyof AddressObject]).toLowerCase() === String(v).toLowerCase()));
const OBJS: (Partial<AddressObject> & { name: string; why: string })[] = [
  { name: 'H_WEB-01', zone: 'DMZ', type: 'host', ip: LAB.webServer, why: 'The DMZ web server, published in task 2.2.' },
  { name: 'N_LAN-Staff', zone: 'LAN', type: 'network', ip: '192.168.10.0', ip2: '255.255.255.0', why: 'The whole office LAN, used as the source of the first outbound rule.' },
  { name: 'FQDN_update-site', zone: 'WAN', type: 'fqdn', fqdn: 'updates.vendor.example', why: 'A name, not an IP: the firewall resolves it, so the rule follows the site if its address changes.' },
  { name: 'H_FIN-PC', zone: 'LAN', type: 'host', ip: LAB.finPc, why: 'One finance workstation, placed in a group so more can be added later.' },
];
const objSteps = (o: (typeof OBJS)[number], n: number): StepDef[] => {
  const { why, ...want } = o;
  const w: Record<string, unknown> = { ...want };
  return [
    open(`o${n}`, `Click Add for ${o.name}`, 'addr', AD, '[data-guide="add-address"]', { tab: 'objects', why }),
    form(`f${n}`, `Fill in ${o.name}`, 'addr', w, AD, '#ad-name', { labels: { name: 'Name', zone: 'Zone', type: 'Type', ip: o.type === 'network' ? 'Network' : 'IP Address', ip2: 'Netmask', fqdn: 'FQDN' }, saved: (s) => has(s, want) }),
    save(`s${n}`, 'Click Save', AD, '[data-guide="addr-save"]', (s) => has(s, want)),
  ];
};
const grpOk = (s: S) => !!s.config.addressGroups.find((g) => g.name === 'G_Finance-PCs')?.members.includes('H_FIN-PC');
const t15: TaskDef = {
  id: '1.5', level: 1, title: 'Address objects and groups', minutes: 15, difficulty: 'Fresher',
  what: 'Address objects give names to hosts, networks, ranges and FQDNs. Groups bundle objects. Rules refer to names, never to raw IPs.',
  whatWeDo: 'Create the four objects the next tasks use, then a group for finance PCs.',
  why: 'When an address changes you edit one object, not twenty rules. Names also make rules readable in an audit.',
  prerequisites: ['1.4'],
  expected: [
    { label: 'H_WEB-01', value: `Host ${LAB.webServer}, zone DMZ` }, { label: 'N_LAN-Staff', value: 'Network 192.168.10.0/255.255.255.0, zone LAN' },
    { label: 'FQDN_update-site', value: 'FQDN updates.vendor.example, zone WAN' }, { label: 'H_FIN-PC', value: `Host ${LAB.finPc}, zone LAN` }, { label: 'G_Finance-PCs', value: 'contains H_FIN-PC' },
  ],
  steps: [
    nav('nav', AD, ['Match Objects', 'Addresses'], undefined, 'Default objects (X0 IP, X0 Subnet, LAN Subnets…) are created by the firewall from the interfaces; yours are “Custom”.'),
    ...OBJS.flatMap(objSteps),
    open('go', 'Open the Address Groups tab and click Add', 'addrgroup', AD, '[data-guide="add-group"]', { tab: 'groups' }),
    form('gf', 'Name the group G_Finance-PCs and move H_FIN-PC into it', 'addrgroup', { name: 'G_Finance-PCs', members: ['H_FIN-PC'] }, AD, '#ag-name', { labels: { name: 'Name', members: 'Members' }, saved: grpOk }),
    save('gs', 'Click Save', AD, '[data-guide="grp-save"]', grpOk),
  ],
  checks: [
    ...OBJS.map((o) => { const { why: _w, ...want } = o; void _w; return { id: o.name, label: `${o.name} exists with the right type, zone and value`, test: (s: S) => ok(has(s, want), 'matches', s.config.addresses.some((x) => x.name === o.name) ? `${o.name} exists but a value differs.` : `${o.name} does not exist.`) }; }),
    { id: 'grp', label: 'G_Finance-PCs contains H_FIN-PC', test: (s) => ok(grpOk(s), 'group OK', 'Group missing or H_FIN-PC not a member.') },
  ],
  verify: 'Every object is compared field by field with the plan.',
  mistakes: ['Network object with a host address (192.168.10.1 instead of .0).', 'Wrong zone — a LAN object in the WAN zone silently fails zone-aware checks.'],
  troubleshooting: ['“already exists”: names are unique across objects and groups.', 'Cannot delete an object: it is still used by a rule or group (see References).'],
};

/* ------------------------------------------------------------------ 1.6 */
const AR = 'policy/rules/access';
const SVC = 'object/match/services';
const sgOk = (s: S) => { const g = s.config.serviceGroups.find((x) => x.name === 'SG_Web-DNS'); return !!g && ['HTTP', 'HTTPS', 'DNS (Name Service)'].every((m) => g.members.includes(m)); };
const ruleOk = (s: S) => s.config.accessRules.some((r) => r.name === 'LAN-Web-Out' && r.fromZone === 'LAN' && r.toZone === 'WAN' && r.action === 'allow' && r.src === 'N_LAN-Staff' && r.dst === 'Any' && r.service === 'SG_Web-DNS' && r.logging && r.enabled);
const defOff = (s: S) => s.config.accessRules.find((r) => r.id === 'r-lan-wan')?.enabled === false;
const t16: TaskDef = {
  id: '1.6', level: 1, title: 'First access rule and outbound NAT', minutes: 20, difficulty: 'Fresher',
  what: 'Access rules decide what may cross from one zone to another, top-down, first match wins. NAT then rewrites the private source to the public WAN address.',
  whatWeDo: 'Allow the staff LAN only web and DNS to the internet, log it, turn off the “allow anything” default, and prove web works while SSH does not.',
  why: 'The factory LAN→WAN rule allows every port. Least privilege means allowing what the business needs and logging it.',
  prerequisites: ['1.5'],
  expected: [{ label: 'Service group', value: 'SG_Web-DNS = HTTP, HTTPS, DNS (Name Service)' }, { label: 'Rule', value: 'LAN-Web-Out: LAN→WAN, N_LAN-Staff → Any, SG_Web-DNS, Allow, logging on' }, { label: 'Default LAN→WAN', value: 'disabled' }, { label: 'NAT', value: 'Default NAT Policy (X1) enabled' }],
  steps: [
    nav('svc', SVC, ['Match Objects', 'Services']),
    open('sgo', 'Open the Service Groups tab and click Add', 'svcgroup', SVC, '[data-guide="add-svcgroup"]', { tab: 'groups' }),
    form('sgf', 'Create SG_Web-DNS with HTTP, HTTPS and DNS (Name Service)', 'svcgroup', { name: 'SG_Web-DNS', members: ['HTTP', 'HTTPS', 'DNS (Name Service)'] }, SVC, '#sg-name',
      { labels: { name: 'Name', members: 'Members' }, saved: sgOk, beginner: 'DNS (Name Service) is itself a group of TCP 53 and UDP 53. Picking only one of them breaks some lookups.' }),
    save('sgs', 'Click Save', SVC, '[data-guide="sg-save"]', sgOk),
    nav('ar', AR, ['Rules and Policies', 'Access Rules']),
    open('ro', 'Click Add', 'rule', AR, '[data-guide="add-rule"]'),
    form('rf', 'Fill in the rule', 'rule', { action: 'allow', name: 'LAN-Web-Out', fromZone: 'LAN', toZone: 'WAN', src: 'N_LAN-Staff', dst: 'Any', service: 'SG_Web-DNS', logging: true, enabled: true }, AR, '#ar-name',
      { labels: { action: 'Action', name: 'Name', fromZone: 'From', toZone: 'To', src: 'Source', dst: 'Destination', service: 'Service', logging: 'Logging', enabled: 'Enable' }, saved: ruleOk }),
    save('rs', 'Click Add (it goes to the top of LAN→WAN)', AR, orConfirm('[data-guide="rule-save"]'), ruleOk),
    save('def', 'Disable “Default LAN→WAN” with its Enable toggle', AR, '[data-guide="rule:Default LAN→WAN"] .tw-toggle', defOff, undefined,
      { why: 'Otherwise anything your rule does not allow falls through to the default and is allowed anyway.' }),
    nav('nat', 'policy/rules/nat', ['Rules and Policies', 'NAT Rules']),
    info('natinfo', `Find “Default NAT Policy (X1)”: private sources leaving X1 become ${LAB.wanIp}. Nothing to add.`, { route: 'policy/rules/nat', target: '[data-guide="nat:Default NAT Policy (X1)"]' }),
    test('web', 'Test HR-PC → www.search.example HTTPS — allowed by LAN-Web-Out', (d) => d.from === 'hr' && Number(d.port) === 443 && d.rule === 'LAN-Web-Out', ['allowed'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'https' } }),
    test('ssh', 'Test HR-PC → www.search.example SSH — must be refused', (d) => d.from === 'hr' && Number(d.port) === 22, ['no-rule', 'denied'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'ssh' } }),
    nav('logs', 'monitor/logs/system-logs', ['Logs', 'System Logs']),
    info('ev', 'Find the allowed HTTPS entry (rule LAN-Web-Out) and the dropped SSH entry', { route: 'monitor/logs/system-logs', target: '[data-guide="logs-search"]' }),
  ],
  checks: [
    { id: 'sg', label: 'SG_Web-DNS contains HTTP, HTTPS, DNS (Name Service)', test: (s) => ok(sgOk(s), 'group OK', 'SG_Web-DNS missing or incomplete.') },
    { id: 'rule', label: 'LAN-Web-Out matches the plan', test: (s) => ok(ruleOk(s), 'rule OK', 'LAN-Web-Out is missing or a field differs.') },
    { id: 'def', label: 'Default LAN→WAN is disabled', test: (s) => ok(defOff(s), 'disabled', 'The default LAN→WAN rule is still enabled.') },
    { id: 'nat', label: 'Default outbound NAT on X1 is enabled', test: (s) => ok(!s.config.natDefaultsDisabled.includes('X1'), 'enabled', 'Default NAT Policy (X1) is disabled.') },
    { id: 'webok', label: 'Staff web browsing works (incl. DNS)', test: (s) => flowIs(s, { from: 'hr', to: 'www.search.example', proto: 'TCP', port: 443, user: userFor(s, 'LAN-Web-Out') }, ['allowed']) },
    { id: 'sshno', label: 'SSH to the internet is refused', test: (s) => flowIs(s, { from: 'hr', to: 'www.search.example', proto: 'TCP', port: 22, user: userFor(s, 'LAN-Web-Out') }, ['no-rule', 'denied']) },
  ],
  verify: 'The rule, group and NAT state are read from the configuration; the engine re-runs a web flow and an SSH flow.',
  mistakes: ['Picking only “DNS (Name Service) UDP”: some lookups use TCP and fail.', 'Leaving the default LAN→WAN enabled, which makes the new rule meaningless.', 'Creating the rule WAN→LAN by mistake.'],
  troubleshooting: ['Web test says DNS failure: the rule does not include DNS, or HR-PC’s DNS (1.1.1.1) is blocked.', 'SSH still allowed: another enabled LAN→WAN rule above or below matches it.'],
};

export const LEVEL1: TaskDef[] = [t11, t12, t13, t14, t15, t16];
