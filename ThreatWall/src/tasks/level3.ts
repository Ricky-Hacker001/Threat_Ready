import type { IpsecPolicy, RootState } from '../state/types';
import type { CheckResult, StepDef, TaskDef } from './types';
import { event, fail, flowIs, form, info, nav, open, orConfirm, pass, save, test } from './dsl';
import { LAB } from '../state/baseline';
import { evaluate } from '../engine/traffic';
import { tunnelStatus } from '../engine/vpn';
import { userFor } from './level1';

type S = RootState;
const ok = (b: boolean, good: string, bad: string): CheckResult => (b ? pass(good) : fail(bad));
const U = (s: S) => userFor(s, 'LAN-Web-Out');
const withLab = (s: S, p: Partial<S['lab']>): S => ({ ...s, lab: { ...s.lab, ...p } });
const gotIt = (id: string, title: string, route: string, target: string, extra: Partial<StepDef> = {}) => info(id, title, { route, target, ...extra });

/* ------------------------------------------------------------------ 3.1 */
const IPS = 'policy/security/ips';
const GAV = 'policy/security/gateway-av';
const ipsOk = (s: S) => { const i = s.config.security.ips; return i.enabled && i.high.prevent && i.high.detect && i.medium.prevent && i.medium.detect && i.low.detect && !i.low.prevent; };
const gavOk = (s: S) => s.config.security.gav.enabled && !!s.config.security.gav.protocols.HTTP?.inbound;
const exclOk = (s: S) => s.config.security.ips.exclusions.includes(5946) && !s.config.security.ips.exclusions.includes(2103);
const ipsGet = (d: Record<string, unknown>, k: string) => { if (k === 'enabled') return d.enabled; const [lv, f] = k.split('.'); return (d[lv] as Record<string, boolean>)[f]; };
const t31: TaskDef = {
  id: '3.1', level: 3, title: 'IPS and gateway anti-virus', minutes: 25, difficulty: 'Advanced',
  what: 'IPS matches traffic against attack signatures; Gateway Anti-Virus scans files in transit. Both act per priority and per zone.',
  whatWeDo: 'Prevent and detect high and medium attacks, detect low, scan HTTP downloads, then handle a false positive with a single, justified signature exclusion.',
  why: 'Unpatched systems are attacked within hours of a vulnerability going public. IPS buys time; AV catches known malware at the edge.',
  prerequisites: ['Level 2 complete'],
  expected: [{ label: 'IPS', value: 'High: Prevent + Detect · Medium: Prevent + Detect · Low: Detect' }, { label: 'Gateway AV', value: 'Enabled, HTTP inbound inspection on' }, { label: 'Exclusion', value: 'only the signature that broke the ERP sync (from the log)' }],
  steps: [
    nav('nav', IPS, ['Security Services', 'Intrusion Prevention']),
    form('f', 'Enable IPS; Prevent + Detect High and Medium; Detect Low', 'ips', { enabled: true, 'high.prevent': true, 'high.detect': true, 'medium.prevent': true, 'medium.detect': true, 'low.prevent': false, 'low.detect': true }, IPS, '#ips-enable',
      { get: ipsGet, labels: { enabled: 'Enable IPS' }, saved: ipsOk, beginner: 'Low-priority signatures produce many false alarms; detect them for visibility but do not block.' }),
    save('s', 'Click Accept', IPS, '[data-guide="accept"]', ipsOk),
    nav('gnav', GAV, ['Security Services', 'Gateway Anti-Virus']),
    form('gf', 'Enable Gateway Anti-Virus (keep HTTP inbound on)', 'gav', { enabled: true }, GAV, '#gav-enable', { labels: { enabled: 'Enable' }, saved: gavOk }),
    save('gs', 'Click Accept', GAV, '[data-guide="accept"]', gavOk),
    test('t1', 'Test HR-PC → www.search.example HTTP with Payload “Simulated exploit” — blocked by IPS', (d) => d.from === 'hr' && d.payload === 'exploit' && d.security === 'ips', ['security-blocked'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'http', payload: 'exploit' } }),
    test('t2', 'Test an EICAR download over HTTP — blocked by Gateway AV', (d) => d.from === 'hr' && d.payload === 'eicar' && d.security === 'gav', ['security-blocked'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'http', payload: 'eicar' },
      beginner: 'EICAR is a harmless test string every AV engine detects — the lab never uses real malware.' }),
    test('t3', 'Finance reports the ERP sync is broken: test HR-PC → erp.kaveri-textiles.example HTTP with Payload “ERP sync pattern”', (d) => d.from === 'hr' && d.payload === 'fp', ['security-blocked'], { prefill: { from: 'hr', to: 'erp.kaveri-textiles.example', svc: 'http', payload: 'fp' } }),
    nav('logs', 'monitor/logs/system-logs', ['Logs', 'System Logs']),
    gotIt('sid', 'Find the IPS entry for the ERP traffic and note its SID (signature ID)', 'monitor/logs/system-logs', '[data-guide="logs-search"]', { why: 'Never exclude by guesswork — the log tells you exactly which signature fired.' }),
    nav('back', IPS, ['Security Services', 'Intrusion Prevention']),
    form('ex', 'Add that SID under Signature exclusions', 'ips', { excl: true }, IPS, '#ips-sid', { get: (d) => ((d.exclusions as number[]) ?? []).includes(5946), labels: { excl: 'SID excluded' }, saved: exclOk,
      hint: (c) => { const d = c.draft<{ exclusions: number[] }>('ips'); return d?.exclusions.includes(2103) ? 'You excluded 2103 — that is the real exploit signature. Remove it.' : null; } }),
    save('exs', 'Click Accept', IPS, '[data-guide="accept"]', exclOk),
    test('t4', 'Test the ERP sync again — allowed', (d) => d.from === 'hr' && d.payload === 'fp', ['allowed'], { prefill: { from: 'hr', to: 'erp.kaveri-textiles.example', svc: 'http', payload: 'fp' } }),
  ],
  checks: [
    { id: 'ips', label: 'IPS levels as planned', test: (s) => ok(ipsOk(s), 'IPS OK', 'IPS settings differ from the plan.') },
    { id: 'gav', label: 'Gateway AV on with HTTP inbound', test: (s) => ok(gavOk(s), 'GAV OK', 'Gateway AV is off or HTTP inbound is off.') },
    { id: 'exp', label: 'Exploit blocked', test: (s) => flowIs(s, { from: 'hr', to: 'www.search.example', proto: 'TCP', port: 80, payload: 'exploit', user: U(s) }, ['security-blocked']) },
    { id: 'eicar', label: 'EICAR over HTTP blocked', test: (s) => flowIs(s, { from: 'hr', to: 'www.search.example', proto: 'TCP', port: 80, payload: 'eicar', user: U(s) }, ['security-blocked']) },
    { id: 'fp', label: 'ERP sync works (one exclusion, the right one)', test: (s) => { const r = flowIs(s, { from: 'hr', to: 'erp.kaveri-textiles.example', proto: 'TCP', port: 80, payload: 'fp', user: U(s) }, ['allowed']); return r.ok && !exclOk(s) ? fail('Allowed, but the exclusion list is not exactly the ERP signature.') : r; } },
  ],
  verify: 'Settings are read from the configuration and the engine replays the exploit, EICAR and ERP flows.',
  mistakes: ['Disabling Medium prevention to “fix” the ERP app — that opens every medium attack.', 'Excluding the exploit signature 2103 instead of the false positive.'],
  troubleshooting: ['Nothing blocked: licensed? enabled globally? IPS/GAV ticked on LAN and WAN zones?', 'HTTPS tests are not blocked: without DPI-SSL the engines cannot see inside (task 3.2).'],
};

