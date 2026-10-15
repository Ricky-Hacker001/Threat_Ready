import type { ComponentType } from 'react';
import { Hammer } from 'lucide-react';
import type { Route } from '../shell/nav';
import { DashboardPage } from './home/Dashboard';
import { InterfacesPage } from './network/Interfaces';
import { ZonesPage } from './object/Zones';
import { LicensesPage } from './device/Licenses';
import { AdministrationPage } from './device/Administration';
import { FirmwarePage } from './device/Firmware';
import { AuditLogsPage } from './monitor/AuditLogs';
import { AddressesPage } from './object/Addresses';
import { ServicesPage, SchedulesPage } from './object/Services';
import { AccessRulesPage } from './policy/AccessRules';
import { NatRulesPage } from './policy/NatRules';
import { RoutingRulesPage } from './policy/RoutingRules';
import { DhcpPage } from './network/Dhcp';
import { ArpPage, AntiSpoofPage } from './network/Arp';
import { DnsPage } from './network/Dns';
import { DiagnosticsPage } from './device/Diagnostics';
import { SystemLogsPage } from './monitor/SystemLogs';
import { TopologyPage } from './home/Topology';
import { SystemMonitorPage } from './monitor/SystemMonitor';
import { ConnectionsPage } from './monitor/Connections';
import { CfsProfilesPage, CfsRulesPage, CfsSettingsPage } from './security/ContentFilter';
import { AppControlPage, BotnetPage, GavPage, IpsPage, SecuritySummaryPage } from './security/Security';
import { LocalUsersPage, UserSettingsPage, UserStatusPage } from './device/Users';
import { BranchPeerPage, IpsecPage } from './vpn/Ipsec';
import { SslVpnClientPage, SslVpnServerPage, SslVpnStatusPage } from './vpn/SslVpn';
import { FailoverPage, PathProfilesPage, SdwanGroupsPage, SlaProbesPage } from './network/Sdwan';
import { CertificatesPage, DpiClientPage, DpiServerPage } from './security/DpiSsl';
import { HaMonitoringPage, HaSettingsPage, HaStatusPage } from './device/HighAvailability';
import { PacketMonitorPage } from './monitor/PacketMonitor';
import { SyslogPage } from './device/Syslog';
import { TimePage } from './device/Time';

/** Route → page. Pages not listed render <PlannedPage>, which states which task stage builds them. */
const PAGES: Record<string, ComponentType> = {
  'home/dashboard/system': DashboardPage,
  'network/system/interfaces': InterfacesPage,
  'object/match/zones': ZonesPage,
  'device/settings/licenses': LicensesPage,
  'device/settings/administration': AdministrationPage,
  'device/settings/firmware': FirmwarePage,
  'monitor/logs/auditing-logs': AuditLogsPage,
  'monitor/logs/system-logs': SystemLogsPage,
  'monitor/realtime/system-monitor': SystemMonitorPage,
  'monitor/tools/connections': ConnectionsPage,
  'home/dashboard/topology': TopologyPage,
  'network/system/zones': ZonesPage,
  'network/system/dhcp': DhcpPage,
  'network/system/arp': ArpPage,
  'network/system/mac-ip-anti-spoof': AntiSpoofPage,
  'network/dns/settings': DnsPage,
  'object/match/addresses': AddressesPage,
  'object/match/services': ServicesPage,
  'object/match/schedules': SchedulesPage,
  'policy/rules/access': AccessRulesPage,
  'policy/rules/nat': NatRulesPage,
  'policy/rules/routing': RoutingRulesPage,
  'device/diagnostics/tools': DiagnosticsPage,
  'policy/security/content-filter': CfsSettingsPage,
  'object/profiles/content-filter': CfsProfilesPage,
  'policy/rules/content-filter': CfsRulesPage,
  'policy/security/app-control': AppControlPage,
  'policy/security/summary': SecuritySummaryPage,
  'policy/security/ips': IpsPage,
  'policy/security/gateway-av': GavPage,
  'policy/security/botnet': BotnetPage,
  'device/users/local': LocalUsersPage,
  'device/users/settings': UserSettingsPage,
  'device/users/status': UserStatusPage,
  'network/ipsec/rules': IpsecPage,
  'network/ipsec/branch': BranchPeerPage,
  'network/sslvpn/status': SslVpnStatusPage,
  'network/sslvpn/server': SslVpnServerPage,
  'network/sslvpn/client': SslVpnClientPage,
  'network/sdwan/groups': SdwanGroupsPage,
  'network/sdwan/probes': SlaProbesPage,
  'network/sdwan/paths': PathProfilesPage,
  'network/system/failover': FailoverPage,
  'policy/dpi-ssl/client': DpiClientPage,
  'policy/dpi-ssl/server': DpiServerPage,
  'device/settings/certificates': CertificatesPage,
  'device/ha/status': HaStatusPage,
  'device/ha/settings': HaSettingsPage,
  'device/ha/monitoring': HaMonitoringPage,
  'monitor/tools/packet-monitor': PacketMonitorPage,
  'device/log/syslog': SyslogPage,
  'device/settings/time': TimePage,
};

export function PageFor({ route }: { route: Route }) {
  const Page = PAGES[route.path];
  return Page ? <Page key={route.path} /> : <PlannedPage route={route} />;
}

function PlannedPage({ route }: { route: Route }) {
  return (
    <div className="tw-page">
      <div className="tw-planned">
        <h1><Hammer size={16} style={{ verticalAlign: -2, marginRight: 6 }} color="var(--tw-accent)" />{route.item.label}</h1>
        <p className="muted">
          This page is built in the task stage that uses it
          {route.item.tasks.length ? <> — task{route.item.tasks.length > 1 ? 's' : ''} <b>{route.item.tasks.join(', ')}</b></> : null}.
          Its menu position and path (<b>{route.view.label.toUpperCase()} | {route.group.label} &gt; {route.item.label}</b>) are final.
        </p>
      </div>
    </div>
  );
}
