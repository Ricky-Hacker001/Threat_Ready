/**
 * End-to-end walkthrough of all 30 tasks through the GUI, exactly as a learner would do them.
 * Usage: npm run build && npm run preview (port 4173) in one terminal, then: node e2e/run-all.mjs
 */
import { start, level0 } from './lib.mjs';
const h = await start(process.env.TW_URL); const { p, W } = h;

const step = async (label) => console.log(label, '| cur:', await h.cur(), '| fail:', await h.fail());
const lt = async () => { await p.click('button:has-text("Load this test")'); await W(300); await p.click('[data-guide="lt-send"]'); await W(500); return p.evaluate(() => document.querySelector('.tw-verdict')?.textContent); };
const tog = async (sel, want) => { const on = await p.getAttribute(sel, 'aria-checked'); if ((on === 'true') !== want) await p.click(sel); };
const note = async (key, text) => { await p.fill(`[data-guide="note:${key}"]`, text); await W(300); };
const addRule = async (o) => {
  await p.click('[data-guide="add-rule"]'); await W();
  if (o.action) await p.click(`[data-guide="ar-action-${o.action}"]`);
  await p.fill('#ar-name', o.name); await h.sel('#ar-fz', o.from); await h.sel('#ar-tz', o.to);
  if (o.src) await h.sel('#ar-src', o.src); if (o.dst) await h.sel('#ar-dst', o.dst); if (o.svc) await h.sel('#ar-svc', o.svc); if (o.sch) await h.sel('#ar-sch', o.sch);
  await W(); await p.click('[data-guide="rule-save"]'); await W(); if (await p.$('[data-guide="confirm"]')) { await p.click('[data-guide="confirm"]'); await W(); }
};
const nextTask = async () => { const nb = await p.$('button:has-text("Next:")'); if (nb) await nb.click(); await W(400); };

