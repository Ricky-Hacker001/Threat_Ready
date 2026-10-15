/**
 * The lab "world" around the firewall: devices on each segment and the simulated internet.
 * All public addresses come from documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
 * or the two well-known resolvers the guide uses; nothing here ever touches a real network.
 */
import { LAB } from '../state/baseline';

export type HostAddr =
  | { mode: 'static'; ip: string; mask: string; gw: string; dns: string }
  | { mode: 'dhcp' }
  | { mode: 'pc' }                       // ADMIN-PC: from session.pc
  | { mode: 'public'; ip: string };      // internet host

export interface LabHost {
  id: string;
  name: string;
  kind: 'pc' | 'laptop' | 'phone' | 'printer' | 'server' | 'internet' | 'branch' | 'remote';
  segment: 'iface' | 'vlan' | 'internet' | 'branch';
  iface?: string;                        // attachment port for 'iface'
  vlan?: number;                         // VLAN tag for 'vlan' (on X0)
  mac?: string;
  addr: HostAddr;
  note?: string;
}

export const HOSTS: LabHost[] = [
  { id: 'admin', name: 'ADMIN-PC', kind: 'pc', segment: 'iface', iface: 'X0', mac: LAB.macs.admin, addr: { mode: 'pc' }, note: 'Your workstation' },
  { id: 'hr', name: 'HR-PC', kind: 'pc', segment: 'iface', iface: 'X0', mac: LAB.macs.hr, addr: { mode: 'static', ip: LAB.hrPc, mask: '255.255.255.0', gw: LAB.lanIp, dns: LAB.dns1 } },
  { id: 'fin', name: 'FIN-PC', kind: 'pc', segment: 'iface', iface: 'X0', mac: LAB.macs.fin, addr: { mode: 'static', ip: LAB.finPc, mask: '255.255.255.0', gw: LAB.lanIp, dns: LAB.dns1 } },
  { id: 'rogue', name: 'Unknown laptop', kind: 'laptop', segment: 'iface', iface: 'X0', mac: LAB.macs.rogue, addr: { mode: 'static', ip: LAB.finPc, mask: '255.255.255.0', gw: LAB.lanIp, dns: LAB.dns1 }, note: 'Static IP set to Finance’s address' },
  { id: 'printer', name: 'PRINTER-01', kind: 'printer', segment: 'iface', iface: 'X0', mac: LAB.macs.printer, addr: { mode: 'dhcp' } },
  { id: 'web01', name: 'WEB-01', kind: 'server', segment: 'iface', iface: 'X2', mac: '00:50:56:aa:01:00', addr: { mode: 'static', ip: LAB.webServer, mask: '255.255.255.0', gw: LAB.dmzIp, dns: LAB.dns1 } },
  { id: 'staff-laptop', name: 'STAFF-LAPTOP', kind: 'laptop', segment: 'vlan', vlan: 10, mac: '00:1a:2b:10:00:11', addr: { mode: 'dhcp' } },
  { id: 'fin-laptop', name: 'FIN-LAPTOP', kind: 'laptop', segment: 'vlan', vlan: 20, mac: '00:1a:2b:20:00:21', addr: { mode: 'dhcp' } },
  { id: 'guest-phone', name: 'GUEST-PHONE', kind: 'phone', segment: 'vlan', vlan: 30, mac: 'a4:5e:60:30:00:31', addr: { mode: 'dhcp' } },
  { id: 'branch-pc', name: 'BRANCH-PC', kind: 'branch', segment: 'branch', mac: '00:1a:2b:20:20:10', addr: { mode: 'static', ip: '192.168.20.10', mask: '255.255.255.0', gw: '192.168.20.1', dns: LAB.dns1 } },
  { id: 'remote-user', name: 'REMOTE-LAPTOP (home)', kind: 'remote', segment: 'internet', addr: { mode: 'public', ip: '192.0.2.80' } },
  { id: 'outside', name: 'INTERNET-TESTER', kind: 'internet', segment: 'internet', addr: { mode: 'public', ip: '192.0.2.200' } },
];