/* ------------------------------------------------------------------ 3.2 */
const DPI = 'policy/dpi-ssl/client';
const dpiOk = (s: S) => { const d = s.config.security.dpiSsl; return d.clientEnabled && Object.values(d.inspect).every(Boolean); };
const exOk = (s: S) => { const d = s.config.security.dpiSsl; return d.excludedCategories.includes('Financial Services') && d.excludedCategories.includes('Health') && d.excludedNames.some((n) => 'pinned-app.example'.endsWith(n)); };
const t32: TaskDef = {
  id: '3.2', level: 3, title: 'DPI-SSL (TLS inspection)', minutes: 25, difficulty: 'Advanced',
  what: 'Most traffic is HTTPS, so IPS and AV are blind to it. DPI-SSL decrypts LAN→internet HTTPS, inspects it, and re-encrypts it with the firewall’s CA.',
  whatWeDo: 'Prove HTTPS hides an EICAR download, deploy the firewall CA to the PCs, enable client inspection, and exclude banking, health and a certificate-pinned app.',
  why: 'Attackers deliver malware over HTTPS precisely because many firewalls cannot see it. Exclusions protect privacy and keep pinned apps working.',
  prerequisites: ['3.1'],
  expected: [{ label: 'Client DPI-SSL', value: 'Enabled; inspect IPS, GAV, Anti-Spyware, App Control, CFS' }, { label: 'Excluded categories', value: 'Financial Services, Health' }, { label: 'Excluded names', value: 'pinned-app.example' }, { label: 'Clients', value: 'ThreatWall DPI-SSL CA trusted' }],
  steps: [
    test('t0', 'Test HR-PC → www.search.example HTTPS with Payload EICAR — it gets through (AV is blind)', (d) => d.from === 'hr' && d.payload === 'eicar' && Number(d.port) === 443, ['allowed'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'https', payload: 'eicar' } }),
    nav('cert', 'device/settings/certificates', ['Settings', 'Certificates']),
    event('exp', 'Export the “ThreatWall DPI-SSL CA” certificate', 'cert-export', (d) => String(d.name).includes('DPI-SSL'), { route: 'device/settings/certificates', target: '[data-guide="cert-export:ThreatWall DPI-SSL CA"]' }),
    { id: 'push', title: 'In Lab Tools › Lab Controls, push the CA to the PCs (as group policy would)', lab: 'controls', target: '[data-guide="lab-ca-btn"]', done: (c) => c.s.lab.pcsTrustDpiCa,
      why: 'If you enable inspection first, every HTTPS site shows a certificate error to every user.' },
    nav('dpi', DPI, ['DPI-SSL', 'Client SSL']),
    form('f', 'Enable SSL Client Inspection and all five inspection types', 'dpi', { clientEnabled: true, ips: true, gav: true, spyware: true, appControl: true, cfs: true }, DPI, '#dpi-enable',
      { get: (d, k) => (k === 'clientEnabled' ? d.clientEnabled : (d.inspect as Record<string, boolean>)[k]), labels: { clientEnabled: 'Enable' }, saved: dpiOk }),
    form('x', 'On Objects, exclude Financial Services and Health, and the name pinned-app.example', 'dpi', { cats: ['Financial Services', 'Health'], names: ['pinned-app.example'] }, DPI, '[data-guide="tab:objects"]',
      { get: (d, k) => (k === 'cats' ? d.excludedCategories : d.excludedNames), labels: { cats: 'Excluded categories', names: 'Excluded names' }, saved: exOk }),
    save('s', 'Click Accept', DPI, '[data-guide="accept"]', (s) => dpiOk(s) && exOk(s)),
    test('t1', 'Repeat the HTTPS EICAR test — now blocked', (d) => d.from === 'hr' && d.payload === 'eicar' && Number(d.port) === 443, ['security-blocked'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'https', payload: 'eicar' } }),
    test('t2', 'Test HR-PC → bank.example HTTPS — allowed, original certificate (not inspected)', (d) => d.from === 'hr' && String(d.to).includes('bank') && String(d.cert).includes('original'), ['allowed'], { prefill: { from: 'hr', to: 'bank.example', svc: 'https' } }),
    test('t3', 'Test HR-PC → pinned-app.example HTTPS — works thanks to the exclusion', (d) => d.from === 'hr' && String(d.to).includes('pinned-app'), ['allowed'], { prefill: { from: 'hr', to: 'pinned-app.example', svc: 'https' } }),
  ],
  checks: [
    { id: 'dpi', label: 'Client DPI-SSL on with all inspections', test: (s) => ok(dpiOk(s), 'on', 'DPI-SSL off or an inspection type is off.') },
    { id: 'ex', label: 'Banking, health and the pinned app are excluded', test: (s) => ok(exOk(s), 'exclusions OK', 'An exclusion is missing.') },
    { id: 'ca', label: 'PCs trust the DPI-SSL CA', test: (s) => ok(s.lab.pcsTrustDpiCa, 'trusted', 'The CA is not deployed to the PCs.') },
    { id: 'eicar', label: 'EICAR over HTTPS is blocked', test: (s) => flowIs(s, { from: 'hr', to: 'www.search.example', proto: 'TCP', port: 443, payload: 'eicar', user: U(s) }, ['security-blocked']) },
    { id: 'bank', label: 'Banking traffic is not decrypted', test: (s) => { const r = evaluate(s, { from: 'hr', to: 'bank.example', proto: 'TCP', port: 443, user: U(s) }).result; return ok(r.ok && !!r.certIssuer?.includes('original'), r.certIssuer ?? '', `${r.verdict}; certificate ${r.certIssuer ?? 'n/a'}`); } },
    { id: 'pin', label: 'Pinned app works', test: (s) => flowIs(s, { from: 'hr', to: 'pinned-app.example', proto: 'TCP', port: 443, user: U(s) }, ['allowed']) },
  ],
  verify: 'Configuration and the lab’s client trust are read; the engine replays EICAR over HTTPS, a bank site and the pinned app.',
  mistakes: ['Enabling DPI-SSL before deploying the CA — instant certificate errors company-wide.', 'Inspecting banking/health sites — privacy and legal exposure.'],
  troubleshooting: ['Certificate errors: is the CA pushed to the PCs?', 'An app breaks only with DPI-SSL on: it pins its certificate — exclude its name.'],
};

