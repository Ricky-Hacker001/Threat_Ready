import type { LucideIcon } from 'lucide-react';
import {
  Activity, Boxes, Cable, Gauge, Globe, HardDrive, KeyRound, LayoutDashboard, LineChart, List, Lock, Monitor, Network,
  ScrollText, Server, Shield, ShieldCheck, SlidersHorizontal, Stethoscope, Unlock, Users, Waypoints, Wrench, FileCog, Flame,
} from 'lucide-react';

export type ViewId = 'home' | 'monitor' | 'device' | 'network' | 'object' | 'policy';

export interface NavItem {
  id: string;
  label: string;
  /** Task IDs from the learning track that use this page. */
  tasks: string[];
}
export interface NavGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  header?: string;           // small caps band shown above the group
  items: NavItem[];
}
export interface View {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  groups: NavGroup[];
}

const it = (id: string, label: string, tasks: string[] = []): NavItem => ({ id, label, tasks });

export const VIEWS: View[] = [
  {
    id: 'home', label: 'Home', icon: Gauge,
    groups: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, items: [it('system', 'System', ['0.4']), it('topology', 'Topology', ['0.4'])] },
    ],
  },
  {
    id: 'monitor', label: 'Monitor', icon: Activity,
    groups: [
      { id: 'realtime', label: 'Real-Time Charts', icon: LineChart, items: [it('system-monitor', 'System Monitor', ['0.4'])] },
      { id: 'logs', label: 'Logs', icon: List, items: [it('system-logs', 'System Logs', ['1.6', '4.3', '4.5']), it('auditing-logs', 'Auditing Logs', ['0.6', '4.4'])] },
      { id: 'tools', label: 'Tools & Monitors', icon: Wrench, items: [it('packet-monitor', 'Packet Monitor', ['4.2', '4.5']), it('connections', 'Connections', ['1.6', '4.5'])] },
    ],
  },
  {
    id: 'device', label: 'Device', icon: Monitor,
    groups: [
      {
        id: 'settings', label: 'Settings', icon: SlidersHorizontal, header: 'Firewall',
        items: [
          it('licenses', 'Licenses', ['0.5']),
          it('administration', 'Administration', ['0.7', '4.4']),
          it('time', 'Time', ['0.3']),
          it('certificates', 'Certificates', ['3.2', '4.4']),
          it('firmware', 'Firmware and Settings', ['0.6', '4.4']),
        ],
      },
      { id: 'ha', label: 'High Availability', icon: Server, items: [it('status', 'Status', ['4.1']), it('settings', 'Settings', ['4.1']), it('monitoring', 'Monitoring', ['4.1'])] },
      { id: 'users', label: 'Users', icon: Users, items: [it('status', 'Status', ['2.7']), it('settings', 'Settings', ['2.7']), it('local', 'Local Users & Groups', ['2.7', '3.3'])] },
      { id: 'log', label: 'Log', icon: ScrollText, items: [it('syslog', 'Syslog', ['4.4'])] },
      { id: 'diagnostics', label: 'Diagnostics', icon: Stethoscope, items: [it('tools', 'Diagnostic Tools', ['1.2'])] },
    ],
  },
  {
    id: 'network', label: 'Network', icon: Network,
    groups: [
      {
        id: 'system', label: 'System', icon: Cable,
        items: [
          it('interfaces', 'Interfaces', ['1.1', '2.4', '3.5']),
          it('zones', 'Zones', ['1.1', '2.4']),
          it('failover', 'Failover & LB', ['3.5']),
          it('arp', 'ARP', ['1.4']),
          it('mac-ip-anti-spoof', 'MAC IP Anti-Spoof', ['1.4', '4.5']),
          it('dhcp', 'DHCP Server', ['1.3', '2.4']),
        ],
      },
      { id: 'dns', label: 'DNS', icon: Globe, items: [it('settings', 'DNS Settings', ['1.2'])] },
      { id: 'sdwan', label: 'SDWAN', icon: Waypoints, items: [it('groups', 'SD-WAN Groups', ['3.5']), it('probes', 'SLA Probes', ['3.5']), it('paths', 'Path Selection Profiles', ['3.5'])] },
      { id: 'ipsec', label: 'IPSec VPN', icon: Lock, items: [it('rules', 'Rules and Settings', ['3.4', '4.3']), it('branch', 'Branch Peer (lab)', ['3.4', '4.3'])] },
      { id: 'sslvpn', label: 'SSL VPN', icon: KeyRound, items: [it('status', 'Status', ['3.3']), it('server', 'Server Settings', ['3.3']), it('client', 'Client Settings', ['3.3'])] },
    ],
  },
  {
    id: 'object', label: 'Object', icon: Boxes,
    groups: [
      {
        id: 'match', label: 'Match Objects', icon: Boxes,
        items: [it('zones', 'Zones', ['1.1', '2.4']), it('addresses', 'Addresses', ['1.5', '2.2', '3.3', '3.4']), it('services', 'Services', ['2.1']), it('schedules', 'Schedules', ['2.1'])],
      },
      { id: 'profiles', label: 'Profile Objects', icon: FileCog, items: [it('content-filter', 'Content Filter', ['2.5'])] },
    ],
  },
  {
    id: 'policy', label: 'Policy', icon: Flame,
    groups: [
      {
        id: 'rules', label: 'Rules and Policies', icon: ShieldCheck,
        items: [
          it('access', 'Access Rules', ['1.6', '2.1', '2.2', '2.3', '2.4', '2.7']),
          it('nat', 'NAT Rules', ['1.6', '2.2']),
          it('routing', 'Routing Rules', ['1.2', '3.5']),
          it('content-filter', 'Content Filter Rules', ['2.5']),
        ],
      },
      { id: 'dpi-ssl', label: 'DPI-SSL', icon: Unlock, items: [it('client', 'Client SSL', ['3.2']), it('server', 'Server SSL', ['3.2'])] },
      {
        id: 'security', label: 'Security Services', icon: Shield,
        items: [
          it('summary', 'Summary', ['3.1']),
          it('gateway-av', 'Gateway Anti-Virus', ['3.1']),
          it('ips', 'Intrusion Prevention', ['3.1']),
          it('app-control', 'App Control', ['2.6']),
          it('content-filter', 'Content Filter', ['2.5']),
          it('botnet', 'Botnet Filter', ['4.5']),
        ],
      },
    ],
  },
];

// silence unused-import lint for icons kept for upcoming pages
void [HardDrive];

export interface Route { view: View; group: NavGroup; item: NavItem; path: string }

export function routeFor(path: string): Route | null {
  const [v, g, i] = path.split('/');
  const view = VIEWS.find((x) => x.id === v);
  const group = view?.groups.find((x) => x.id === g);
  const item = group?.items.find((x) => x.id === i);
  return view && group && item ? { view, group, item, path } : null;
}

export const firstRouteOf = (view: View): string => `${view.id}/${view.groups[0].id}/${view.groups[0].items[0].id}`;
export const DEFAULT_ROUTE = 'home/dashboard/system';
