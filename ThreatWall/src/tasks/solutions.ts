/**
 * Answer key: the configuration each task expects, applied directly to state.
 * Used ONLY by automated tests (to prove checks pass with the right config and fail without it).
 * Never imported by the UI.
 */
import type { AccessRule, AddressObject, IpsecPolicy, NetInterface, RootState } from '../state/types';
import { LAB } from '../state/baseline';
import { hashPassword } from '../lib/hash';
import { pcLease } from '../engine/network';

export const LAB_PASSWORD = 'Lab-Firewall#2026';
type S = RootState;

const setIface = (s: S, name: string, patch: Partial<NetInterface>): S => ({
  ...s, config: { ...s.config, interfaces: s.config.interfaces.map((i) => (i.name === name ? { ...i, ...patch } : i)) },
});
const addAddr = (s: S, a: Omit<AddressObject, 'id'>): S => ({ ...s, config: { ...s.config, addresses: [...s.config.addresses.filter((x) => x.name !== a.name), { ...a, id: `a-${a.name}` }] } });
export const mkRule = (p: Partial<AccessRule> & Pick<AccessRule, 'name' | 'fromZone' | 'toZone'>): AccessRule => ({
  id: `r-${p.name}`, action: 'allow', src: 'Any', dst: 'Any', service: 'Any', schedule: 'Always', usersIncl: 'All', usersExcl: 'None', logging: true,
  enabled: true, builtIn: false, auto: null, hits: 0, lastHit: null, comment: '', ...p,
});
const addRuleTop = (s: S, r: AccessRule): S => ({ ...s, config: { ...s.config, accessRules: [r, ...s.config.accessRules.filter((x) => x.name !== r.name)] } });

export function s01(s: S): S {
  const st = { ...s, session: { ...s.session, pc: { ...s.session.pc, cabled: true } } };
  const l = pcLease(st)!;
  return { ...st, session: { ...st.session, pc: { ...st.session.pc, ip: l.ip, mask: l.mask, gateway: l.gateway, dns: l.dns } } };
}
export const s02 = (s: S): S => ({ ...s, session: { ...s.session, certAccepted: true } });
export const s03 = (s: S): S => ({
  ...s,
  config: { ...s.config, system: { ...s.config.system, adminPasswordHash: hashPassword(LAB_PASSWORD), defaultPassword: false, setupComplete: true } },
  session: { ...s.session, loggedIn: true, user: 'admin' },
});
export const s05 = (s: S): S => ({
  ...s,
  config: {
    ...s.config,
    licensing: { registered: true, account: 'admin@lab.local', registeredAt: 1, services: s.config.licensing.services.map((x) => ({ ...x, status: 'licensed', expires: '2027-12-31' })) },
  },
});
export const s06 = (s: S): S => ({ ...s, config: { ...s.config, backups: [{ id: 'b1', createdAt: 1, firmware: s.config.system.firmware, user: 'admin', comment: 'Before changes', kind: 'local', snapshot: '{}' }] } });
export const s07 = (s: S): S => ({ ...s, config: { ...s.config, system: { ...s.config.system, hostname: LAB.hostname, adminTimeoutMin: 10 } } });

export function s11(s: S): S {
  let x = setIface(s, 'X1', {
    zone: 'WAN', mode: 'static', ip: LAB.wanIp, mask: LAB.wanMask, gateway: LAB.wanGw, dns: [LAB.dns1, LAB.dns2, '0.0.0.0'],
    mgmt: { https: false, http: false, ping: true, ssh: false, snmp: false },
  });
  x = setIface(x, 'X0', { ip: LAB.lanIp, mask: LAB.lanMask, mgmt: { https: true, http: false, ping: true, ssh: true, snmp: false } });
  return { ...x, session: { ...x.session, connectedIp: LAB.lanIp, pc: { ...x.session.pc, mode: 'static', ip: LAB.adminPc, mask: LAB.lanMask, gateway: LAB.lanIp, dns: LAB.dns1 } } };
}