export interface Site { name: string; ip: string; category: string; app?: string }

/** Lab DNS: what the simulated internet resolves. */
export const SITES: Site[] = [
  { name: 'www.search.example', ip: '192.0.2.10', category: 'Search Engines' },
  { name: 'erp.kaveri-textiles.example', ip: '192.0.2.20', category: 'Business' },
  { name: 'updates.vendor.example', ip: '192.0.2.30', category: 'Computers and Internet' },
  { name: 'malware-test.example', ip: '192.0.2.40', category: 'Malware' },
  { name: 'phish-login.example', ip: '192.0.2.41', category: 'Phishing' },
  { name: 'adult-site.example', ip: '192.0.2.42', category: 'Adult Content' },
  { name: 'unblock-proxy.example', ip: '192.0.2.43', category: 'Proxy Avoidance' },
  { name: 'social.example', ip: '192.0.2.44', category: 'Social Networking', app: 'social' },
  { name: 'video.example', ip: '192.0.2.45', category: 'Streaming Media' },
  { name: 'bank.example', ip: '192.0.2.50', category: 'Financial Services' },
  { name: 'clinic.example', ip: '192.0.2.51', category: 'Health' },
  { name: 'saas-tool.example', ip: '192.0.2.60', category: 'Business' },
  { name: 'pinned-app.example', ip: '192.0.2.61', category: 'Business' },
  { name: LAB.c2Name, ip: LAB.c2, category: 'Uncategorized' },
  { name: 'dns.resolver.example', ip: '8.8.8.8', category: 'Computers and Internet' },
  { name: 'one.one.one.one', ip: '1.1.1.1', category: 'Computers and Internet' },
];

export const CFS_CATEGORIES = [
  'Malware', 'Phishing', 'Adult Content', 'Proxy Avoidance', 'Gambling', 'Hacking', 'Social Networking', 'Streaming Media',
  'Financial Services', 'Health', 'Business', 'Search Engines', 'Computers and Internet', 'Uncategorized',
];

export interface AppDef { id: string; name: string; category: 'P2P' | 'Proxy-Access' | 'Social Networking' | 'Streaming Media' | 'Business Apps'; port: number; proto: 'TCP' | 'UDP' }
export const APPS: AppDef[] = [
  { id: 'bittorrent', name: 'BitTorrent', category: 'P2P', port: 6881, proto: 'TCP' },
  { id: 'ultrasurf', name: 'UltraSurf proxy', category: 'Proxy-Access', port: 443, proto: 'TCP' },
  { id: 'social', name: 'Social network (web)', category: 'Social Networking', port: 443, proto: 'TCP' },
  { id: 'video', name: 'Video streaming', category: 'Streaming Media', port: 443, proto: 'TCP' },
  { id: 'erp-sync', name: 'ERP sync client', category: 'Business Apps', port: 443, proto: 'TCP' },
];

/** IPS signatures the lab can trigger. */
export const SIGNATURES: Record<number, { name: string; severity: 'high' | 'medium' | 'low' }> = {
  2103: { name: 'WEB-ATTACKS Apache path traversal attempt', severity: 'high' },
  5946: { name: 'PROTOCOLS QUIC – UDP activity (ERP sync false positive)', severity: 'medium' },
  7001: { name: 'SCAN TCP port sweep', severity: 'low' },
};

export const hostById = (id: string): LabHost | undefined => HOSTS.find((h) => h.id === id);
export const siteByName = (n: string): Site | undefined => SITES.find((s) => s.name.toLowerCase() === n.trim().toLowerCase());
export const siteByIp = (ip: string): Site | undefined => SITES.find((s) => s.ip === ip);
export const ISP_GATEWAYS: Record<string, string> = { X1: LAB.wanGw, X3: LAB.wan2Gw };
