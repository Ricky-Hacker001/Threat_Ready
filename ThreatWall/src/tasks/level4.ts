import type { AccessRule, LogEntry, RootState } from '../state/types';
import type { CheckResult, StepDef, TaskDef } from './types';
import { event, fail, flowIs, form, info, nav, open, orConfirm, pass, save, test } from './dsl';
import { LAB } from '../state/baseline';
import { evaluate } from '../engine/traffic';
import { tunnelStatus, branchNetworks } from '../engine/vpn';
import { hostNet } from '../engine/network';
import { hostById, ISP_GATEWAYS } from '../engine/world';
import { findAddress } from '../engine/objects';
import { parseUrl } from '../auth/browser';
import { uid } from '../lib/hash';

type S = RootState;
const ok = (b: boolean, good: string, bad: string): CheckResult => (b ? pass(good) : fail(bad));
const withLab = (s: S, p: Partial<S['lab']>): S => ({ ...s, lab: { ...s.lab, ...p } });
const stepDone = (s: S, task: string, step: string) => !!s.progress.tasks[task]?.stepDoneAt[step];
const note = (s: S, k: string) => (s.progress.notes[k] ?? '').trim();
const noteStep = (id: string, key: string, title: string, min = 20, opts: Partial<StepDef> = {}): StepDef => ({
  id, title, target: `[data-guide="note:${key}"]`, ...opts,
  done: (c) => (c.s.progress.notes[key] ?? '').trim().length >= min,
  hint: (c) => { const v = (c.s.progress.notes[key] ?? '').trim(); return v && v.length < min ? `Write at least ${min} characters — enough that a colleague understands it tomorrow.` : null; },
});
const arjun = LAB.users[1];

/* ------------------------------------------------------------------ 4.1 */
const haCfgOk = (s: S) => { const h = s.config.ha; return h.mode === 'active-standby' && h.secondarySerial === LAB.haSerial && h.statefulSync; };
const haMonOk = (s: S) => ['X0', 'X1'].every((i) => s.config.ha.monitorIfaces.includes(i));
const t41: TaskDef = {
  id: '4.1', level: 4, title: 'High availability', minutes: 25, difficulty: 'Expert',
  what: 'Two identical firewalls share one identity: the primary is active, the secondary waits. With stateful sync it already knows every open connection.',
  whatWeDo: 'Pair the secondary unit, monitor the LAN and WAN links, synchronize, then pull the power on the primary and confirm traffic keeps flowing.',
  why: 'The firewall is a single point of failure for the whole office. HA turns a hardware fault into a non-event.',
  prerequisites: ['Level 3 complete'],
  expected: [{ label: 'Mode', value: 'Active / Standby' }, { label: 'Secondary serial', value: LAB.haSerial }, { label: 'Stateful sync', value: 'On' }, { label: 'Monitored links', value: 'X0, X1' }],
  steps: [
    nav('nav', 'device/ha/settings', ['High Availability', 'Settings']),
    form('f', 'Active/Standby, secondary serial, stateful synchronization on', 'ha', { mode: 'active-standby', secondarySerial: LAB.haSerial, statefulSync: true }, 'device/ha/settings', '#ha-mode',
      { labels: { mode: 'Mode', secondarySerial: 'Secondary serial', statefulSync: 'Stateful sync' }, saved: haCfgOk, beginner: 'Without stateful sync the standby takes over but every open session (calls, downloads, VPN) drops.' }),
    save('s', 'Click Accept', 'device/ha/settings', '[data-guide="accept"]', haCfgOk),
    nav('mon', 'device/ha/monitoring', ['High Availability', 'Monitoring']),
    form('mf', 'Monitor X0 and X1', 'ha', { monitorIfaces: ['X0', 'X1'] }, 'device/ha/monitoring', '#ha-mon-X0', { labels: { monitorIfaces: 'Monitored' }, saved: (s) => haCfgOk(s) && haMonOk(s) }),
    save('ms', 'Click Accept', 'device/ha/monitoring', '[data-guide="accept"]', (s) => haCfgOk(s) && haMonOk(s)),
    nav('st', 'device/ha/status', ['High Availability', 'Status']),
    save('sync', 'Click Synchronize Settings', 'device/ha/status', '[data-guide="ha-sync"]', (s) => s.config.ha.synced && haCfgOk(s)),
    test('t1', 'Test HR-PC → www.search.example HTTPS — served by the primary', (d) => d.from === 'hr' && d.servedBy === 'primary', ['allowed'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'https' } }),
    { id: 'off', title: 'In Lab Tools › Lab Controls, power off the Primary unit', lab: 'controls', target: '[data-guide="lab-ha-primary"]', done: (c) => !c.s.lab.haPower.primary },
    test('t2', 'Test again — still allowed, now served by the secondary', (d) => d.from === 'hr' && d.servedBy === 'secondary', ['allowed'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'https' } }),
    { id: 'on', title: 'Power the primary back on', lab: 'controls', target: '[data-guide="lab-ha-primary"]', done: (c) => c.s.lab.haPower.primary },
  ],
  checks: [
    { id: 'cfg', label: 'Active/Standby with the right secondary, stateful sync on', test: (s) => ok(haCfgOk(s), 'HA OK', 'HA mode, serial or stateful sync differ.') },
    { id: 'mon', label: 'X0 and X1 monitored', test: (s) => ok(haMonOk(s), 'monitored', 'X0 and X1 must both be monitored.') },
    { id: 'sync', label: 'Units synchronized', test: (s) => ok(s.config.ha.synced, 'synchronized', 'Not synchronized.') },
    { id: 'fail', label: 'Traffic survives a primary failure', test: (s) => { const r = evaluate(withLab(s, { haPower: { primary: false, secondary: true } }), { from: 'hr', to: 'www.search.example', proto: 'TCP', port: 443, user: LAB.users[0] }).result; return ok(r.ok && r.servedBy === 'secondary', 'secondary took over', `${r.verdict}: ${r.reason}`); } },
  ],
  verify: 'HA settings are read from the configuration; the engine simulates the primary powered off.',
  mistakes: ['Typing the primary’s own serial as the secondary.', 'Forgetting to synchronize: the standby would come up with an empty configuration.'],
  troubleshooting: ['Synchronize is greyed out: check mode, serial, the HA licence and that the secondary is powered.', 'Traffic stops when the primary is off: HA not synchronized.'],
};

