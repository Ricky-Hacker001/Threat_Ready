import type {
  AccessRule, AntiSpoofIface, FirewallConfig, LabControls, LabSession, NetInterface, Progress, RootState, ServiceObject, Zone, PacketMonitorState,
} from './types';
import { hashPassword } from '../lib/hash';

export const STATE_VERSION = 2;

export const FACTORY = {
  mgmtIp: '192.168.168.168',
  mgmtMask: '255.255.255.0',
  adminUser: 'admin',
  adminPassword: 'password',
} as const;

/** The task guide's lab addressing plan. Every task, check and hint reads from here. */
export const LAB = {
  hostname: 'KGI-HQ-FW',
  lanIp: '192.168.10.1',
  lanMask: '255.255.255.0',
  wanIp: '203.0.113.10',
  wanMask: '255.255.255.248',
  wanGw: '203.0.113.9',
  dmzIp: '172.16.10.1',
  dmzMask: '255.255.255.0',
  webServer: '172.16.10.100',
  publicWeb: '203.0.113.11',
  wan2Ip: '198.51.100.34',
  wan2Mask: '255.255.255.248',
  wan2Gw: '198.51.100.33',
  dns1: '1.1.1.1',
  dns2: '8.8.8.8',
  poolStart: '192.168.10.100',
  poolEnd: '192.168.10.199',
  adminPc: '192.168.10.5',
  hrPc: '192.168.10.21',
  finPc: '192.168.10.22',
  printer: '192.168.10.50',
  branchWan: '198.51.100.20',
  branchLan: '192.168.20.0',
  sslPoolStart: '192.168.50.10',
  sslPoolEnd: '192.168.50.50',
  macs: {
    admin: '00:1a:2b:3c:4d:05',
    hr: '00:1a:2b:3c:4d:21',
    fin: '00:1a:2b:3c:4d:22',
    printer: '00:1a:2b:3c:4d:50',
    rogue: 'de:ad:be:ef:00:99',
  },
  vlans: [
    { id: 10, zone: 'LAN', ip: '10.10.10.1', start: '10.10.10.100', end: '10.10.10.199' },
    { id: 20, zone: 'Finance', ip: '10.10.20.1', start: '10.10.20.100', end: '10.10.20.199' },
    { id: 30, zone: 'Guest', ip: '10.10.30.1', start: '10.10.30.100', end: '10.10.30.199' },
  ],
  users: ['priya', 'arjun'],
  haSerial: '7C3A19E40C11',
  syslog: '192.168.10.250',
  adminName: 'kgi-fwadmin',
  mgmtPort: 4443,
  c2: '192.0.2.66',
  c2Name: 'cdn-update-check.example',
} as const;

const noMgmt = { https: false, http: false, ping: false, ssh: false, snmp: false };

function port(name: string, mac: string, patch: Partial<NetInterface> = {}): NetInterface {
  return {
    name, kind: 'physical', zone: null, mode: 'unassigned', ip: '0.0.0.0', mask: '0.0.0.0', gateway: '0.0.0.0',
    dns: ['0.0.0.0', '0.0.0.0', '0.0.0.0'], mgmt: { ...noMgmt }, userLogin: { http: false, https: false }, httpRedirect: false,
    comment: '', enabled: true, link: 'nolink', speed: '', mac, ...patch,
  };
}

function zone(name: string, securityType: Zone['securityType'], flags: Partial<Zone> = {}): Zone {
  return {
    name, securityType, interfaceTrust: false, gatewayAv: false, antiSpyware: false, ips: false, appControl: false,
    sslControl: false, sslVpnAccess: false, dpiSslClient: false, dpiSslServer: false, comment: '', builtIn: true, ...flags,
  };
}

let sid = 0;
const svc = (name: string, protocol: ServiceObject['protocol'], a = 0, b = a): ServiceObject =>
  ({ id: `svc-${++sid}`, name, protocol, portStart: a, portEnd: b, builtIn: true });

export const defaultAntiSpoof = (): AntiSpoofIface => ({
  enabled: false, staticArp: false, dhcpServer: false, arpLock: false, arpWatch: false, enforceIngress: false, spoofDetection: false, allowMgmt: true,
});