export function s13(s: S): S {
  return {
    ...s,
    config: {
      ...s.config,
      dhcp: {
        ...s.config.dhcp,
        scopes: [{ id: 'scope-x0', iface: 'X0', start: LAB.poolStart, end: LAB.poolEnd, gateway: LAB.lanIp, dns: [LAB.dns1, LAB.dns2], leaseMin: 1440, enabled: true, comment: '' }],
        statics: [{ id: 'st-printer', name: 'PRINTER-01', ip: LAB.printer, mac: LAB.macs.printer, enabled: true }],
      },
    },
  };
}

export function s14(s: S): S {
  const e = (ip: string, mac: string, blacklisted = false) => ({ id: `as-${mac}`, iface: 'X0', ip, mac, router: false, blacklisted, comment: '' });
  return {
    ...s,
    config: {
      ...s.config,
      antiSpoof: {
        ifaces: { X0: { enabled: true, staticArp: false, dhcpServer: true, arpLock: true, arpWatch: false, enforceIngress: true, spoofDetection: true, allowMgmt: true } },
        cache: [e(LAB.adminPc, LAB.macs.admin), e(LAB.hrPc, LAB.macs.hr), e(LAB.finPc, LAB.macs.fin), e(LAB.finPc, LAB.macs.rogue, true)],
      },
    },
  };
}

export function s15(s: S): S {
  let x = addAddr(s, { name: 'H_WEB-01', zone: 'DMZ', type: 'host', ip: LAB.webServer, ip2: '255.255.255.255', fqdn: '', comment: '' });
  x = addAddr(x, { name: 'N_LAN-Staff', zone: 'LAN', type: 'network', ip: '192.168.10.0', ip2: '255.255.255.0', fqdn: '', comment: '' });
  x = addAddr(x, { name: 'FQDN_update-site', zone: 'WAN', type: 'fqdn', ip: '', ip2: '', fqdn: 'updates.vendor.example', comment: '' });
  x = addAddr(x, { name: 'H_FIN-PC', zone: 'LAN', type: 'host', ip: LAB.finPc, ip2: '255.255.255.255', fqdn: '', comment: '' });
  return { ...x, config: { ...x.config, addressGroups: [{ id: 'g-fin', name: 'G_Finance-PCs', members: ['H_FIN-PC'], comment: '' }] } };
}

export function s16(s: S): S {
  let x: S = { ...s, config: { ...s.config, serviceGroups: [...s.config.serviceGroups, { id: 'sg-web', name: 'SG_Web-DNS', members: ['HTTP', 'HTTPS', 'DNS (Name Service)'], builtIn: false }] } };
  x = addRuleTop(x, mkRule({ name: 'LAN-Web-Out', fromZone: 'LAN', toZone: 'WAN', src: 'N_LAN-Staff', service: 'SG_Web-DNS' }));
  return { ...x, config: { ...x.config, accessRules: x.config.accessRules.map((r) => (r.id === 'r-lan-wan' ? { ...r, enabled: false } : r)) } };
}

export function s22(s: S): S {
  let x = setIface(s, 'X2', { zone: 'DMZ', mode: 'static', ip: LAB.dmzIp, mask: LAB.dmzMask });
  x = addAddr(x, { name: 'webserver_public_ip', zone: 'WAN', type: 'host', ip: LAB.publicWeb, ip2: '255.255.255.255', fqdn: '', comment: '' });
  x = addAddr(x, { name: 'webserver_private_ip', zone: 'DMZ', type: 'host', ip: LAB.webServer, ip2: '255.255.255.255', fqdn: '', comment: '' });
  x = {
    ...x,
    config: {
      ...x.config,
      natRules: [...x.config.natRules, {
        id: 'nat-web', name: 'Publish WEB-01 HTTPS', origSrc: 'Any', transSrc: 'Original', origDst: 'webserver_public_ip', transDst: 'webserver_private_ip',
        origSvc: 'HTTPS', transSvc: 'Original', inIface: 'X1', outIface: 'Any', enabled: true, builtIn: false, hits: 0, comment: '',
      }],
    },
  };
  return addRuleTop(x, mkRule({ name: 'WAN-to-WEB-01-HTTPS', fromZone: 'WAN', toZone: 'DMZ', dst: 'webserver_public_ip', service: 'HTTPS' }));
}