/* ------------------------------------------------------------------ 3.3 */
const AD = 'object/match/addresses';
const poolOk = (s: S) => s.config.addresses.some((a) => a.name === 'SSLVPN_Pool' && a.zone === 'SSLVPN' && a.type === 'range' && a.ip === LAB.sslPoolStart && a.ip2 === LAB.sslPoolEnd);
const serverOk = (s: S) => !!s.config.sslvpn.zones.WAN && s.config.sslvpn.port === 4433;
const LAN_ROUTES = ['N_LAN-Staff', 'X0 Subnet', 'LAN Subnets'];
const clientOk = (s: S) => s.config.sslvpn.pool === 'SSLVPN_Pool' && s.config.sslvpn.clientRoutes.some((r) => LAN_ROUTES.includes(r)) && !s.config.sslvpn.tunnelAll && !s.config.sslvpn.clientRoutes.some((r) => ['Any', 'DMZ Subnets', 'X2 Subnet', 'H_WEB-01'].includes(r));
const vpnUser = (s: S) => s.config.users.local.some((u) => u.name === LAB.users[0] && u.groups.includes('SSLVPN Services') && u.otp);
const t33: TaskDef = {
  id: '3.3', level: 3, title: 'SSL VPN for remote users', minutes: 25, difficulty: 'Advanced',
  what: 'SSL VPN (NetExtender) gives a remote laptop an office address from a pool and routes only the networks you list through the tunnel.',
  whatWeDo: `Create the client pool, enable SSL VPN on WAN port 4433, route only the staff LAN, give ${LAB.users[0]} VPN access with a one-time code, connect, and prove the LAN works while the DMZ does not.`,
  why: 'Remote access is the front door attackers try first. Least-privilege routes plus MFA limit what a stolen password can reach.',
  prerequisites: ['3.2'],
  expected: [{ label: 'SSLVPN_Pool', value: `Range ${LAB.sslPoolStart}–${LAB.sslPoolEnd}, zone SSLVPN` }, { label: 'Server', value: 'WAN zone on, port 4433' }, { label: 'Client routes', value: 'N_LAN-Staff only (split tunnel)' }, { label: 'User', value: `${LAB.users[0]}: SSLVPN Services + one-time password` }],
  steps: [
    nav('ad', AD, ['Match Objects', 'Addresses']),
    open('po', 'Click Add for SSLVPN_Pool', 'addr', AD, '[data-guide="add-address"]', { tab: 'objects' }),
    form('pf', 'SSLVPN_Pool: zone SSLVPN, type Range', 'addr', { name: 'SSLVPN_Pool', zone: 'SSLVPN', type: 'range', ip: LAB.sslPoolStart, ip2: LAB.sslPoolEnd }, AD, '#ad-name', { labels: { name: 'Name', zone: 'Zone', type: 'Type', ip: 'Start', ip2: 'End' }, saved: poolOk }),
    save('ps', 'Click Save', AD, '[data-guide="addr-save"]', poolOk),
    nav('srv', 'network/sslvpn/server', ['SSL VPN', 'Server Settings']),
    form('sf', 'Turn SSL VPN on for WAN and keep port 4433', 'sslserver', { wan: true, port: 4433 }, 'network/sslvpn/server', '#ssl-zone-WAN', { get: (d, k) => (k === 'wan' ? (d.zones as Record<string, boolean>).WAN === true : d.port), labels: { wan: 'WAN', port: 'Port' }, saved: serverOk }),
    save('ss', 'Click Accept', 'network/sslvpn/server', '[data-guide="accept"]', serverOk),
    nav('cli', 'network/sslvpn/client', ['SSL VPN', 'Client Settings']),
    form('cf', 'Pool SSLVPN_Pool, client route N_LAN-Staff only, tunnel-all off', 'sslclient', { pool: 'SSLVPN_Pool', routes: ['N_LAN-Staff'], tunnelAll: false }, 'network/sslvpn/client', '#ssl-pool',
      { get: (d, k) => (k === 'routes' ? d.clientRoutes : d[k]), labels: { pool: 'Pool', routes: 'Client routes', tunnelAll: 'Tunnel all' }, saved: clientOk, beginner: 'Hold Ctrl (Cmd on Mac) to pick items in the routes list.' }),
    save('cs', 'Click Accept', 'network/sslvpn/client', '[data-guide="accept"]', clientOk, (s) => (s.config.sslvpn.clientRoutes.some((r) => ['Any', 'DMZ Subnets', 'X2 Subnet', 'H_WEB-01'].includes(r)) ? 'A route reaches the DMZ — remove it.' : null)),
    nav('us', 'device/users/local', ['Users', 'Local Users & Groups']),
    open('uo', `Click Configure on ${LAB.users[0]}`, 'user', 'device/users/local', `[data-guide="edit-user:${LAB.users[0]}"]`, { tab: 'users', match: (d) => d.name === LAB.users[0] }),
    form('uf', 'Tick SSLVPN Services and Require one-time password', 'user', { groups: ['SSLVPN Services', 'Staff'], otp: true }, 'device/users/local', '[data-guide="us-group:SSLVPN Services"]', { labels: { groups: 'Member of', otp: 'One-time password' }, saved: vpnUser }),
    save('us2', 'Click Save', 'device/users/local', '[data-guide="user-save"]', vpnUser),
    { id: 'nx', title: `In Lab Tools › Lab Controls › NetExtender, connect as ${LAB.users[0]} with the code from the lab authenticator`, lab: 'controls', target: '[data-guide="lab-nx-user"]', done: (c) => c.s.lab.remoteUserConnected,
      hint: (c) => { const e = [...c.events].reverse().find((x) => x.type === 'lab' && x.data.action === 'netextender' && x.data.ok === false); return e ? String(e.data.reason) : null; } },
    test('t1', 'Test REMOTE-LAPTOP → HR-PC (RDP) — allowed through the tunnel', (d) => d.from === 'remote-user' && (d.to === 'hr' || d.to === LAB.hrPc), ['allowed'], { prefill: { from: 'remote-user', to: 'hr', svc: 'rdp' } }),
    test('t2', 'Test REMOTE-LAPTOP → WEB-01 (HTTPS) — not reachable', (d) => d.from === 'remote-user' && (d.to === 'web01' || d.to === LAB.webServer), ['no-rule', 'denied', 'invalid-route'], { prefill: { from: 'remote-user', to: 'web01', svc: 'https' } }),
  ],
  checks: [
    { id: 'pool', label: 'SSLVPN_Pool range in zone SSLVPN', test: (s) => ok(poolOk(s), 'pool OK', 'SSLVPN_Pool missing or wrong.') },
    { id: 'srv', label: 'SSL VPN on WAN, port 4433', test: (s) => ok(serverOk(s), 'server OK', 'Not enabled on WAN or wrong port.') },
    { id: 'cli', label: 'Split tunnel to the staff LAN only', test: (s) => ok(clientOk(s), 'routes OK', 'Pool or routes differ, or the DMZ is routed.') },
    { id: 'user', label: `${LAB.users[0]} has SSL VPN access with OTP`, test: (s) => ok(vpnUser(s), 'user OK', 'Not in SSLVPN Services or OTP off.') },
    { id: 'lan', label: 'Remote user reaches the LAN', test: (s) => flowIs(withLab(s, { remoteUserConnected: true }), { from: 'remote-user', to: LAB.hrPc, proto: 'TCP', port: 3389 }, ['allowed']) },
    { id: 'dmz', label: 'Remote user cannot reach the DMZ', test: (s) => flowIs(withLab(s, { remoteUserConnected: true }), { from: 'remote-user', to: LAB.webServer, proto: 'TCP', port: 443 }, ['no-rule', 'denied', 'invalid-route']) },
  ],
  verify: 'Settings come from the configuration; the engine simulates a connected NetExtender client reaching the LAN and the DMZ.',
  mistakes: ['Tunnel-all or “Any” routes — the laptop gets the whole network.', 'Pool in the LAN zone — the SSL VPN zone rules then do not apply.', 'Forgetting SSLVPN Services: login works, VPN access is refused.'],
  troubleshooting: ['Portal unreachable: SSL VPN not enabled on WAN, or wrong port.', '“not a member of SSLVPN Services”: edit the user.', 'One-time code rejected: codes change every 30 seconds.'],
};