function rule(id: string, name: string, fromZone: string, toZone: string, action: AccessRule['action']): AccessRule {
  return {
    id, name, fromZone, toZone, action, src: 'Any', dst: 'Any', service: 'Any', schedule: 'Always', usersIncl: 'All', usersExcl: 'None',
    logging: action !== 'allow', enabled: true, builtIn: true, auto: null, hits: 0, lastHit: null, comment: 'Default rule',
  };
}

const licSvc = (id: string, name: string) => ({ id, name, status: 'not-licensed' as const, expires: null });

/** Factory-default appliance, as it arrives in the box. */
export function factoryConfig(): FirewallConfig {
  sid = 0;
  return {
    system: {
      hostname: 'TW4700-7C3A19', domain: 'lab.local', description: '', model: 'TW 4700', serial: '7C3A19E40B52', authCode: 'TW7K-Q2RD',
      firmware: 'ThreatWall OS 7.1.2-7019', romVersion: '1.2.0', adminUser: FACTORY.adminUser, adminPasswordHash: hashPassword(FACTORY.adminPassword),
      defaultPassword: true, adminTimeoutMin: 5, timezone: 'Asia/Kolkata', setupComplete: false, ipv6: false, otpMethod: 'disabled',
      bootedAt: Date.now() - (3 * 86400 + 4 * 3600 + 17 * 60) * 1000,
      httpsPort: 443, certificate: 'Default self-signed certificate', lockout: { enabled: false, attempts: 5, minutes: 5 },
      syslog: { enabled: false, server: '', port: 514 }, backupSchedule: 'none', firmwareReviewed: false, limitedAdmins: [],
    },
    interfaces: [
      port('X0', '7c:3a:19:e4:0b:50', {
        zone: 'LAN', mode: 'static', ip: FACTORY.mgmtIp, mask: FACTORY.mgmtMask,
        mgmt: { https: true, http: false, ping: true, ssh: true, snmp: false }, userLogin: { http: false, https: true },
        comment: 'Default LAN', link: 'up', speed: '1 Gbps Full Duplex',
      }),
      port('X1', '7c:3a:19:e4:0b:51', { zone: 'WAN', mode: 'dhcp', comment: 'Default WAN', link: 'up', speed: '1 Gbps Full Duplex' }),
      port('X2', '7c:3a:19:e4:0b:52', { link: 'up', speed: '1 Gbps Full Duplex' }),
      port('X3', '7c:3a:19:e4:0b:53', { link: 'up', speed: '1 Gbps Full Duplex' }),
      port('X4', '7c:3a:19:e4:0b:54'),
      port('X5', '7c:3a:19:e4:0b:55'),
      port('X6', '7c:3a:19:e4:0b:56'),
      port('X7', '7c:3a:19:e4:0b:57'),
      port('MGMT', '7c:3a:19:e4:0b:5f', {
        kind: 'mgmt', zone: 'MGMT', mode: 'static', ip: '192.168.1.254', mask: '255.255.255.0',
        mgmt: { https: true, http: false, ping: true, ssh: true, snmp: false }, comment: 'Out-of-band management',
      }),
    ],
    zones: [
      zone('LAN', 'Trusted', { interfaceTrust: true, gatewayAv: true, antiSpyware: true, ips: true, appControl: true }),
      zone('WAN', 'Untrusted', { gatewayAv: true, antiSpyware: true, ips: true, appControl: true }),
      zone('DMZ', 'Public', { interfaceTrust: true, gatewayAv: true, ips: true }),
      zone('VPN', 'Encrypted'),
      zone('SSLVPN', 'SSL VPN'),
      zone('MGMT', 'Management', { interfaceTrust: true }),
      zone('MULTICAST', 'Untrusted'),
      zone('WLAN', 'Wireless'),
    ],
    dhcp: {
      enabled: true,
      conflictDetection: true,
      scopes: [{ id: 'scope-x0', iface: 'X0', start: '192.168.168.100', end: '192.168.168.199', gateway: FACTORY.mgmtIp, dns: [FACTORY.mgmtIp, '0.0.0.0'], leaseMin: 1440, enabled: true, comment: 'Factory LAN scope' }],
      statics: [],
    },
    staticArp: [],
    antiSpoof: { ifaces: {}, cache: [] },
    dns: { mode: 'inherit', servers: ['0.0.0.0', '0.0.0.0', '0.0.0.0'] },
    addresses: [],
    addressGroups: [],
    services: [
      svc('HTTP', 'TCP', 80), svc('HTTPS', 'TCP', 443), svc('DNS (Name Service) TCP', 'TCP', 53), svc('DNS (Name Service) UDP', 'UDP', 53),
      svc('SSH', 'TCP', 22), svc('Telnet', 'TCP', 23), svc('FTP', 'TCP', 21), svc('SMTP', 'TCP', 25), svc('POP3', 'TCP', 110), svc('IMAP', 'TCP', 143),
      svc('NTP', 'UDP', 123), svc('SNMP', 'UDP', 161, 162), svc('RDP', 'TCP', 3389), svc('Ping', 'ICMP'), svc('HTTP 8080', 'TCP', 8080),
      svc('IKE', 'UDP', 500), svc('IKE NAT-T', 'UDP', 4500), svc('ESP (IPSec)', 'ESP'), svc('SSL VPN (4433)', 'TCP', 4433), svc('BitTorrent', 'TCP', 6881, 6889),
    ],
    serviceGroups: [{ id: 'sg-dns', name: 'DNS (Name Service)', members: ['DNS (Name Service) TCP', 'DNS (Name Service) UDP'], builtIn: true }],
    schedules: [
      { id: 'sch-work', name: 'Work Hours', days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', builtIn: true },
      { id: 'sch-weekend', name: 'Weekend Hours', days: [0, 6], start: '00:00', end: '24:00', builtIn: true },
    ],
    accessRules: [
      rule('r-lan-lan', 'Default LAN→LAN', 'LAN', 'LAN', 'allow'),
      rule('r-lan-wan', 'Default LAN→WAN', 'LAN', 'WAN', 'allow'),
      rule('r-lan-dmz', 'Default LAN→DMZ', 'LAN', 'DMZ', 'allow'),
      rule('r-dmz-wan', 'Default DMZ→WAN', 'DMZ', 'WAN', 'allow'),
      rule('r-dmz-lan', 'Default DMZ→LAN', 'DMZ', 'LAN', 'deny'),
      rule('r-wan-lan', 'Default WAN→LAN', 'WAN', 'LAN', 'deny'),
      rule('r-wan-dmz', 'Default WAN→DMZ', 'WAN', 'DMZ', 'deny'),
    ],
    natRules: [],
    natDefaultsDisabled: [],
    routes: [],
    security: {
      gav: { enabled: false, protocols: Object.fromEntries(['HTTP', 'FTP', 'IMAP', 'SMTP', 'POP3', 'CIFS/NETBIOS', 'TCP STREAM'].map((p) => [p, { inbound: true, outbound: ['HTTP', 'FTP', 'SMTP', 'TCP STREAM'].includes(p) }])) },
      ips: { enabled: false, high: { prevent: false, detect: true }, medium: { prevent: false, detect: true }, low: { prevent: false, detect: false }, exclusions: [] },
      appControl: { enabled: false, logAll: false, categories: { P2P: 'none', 'Proxy-Access': 'none', 'Social Networking': 'none', 'Streaming Media': 'none', 'Business Apps': 'none' } },
      cfs: { enabled: false, blockIfUnavailable: false, excludeAdmin: true, profiles: [{ id: 'cfs-default', name: 'CFS Default Profile', blocked: [], allowList: [] }], rules: [] },
      dpiSsl: { clientEnabled: false, inspect: { ips: true, gav: true, spyware: true, appControl: true, cfs: true }, alwaysAuthServer: true, excludedCategories: [], excludedNames: [] },
      botnet: { enabled: false },
    },
    users: {
      local: [],
      groups: ['Everyone', 'Trusted Users', 'Content Filtering Bypass', 'Limited Administrators', 'SSLVPN Services'].map((name) => ({ name, builtIn: true, comment: '' })),
      inactivityMin: 15,
      redirectToLogin: true,
    },
    sslvpn: { zones: {}, port: 4433, domain: 'LocalDomain', pool: '', dns: ['0.0.0.0', '0.0.0.0'], clientRoutes: [], tunnelAll: false },
    ipsec: [
      {
        id: 'gvpn', name: 'WAN GroupVPN', kind: 'group', gateway: '0.0.0.0', secret: '', localNet: 'LAN Subnets', remoteNet: 'Any', exchange: 'aggressive',
        p1: { dh: 'Group 2', enc: '3DES', auth: 'SHA1', life: 28800 }, p2: { proto: 'ESP', enc: '3DES', auth: 'SHA1', pfs: false, pfsGroup: 'Group 2', life: 28800 },
        keepAlive: false, suppressAutoRules: false, boundTo: 'Zone WAN', enabled: false,
      },
    ],
    sdwan: { groups: [], probes: [], profiles: [] },
    ha: { mode: 'none', secondarySerial: '', statefulSync: false, preempt: false, monitorIfaces: [], monitorIps: {}, synced: false },
    certificates: [
      { name: 'Default self-signed certificate', type: 'Local', subject: 'CN=192.168.168.168', issuer: 'self-signed', expires: '2036-01-01', builtIn: true },
      { name: 'ThreatWall DPI-SSL CA', type: 'CA', subject: 'CN=ThreatWall DPI-SSL CA', issuer: 'self-signed', expires: '2036-01-01', builtIn: true },
    ],
    licensing: {
      registered: false, account: null, registeredAt: null,
      services: [
        licSvc('gav', 'Gateway Anti-Virus'), licSvc('spy', 'Anti-Spyware'), licSvc('ips', 'Intrusion Prevention'), licSvc('app', 'Application Control'),
        licSvc('cfs', 'Content Filtering Service'), licSvc('dpissl', 'DPI-SSL'), licSvc('botnet', 'Botnet Filter'), licSvc('geoip', 'Geo-IP Filter'),
        licSvc('sslvpn', 'SSL VPN (25 users)'), licSvc('ha', 'Stateful High Availability'),
      ],
    },
    backups: [],
    branch: {
      hostname: 'KGI-BR-FW', wanIp: LAB.branchWan, wanMask: '255.255.255.248', wanGw: '198.51.100.17', lanIp: '192.168.20.1', lanMask: '255.255.255.0',
      addresses: [], ipsec: [],
    },
  };
}

export function initialSession(): LabSession {
  return {
    certAccepted: false,
    loggedIn: false,
    user: null,
    connectedVia: 'X0',
    connectedIp: FACTORY.mgmtIp,
    connectedPort: 443,
    browserUrl: '',
    disconnected: null,
    pc: { name: 'ADMIN-PC', mac: LAB.macs.admin, cabled: false, mode: 'dhcp', ip: '', mask: '', gateway: '', dns: '' },
    lastActivity: Date.now(),
  };
}

export function initialLab(): LabControls {
  return {
    clockOverride: null, isp: { X1: 'up', X3: 'up' }, trunk: false, haPower: { primary: true, secondary: true }, pcsTrustDpiCa: false,
    remoteUserConnected: false, authSessions: [], scenarios: {}, haFailoverAt: null,
  };
}

export function initialProgress(): Progress {
  return { mode: 'guided', beginner: true, panelOpen: true, current: '0.1', tasks: {}, events: [], notes: {}, badgesSeen: [], learner: '' };
}

export function initialPm(): PacketMonitorState {
  return { filter: { src: '', dst: '', dstPort: '', etherType: 'IP', dropped: true, forwarded: true, consumed: true }, capturing: false, packets: [] };
}

export function initialState(): RootState {
  return {
    version: STATE_VERSION, config: factoryConfig(), session: initialSession(), lab: initialLab(), progress: initialProgress(),
    audit: [], logs: [], pm: initialPm(),
  };
}