export const ipsecPolicy = (p: Partial<IpsecPolicy> & Pick<IpsecPolicy, 'id' | 'name' | 'gateway' | 'localNet' | 'remoteNet'>): IpsecPolicy => ({
  kind: 'site', secret: 'TrainingOnly-PSK-2026!', exchange: 'ikev2',
  p1: { dh: 'Group 14', enc: 'AES-256', auth: 'SHA256', life: 28800 },
  p2: { proto: 'ESP', enc: 'AES-256', auth: 'SHA256', pfs: true, pfsGroup: 'Group 14', life: 28800 },
  keepAlive: true, suppressAutoRules: false, boundTo: 'Zone WAN', enabled: true, ...p,
});

export function s34(s: S): S {
  const x = addAddr(s, { name: 'N_Branch-LAN', zone: 'VPN', type: 'network', ip: '192.168.20.0', ip2: '255.255.255.0', fqdn: '', comment: '' });
  return {
    ...x,
    config: {
      ...x.config,
      ipsec: [...x.config.ipsec.filter((p) => p.kind !== 'site'), ipsecPolicy({ id: 'vpn-hq', name: 'HQ-to-Branch', gateway: LAB.branchWan, localNet: 'N_LAN-Staff', remoteNet: 'N_Branch-LAN' })],
      branch: {
        ...x.config.branch,
        addresses: [{ id: 'br-hq', name: 'N_HQ-LAN', zone: 'VPN', type: 'network', ip: '192.168.10.0', ip2: '255.255.255.0', fqdn: '', comment: '' }],
        ipsec: [ipsecPolicy({ id: 'vpn-br', name: 'Branch-to-HQ', gateway: LAB.wanIp, localNet: 'X0 Subnet', remoteNet: 'N_HQ-LAN' })],
      },
    },
  };
}

export function s35(s: S): S {
  let x = setIface(s, 'X3', { zone: 'WAN', mode: 'static', ip: LAB.wan2Ip, mask: LAB.wan2Mask, gateway: LAB.wan2Gw, dns: [LAB.dns1, LAB.dns2, '0.0.0.0'] });
  x = {
    ...x,
    config: {
      ...x.config,
      sdwan: {
        groups: [{ id: 'g1', name: 'WAN-Group', members: ['X1', 'X3'] }],
        probes: [{ id: 'p1', name: 'Probe-1.1.1.1', target: '1.1.1.1', ifaces: ['X1', 'X3'], intervalSec: 3, enabled: true }],
        profiles: [{ id: 'pp1', name: 'Internet-Failover', group: 'WAN-Group', probe: 'Probe-1.1.1.1', maxLatencyMs: 50, maxLossPct: 5, backup: 'X3', enabled: true }],
      },
      routes: [...x.config.routes, { id: 'rt-sdwan', name: 'SD-WAN-Internet', src: 'Any', dst: 'Any', service: 'Any', type: 'sdwan', iface: '', gateway: '0.0.0.0', pathProfile: 'Internet-Failover', metric: 1, enabled: true, hits: 0, comment: '' }],
    },
  };
  return x;
}

export const upTo1 = (s: S) => s16(s15(s14(s13(s11(s07(s06(s05(s03(s02(s01(s)))))))))));