/* ------------------------------------------------------------------ 3.4 */
const IP = 'network/ipsec/rules';
const BR = 'network/ipsec/branch';
const PSK_HINT = 'a training-only secret of your choice (same on both sides)';
const hqPol = (s: S) => s.config.ipsec.find((p) => p.kind === 'site' && p.name === 'HQ-to-Branch');
const prop = (p?: IpsecPolicy) => !!p && p.exchange === 'ikev2' && p.p1.dh === 'Group 14' && p.p1.enc === 'AES-256' && p.p1.auth === 'SHA256' && p.p2.proto === 'ESP' && p.p2.enc === 'AES-256' && p.p2.auth === 'SHA256' && p.p2.pfs && p.p2.pfsGroup === 'Group 14';
const hqOk = (s: S) => { const p = hqPol(s); return !!p && p.enabled && p.gateway === LAB.branchWan && p.localNet === 'N_LAN-Staff' && p.remoteNet === 'N_Branch-LAN' && prop(p); };
const brPol = (s: S) => s.config.branch.ipsec.find((p) => p.enabled);
const brOk = (s: S) => { const p = brPol(s); return !!p && p.gateway === LAB.wanIp && prop(p) && s.config.branch.addresses.some((a) => a.name === p.remoteNet && a.ip === '192.168.10.0' && a.ip2 === '255.255.255.0'); };
const up = (s: S) => { const p = hqPol(s); return !!p && tunnelStatus(s, p.id).state === 'up'; };
const brNet = (s: S) => s.config.addresses.some((a) => a.name === 'N_Branch-LAN' && a.zone === 'VPN' && a.type === 'network' && a.ip === '192.168.20.0' && a.ip2 === '255.255.255.0');
const propWant = { exchange: 'ikev2', 'p1.dh': 'Group 14', 'p1.enc': 'AES-256', 'p1.auth': 'SHA256', 'p2.enc': 'AES-256', 'p2.auth': 'SHA256', 'p2.pfs': true, 'p2.pfsGroup': 'Group 14' };
const pget = (d: Record<string, unknown>, k: string) => { if (!k.includes('.')) return d[k]; const [a, b] = k.split('.'); return (d[a] as Record<string, unknown>)[b]; };
const plabels = { exchange: 'Exchange', 'p1.dh': 'P1 DH', 'p1.enc': 'P1 Enc', 'p1.auth': 'P1 Auth', 'p2.enc': 'P2 Enc', 'p2.auth': 'P2 Auth', 'p2.pfs': 'PFS', 'p2.pfsGroup': 'PFS group', name: 'Name', gateway: 'Gateway', secretSet: 'Secret set', secretMatch: 'Secrets match', localNet: 'Local network', remoteNet: 'Remote network' };
const t34: TaskDef = {
  id: '3.4', level: 3, title: 'Site-to-site IPsec VPN', minutes: 35, difficulty: 'Advanced',
  what: 'A site-to-site tunnel joins two office LANs over the internet. Both firewalls must mirror each other: peer address, key, proposals and networks.',
  whatWeDo: `Build HQ-to-Branch on HQ (${LAB.wanIp}) and the mirror policy on the Branch firewall (${LAB.branchWan}), bring the tunnel up, and reach HQ from BRANCH-PC.`,
  why: 'Branches need the ERP and file servers at HQ. A mis-matched setting anywhere keeps the tunnel down — the commonest VPN ticket there is.',
  prerequisites: ['3.3'],
  expected: [
    { label: 'HQ policy', value: `HQ-to-Branch → ${LAB.branchWan}, N_LAN-Staff ↔ N_Branch-LAN` }, { label: 'Branch policy', value: `peer ${LAB.wanIp}, X0 Subnet ↔ N_HQ-LAN (192.168.10.0/24)` },
    { label: 'Proposals', value: 'IKEv2 · P1 DH 14 / AES-256 / SHA256 · P2 ESP AES-256 / SHA256 · PFS group 14' }, { label: 'Pre-shared key', value: PSK_HINT },
  ],
  steps: [
    nav('ad', AD, ['Match Objects', 'Addresses']),
    open('bo', 'Click Add for N_Branch-LAN', 'addr', AD, '[data-guide="add-address"]', { tab: 'objects' }),
    form('bf', 'N_Branch-LAN: zone VPN, Network 192.168.20.0 / 255.255.255.0', 'addr', { name: 'N_Branch-LAN', zone: 'VPN', type: 'network', ip: '192.168.20.0', ip2: '255.255.255.0' }, AD, '#ad-name', { labels: plabels, saved: brNet }),
    save('bs', 'Click Save', AD, '[data-guide="addr-save"]', brNet),
    nav('ip', IP, ['IPSec VPN', 'Rules and Settings']),
    open('ho', 'Click Add', 'vpn', IP, '[data-guide="add-vpn"]'),
    form('hg', 'General: name, peer gateway and a training-only shared secret (twice)', 'vpn', { name: 'HQ-to-Branch', gateway: LAB.branchWan, secretSet: true, secretMatch: true }, IP, '#vp-name', { labels: plabels, saved: hqOk,
      beginner: 'Lab rule: invent a practice key (8+ characters). Never type a real VPN secret into a training tool.' }),
    form('hn', 'Network tab: local N_LAN-Staff, destination N_Branch-LAN', 'vpn', { localNet: 'N_LAN-Staff', remoteNet: 'N_Branch-LAN' }, IP, '[data-guide="tab:network"]', { labels: plabels, saved: hqOk }),
    form('hp', 'Proposals tab: IKEv2; P1 Group 14 / AES-256 / SHA256; P2 AES-256 / SHA256, PFS Group 14', 'vpn', propWant, IP, '[data-guide="tab:proposals"]', { get: pget, labels: plabels, saved: hqOk }),
    save('hs', 'Click OK', IP, '[data-guide="vpn-save"]', hqOk),
    gotIt('down', 'The tunnel shows Down: the Branch has no matching policy yet. Read the negotiation log under the table.', IP, '[data-guide="vpn-transcript"]'),
    nav('br', BR, ['IPSec VPN', 'Branch Peer (lab)']),
    open('bao', 'On the Branch, add address N_HQ-LAN', 'braddr', BR, '[data-guide="add-braddr"]'),
    form('baf', 'N_HQ-LAN: 192.168.10.0 / 255.255.255.0', 'braddr', { name: 'N_HQ-LAN', ip: '192.168.10.0', ip2: '255.255.255.0' }, BR, '#ba-name', { labels: { name: 'Name', ip: 'Network', ip2: 'Mask' }, saved: (s) => s.config.branch.addresses.some((a) => a.name === 'N_HQ-LAN' && a.ip === '192.168.10.0') }),
    save('bas', 'Click Save', BR, '[data-guide="braddr-save"]', (s) => s.config.branch.addresses.some((a) => a.name === 'N_HQ-LAN' && a.ip === '192.168.10.0')),
    open('bpo', 'On the Branch, add the mirror VPN policy', 'brvpn', BR, '[data-guide="add-brvpn"]'),
    form('bpg', `General: name Branch-to-HQ, peer ${LAB.wanIp}, the same shared secret`, 'brvpn', { name: 'Branch-to-HQ', gateway: LAB.wanIp, secretSet: true, secretMatch: true }, BR, '#vp-name', { labels: plabels, saved: brOk }),
    form('bpn', 'Network: local X0 Subnet, destination N_HQ-LAN', 'brvpn', { localNet: 'X0 Subnet', remoteNet: 'N_HQ-LAN' }, BR, '[data-guide="tab:network"]', { labels: plabels, saved: brOk }),
    form('bpp', 'Proposals: identical to HQ', 'brvpn', propWant, BR, '[data-guide="tab:proposals"]', { get: pget, labels: plabels, saved: brOk }),
    save('bps', 'Click OK', BR, '[data-guide="brvpn-save"]', up, (s) => { const p = hqPol(s); return p ? `Tunnel still down: ${tunnelStatus(s, p.id).reason}` : null; }),
    nav('back', IP, ['IPSec VPN', 'Rules and Settings']),
    gotIt('upinfo', 'HQ-to-Branch shows Up. Read the log: Phase 1 agreed, authenticated, Phase 2 established.', IP, '[data-guide="vpn-transcript"]'),
    test('t1', 'Test BRANCH-PC → 192.168.10.5 (ping) — allowed through the tunnel', (d) => d.from === 'branch-pc', ['allowed'], { prefill: { from: 'branch-pc', to: LAB.adminPc, svc: 'icmp' } }),
  ],
  checks: [
    { id: 'net', label: 'N_Branch-LAN is 192.168.20.0/24 in zone VPN', test: (s) => ok(brNet(s), 'object OK', 'N_Branch-LAN missing or wrong.') },
    { id: 'hq', label: 'HQ-to-Branch matches the plan', test: (s) => ok(hqOk(s), 'HQ policy OK', 'HQ policy missing or a value differs.') },
    { id: 'br', label: 'Branch policy mirrors HQ', test: (s) => ok(brOk(s), 'Branch policy OK', 'Branch policy missing or a value differs.') },
    { id: 'up', label: 'Tunnel is up', test: (s) => { const p = hqPol(s); return p ? ok(up(s), 'IKE and IPsec SAs established', tunnelStatus(s, p.id).reason) : fail('No HQ-to-Branch policy.'); } },
    { id: 'flow', label: 'BRANCH-PC reaches HQ', test: (s) => flowIs(s, { from: 'branch-pc', to: LAB.adminPc, proto: 'ICMP', port: 0 }, ['allowed']) },
  ],
  verify: 'Both policies are compared with the plan; the simulator negotiates IKE between them and sends traffic from the Branch.',
  mistakes: ['Different keys on each side (AUTHENTICATION_FAILED).', 'PFS on one side only (NO_PROPOSAL_CHOSEN).', 'Local/remote networks not mirrored (TS_UNACCEPTABLE).'],
  troubleshooting: ['Read the negotiation log: it names the exact stage that failed.', 'Peer does not answer: check the gateway addresses (HQ X1 203.0.113.10, Branch 198.51.100.20).'],
};