/* ------------------------------------------------------------------ 4.2 */
const BAD_GW = '203.0.113.14';
export function seedRouteFault(s: S): S {
  const cfg = s.config;
  const addresses = cfg.addresses.some((a) => a.name === 'H_ERP-Server') ? cfg.addresses : [...cfg.addresses, { id: 'seed-erp', name: 'H_ERP-Server', zone: 'WAN', type: 'host' as const, ip: '192.0.2.20', ip2: '255.255.255.255', fqdn: '', comment: 'ERP SaaS (added by previous admin)' }];
  const routes = cfg.routes.some((r) => r.name === 'ERP-Legacy-Path') ? cfg.routes.map((r) => (r.name === 'ERP-Legacy-Path' ? { ...r, enabled: true, gateway: BAD_GW, iface: 'X1' } : r))
    : [...cfg.routes, { id: 'seed-erp-route', name: 'ERP-Legacy-Path', src: 'Any', dst: 'H_ERP-Server', service: 'Any', type: 'standard' as const, iface: 'X1', gateway: BAD_GW, pathProfile: '', metric: 1, enabled: true, hits: 0, comment: 'Via the old ISP router — re-enabled during last night’s change' }];
  return { ...s, config: { ...cfg, addresses, routes } };
}
const badRoute = (s: S) => s.config.routes.some((r) => r.enabled && r.type === 'standard' && ISP_GATEWAYS[r.iface] && r.gateway !== '0.0.0.0' && r.gateway !== ISP_GATEWAYS[r.iface]);
const pmHas = (s: S, status: string) => s.pm.packets.some((p) => p.dst === '192.0.2.20' && p.dstPort === 443 && p.status === status);
const erpFlow = (s: S) => evaluate(s, { from: 'fin', to: 'erp.kaveri-textiles.example', proto: 'TCP', port: 443, user: arjun }).result;
const t42: TaskDef = {
  id: '4.2', level: 4, title: 'Packet-flow troubleshooting', minutes: 25, difficulty: 'Expert',
  what: 'Packet Monitor records what the firewall did with each packet — forwarded, consumed or dropped — and the exact drop reason.',
  whatWeDo: 'After a night change, Finance cannot reach the ERP SaaS while everything else works. Capture the failing flow, read the drop code, fix the cause, capture the success, and write the root cause.',
  why: 'Guessing burns hours and causes new outages. A capture turns “it doesn’t work” into one precise line of evidence.',
  prerequisites: ['4.1'],
  scenario: { label: 'Apply last night’s change: Finance reports erp.kaveri-textiles.example times out since this morning.', apply: seedRouteFault },
  expected: [{ label: 'Failing flow', value: 'FIN-PC → erp.kaveri-textiles.example (192.0.2.20) TCP 443' }, { label: 'Capture filter', value: 'Destination 192.0.2.20, port 443' }, { label: 'Evidence', value: 'one dropped and one forwarded packet, exported' }],
  notes: [{ key: 'rca-42', label: 'Root cause and fix (for the change ticket)', placeholder: 'What broke, how the capture proved it, what you changed…', rows: 4 }],
  steps: [
    test('t1', `Reproduce: test FIN-PC → erp.kaveri-textiles.example HTTPS as user ${arjun}`, (d) => d.from === 'fin' && String(d.to).includes('erp'), ['invalid-route'], { prefill: { from: 'fin', to: 'erp.kaveri-textiles.example', svc: 'https', user: arjun } }),
    nav('pm', 'monitor/tools/packet-monitor', ['Tools & Monitors', 'Packet Monitor']),
    form('flt', 'Set the filter: destination 192.0.2.20, port 443', 'pm', { dst: '192.0.2.20', dstPort: '443' }, 'monitor/tools/packet-monitor', '#pm-dst', { labels: { dst: 'Destination', dstPort: 'Port' }, saved: (s) => s.pm.capturing && s.pm.filter.dst === '192.0.2.20' }),
    save('start', 'Click Start Capture', 'monitor/tools/packet-monitor', '[data-guide="pm-start"]', (s) => s.pm.capturing && s.pm.filter.dst === '192.0.2.20'),
    { ...test('t2', 'Send the same test again while capturing', (d) => d.from === 'fin' && String(d.to).includes('erp'), ['invalid-route'], { prefill: { from: 'fin', to: 'erp.kaveri-textiles.example', svc: 'https', user: arjun } }), done: (c) => pmHas(c.s, 'dropped') },
    info('read', 'Click the DROPPED packet and read its drop code: the next hop of route ERP-Legacy-Path does not answer', { route: 'monitor/tools/packet-monitor', target: '[data-guide="pkt:dropped"]' }),
    nav('rt', 'policy/rules/routing', ['Rules and Policies', 'Routing Rules']),
    save('fix', 'Disable ERP-Legacy-Path (or correct its gateway to the ISP router 203.0.113.9)', 'policy/rules/routing', '[data-guide="route:ERP-Legacy-Path"] .tw-toggle', (s) => !badRoute(s)),
    nav('pm2', 'monitor/tools/packet-monitor', ['Tools & Monitors', 'Packet Monitor']),
    { ...test('t3', 'Test again — the capture now shows FORWARDED', (d) => d.from === 'fin' && String(d.to).includes('erp'), ['allowed'], { prefill: { from: 'fin', to: 'erp.kaveri-textiles.example', svc: 'https', user: arjun } }), done: (c) => pmHas(c.s, 'forwarded') },
    event('exp', 'Export the capture as evidence', 'pm-export', (d) => Number(d.dropped) > 0 && Number(d.forwarded) > 0, { route: 'monitor/tools/packet-monitor', target: '[data-guide="pm-export"]',
      hint: (c) => (!pmHas(c.s, 'dropped') || !pmHas(c.s, 'forwarded') ? 'The buffer must contain both the dropped and the forwarded packet.' : null) }),
    noteStep('rca', 'rca-42', 'Write the root cause in the task notes below', 40),
  ],
  checks: [
    { id: 'flow', label: 'Finance reaches the ERP again', test: (s) => { const r = erpFlow(s); return ok(r.ok, 'ERP reachable', `${r.verdict}: ${r.reason}`); } },
    { id: 'route', label: 'No route points at an unreachable next hop', test: (s) => ok(!badRoute(s), 'routes OK', 'A route still uses a gateway that does not answer.') },
    { id: 'ev', label: 'Capture evidence exported (drop and fix)', test: (s) => ok(stepDone(s, '4.2', 'exp'), 'exported', 'Capture not exported yet.') },
    { id: 'rca', label: 'Root cause written', test: (s) => ok(note(s, 'rca-42').length >= 40, 'RCA recorded', 'RCA missing or too short.') },
  ],
  verify: 'The engine replays the ERP flow; evidence and RCA are taken from your recorded actions and notes.',
  mistakes: ['Adding an allow rule — the packet was never denied, it was routed into a dead next hop.', 'Deleting the route without recording why (no audit trail for the next admin).'],
  troubleshooting: ['Capture empty: start the capture before sending traffic, and match the filter (dst 192.0.2.20, port 443).', 'Still failing after the fix: send the test again — captures only show new packets.'],
};