/* ---------------- Level 2 ---------------- */
export function s21(s: S): S {
  let x: S = {
    ...s,
    config: {
      ...s.config,
      services: [...s.config.services, { id: 's8443', name: 'TCP-8443', protocol: 'TCP', portStart: 8443, portEnd: 8443, builtIn: false }],
      serviceGroups: [...s.config.serviceGroups, { id: 'sg-saas', name: 'SG_SaaS', members: ['TCP-8443', 'HTTPS'], builtIn: false }],
      schedules: [...s.config.schedules, { id: 'oh', name: 'Office-Hours', days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00', builtIn: false }],
    },
  };
  x = addRuleTop(x, mkRule({ name: 'LAN-SaaS-Office-Hours', fromZone: 'LAN', toZone: 'WAN', src: 'N_LAN-Staff', service: 'SG_SaaS', schedule: 'Office-Hours' }));
  return x;
}

export function s23(s: S, seed: (s: S) => S): S {
  const x = seed(s);
  const rules = x.config.accessRules;
  const block = rules.find((r) => r.name === 'Block-Proxy-Site')!;
  const rest = rules.filter((r) => r !== block);
  const first = rest.findIndex((r) => r.fromZone === 'LAN' && r.toZone === 'WAN');
  const ordered = [...rest.slice(0, first), { ...block, hits: 1 }, ...rest.slice(first)];
  const off = ['Temp-Vendor-RDP', 'Old-FTP-Out', 'Test-Telnet', 'Allow-POP3-Legacy'];
  return {
    ...x,
    config: { ...x.config, accessRules: ordered.map((r) => (off.includes(r.name) ? { ...r, enabled: false } : r)) },
    audit: [{ id: 'mv', ts: 2, user: 'admin', category: 'Policy', action: 'Access rule Block-Proxy-Site moved up', detail: 'LAN→WAN: now priority 1' }, ...x.audit],
  };
}

export function s24(s: S): S {
  let x: S = {
    ...s,
    config: {
      ...s.config,
      zones: [...s.config.zones,
        { ...s.config.zones.find((z) => z.name === 'LAN')!, name: 'Finance', builtIn: false },
        { ...s.config.zones.find((z) => z.name === 'DMZ')!, name: 'Guest', interfaceTrust: false, builtIn: false }],
    },
    lab: { ...s.lab, trunk: true },
  };
  const x0 = x.config.interfaces.find((i) => i.name === 'X0')!;
  for (const v of LAB.vlans) {
    x = {
      ...x,
      config: {
        ...x.config,
        interfaces: [...x.config.interfaces, { ...x0, name: `X0:V${v.id}`, kind: 'vlan', parent: 'X0', vlanId: v.id, zone: v.zone, ip: v.ip, mask: '255.255.255.0', mgmt: { https: false, http: false, ping: true, ssh: false, snmp: false } }],
        dhcp: { ...x.config.dhcp, scopes: [...x.config.dhcp.scopes, { id: `sc-${v.id}`, iface: `X0:V${v.id}`, start: v.start, end: v.end, gateway: v.ip, dns: [LAB.dns1, LAB.dns2], leaseMin: 1440, enabled: true, comment: '' }] },
      },
    };
  }
  x = addRuleTop(x, mkRule({ name: 'Guest-Web-Out', fromZone: 'Guest', toZone: 'WAN', service: 'SG_Web-DNS' }));
  return addRuleTop(x, mkRule({ name: 'Guest-to-Finance-Deny', fromZone: 'Guest', toZone: 'Finance', action: 'deny' }));
}

export function s25(s: S): S {
  const c = s.config.security.cfs;
  return {
    ...s,
    config: {
      ...s.config,
      security: {
        ...s.config.security,
        cfs: {
          ...c, enabled: true,
          profiles: [...c.profiles, { id: 'p-staff', name: 'CFS_Staff', blocked: ['Malware', 'Phishing', 'Adult Content', 'Proxy Avoidance', 'Streaming Media'], allowList: ['video.example'] }],
          rules: [...c.rules, { id: 'cr-lan', name: 'CFS-LAN', srcZone: 'LAN', dstZone: 'WAN', users: 'All', profile: 'CFS_Staff', enabled: true, hits: 0 }],
        },
      },
    },
  };
}

export const s26 = (s: S): S => ({
  ...s,
  config: { ...s.config, security: { ...s.config.security, appControl: { ...s.config.security.appControl, enabled: true, categories: { ...s.config.security.appControl.categories, P2P: 'block', 'Proxy-Access': 'block', 'Social Networking': 'log' } } } },
});

export function s27(s: S): S {
  const users = LAB.users.map((n) => ({ id: `u-${n}`, name: n, passwordHash: hashPassword('Practice#Pass1'), groups: ['Everyone', 'Staff'], otp: false, vpnAccess: [], comment: '' }));
  return {
    ...s,
    config: {
      ...s.config,
      users: { ...s.config.users, groups: [...s.config.users.groups, { name: 'Staff', builtIn: false, comment: '' }], local: [...s.config.users.local, ...users] },
      accessRules: s.config.accessRules.map((r) => (r.name === 'LAN-Web-Out' ? { ...r, usersIncl: 'Staff' } : r)),
    },
  };
}

/* ---------------- Level 3 ---------------- */
const sec = (s: S, patch: Partial<S['config']['security']>): S => ({ ...s, config: { ...s.config, security: { ...s.config.security, ...patch } } });
export const s31 = (s: S): S => sec(s, {
  ips: { enabled: true, high: { prevent: true, detect: true }, medium: { prevent: true, detect: true }, low: { prevent: false, detect: true }, exclusions: [5946] },
  gav: { ...s.config.security.gav, enabled: true },
});
export const s32 = (s: S): S => ({
  ...sec(s, { dpiSsl: { ...s.config.security.dpiSsl, clientEnabled: true, inspect: { ips: true, gav: true, spyware: true, appControl: true, cfs: true }, excludedCategories: ['Financial Services', 'Health'], excludedNames: ['pinned-app.example'] } }),
  lab: { ...s.lab, pcsTrustDpiCa: true },
});
export function s33(s: S): S {
  const x = addAddr(s, { name: 'SSLVPN_Pool', zone: 'SSLVPN', type: 'range', ip: LAB.sslPoolStart, ip2: LAB.sslPoolEnd, fqdn: '', comment: '' });
  return {
    ...x,
    config: {
      ...x.config,
      sslvpn: { ...x.config.sslvpn, zones: { WAN: true }, port: 4433, pool: 'SSLVPN_Pool', clientRoutes: ['N_LAN-Staff'], tunnelAll: false, dns: [LAB.dns1, '0.0.0.0'] },
      users: { ...x.config.users, local: x.config.users.local.map((u) => (u.name === LAB.users[0] ? { ...u, groups: [...u.groups, 'SSLVPN Services'], otp: true } : u)) },
    },
  };
}

/* ---------------- Level 4 ---------------- */
export const s41 = (s: S): S => ({ ...s, config: { ...s.config, ha: { ...s.config.ha, mode: 'active-standby', secondarySerial: LAB.haSerial, statefulSync: true, preempt: true, monitorIfaces: ['X0', 'X1'], synced: true } } });
const doneSteps = (s: S, task: string, ids: string[]): S => ({ ...s, progress: { ...s.progress, tasks: { ...s.progress.tasks, [task]: { ...(s.progress.tasks[task] ?? { status: 'in-progress', step: 0, startedAt: 1, completedAt: null, failures: [], checks: [] }), stepDoneAt: { ...(s.progress.tasks[task]?.stepDoneAt ?? {}), ...Object.fromEntries(ids.map((i) => [i, 1])) } } } } });
export const s42 = (s: S, seed: (s: S) => S): S => {
  const x = seed(s);
  return doneSteps({ ...x, config: { ...x.config, routes: x.config.routes.map((r) => (r.name === 'ERP-Legacy-Path' ? { ...r, enabled: false } : r)) }, progress: { ...x.progress, notes: { ...x.progress.notes, 'rca-42': 'Route ERP-Legacy-Path re-enabled overnight pointed at old next hop 203.0.113.14; capture showed drop. Disabled it.' } } }, '4.2', ['exp']);
};
export const s43 = (s: S, seed: (s: S) => S): S => {
  const x = seed(s);
  const hq = x.config.ipsec.find((p) => p.kind === 'site')!;
  return {
    ...x,
    config: { ...x.config, branch: { ...x.config.branch, ipsec: x.config.branch.ipsec.map((p) => ({ ...p, secret: hq.secret, p2: { ...p.p2, pfs: true, pfsGroup: 'Group 14' }, remoteNet: 'N_HQ-LAN' })) } },
    progress: { ...x.progress, notes: { ...x.progress.notes, 'rca-43-1': 'AUTHENTICATION_FAILED: branch PSK changed; re-entered.', 'rca-43-2': 'NO_PROPOSAL_CHOSEN: PFS disabled at branch; enabled group 14.', 'rca-43-3': 'TS_UNACCEPTABLE: branch remote network wrong; set N_HQ-LAN.' } },
  };
};
export function s44(s: S): S {
  const x = { ...s, config: { ...s.config, certificates: [...s.config.certificates, { name: 'KGI-HQ-FW management', type: 'Local' as const, subject: 'CN=kgi-hq-fw.kgi.example', issuer: 'KGI Internal Root CA (lab)', expires: '2028-12-31', builtIn: false }] } };
  return {
    ...x,
    config: {
      ...x.config,
      system: { ...x.config.system, adminUser: LAB.adminName, otpMethod: 'totp', lockout: { enabled: true, attempts: 5, minutes: 30 }, httpsPort: LAB.mgmtPort, certificate: 'KGI-HQ-FW management', syslog: { enabled: true, server: LAB.syslog, port: 514 }, backupSchedule: 'weekly', firmwareReviewed: true },
    },
    session: { ...x.session, connectedPort: LAB.mgmtPort },
  };
}
export function s45(s: S, seed: (s: S) => S): S {
  let x = seed(s);
  x = addAddr(x, { name: 'H_C2-Server', zone: 'WAN', type: 'host', ip: LAB.c2, ip2: '255.255.255.255', fqdn: '', comment: '' });
  x = addRuleTop(x, mkRule({ name: 'Block-C2-Outbound', fromZone: 'LAN', toZone: 'WAN', action: 'deny', dst: 'H_C2-Server' }));
  x = {
    ...x,
    config: {
      ...x.config,
      security: { ...x.config.security, botnet: { enabled: true } },
      antiSpoof: {
        ifaces: { ...x.config.antiSpoof.ifaces, 'X0:V10': { enabled: true, staticArp: false, dhcpServer: false, arpLock: false, arpWatch: false, enforceIngress: false, spoofDetection: true, allowMgmt: true } },
        cache: [...x.config.antiSpoof.cache, { id: 'q1', iface: 'X0:V10', ip: '10.10.10.100', mac: '00:1a:2b:10:00:11', router: false, blacklisted: true, comment: 'Quarantine' }],
      },
    },
    progress: { ...x.progress, notes: { ...x.progress.notes, 'ir-host': 'STAFF-LAPTOP 10.10.10.100 found in logs', 'ir-timeline': 'Beacon every 5 minutes for an hour; contained today.', 'ir-containment': 'Blocked C2 for LAN, botnet filter, MAC blacklisted.', 'ir-root': 'Legacy allow-any-HTTPS rule let unknown traffic out.', 'ir-next': 'Re-image laptop, review logs, remove legacy rule.' } },
  };
  return doneSteps(x, '4.5', ['exp', 'lexp']);
}