/* ------------------------------------------------------------------ 3.5 */
const IF = 'network/system/interfaces';
const x3Ok = (s: S) => { const i = s.config.interfaces.find((x) => x.name === 'X3'); return !!i && i.zone === 'WAN' && i.mode === 'static' && i.ip === LAB.wan2Ip && i.mask === LAB.wan2Mask && i.gateway === LAB.wan2Gw && !i.mgmt.https && !i.mgmt.ssh; };
const grpOk = (s: S) => s.config.sdwan.groups.some((g) => g.name === 'WAN-Group' && g.members[0] === 'X1' && g.members.includes('X3'));
const probeOk = (s: S) => s.config.sdwan.probes.some((p) => p.name === 'Probe-1.1.1.1' && p.target === '1.1.1.1' && p.ifaces.includes('X1') && p.ifaces.includes('X3') && p.enabled);
const profOk = (s: S) => s.config.sdwan.profiles.some((p) => p.name === 'Internet-Failover' && p.group === 'WAN-Group' && p.probe === 'Probe-1.1.1.1' && p.enabled);
const routeOk = (s: S) => s.config.routes.some((r) => r.enabled && r.type === 'sdwan' && r.pathProfile === 'Internet-Failover' && r.dst === 'Any');
const egress = (s: S) => evaluate(s, { from: 'hr', to: 'www.search.example', proto: 'TCP', port: 443, user: U(s) }).result;
const t35: TaskDef = {
  id: '3.5', level: 3, title: 'Dual WAN with SD-WAN failover', minutes: 30, difficulty: 'Advanced',
  what: 'SD-WAN probes each internet link and steers traffic to a healthy one. Link up is not enough: the ISP can fail behind a working cable.',
  whatWeDo: `Bring up ISP-2 on X3, probe 1.1.1.1 through both links, route internet traffic by an SD-WAN profile, then fail ISP-1 and watch traffic move to X3 and back.`,
  why: 'A single ISP is a single point of failure for every cloud app, VPN and phone call. Failover must be automatic and tested.',
  prerequisites: ['3.4'],
  expected: [
    { label: 'X3', value: `WAN, static ${LAB.wan2Ip} / ${LAB.wan2Mask}, gateway ${LAB.wan2Gw}, DNS 1.1.1.1/8.8.8.8` }, { label: 'SD-WAN group', value: 'WAN-Group: X1 then X3' },
    { label: 'Probe', value: 'Probe-1.1.1.1: ping 1.1.1.1 on X1 and X3, every 3 s' }, { label: 'Profile', value: 'Internet-Failover: WAN-Group, Probe-1.1.1.1, ≤50 ms, ≤5% loss, backup X3' }, { label: 'Route', value: 'SD-WAN route Any → Any using Internet-Failover' },
  ],
  steps: [
    nav('if', IF, ['System', 'Interfaces']),
    open('x3o', 'Click Configure on X3', 'iface', IF, '[data-guide="edit:X3"]', { match: (d) => d.name === 'X3' }),
    form('x3f', 'X3: zone WAN, static ISP-2 address, gateway and DNS (no HTTPS/SSH management)', 'iface', { zone: 'WAN', mode: 'static', ip: LAB.wan2Ip, mask: LAB.wan2Mask, gateway: LAB.wan2Gw, dns1: LAB.dns1 }, IF, '#if-zone',
      { get: (d, k) => (k === 'dns1' ? (d.dns as string[])[0] : d[k]), labels: { zone: 'Zone', mode: 'Mode', ip: 'IP', mask: 'Mask', gateway: 'Gateway', dns1: 'DNS 1' }, saved: x3Ok }),
    save('x3s', 'Click OK', IF, orConfirm('[data-guide="iface-ok"]'), x3Ok, (s) => (s.config.interfaces.find((x) => x.name === 'X3')?.mgmt.https ? 'X3 answers HTTPS management — untick it.' : null)),
    nav('g', 'network/sdwan/groups', ['SDWAN', 'SD-WAN Groups']),
    open('go', 'Click Add', 'sdgroup', 'network/sdwan/groups', '[data-guide="add-sdgroup"]'),
    form('gf', 'WAN-Group with X1 first, then X3', 'sdgroup', { name: 'WAN-Group', members: ['X1', 'X3'] }, 'network/sdwan/groups', '#sg2-name', { labels: { name: 'Name', members: 'Members' }, saved: grpOk }),
    save('gs', 'Click Save', 'network/sdwan/groups', '[data-guide="sdgroup-save"]', grpOk, (s) => (s.config.sdwan.groups.find((g) => g.name === 'WAN-Group')?.members[0] === 'X3' ? 'X3 is first — tick X1 first so it is the primary.' : null)),
    nav('p', 'network/sdwan/probes', ['SDWAN', 'SLA Probes']),
    open('po', 'Click Add', 'probe', 'network/sdwan/probes', '[data-guide="add-probe"]'),
    form('pf', 'Probe-1.1.1.1: target 1.1.1.1 from X1 and X3, every 3 s', 'probe', { name: 'Probe-1.1.1.1', target: '1.1.1.1', ifaces: ['X1', 'X3'], intervalSec: 3 }, 'network/sdwan/probes', '#pr-name', { labels: { name: 'Name', target: 'Target', ifaces: 'Interfaces', intervalSec: 'Interval' }, saved: probeOk }),
    save('ps', 'Click Save', 'network/sdwan/probes', '[data-guide="probe-save"]', probeOk),
    nav('pp', 'network/sdwan/paths', ['SDWAN', 'Path Selection Profiles']),
    open('ppo', 'Click Add', 'pathprof', 'network/sdwan/paths', '[data-guide="add-pathprof"]'),
    form('ppf', 'Internet-Failover: WAN-Group, Probe-1.1.1.1, 50 ms, 5%, backup X3', 'pathprof', { name: 'Internet-Failover', group: 'WAN-Group', probe: 'Probe-1.1.1.1', maxLatencyMs: 50, maxLossPct: 5, backup: 'X3' }, 'network/sdwan/paths', '#pp-name',
      { labels: { name: 'Name', group: 'Group', probe: 'Probe', maxLatencyMs: 'Latency', maxLossPct: 'Loss', backup: 'Backup' }, saved: profOk }),
    save('pps', 'Click Save', 'network/sdwan/paths', '[data-guide="pathprof-save"]', profOk),
    nav('rt', 'policy/rules/routing', ['Rules and Policies', 'Routing Rules']),
    open('ro', 'Click Add', 'route', 'policy/rules/routing', '[data-guide="add-route"]'),
    form('rf', 'SD-WAN route: name SD-WAN-Internet, Any → Any, type SD-WAN Route, profile Internet-Failover', 'route', { name: 'SD-WAN-Internet', src: 'Any', dst: 'Any', service: 'Any', type: 'sdwan', pathProfile: 'Internet-Failover' }, 'policy/rules/routing', '#rt-name',
      { labels: { name: 'Name', src: 'Source', dst: 'Destination', service: 'Service', type: 'Route Type', pathProfile: 'Profile' }, saved: routeOk }),
    save('rs', 'Click Add', 'policy/rules/routing', '[data-guide="route-save"]', routeOk),
    test('t1', 'Test HR-PC → www.search.example HTTPS — leaves via X1', (d) => d.from === 'hr' && d.egress === 'X1', ['allowed'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'https' } }),
    { id: 'fail', title: 'In Lab Tools › Lab Controls, fail ISP-1 on X1', lab: 'controls', target: '[data-guide="lab-isp-X1"]', done: (c) => c.s.lab.isp.X1 === 'down',
      beginner: 'The cable stays up — only the ISP behind it stops answering. Without a probe the firewall would keep sending traffic into a black hole.' },
    test('t2', 'Test again — traffic now leaves via X3', (d) => d.from === 'hr' && d.egress === 'X3', ['allowed'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'https' } }),
    { id: 'restore', title: 'Restore ISP-1', lab: 'controls', target: '[data-guide="lab-isp-X1"]', done: (c) => c.s.lab.isp.X1 === 'up' },
    test('t3', 'Test once more — traffic is back on X1', (d) => d.from === 'hr' && d.egress === 'X1', ['allowed'], { prefill: { from: 'hr', to: 'www.search.example', svc: 'https' } }),
  ],
  checks: [
    { id: 'x3', label: 'X3 is WAN 198.51.100.34/29 via .33, no admin access', test: (s) => ok(x3Ok(s), 'X3 OK', 'X3 not configured as planned.') },
    { id: 'sd', label: 'Group, probe, profile and SD-WAN route exist', test: (s) => ok(grpOk(s) && probeOk(s) && profOk(s) && routeOk(s), 'SD-WAN OK', `Missing: ${[!grpOk(s) && 'group', !probeOk(s) && 'probe', !profOk(s) && 'profile', !routeOk(s) && 'route'].filter(Boolean).join(', ')}`) },
    { id: 'normal', label: 'Normally traffic uses X1', test: (s) => { const r = egress(withLab(s, { isp: { ...s.lab.isp, X1: 'up', X3: 'up' } })); return ok(r.ok && r.egress === 'X1', 'X1', `${r.verdict} via ${r.egress || '—'}`); } },
    { id: 'failover', label: 'When ISP-1 fails, traffic uses X3', test: (s) => { const r = egress(withLab(s, { isp: { ...s.lab.isp, X1: 'down', X3: 'up' } })); return ok(r.ok && r.egress === 'X3', 'X3', `${r.verdict} via ${r.egress || '—'}: ${r.reason}`); } },
  ],
  verify: 'Configuration is compared with the plan; the engine evaluates browsing with ISP-1 healthy and failed.',
  mistakes: ['Relying on link state: the cable stays up when the ISP fails.', 'Probing the ISP gateway itself (.9) — it can answer while the internet behind it is down.', 'Allowing HTTPS management on the new WAN.'],
  troubleshooting: ['No failover: is the route type SD-WAN with the profile? does the probe include X1?', 'X3 never used: gateway must be 198.51.100.33.'],
};

export const LEVEL3: TaskDef[] = [t31, t32, t33, t34, t35];