/* ------------------------------------------------------------------ 4.3 */
export function seedVpnFaults(s: S): S {
  const b = s.config.branch;
  const target = b.ipsec.find((p) => p.enabled) ?? b.ipsec[0];
  if (!target) return s;
  const addresses = b.addresses.some((a) => a.name === 'N_HQ-LAN-old') ? b.addresses : [...b.addresses, { id: 'seed-hqold', name: 'N_HQ-LAN-old', zone: 'VPN', type: 'network' as const, ip: '192.168.100.0', ip2: '255.255.255.0', fqdn: '', comment: 'Old HQ plan' }];
  const ipsec = b.ipsec.map((p) => (p.id === target.id ? { ...p, enabled: true, secret: 'Branch-Old-Key-2024', p2: { ...p.p2, pfs: false }, remoteNet: 'N_HQ-LAN-old' } : p));
  const log: Omit<LogEntry, 'id'> = { ts: Date.now(), category: 'VPN', priority: 'Alert', message: `IKE: VPN tunnel to ${LAB.branchWan} went down after a configuration change at ${b.hostname}`, src: LAB.wanIp, dst: LAB.branchWan, proto: 'udp', action: 'info', rule: '', notes: 'Synthetic lab event' };
  return { ...s, config: { ...s.config, branch: { ...b, addresses, ipsec } }, logs: [{ ...log, id: uid() }, ...s.logs] };
}
const hqVpn = (s: S) => s.config.ipsec.find((p) => p.kind === 'site' && p.enabled);
const stage = (s: S) => { const p = hqVpn(s); return p ? tunnelStatus(s, p.id) : null; };
const brPolicy = (s: S) => s.config.branch.ipsec.find((p) => p.enabled);
const past = (s: S, st: string[]) => { const t = stage(s); return !!t && (t.state === 'up' || !st.includes(t.stage)); };
const p2MismatchGone = (s: S) => { const t = stage(s); return !!t && (t.state === 'up' || (t.stage === 'phase2' && !t.reason.startsWith('Phase 2 proposal'))); };
const t43: TaskDef = {
  id: '4.3', level: 4, title: 'IPsec troubleshooting', minutes: 30, difficulty: 'Expert',
  what: 'IKE negotiates in stages: reach the peer, agree Phase 1, authenticate, agree Phase 2 and traffic selectors. The log names the stage that failed.',
  whatWeDo: 'The Branch admin changed three things last night and the tunnel is down. Use the negotiation log to find and fix each fault in order, recording the cause of each.',
  why: 'VPN outages are the commonest escalation. Reading IKE messages beats re-typing everything and hoping.',
  prerequisites: ['4.2'],
  scenario: { label: 'Apply the Branch admin’s overnight change: the HQ↔Branch tunnel drops.', apply: seedVpnFaults },
  expected: [{ label: 'Fault 1', value: 'AUTHENTICATION_FAILED → pre-shared key' }, { label: 'Fault 2', value: 'NO_PROPOSAL_CHOSEN → Phase 2 / PFS' }, { label: 'Fault 3', value: 'TS_UNACCEPTABLE → networks' }],
  notes: [
    { key: 'rca-43-1', label: 'Fault 1 — log message, cause, fix', placeholder: 'AUTHENTICATION_FAILED …', rows: 2 },
    { key: 'rca-43-2', label: 'Fault 2 — log message, cause, fix', placeholder: 'NO_PROPOSAL_CHOSEN …', rows: 2 },
    { key: 'rca-43-3', label: 'Fault 3 — log message, cause, fix', placeholder: 'TS_UNACCEPTABLE …', rows: 2 },
  ],
  steps: [
    test('t1', 'Reproduce: BRANCH-PC → 192.168.10.5 (ping)', (d) => d.from === 'branch-pc', ['vpn-unavailable'], { prefill: { from: 'branch-pc', to: LAB.adminPc, svc: 'icmp' } }),
    nav('ip', 'network/ipsec/rules', ['IPSec VPN', 'Rules and Settings']),
    info('l1', 'Read the IKE log: authentication failed — the keys differ', { route: 'network/ipsec/rules', target: '[data-guide="vpn-transcript"]' }),
    noteStep('n1', 'rca-43-1', 'Record fault 1 in the notes', 15),
    nav('br', 'network/ipsec/branch', ['IPSec VPN', 'Branch Peer (lab)']),
    { id: 'f1', title: 'Edit the Branch policy and re-enter the same shared secret as HQ (both fields), then OK', route: 'network/ipsec/branch', target: (c) => `[data-guide="edit-brvpn:${brPolicy(c.s)?.name ?? ''}"]`, done: (c) => past(c.s, ['peer', 'phase1', 'auth']) },
    nav('ip2', 'network/ipsec/rules', ['IPSec VPN', 'Rules and Settings']),
    info('l2', 'Read the log again: authentication passes, Phase 2 now fails with NO_PROPOSAL_CHOSEN', { route: 'network/ipsec/rules', target: '[data-guide="vpn-transcript"]' }),
    noteStep('n2', 'rca-43-2', 'Record fault 2', 15),
    nav('br2', 'network/ipsec/branch', ['IPSec VPN', 'Branch Peer (lab)']),
    { id: 'f2', title: 'On the Branch policy’s Proposals tab, turn PFS on with DH Group 14, then OK', route: 'network/ipsec/branch', target: (c) => `[data-guide="edit-brvpn:${brPolicy(c.s)?.name ?? ''}"]`, done: (c) => p2MismatchGone(c.s) },
    nav('ip3', 'network/ipsec/rules', ['IPSec VPN', 'Rules and Settings']),
    info('l3', 'Read the log: TS_UNACCEPTABLE — the Branch expects the wrong HQ network', { route: 'network/ipsec/rules', target: '[data-guide="vpn-transcript"]' }),
    noteStep('n3', 'rca-43-3', 'Record fault 3', 15),
    nav('br3', 'network/ipsec/branch', ['IPSec VPN', 'Branch Peer (lab)']),
    { id: 'f3', title: 'On the Branch policy’s Network tab, set the destination back to N_HQ-LAN, then OK', route: 'network/ipsec/branch', target: (c) => `[data-guide="edit-brvpn:${brPolicy(c.s)?.name ?? ''}"]`, done: (c) => stage(c.s)?.state === 'up' },
    test('t2', 'Test BRANCH-PC → 192.168.10.5 again — allowed', (d) => d.from === 'branch-pc', ['allowed'], { prefill: { from: 'branch-pc', to: LAB.adminPc, svc: 'icmp' } }),
  ],
  checks: [
    { id: 'up', label: 'Tunnel is up', test: (s) => { const t = stage(s); return t ? ok(t.state === 'up', 'up', t.reason) : fail('No enabled HQ site-to-site policy.'); } },
    { id: 'psk', label: 'Keys match', test: (s) => ok(!!brPolicy(s) && brPolicy(s)!.secret === hqVpn(s)?.secret, 'keys match', 'Pre-shared keys differ.') },
    { id: 'pfs', label: 'PFS group 14 on both sides', test: (s) => ok(!!brPolicy(s)?.p2.pfs && brPolicy(s)!.p2.pfsGroup === 'Group 14', 'PFS OK', 'Branch PFS off or wrong group.') },
    { id: 'ts', label: 'Branch destination is the HQ LAN 192.168.10.0/24', test: (s) => { const p = brPolicy(s); return ok(!!p && branchNetworks(s.config.branch, p.remoteNet).join() === '192.168.10.0/24', 'selectors OK', `Branch destination: ${p ? branchNetworks(s.config.branch, p.remoteNet).join(', ') || p.remoteNet : 'n/a'}`); } },
    { id: 'flow', label: 'Branch reaches HQ', test: (s) => flowIs(s, { from: 'branch-pc', to: LAB.adminPc, proto: 'ICMP', port: 0 }, ['allowed']) },
    { id: 'rca', label: 'Each fault documented', test: (s) => ok(['rca-43-1', 'rca-43-2', 'rca-43-3'].every((k) => note(s, k).length >= 15), '3 notes', 'One or more fault notes missing.') },
  ],
  verify: 'IKE is renegotiated from both configurations; notes are part of the evidence.',
  mistakes: ['Changing HQ to match a wrong Branch setting — fix the side that changed.', 'Fixing all three blindly without reading which stage failed.'],
  troubleshooting: ['Reason still AUTHENTICATION_FAILED: retype the key on both fields; it is case-sensitive.', 'TS_UNACCEPTABLE: compare HQ local/remote with Branch remote/local — they must mirror exactly.'],
};