let failed = false;
try {
await level0(h);
// ---------------- l1 ----------------

console.log('L0', await h.status());
// 1.1
await h.go('network/system/interfaces');
await p.click('[data-guide="edit:X1"]'); await W();
await h.sel('#if-mode', 'static'); await W();
await p.fill('#if-ip', '203.0.113.10'); await p.fill('#if-mask', '255.255.255.248'); await p.fill('#if-gw', '203.0.113.9'); await W();
await p.fill('#if-dns0', '1.1.1.1'); await p.fill('#if-dns1', '8.8.8.8'); await W();
for (const k of ['https','ssh']) { if (await p.isChecked(`#if-m-${k}`)) await p.click(`#if-m-${k}`); }
if (!(await p.isChecked('#if-m-ping'))) await p.click('#if-m-ping');
await W(); await step('x1 before ok');
await p.click('[data-guide="iface-ok"]'); await W();
if (await p.$('[data-guide="confirm"]')) await p.click('[data-guide="confirm"]'); await W();
await step('after x1');
await p.click('[data-guide="edit:X0"]'); await W();
await p.fill('#if-ip', '192.168.10.1'); await W();
await p.click('[data-guide="iface-ok"]'); await W(); await p.click('[data-guide="confirm"]'); await W(500);
await step('after x0');
await h.lab('pc'); await p.click('[data-guide="pc-mode-static"]'); await p.fill('#pc-ip', '192.168.10.5'); await p.fill('#pc-mask', '255.255.255.0'); await p.fill('#pc-gw', '192.168.10.1'); await p.fill('#pc-dns', '1.1.1.1'); await p.click('[data-guide="pc-apply"]'); await W();
await p.fill('[data-guide="url"]', 'https://192.168.10.1'); await p.press('[data-guide="url"]', 'Enter'); await W();
await p.click('[data-guide="cert-advanced"]'); await p.click('[data-guide="cert-proceed"]'); await W();
await p.fill('#tw-user', 'admin'); await p.fill('#tw-pass', 'Lab-Firewall#2026'); await p.click('[data-guide="login-submit"]'); await W(700);
console.log('1.1', await h.status());
// 1.2
await h.go('policy/rules/routing'); await h.gotIt();
await h.go('network/dns/settings'); await W(400);
await h.go('device/diagnostics/tools');
for (const [tool, t] of [['ping','203.0.113.9'],['ping','8.8.8.8'],['dns','www.search.example']]) { await h.sel('#dg-tool', tool); await p.fill('#dg-target', t); await p.click('[data-guide="diag-go"]'); await W(); }
await h.cmd('nslookup www.search.example'); await W(500);
console.log('1.2', await h.status());
// 1.3
await h.go('network/system/dhcp'); await h.gotIt();
await p.click('[data-guide="edit-scope:X0"]'); await W();
await p.fill('#sc-start', '192.168.10.100'); await p.fill('#sc-end', '192.168.10.199'); await p.fill('#sc-gw', '192.168.10.1'); await p.fill('#sc-dns0', '1.1.1.1'); await p.fill('#sc-dns1', '8.8.8.8'); await W();
await p.click('[data-guide="scope-save"]'); await W();
await p.click('[data-guide="add-static"]'); await W();
await p.fill('#st-name', 'PRINTER-01'); await p.fill('#st-ip', '192.168.10.50'); await p.fill('#st-mac', '00:1a:2b:3c:4d:50'); await W(); await p.click('[data-guide="static-save"]'); await W();
await p.click('[data-guide="tab:leases"]'); await W(); await h.gotIt();
console.log('1.3', await h.status());
// 1.4
console.log('fin test', await h.send({ from: 'fin', to: 'www.search.example' }));
await h.go('network/system/arp'); await h.gotIt();
await h.go('network/system/mac-ip-anti-spoof');
await p.click('[data-guide="tab:cache"]');
for (const [ip, mac, black] of [['192.168.10.5','00:1a:2b:3c:4d:05'],['192.168.10.21','00:1a:2b:3c:4d:21'],['192.168.10.22','00:1a:2b:3c:4d:22'],['192.168.10.22','de:ad:be:ef:00:99',true]]) {
  await p.click('[data-guide="spoof-add"]'); await W(); await p.fill('#se-ip', ip); await p.fill('#se-mac', mac); if (black) await p.click('#se-black'); await W(); await p.click('[data-guide="spoofentry-save"]'); await W();
}
await step('after cache');
await p.click('[data-guide="tab:settings"]'); await p.click('[data-guide="spoof-edit:X0"]'); await W();
for (const k of ['enabled','dhcpServer','arpLock','enforceIngress','spoofDetection']) { await p.click(`#as-${k}`); }
await W(); await p.click('[data-guide="spoofif-save"]'); await W();
console.log('rogue', await h.send({ from: 'rogue', to: 'www.search.example' }));
console.log('fin', await h.send({ from: 'fin', to: 'www.search.example' }));
await h.go('monitor/logs/system-logs'); await h.gotIt();
console.log('1.4', await h.status());
// 1.5
await h.go('object/match/addresses');
for (const o of [{n:'H_WEB-01',z:'DMZ',t:'host',ip:'172.16.10.100'},{n:'N_LAN-Staff',z:'LAN',t:'network',ip:'192.168.10.0',m:'255.255.255.0'},{n:'FQDN_update-site',z:'WAN',t:'fqdn',f:'updates.vendor.example'},{n:'H_FIN-PC',z:'LAN',t:'host',ip:'192.168.10.22'}]) {
  await p.click('[data-guide="add-address"]'); await W(); await p.fill('#ad-name', o.n); await h.sel('#ad-zone', o.z); await h.sel('#ad-type', o.t);
  if (o.ip) await p.fill('#ad-ip', o.ip); if (o.m) await p.fill('#ad-ip2', o.m); if (o.f) await p.fill('#ad-fqdn', o.f); await W(); await p.click('[data-guide="addr-save"]'); await W();
}
await p.click('[data-guide="tab:groups"]'); await p.click('[data-guide="add-group"]'); await W();
await p.fill('#ag-name', 'G_Finance-PCs'); await p.selectOption('#ag-avail', 'H_FIN-PC'); await p.click('[data-guide="ag-add"]'); await W(); await p.click('[data-guide="grp-save"]'); await W(500);
console.log('1.5', await h.status());
// 1.6
await h.go('object/match/services'); await p.click('[data-guide="tab:groups"]'); await p.click('[data-guide="add-svcgroup"]'); await W();
await p.fill('#sg-name', 'SG_Web-DNS'); await p.selectOption('#sg-avail', ['HTTP','HTTPS','DNS (Name Service)']); await p.click('[data-guide="sg-add"]'); await W(); await p.click('[data-guide="sg-save"]'); await W();
await h.go('policy/rules/access'); await p.click('[data-guide="add-rule"]'); await W();
await p.fill('#ar-name', 'LAN-Web-Out'); await h.sel('#ar-fz', 'LAN'); await h.sel('#ar-tz', 'WAN'); await h.sel('#ar-src', 'N_LAN-Staff'); await h.sel('#ar-svc', 'SG_Web-DNS'); await W();
await p.click('[data-guide="rule-save"]'); await W(); if (await p.$('[data-guide="confirm"]')) { await p.click('[data-guide="confirm"]'); await W(); }
await p.click('[data-guide="rule:Default LAN→WAN"] .tw-toggle'); await W();
await h.go('policy/rules/nat'); await h.gotIt();
console.log('web', await h.send({ from: 'hr', to: 'www.search.example', svc: 'https' }));
console.log('ssh', await h.send({ from: 'hr', to: 'www.search.example', svc: 'ssh' }));
await h.go('monitor/logs/system-logs'); await h.gotIt();
console.log('1.6', await h.status());

// ---------------- l2 ----------------
await nextTask();

// 2.1
await h.go('object/match/services'); await p.click('[data-guide="add-service"]'); await W();
await p.fill('#sv-name', 'TCP-8443'); await p.fill('#sv-start', '8443'); await W(); await p.click('[data-guide="svc-save"]'); await W();
await p.click('[data-guide="tab:groups"]'); await p.click('[data-guide="add-svcgroup"]'); await W();
await p.fill('#sg-name', 'SG_SaaS'); await p.selectOption('#sg-avail', ['TCP-8443','HTTPS']); await p.click('[data-guide="sg-add"]'); await W(); await p.click('[data-guide="sg-save"]'); await W();
await h.go('object/match/schedules'); await p.click('[data-guide="add-schedule"]'); await W();
await p.fill('#sc-name', 'Office-Hours'); for (const d of ['Mon','Tue','Wed','Thu','Fri','Sat']) await p.click(`[data-guide="sc-day-${d}"]`); await p.fill('#sc-start', '09:00'); await p.fill('#sc-end', '19:00'); await W(); await p.click('[data-guide="sch-save"]'); await W();
await h.go('policy/rules/access');
await addRule({ name: 'LAN-SaaS-Office-Hours', from: 'LAN', to: 'WAN', src: 'N_LAN-Staff', svc: 'SG_SaaS', sch: 'Office-Hours' });
await step('before tests');
console.log('10:00', await lt()); console.log('21:00', await lt());
console.log('2.1', (await h.status())['2.1']);
// 2.2
await h.go('network/system/interfaces'); await p.click('[data-guide="edit:X2"]'); await W();
await h.sel('#if-zone', 'DMZ'); await W(); await h.sel('#if-mode', 'static').catch(()=>{}); await p.fill('#if-ip', '172.16.10.1'); await p.fill('#if-mask', '255.255.255.0'); await W();
await p.click('[data-guide="iface-ok"]'); await W(); if (await p.$('[data-guide="confirm"]')) { await p.click('[data-guide="confirm"]'); await W(); }
await step('after x2');
await h.go('object/match/addresses');
for (const o of [{n:'webserver_public_ip',z:'WAN',ip:'203.0.113.11'},{n:'webserver_private_ip',z:'DMZ',ip:'172.16.10.100'}]) { await p.click('[data-guide="add-address"]'); await W(); await p.fill('#ad-name', o.n); await h.sel('#ad-zone', o.z); await p.fill('#ad-ip', o.ip); await W(); await p.click('[data-guide="addr-save"]'); await W(); }
await h.go('policy/rules/nat'); await p.click('[data-guide="add-nat"]'); await W();
await p.fill('#nat-name', 'Publish-WEB-01-HTTPS'); await h.sel('#nat-od', 'webserver_public_ip'); await h.sel('#nat-td', 'webserver_private_ip'); await h.sel('#nat-osv', 'HTTPS'); await h.sel('#nat-in', 'X1'); await W(); await p.click('[data-guide="nat-save"]'); await W();
await h.go('policy/rules/access');
await addRule({ name: 'WAN-to-WEB-01-HTTPS', from: 'WAN', to: 'DMZ', dst: 'webserver_public_ip', svc: 'HTTPS' });
await step('before web tests');
console.log('https', await lt()); console.log('http', await lt()); console.log('ssh', await lt());
console.log('2.2', (await h.status())['2.2']);
// 2.3
await p.click('button:has-text("Start scenario")'); await W(600);
await h.go('policy/rules/access'); await h.gotIt();
console.log('proxy before', await lt());
for (let i=0;i<8;i++) { const b = await p.$('[data-guide="up:Block-Proxy-Site"]:not([disabled])'); if (!b) break; await b.click(); await W(200); }
await W(300); await step('after move');
console.log('proxy after', await lt());
for (const n of ['Temp-Vendor-RDP','Old-FTP-Out','Test-Telnet','Allow-POP3-Legacy']) { await p.click(`[data-guide="rule:${n}"] .tw-toggle`); await W(150); }
await W(300); await h.go('monitor/logs/auditing-logs'); await h.gotIt();
console.log('2.3', (await h.status())['2.3']);

// ---------------- l2b ----------------
await nextTask();

// 2.4
await h.go('object/match/zones');
for (const [n, t] of [['Finance','Trusted'],['Guest','Public']]) { await p.click('[data-guide="add-zone"]'); await W(); await p.fill('#z-name', n); await h.sel('#z-type', t); await W(); await p.click('[data-guide="zone-save"]'); await W(); }
await h.go('network/system/interfaces');
for (const v of [{id:10,z:'LAN',ip:'10.10.10.1'},{id:20,z:'Finance',ip:'10.10.20.1'},{id:30,z:'Guest',ip:'10.10.30.1'}]) {
  await p.click('[data-guide="add-iface"]'); await W(); await p.fill('#vl-tag', String(v.id)); await W(); await p.click('[data-guide="vlan-next"]'); await W();
  await h.sel('#if-zone', v.z); await p.fill('#if-ip', v.ip); await p.fill('#if-mask', '255.255.255.0'); await W(); await p.click('[data-guide="iface-ok"]'); await W(); if (await p.$('[data-guide="confirm"]')) { await p.click('[data-guide="confirm"]'); await W(); }
}
await step('after vlans');
await h.go('network/system/dhcp');
for (const v of [10,20,30]) { await p.click('[data-guide="add-scope"]'); await W(); await h.sel('#sc-if', `X0:V${v}`); await p.fill('#sc-start', `10.10.${v}.100`); await p.fill('#sc-end', `10.10.${v}.199`); await p.fill('#sc-gw', `10.10.${v}.1`); await p.fill('#sc-dns0', '1.1.1.1'); await W(); await p.click('[data-guide="scope-save"]'); await W(); }
await step('after scopes');
await h.lab('controls'); await p.click('[data-guide="lab-trunk-btn"]'); await W();
await h.go('policy/rules/access');
await addRule({ name: 'Guest-Web-Out', from: 'Guest', to: 'WAN', svc: 'SG_Web-DNS' });
await addRule({ name: 'Guest-to-Finance-Deny', from: 'Guest', to: 'Finance', action: 'deny' });
await step('before vlan tests');
console.log('guest web', await lt()); console.log('guest fin', await lt());
console.log('2.4', (await h.status())['2.4']);
// 2.5
await h.go('policy/security/content-filter'); await p.click('#cfs-enable'); await W();
await h.go('object/profiles/content-filter'); await p.click('[data-guide="add-cfsprofile"]'); await W();
await p.fill('#cp-name', 'CFS_Staff'); for (const c of ['Malware','Phishing','Adult Content','Proxy Avoidance','Streaming Media']) await p.click(`[data-guide="cat:${c}"]`);
await p.fill('#cp-allow', 'video.example'); await W(); await p.click('[data-guide="cfsprofile-save"]'); await W();
await h.go('policy/rules/content-filter'); await p.click('[data-guide="add-cfsrule"]'); await W();
await p.fill('#cr-name', 'CFS-LAN'); await h.sel('#cr-profile', 'CFS_Staff'); await W(); await p.click('[data-guide="cfsrule-save"]'); await W();
await step('before cfs tests');
console.log('mal', await lt()); console.log('vid', await lt()); console.log('goo', await lt());
console.log('2.5', (await h.status())['2.5']);
// 2.6
await h.go('policy/security/app-control'); await p.click('#ac-enable'); await h.sel('#ac-P2P', 'block'); await h.sel('#ac-Proxy-Access', 'block'); await h.sel('#ac-Social-Networking', 'log'); await W(); await p.click('[data-guide="accept"]'); await W();
console.log('ultra', await lt()); console.log('social', await lt());
await h.go('monitor/logs/system-logs'); await h.gotIt();
console.log('2.6', (await h.status())['2.6']);
// 2.7
await h.go('device/users/local'); await p.click('[data-guide="tab:groups"]'); await p.click('[data-guide="add-ugroup"]'); await W(); await p.fill('#ug-name', 'Staff'); await W(); await p.click('[data-guide="ugroup-save"]'); await W();
await p.click('[data-guide="tab:users"]');
for (const n of ['priya','arjun']) { await p.click('[data-guide="add-user"]'); await W(); await p.fill('#us-name', n); await p.fill('#us-pw', 'Practice#Pass1'); await p.fill('#us-pw2', 'Practice#Pass1'); await p.click('[data-guide="us-group:Staff"]'); await W(); await p.click('[data-guide="user-save"]'); await W(); }
await step('after users');
await h.go('policy/rules/access'); await p.click('[data-guide="edit:LAN-Web-Out"]'); await W(); await p.click('[data-guide="tab:users"]'); await h.sel('#ar-uin', 'Staff'); await W(); await p.click('[data-guide="rule-save"]'); await W(); if (await p.$('[data-guide="confirm"]')) { await p.click('[data-guide="confirm"]'); await W(); }
console.log('anon', await lt());
await h.lab('controls'); await p.fill('[data-guide="lab-auth-user"]', 'priya'); await p.fill('[data-guide="lab-auth"] input[type=password]', 'Practice#Pass1'); await p.click('[data-guide="lab-auth-login"]'); await W(400);
console.log('auth', await lt());
await h.go('device/users/status'); await h.gotIt();
console.log('L2', await h.status());

// ---------------- l3 ----------------
await nextTask();

// 3.1
await h.go('policy/security/ips');
await tog('#ips-enable', true); await tog('#ips-high-prevent', true); await tog('#ips-high-detect', true); await tog('#ips-medium-prevent', true); await tog('#ips-medium-detect', true); await tog('#ips-low-detect', true); await W();
await p.click('[data-guide="accept"]'); await W();
await h.go('policy/security/gateway-av'); await tog('#gav-enable', true); await W(); await p.click('[data-guide="accept"]'); await W();
await step('3.1 before tests');
console.log('exploit', await lt()); console.log('eicar', await lt()); console.log('fp', await lt());
await h.go('monitor/logs/system-logs'); await h.gotIt();
await h.go('policy/security/ips'); await p.fill('#ips-sid', '5946'); await p.click('[data-guide="ips-add-excl"]'); await W(); await p.click('[data-guide="accept"]'); await W();
console.log('fp2', await lt());
console.log('3.1', (await h.status())['3.1']);
// 3.2
console.log('https eicar before', await lt());
await h.go('device/settings/certificates'); await p.click('[data-guide="cert-export:ThreatWall DPI-SSL CA"]'); await W();
await h.lab('controls'); await p.click('[data-guide="lab-ca-btn"]'); await W();
await h.go('policy/dpi-ssl/client'); await tog('#dpi-enable', true); await W();
await p.click('[data-guide="tab:objects"]'); await p.click('[data-guide="dpicat:Financial Services"]'); await p.click('[data-guide="dpicat:Health"]'); await p.fill('#dpi-names', 'pinned-app.example'); await W();
await p.click('[data-guide="accept"]'); await W();
await step('3.2 before tests');
console.log('eicar https', await lt()); console.log('bank', await lt()); console.log('pinned', await lt());
console.log('3.2', (await h.status())['3.2']);
// 3.3
await h.go('object/match/addresses'); await p.click('[data-guide="add-address"]'); await W();
await p.fill('#ad-name', 'SSLVPN_Pool'); await h.sel('#ad-zone', 'SSLVPN'); await h.sel('#ad-type', 'range'); await p.fill('#ad-ip', '192.168.50.10'); await p.fill('#ad-ip2', '192.168.50.50'); await W(); await p.click('[data-guide="addr-save"]'); await W();
await h.go('network/sslvpn/server'); await tog('#ssl-zone-WAN', true); await W(); await p.click('[data-guide="accept"]'); await W();
await h.go('network/sslvpn/client'); await h.sel('#ssl-pool', 'SSLVPN_Pool'); await p.selectOption('#ssl-routes', ['N_LAN-Staff']); await W(); await p.click('[data-guide="accept"]'); await W();
await h.go('device/users/local'); await p.click('[data-guide="edit-user:priya"]'); await W(); await p.click('[data-guide="us-group:SSLVPN Services"]'); await tog('#us-otp', true); await W(); await p.click('[data-guide="user-save"]'); await W();
await step('before nx');
await h.lab('controls');
const otpCode = await p.evaluate(() => document.querySelector('.tw-totp .mono')?.textContent);
await p.fill('[data-guide="lab-nx-user"]', 'priya'); await p.fill('[data-guide="lab-nx"] input[type=password]', 'Practice#Pass1'); await p.fill('[data-guide="lab-nx"] input[aria-label="One-time code"]', otpCode); await p.click('[data-guide="lab-nx-connect"]'); await W(400);
await step('after nx');
console.log('rdp', await lt()); console.log('dmz', await lt());
console.log('3.3', (await h.status())['3.3']);
// 3.4
await h.go('object/match/addresses'); await p.click('[data-guide="add-address"]'); await W();
await p.fill('#ad-name', 'N_Branch-LAN'); await h.sel('#ad-zone', 'VPN'); await h.sel('#ad-type', 'network'); await p.fill('#ad-ip', '192.168.20.0'); await p.fill('#ad-ip2', '255.255.255.0'); await W(); await p.click('[data-guide="addr-save"]'); await W();
const fillPol = async (name, gw, local, remote, save) => {
  await p.fill('#vp-name', name); await p.fill('#vp-gw', gw); await p.fill('#vp-secret', 'TrainingOnly-Key!'); await p.fill('#vp-secret2', 'TrainingOnly-Key!'); await W();
  await p.click('[data-guide="tab:network"]'); await h.sel('#vp-local', local); await h.sel('#vp-remote', remote); await W();
  await p.click('[data-guide="tab:proposals"]'); await h.sel('#vp-ex', 'ikev2'); await h.sel('#vp-dh', 'Group 14'); await h.sel('#vp-enc1', 'AES-256'); await h.sel('#vp-auth1', 'SHA256'); await h.sel('#vp-enc2', 'AES-256'); await h.sel('#vp-auth2', 'SHA256'); await tog('#vp-pfs', true); await W(); await h.sel('#vp-pfsg', 'Group 14'); await W();
  await p.click(`[data-guide="${save}"]`); await W();
};
await h.go('network/ipsec/rules'); await p.click('[data-guide="add-vpn"]'); await W();
await fillPol('HQ-to-Branch', '198.51.100.20', 'N_LAN-Staff', 'N_Branch-LAN', 'vpn-save');
await step('after hq'); await h.gotIt();
await h.go('network/ipsec/branch'); await p.click('[data-guide="add-braddr"]'); await W(); await p.fill('#ba-name', 'N_HQ-LAN'); await p.fill('#ba-ip', '192.168.10.0'); await W(); await p.click('[data-guide="braddr-save"]'); await W();
await p.click('[data-guide="add-brvpn"]'); await W(); await fillPol('Branch-to-HQ', '203.0.113.10', 'X0 Subnet', 'N_HQ-LAN', 'brvpn-save');
await step('after branch');
await h.go('network/ipsec/rules'); await h.gotIt();
console.log('branch', await lt());
console.log('3.4', (await h.status())['3.4']);
// 3.5
await h.go('network/system/interfaces'); await p.click('[data-guide="edit:X3"]'); await W();
await h.sel('#if-zone', 'WAN'); await W(); await h.sel('#if-mode', 'static'); await W(); await p.fill('#if-ip', '198.51.100.34'); await p.fill('#if-mask', '255.255.255.248'); await p.fill('#if-gw', '198.51.100.33'); await p.fill('#if-dns0', '1.1.1.1'); await p.fill('#if-dns1', '8.8.8.8'); await W();
for (const k of ['https','ssh']) { if (await p.isChecked(`#if-m-${k}`)) await p.click(`#if-m-${k}`); }
await p.click('[data-guide="iface-ok"]'); await W(); if (await p.$('[data-guide="confirm"]')) { await p.click('[data-guide="confirm"]'); await W(); }
await step('after x3');
await h.go('network/sdwan/groups'); await p.click('[data-guide="add-sdgroup"]'); await W(); await p.fill('#sg2-name', 'WAN-Group'); await p.click('[data-guide="sdm-X1"]'); await p.click('[data-guide="sdm-X3"]'); await W(); await p.click('[data-guide="sdgroup-save"]'); await W();
await h.go('network/sdwan/probes'); await p.click('[data-guide="add-probe"]'); await W(); await p.fill('#pr-name', 'Probe-1.1.1.1'); await p.fill('#pr-target', '1.1.1.1'); await p.click('[data-guide="pri-X1"]'); await p.click('[data-guide="pri-X3"]'); await W(); await p.click('[data-guide="probe-save"]'); await W();
await h.go('network/sdwan/paths'); await p.click('[data-guide="add-pathprof"]'); await W(); await p.fill('#pp-name', 'Internet-Failover'); await h.sel('#pp-backup', 'X3'); await W(); await p.click('[data-guide="pathprof-save"]'); await W();
await h.go('policy/rules/routing'); await p.click('[data-guide="add-route"]'); await W(); await p.fill('#rt-name', 'SD-WAN-Internet'); await h.sel('#rt-type', 'sdwan'); await W(); await h.sel('#rt-pp', 'Internet-Failover'); await W(); await p.click('[data-guide="route-save"]'); await W();
await step('before sdwan tests');
console.log('x1', await lt());
await h.lab('controls'); await p.click('[data-guide="lab-isp-X1"]'); await W();
console.log('x3', await lt());
await h.lab('controls'); await p.click('[data-guide="lab-isp-X1"]'); await W();
console.log('x1 again', await lt());
console.log('L3', await h.status());

// ---------------- l4 ----------------
await nextTask();

// 4.1
await h.go('device/ha/settings'); await h.sel('#ha-mode', 'active-standby'); await p.fill('#ha-serial', '7C3A19E40C11'); await tog('#ha-stateful', true); await W(); await p.click('[data-guide="accept"]'); await W();
await h.go('device/ha/monitoring'); await tog('#ha-mon-X0', true); await tog('#ha-mon-X1', true); await W(); await p.click('[data-guide="accept"]'); await W();
await h.go('device/ha/status'); await p.click('[data-guide="ha-sync"]'); await W();
console.log('prim', await lt());
await h.lab('controls'); await p.click('[data-guide="lab-ha-primary"]'); await W();
console.log('sec', await lt());
await h.lab('controls'); await p.click('[data-guide="lab-ha-primary"]'); await W(500);
console.log('4.1', (await h.status())['4.1']);
// 4.2
await p.click('button:has-text("Start scenario")'); await W(600);
console.log('erp', await lt());
await h.go('monitor/tools/packet-monitor'); await p.fill('#pm-dst', '192.0.2.20'); await p.fill('#pm-port', '443'); await W(); await p.click('[data-guide="pm-start"]'); await W();
console.log('erp2', await lt());
await h.go('monitor/tools/packet-monitor'); await p.click('[data-guide="pkt:dropped"]'); await W(); await h.gotIt();
await h.go('policy/rules/routing'); await p.click('[data-guide="route:ERP-Legacy-Path"] .tw-toggle'); await W();
await h.go('monitor/tools/packet-monitor');
console.log('erp3', await lt());
await h.go('monitor/tools/packet-monitor'); await p.click('[data-guide="pm-export"]'); await W();
await note('rca-42', 'Route ERP-Legacy-Path was re-enabled and sent ERP traffic to dead next hop 203.0.113.14. Disabled it.');
await W(400); console.log('4.2', (await h.status())['4.2']);
// 4.3
await p.click('button:has-text("Start scenario")'); await W(600);
console.log('br', await lt());
await h.go('network/ipsec/rules'); await h.gotIt();
await note('rca-43-1', 'AUTHENTICATION_FAILED: branch PSK changed');
await h.go('network/ipsec/branch'); await p.click('[data-guide^="edit-brvpn:"]'); await W(); await p.fill('#vp-secret', 'TrainingOnly-Key!'); await p.fill('#vp-secret2', 'TrainingOnly-Key!'); await p.click('[data-guide="brvpn-save"]'); await W();
await step('after psk');
await h.go('network/ipsec/rules'); await h.gotIt();
await note('rca-43-2', 'NO_PROPOSAL_CHOSEN: PFS turned off at branch');
await h.go('network/ipsec/branch'); await p.click('[data-guide^="edit-brvpn:"]'); await W(); await p.click('[data-guide="tab:proposals"]'); await tog('#vp-pfs', true); await W(); await h.sel('#vp-pfsg', 'Group 14'); await p.click('[data-guide="brvpn-save"]'); await W();
await step('after pfs');
await h.go('network/ipsec/rules'); await h.gotIt();
await note('rca-43-3', 'TS_UNACCEPTABLE: remote network set to old HQ plan');
await h.go('network/ipsec/branch'); await p.click('[data-guide^="edit-brvpn:"]'); await W(); await p.click('[data-guide="tab:network"]'); await h.sel('#vp-remote', 'N_HQ-LAN'); await p.click('[data-guide="brvpn-save"]'); await W();
console.log('br2', await lt());
console.log('4.3', (await h.status())['4.3']);
// 4.4
await h.go('device/settings/administration'); await p.fill('#ad-user', 'kgi-fwadmin'); await h.sel('#ad-otp', 'totp'); await p.click('[data-guide="tab:login"]'); await tog('#ad-lockout', true); await W(); await p.fill('#ad-attempts', '5'); await p.fill('#ad-lockmin', '30'); await W(); await p.click('[data-guide="accept"]'); await W();
await h.go('device/settings/certificates'); await p.click('[data-guide="cert-import"]'); await W(); await p.click('[data-guide="certimport-ok"]'); await W();
await h.go('device/settings/administration'); await p.click('[data-guide="tab:mgmt"]'); await h.sel('#ad-cert', 'KGI-HQ-FW management'); await p.fill('#ad-port', '4443'); await W(); await p.click('[data-guide="accept"]'); await W(600);
await step('after port');
await p.fill('[data-guide="url"]', 'https://192.168.10.1:4443'); await p.press('[data-guide="url"]', 'Enter'); await W();
await h.lab('controls');
const code = await p.evaluate(() => [...document.querySelectorAll('.tw-totp span')].find((x) => x.textContent.includes('kgi-fwadmin'))?.querySelector('.mono')?.textContent);
await p.fill('#tw-user', 'kgi-fwadmin'); await p.fill('#tw-pass', 'Lab-Firewall#2026'); await p.fill('#tw-otp', code); await p.click('[data-guide="login-submit"]'); await W(700);
await step('after relogin');
await h.go('device/log/syslog'); await tog('#sl-enable', true); await p.fill('#sl-server', '192.168.10.250'); await p.fill('#sl-port', '514'); await W(); await p.click('[data-guide="accept"]'); await W(); await p.click('[data-guide="syslog-test"]'); await W();
await h.go('device/settings/firmware'); await p.click('[data-guide="tab:settings"]'); await p.click('[data-guide="fw-check"]'); await W(); await h.sel('[data-guide="fw-sched"]', 'weekly'); await W();
await h.go('monitor/logs/auditing-logs'); await h.gotIt();
console.log('4.4', (await h.status())['4.4']);
// 4.5
await p.click('button:has-text("Start scenario")'); await W(600);
await h.go('monitor/logs/system-logs'); await h.gotIt();
await note('ir-host', 'STAFF-LAPTOP 10.10.10.100 beaconing every 5 min');
await h.go('object/match/addresses'); await p.click('[data-guide="add-address"]'); await W(); await p.fill('#ad-name', 'H_C2-Server'); await h.sel('#ad-zone', 'WAN'); await p.fill('#ad-ip', '192.0.2.66'); await W(); await p.click('[data-guide="addr-save"]'); await W();
await h.go('policy/rules/access'); await p.click('[data-guide="add-rule"]'); await W(); await p.click('[data-guide="ar-action-deny"]'); await p.fill('#ar-name', 'Block-C2-Outbound'); await h.sel('#ar-fz', 'LAN'); await h.sel('#ar-tz', 'WAN'); await h.sel('#ar-dst', 'H_C2-Server'); await W(); await p.click('[data-guide="rule-save"]'); await W(); if (await p.$('[data-guide="confirm"]')) { await p.click('[data-guide="confirm"]'); await W(); }
await h.go('policy/security/botnet'); await tog('#botnet-enable', true); await W();
await h.go('network/system/mac-ip-anti-spoof'); await p.click('[data-guide="spoof-edit:X0:V10"]'); await W(); await tog('#as-enabled', true); await tog('#as-spoofDetection', true); await W(); await p.click('[data-guide="spoofif-save"]'); await W();
await p.click('[data-guide="tab:cache"]'); await p.click('[data-guide="spoof-add"]'); await W(); await h.sel('#se-if', 'X0:V10'); await p.fill('#se-ip', '10.10.10.100'); await p.fill('#se-mac', '00:1a:2b:10:00:11'); await p.click('#se-black'); await W(); await p.click('[data-guide="spoofentry-save"]'); await W();
await step('after quarantine');
await h.go('monitor/tools/packet-monitor'); await p.click('button:has-text("Clear")'); await p.fill('#pm-src', '10.10.10.100'); await p.fill('#pm-dst', ''); await p.fill('#pm-port', ''); await W();
if (await p.$('[data-guide="pm-stop"]')) { await p.click('[data-guide="pm-stop"]'); await W(); }
await p.click('[data-guide="pm-start"]'); await W();
console.log('beacon', await lt()); console.log('fin c2', await lt());
await h.go('monitor/tools/packet-monitor'); await p.click('[data-guide="pm-export"]'); await W();
await h.go('monitor/logs/system-logs'); await p.fill('[data-guide="logs-search"]', 'cdn-update-check'); await W(); await p.click('[data-guide="logs-export"]'); await W();
await note('ir-timeline', 'Beacon every 5 minutes for the last hour; contained at report time.');
await note('ir-containment', 'Blocked C2 for all LAN, botnet filter on, laptop MAC blacklisted.');
await note('ir-root', 'Legacy allow-any-HTTPS rule let unknown traffic out unfiltered.');
await note('ir-next', 'Re-image STAFF-LAPTOP, rotate creds, remove legacy rule, monitor.');
await W(500);
await p.click('[data-guide="open-record"]'); await W(800);
if (!(await p.isVisible('text=Training record'))) throw new Error('training record did not open');
await p.click('[data-guide="record-back"]'); await W(600);
console.log('L4', await h.status());

const st = await h.status();
const done = Object.values(st).filter((v) => v.startsWith('completed')).length;
const fails = (await h.state()).progress.tasks;
console.log(`\nCompleted ${done}/30 tasks; recorded failed attempts: ${Object.values(fails).reduce((a, t) => a + t.failures.length, 0)}`);
if (done !== 30) failed = true;
} catch (e) { failed = true; console.log('ERR', e.message); await step('at error'); await p.screenshot({ path: 'e2e-error.png' }); }
if (h.errs.length) { failed = true; console.log('Browser errors', h.errs); }
await h.b.close();
process.exit(failed ? 1 : 0);