/* ------------------------------------------------------------------ 4.4 */
const ADM = 'device/settings/administration';
const wanMgmtOff = (s: S) => s.config.interfaces.filter((i) => i.zone === 'WAN').every((i) => !i.mgmt.https && !i.mgmt.http && !i.mgmt.ssh && !i.mgmt.snmp);
const AUDIT: { id: string; label: string; ok: (s: S) => boolean; why: string }[] = [
  { id: 'wan', label: 'No HTTPS/HTTP/SSH/SNMP management on any WAN interface', ok: wanMgmtOff, why: 'Admin interfaces exposed to the internet.' },
  { id: 'name', label: 'Default admin name “admin” renamed', ok: (s) => s.config.system.adminUser !== 'admin', why: 'Attackers guess “admin” first.' },
  { id: 'pw', label: 'Factory password not in use', ok: (s) => !s.config.system.defaultPassword, why: 'Default password still set.' },
  { id: 'otp', label: 'Administrator one-time password (TOTP) on', ok: (s) => s.config.system.otpMethod === 'totp', why: 'Admin login is single-factor.' },
  { id: 'lock', label: 'Login lockout after ≤5 failures', ok: (s) => s.config.system.lockout.enabled && s.config.system.lockout.attempts <= 5, why: 'Unlimited password guessing.' },
  { id: 'port', label: 'HTTPS management moved off 443', ok: (s) => s.config.system.httpsPort !== 443, why: 'Default port invites scans.' },
  { id: 'cert', label: 'Management certificate from the internal CA', ok: (s) => s.config.system.certificate !== 'Default self-signed certificate', why: 'Users are trained to click through warnings.' },
  { id: 'syslog', label: `Logs sent to syslog ${LAB.syslog}`, ok: (s) => s.config.system.syslog.enabled && s.config.system.syslog.server === LAB.syslog, why: 'Logs live only on the box.' },
  { id: 'export', label: 'Weekly configuration export scheduled', ok: (s) => s.config.system.backupSchedule === 'weekly', why: 'No off-box configuration copy.' },
  { id: 'fw', label: 'Firmware reviewed against advisories', ok: (s) => s.config.system.firmwareReviewed, why: 'Known vulnerabilities may be unpatched.' },
];
const t44: TaskDef = {
  id: '4.4', level: 4, title: 'Hardening and audit', minutes: 35, difficulty: 'Expert',
  what: 'Hardening closes the doors a working firewall still leaves open: who can log in, from where, how, and what evidence is kept.',
  whatWeDo: `Rename the admin, require TOTP and lockout, move HTTPS management to port ${LAB.mgmtPort} with an internal-CA certificate, ship logs to syslog, schedule exports, review firmware — until the audit sheet is all green.`,
  why: 'Auditors and attackers check the same list. Each item here is a finding in a real assessment.',
  prerequisites: ['4.3'],
  expected: [{ label: 'Admin name', value: LAB.adminName }, { label: 'Login', value: 'TOTP on; lockout after 5 failures for 30 minutes' }, { label: 'HTTPS port', value: String(LAB.mgmtPort) }, { label: 'Certificate', value: 'imported internal-CA certificate' }, { label: 'Syslog', value: `${LAB.syslog}:514` }, { label: 'Export', value: 'weekly' }],
  steps: [
    nav('adm', ADM, ['Settings', 'Administration']),
    form('name', `Rename the administrator to ${LAB.adminName} and set One-time Passwords Method to TOTP`, 'admin', { adminUser: LAB.adminName, otpMethod: 'totp' }, ADM, '#ad-user',
      { tab: 'admin', labels: { adminUser: 'Login name', otpMethod: 'OTP method' }, saved: (s) => s.config.system.adminUser === LAB.adminName && s.config.system.otpMethod === 'totp', beginner: 'After this, every admin login asks for the 6-digit code from the lab authenticator (Lab Tools › Lab Controls).' }),
    form('lock', 'On Login / Multiple Administrators: enable lockout, 5 attempts, 30 minutes', 'admin', { lockout: true, attempts: 5, minutes: 30 }, ADM, '#ad-lockout',
      { tab: 'login', labels: { lockout: 'Lockout', attempts: 'Attempts', minutes: 'Minutes' }, saved: (s) => s.config.system.lockout.enabled && s.config.system.lockout.attempts === 5 && s.config.system.lockout.minutes === 30 }),
    save('acc1', 'Click Accept', ADM, '[data-guide="accept"]', (s) => s.config.system.adminUser === LAB.adminName && s.config.system.otpMethod === 'totp' && s.config.system.lockout.enabled),
    nav('cert', 'device/settings/certificates', ['Settings', 'Certificates']),
    open('ci', 'Click Import and import the internal-CA certificate for the firewall', 'certimport', 'device/settings/certificates', '[data-guide="cert-import"]'),
    save('cis', 'Click Import', 'device/settings/certificates', '[data-guide="certimport-ok"]', (s) => s.config.certificates.some((c) => !c.builtIn && c.type === 'Local')),
    nav('adm2', ADM, ['Settings', 'Administration']),
    form('mgmt', `On Management: certificate = the imported one, HTTPS port ${LAB.mgmtPort}`, 'admin', { httpsPort: LAB.mgmtPort }, ADM, '#ad-port',
      { tab: 'mgmt', labels: { httpsPort: 'HTTPS port' }, saved: (s) => s.config.system.httpsPort === LAB.mgmtPort,
        hint: (c) => { const d = c.draft<{ certificate: string }>('admin'); return d && d.certificate === 'Default self-signed certificate' && c.s.config.certificates.some((x) => !x.builtIn) ? 'Also select the imported certificate.' : null; } }),
    save('acc2', 'Click Accept — your session ends because the port changed', ADM, '[data-guide="accept"]', (s) => s.config.system.httpsPort === LAB.mgmtPort && s.config.system.certificate !== 'Default self-signed certificate'),
    { id: 'browse', title: `Browse to the new address with the port`, expect: `https://${LAB.lanIp}:${LAB.mgmtPort}`, target: '[data-guide="url"]', done: (c) => { const u = parseUrl(c.s.session.browserUrl); return !!u && u.port === LAB.mgmtPort; } },
    { id: 'login', title: `Sign in as ${LAB.adminName} with your password and the one-time code`, route: 'browser:login', target: '[data-guide="login-otp"]', done: (c) => c.s.session.loggedIn && c.s.session.connectedPort === LAB.mgmtPort,
      beginner: 'No certificate warning this time: the PCs trust the internal CA that issued the new certificate.' },
    nav('sl', 'device/log/syslog', ['Log', 'Syslog']),
    form('slf', `Enable syslog to ${LAB.syslog} port 514`, 'syslog', { enabled: true, server: LAB.syslog, port: 514 }, 'device/log/syslog', '#sl-enable', { labels: { enabled: 'Enable', server: 'Server', port: 'Port' }, saved: (s) => s.config.system.syslog.enabled && s.config.system.syslog.server === LAB.syslog }),
    save('sls', 'Click Accept', 'device/log/syslog', '[data-guide="accept"]', (s) => s.config.system.syslog.enabled && s.config.system.syslog.server === LAB.syslog),
    event('slt', 'Click “Send test message”', 'syslog-test', (d) => d.ok === true, { route: 'device/log/syslog', target: '[data-guide="syslog-test"]' }),
    nav('fw', 'device/settings/firmware', ['Settings', 'Firmware and Settings']),
    save('fwc', 'On the Settings tab, click “Check for updates”', 'device/settings/firmware', '[data-guide="fw-check"]', (s) => s.config.system.firmwareReviewed, undefined, { tab: 'settings' }),
    save('fws', 'Set Scheduled configuration export to Weekly', 'device/settings/firmware', '[data-guide="fw-sched"]', (s) => s.config.system.backupSchedule === 'weekly', undefined, { tab: 'settings' }),
    nav('aud', 'monitor/logs/auditing-logs', ['Logs', 'Auditing Logs']),
    info('review', 'Review today’s changes in the audit log, then check the audit sheet in Verification below', { route: 'monitor/logs/auditing-logs', target: '.tw-table' }),
  ],
  checks: AUDIT.map((a) => ({ id: a.id, label: a.label, test: (s: S) => ok(a.ok(s), 'pass', `Finding: ${a.why}`) })),
  verify: 'The audit sheet is evaluated from the live configuration — every line must pass.',
  mistakes: ['Changing the port and forgetting it: note it in the admin runbook.', 'Enabling TOTP without access to the authenticator — test in a second session first.'],
  troubleshooting: ['Locked out after the port change: browse to https://192.168.10.1:4443.', 'Code rejected: TOTP codes change every 30 seconds — use the current one.'],
};

/* ------------------------------------------------------------------ 4.5 */
const BEACON = 'staff-laptop';
const beaconIp = (s: S) => { const h = hostById(BEACON)!; return hostNet(s, h)?.ip ?? '10.10.10.100'; };
export function seedBeacon(s: S): S {
  const ip = beaconIp(s);
  const now = Date.now();
  const logs: LogEntry[] = [];
  for (let i = 0; i < 12; i++) {
    logs.push({ id: uid(), ts: now - (12 - i) * 300_000, category: 'Firewall Rule', priority: 'Info', message: `Connection opened: HTTPS STAFF-LAPTOP → ${LAB.c2Name}`, src: `${ip}, X0:V10`, dst: `${LAB.c2}, 443, X1`, proto: 'tcp', action: 'allow', rule: 'Staff-HTTPS-Legacy', notes: 'NAT: Default NAT Policy (X1) · synthetic lab event', host: BEACON });
  }
  logs.push({ id: uid(), ts: now - 60_000, category: 'Security Services', priority: 'Notice', message: `Content filter: ${LAB.c2Name} is Uncategorized (first seen 1 hour ago)`, src: ip, dst: LAB.c2, proto: 'tcp', action: 'info', rule: 'CFS-LAN', notes: 'synthetic lab event', host: BEACON });
  return { ...s, logs: [...logs.reverse(), ...s.logs] };
}
const pair = (s: S) => s.config.accessRules.filter((r) => r.fromZone === 'LAN' && r.toZone === 'WAN');
const c2Rule = (s: S): AccessRule | undefined => pair(s).find((r) => r.enabled && r.action !== 'allow' && r.logging && (findAddress(s.config, r.dst)?.ip === LAB.c2 || findAddress(s.config, r.dst)?.fqdn === LAB.c2Name) && r.src === 'Any' && r.service === 'Any');
const c2Above = (s: S) => { const r = c2Rule(s); if (!r) return false; const l = pair(s); const i = l.indexOf(r); const a = l.findIndex((x) => x.enabled && x.action === 'allow'); return a < 0 || i < a; };
const quarantined = (s: S) => evaluate(s, { from: BEACON, to: 'www.search.example', proto: 'TCP', port: 443 }).result.verdict === 'spoof-blocked';
const IR = [
  { key: 'ir-host', label: 'Affected host (name and IP) and how you identified it', min: 15 },
  { key: 'ir-timeline', label: 'Timeline (first seen, interval, when contained)', min: 20 },
  { key: 'ir-containment', label: 'Containment actions taken', min: 20 },
  { key: 'ir-root', label: 'Likely root cause / how it got out', min: 20 },
  { key: 'ir-next', label: 'Next steps (forensics, re-image, monitoring)', min: 20 },
];
const t45: TaskDef = {
  id: '4.5', level: 4, title: 'Capstone: contain a compromised host', minutes: 45, difficulty: 'Expert',
  what: 'Incident response on the firewall: identify the beaconing host from logs, block the command-and-control destination, quarantine the host, preserve evidence and report.',
  whatWeDo: `A SOC alert says a workstation contacts an unknown domain every five minutes. Find it, block ${LAB.c2Name} (${LAB.c2}) for everyone, isolate the host, capture proof and write the incident report.`,
  why: 'A beacon is a compromised machine asking for instructions. Minutes matter: contain first, investigate second, and keep the evidence intact.',
  prerequisites: ['4.4'],
  scenario: { label: 'Inject the SOC alert: synthetic beacon logs from one workstation to a documentation-range address. No real C2 is ever contacted.', apply: seedBeacon },
  expected: [{ label: 'C2 object', value: `H_C2-Server = ${LAB.c2} (zone WAN)` }, { label: 'Block rule', value: 'LAN→WAN, Any → H_C2-Server, Any, Deny, logging, above every allow' }, { label: 'Quarantine', value: 'blacklist the host’s MAC with anti-spoof on its interface' }, { label: 'Evidence', value: 'packet capture + exported logs + report' }],
  notes: IR.map((x) => ({ key: x.key, label: x.label, placeholder: '', rows: 2 })),
  steps: [
    nav('logs', 'monitor/logs/system-logs', ['Logs', 'System Logs']),
    info('find', `Search the logs for ${LAB.c2Name}: one source connects every 5 minutes via an old rule`, { route: 'monitor/logs/system-logs', target: '[data-guide="logs-search"]' }),
    noteStep('host', 'ir-host', 'Write the affected host (name and IP) in the report notes', 15, {
      hint: (c) => { const v = (c.s.progress.notes['ir-host'] ?? '').toLowerCase(); return v.length >= 15 && !v.includes(beaconIp(c.s)) && !v.includes('staff-laptop') ? 'That is not the host in the logs. Check the Source column.' : null; },
    }),
    nav('ad', 'object/match/addresses', ['Match Objects', 'Addresses']),
    open('ao', 'Click Add for H_C2-Server', 'addr', 'object/match/addresses', '[data-guide="add-address"]', { tab: 'objects' }),
    form('af', `H_C2-Server: zone WAN, host ${LAB.c2}`, 'addr', { name: 'H_C2-Server', zone: 'WAN', type: 'host', ip: LAB.c2 }, 'object/match/addresses', '#ad-name', { labels: { name: 'Name', zone: 'Zone', type: 'Type', ip: 'IP' }, saved: (s) => s.config.addresses.some((a) => a.name === 'H_C2-Server' && a.ip === LAB.c2) }),
    save('as', 'Click Save', 'object/match/addresses', '[data-guide="addr-save"]', (s) => s.config.addresses.some((a) => a.name === 'H_C2-Server' && a.ip === LAB.c2)),
    nav('ar', 'policy/rules/access', ['Rules and Policies', 'Access Rules']),
    open('ro', 'Click Add', 'rule', 'policy/rules/access', '[data-guide="add-rule"]'),
    form('rf', 'Block-C2-Outbound: Deny, LAN→WAN, Any → H_C2-Server, Any, logging, Position top', 'rule', { action: 'deny', name: 'Block-C2-Outbound', fromZone: 'LAN', toZone: 'WAN', src: 'Any', dst: 'H_C2-Server', service: 'Any', logging: true }, 'policy/rules/access', '#ar-name',
      { labels: { action: 'Action', name: 'Name', fromZone: 'From', toZone: 'To', src: 'Source', dst: 'Destination', service: 'Service', logging: 'Logging' }, saved: c2Above }),
    save('rs', 'Click Add', 'policy/rules/access', orConfirm('[data-guide="rule-save"]'), c2Above, (s) => (c2Rule(s) && !c2Above(s) ? 'The block is below an allow rule — move it up.' : null)),
    nav('bot', 'policy/security/botnet', ['Security Services', 'Botnet Filter']),
    save('bf', 'Enable the Botnet Filter as a second layer', 'policy/security/botnet', '#botnet-enable', (s) => s.config.security.botnet.enabled),
    nav('as2', 'network/system/mac-ip-anti-spoof', ['System', 'MAC IP Anti-Spoof']),
    open('qo', 'On Settings, configure the host’s interface X0:V10', 'spoofif', 'network/system/mac-ip-anti-spoof', '[data-guide="spoof-edit:X0:V10"]', { tab: 'settings', match: (d) => d.iface === 'X0:V10' }),
    form('qf', 'Enable anti-spoof and Spoof Detection on X0:V10', 'spoofif', { enabled: true, spoofDetection: true }, 'network/system/mac-ip-anti-spoof', '#as-enabled', { labels: { enabled: 'Enable', spoofDetection: 'Spoof Detection' }, saved: (s) => !!s.config.antiSpoof.ifaces['X0:V10']?.enabled }),
    save('qs', 'Click OK', 'network/system/mac-ip-anti-spoof', '[data-guide="spoofif-save"]', (s) => !!s.config.antiSpoof.ifaces['X0:V10']?.enabled),
    open('bo', 'On Anti-Spoof Cache, click Add', 'spoofentry', 'network/system/mac-ip-anti-spoof', '[data-guide="spoof-add"]', { tab: 'cache', match: () => true }),
    form('bf2', 'Interface X0:V10, the host’s IP and MAC (Lab Hosts), Blacklisted on', 'spoofentry', { iface: 'X0:V10', mac: hostById(BEACON)!.mac!, blacklisted: true }, 'network/system/mac-ip-anti-spoof', '#se-if', { labels: { iface: 'Interface', mac: 'MAC', blacklisted: 'Blacklisted' }, saved: quarantined }),
    save('bs', 'Click OK', 'network/system/mac-ip-anti-spoof', '[data-guide="spoofentry-save"]', quarantined),
    nav('pm', 'monitor/tools/packet-monitor', ['Tools & Monitors', 'Packet Monitor']),
    save('pms', `Filter source = the host’s IP and Start Capture`, 'monitor/tools/packet-monitor', '#pm-src', (s) => s.pm.capturing && s.pm.filter.src === beaconIp(s)),
    test('t1', 'Test STAFF-LAPTOP → cdn-update-check.example HTTPS — dropped (quarantined)', (d) => d.from === BEACON, ['spoof-blocked'], { prefill: { from: BEACON, to: LAB.c2Name, svc: 'https' } }),
    test('t2', `Test FIN-PC → cdn-update-check.example as ${arjun} — blocked for everyone`, (d) => d.from === 'fin' && (String(d.to).includes('cdn-update') || d.to === LAB.c2), ['denied', 'security-blocked'], { prefill: { from: 'fin', to: LAB.c2Name, svc: 'https', user: arjun } }),
    event('exp', 'Export the capture', 'pm-export', (d) => Number(d.dropped) > 0, { route: 'monitor/tools/packet-monitor', target: '[data-guide="pm-export"]' }),
    nav('logs2', 'monitor/logs/system-logs', ['Logs', 'System Logs']),
    event('lexp', `Search ${LAB.c2Name} and export the matching logs`, 'export-logs', (d) => Number(d.rows) > 0, { route: 'monitor/logs/system-logs', target: '[data-guide="logs-export"]' }),
    ...IR.slice(1).map((x, n) => noteStep(`ir${n}`, x.key, `Report: ${x.label}`, x.min)),
    {
      id: 'rep', title: 'Open your training record (award icon at the top of this panel)',
      why: 'The record is generated from your actual results: every check is re-run now, and failed attempts are shown as they happened.',
      target: '[data-guide="open-record"]',
      done: (c) => c.ui.route === 'record',
    },
  ],
  checks: [
    { id: 'rule', label: 'C2 blocked for the whole LAN, logged, above every allow', test: (s) => ok(c2Above(s), 'Block-C2-Outbound in place', c2Rule(s) ? 'The block rule is below an allow rule.' : 'No logged deny rule for the C2 address in LAN→WAN.') },
    { id: 'others', label: 'Other hosts cannot reach the C2', test: (s) => flowIs(s, { from: 'fin', to: LAB.c2, proto: 'TCP', port: 443, user: arjun }, ['denied', 'security-blocked']) },
    { id: 'botnet', label: 'Botnet filter enabled', test: (s) => ok(s.config.security.botnet.enabled, 'on', 'Botnet filter off.') },
    { id: 'quar', label: 'Compromised host quarantined', test: (s) => ok(quarantined(s), 'STAFF-LAPTOP dropped by anti-spoof', 'The host can still send traffic.') },
    { id: 'ev', label: 'Evidence exported (capture and logs)', test: (s) => ok(stepDone(s, '4.5', 'exp') && stepDone(s, '4.5', 'lexp'), 'exported', 'Capture or logs not exported.') },
    { id: 'rep', label: 'Incident report complete and names the right host', test: (s) => { const h = note(s, 'ir-host').toLowerCase(); const all = IR.every((x) => note(s, x.key).length >= x.min); return ok(all && (h.includes(beaconIp(s)) || h.includes('staff-laptop')), 'report complete', !all ? 'Some report fields are missing or too short.' : 'The affected host is not identified correctly.'); } },
  ],
  verify: 'Containment is proven by the engine (C2 blocked, host isolated); evidence comes from your exports; the report from your notes.',
  mistakes: ['Blocking only the infected host — the C2 must be blocked for everyone.', 'Putting the block below the legacy allow rule.', 'Wiping the laptop before capturing evidence.'],
  troubleshooting: ['Block not working: check rule order in LAN→WAN.', 'Quarantine not working: anti-spoof must be enabled on X0:V10, the laptop’s interface, not X0.'],
};

export const LEVEL4: TaskDef[] = [t41, t42, t43, t44, t45];
