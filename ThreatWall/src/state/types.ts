/**
 * ThreatWall simulated appliance — the ONE configuration model shared by every page, the engine and task verification.
 * Pages never hold their own copy: they validate through services/* and call store.commit().
 */

/* ============================== Network ============================== */

export type SecurityType = 'Trusted' | 'Untrusted' | 'Public' | 'Encrypted' | 'SSL VPN' | 'Management' | 'Wireless';

export interface Zone {
  name: string;
  securityType: SecurityType;
  interfaceTrust: boolean;
  gatewayAv: boolean;
  antiSpyware: boolean;
  ips: boolean;
  appControl: boolean;
  sslControl: boolean;
  sslVpnAccess: boolean;
  dpiSslClient: boolean;
  dpiSslServer: boolean;
  comment: string;
  builtIn: boolean;
}

export type IpMode = 'static' | 'dhcp' | 'unassigned';
export type LinkState = 'up' | 'down' | 'nolink';

export interface MgmtAccess { https: boolean; http: boolean; ping: boolean; ssh: boolean; snmp: boolean }

export interface NetInterface {
  name: string;               // X0, X1, MGMT, X0:V10
  kind: 'physical' | 'vlan' | 'mgmt';
  parent?: string;
  vlanId?: number;
  zone: string | null;        // null = Unassigned
  mode: IpMode;
  ip: string;
  mask: string;
  gateway: string;
  dns: [string, string, string];
  mgmt: MgmtAccess;
  userLogin: { http: boolean; https: boolean };
  httpRedirect: boolean;
  comment: string;
  enabled: boolean;
  link: LinkState;            // physical link (cable)
  speed: string;
  mac: string;
}

export interface DhcpScope {
  id: string;
  iface: string;
  start: string;
  end: string;
  gateway: string;
  dns: [string, string];
  leaseMin: number;
  enabled: boolean;
  comment: string;
}
export interface DhcpStatic { id: string; name: string; ip: string; mac: string; enabled: boolean }
export interface DhcpConfig { enabled: boolean; conflictDetection: boolean; scopes: DhcpScope[]; statics: DhcpStatic[] }

export interface StaticArp { id: string; ip: string; mac: string; iface: string; publish: boolean }

export interface AntiSpoofIface {
  enabled: boolean;
  staticArp: boolean;
  dhcpServer: boolean;
  arpLock: boolean;
  arpWatch: boolean;
  enforceIngress: boolean;
  spoofDetection: boolean;
  allowMgmt: boolean;
}
export interface AntiSpoofEntry { id: string; iface: string; ip: string; mac: string; router: boolean; blacklisted: boolean; comment: string }
export interface AntiSpoofConfig { ifaces: Record<string, AntiSpoofIface>; cache: AntiSpoofEntry[] }

export interface DnsSettings { mode: 'inherit' | 'static'; servers: [string, string, string] }

/* ============================== Objects ============================== */

export type AddrType = 'host' | 'range' | 'network' | 'fqdn';
export interface AddressObject {
  id: string;
  name: string;
  zone: string;
  type: AddrType;
  ip: string;                 // host IP, range start, network address
  ip2: string;                // range end or network mask
  fqdn: string;
  comment: string;
}
export interface AddressGroup { id: string; name: string; members: string[]; comment: string }

export type Proto = 'TCP' | 'UDP' | 'ICMP' | 'ESP';
export interface ServiceObject { id: string; name: string; protocol: Proto; portStart: number; portEnd: number; builtIn: boolean }
export interface ServiceGroup { id: string; name: string; members: string[]; builtIn: boolean }

export interface Schedule { id: string; name: string; days: number[]; start: string; end: string; builtIn: boolean }

/* ============================== Policy ============================== */

export type RuleAction = 'allow' | 'deny' | 'discard';
export interface AccessRule {
  id: string;
  name: string;
  fromZone: string;
  toZone: string;
  action: RuleAction;
  src: string;                // address object/group name or 'Any'
  dst: string;
  service: string;            // service/group name or 'Any'
  schedule: string;           // 'Always' or schedule name
  usersIncl: string;          // 'All' or group name
  usersExcl: string;          // 'None' or group name
  logging: boolean;
  enabled: boolean;
  builtIn: boolean;
  auto: string | null;        // created automatically by a feature (e.g. 'sslvpn', 'ipsec:<id>')
  hits: number;
  lastHit: number | null;
  comment: string;
}

export interface NatRule {
  id: string;
  name: string;
  origSrc: string;
  transSrc: string;           // 'Original' or object name
  origDst: string;
  transDst: string;
  origSvc: string;
  transSvc: string;
  inIface: string;            // 'Any' or interface
  outIface: string;
  enabled: boolean;
  builtIn: boolean;
  hits: number;
  comment: string;
}

export interface RoutePolicy {
  id: string;
  name: string;
  src: string;
  dst: string;
  service: string;
  type: 'standard' | 'sdwan';
  iface: string;
  gateway: string;            // IP or '0.0.0.0'
  pathProfile: string;
  metric: number;
  enabled: boolean;
  hits: number;
  comment: string;
}

export interface CfsProfile { id: string; name: string; blocked: string[]; allowList: string[] }
export interface CfsRule { id: string; name: string; srcZone: string; dstZone: string; users: string; profile: string; enabled: boolean; hits: number }

export type AppCategory = 'P2P' | 'Proxy-Access' | 'Social Networking' | 'Streaming Media' | 'Business Apps';
export type AppAction = 'block' | 'log' | 'none';

export interface SecurityConfig {
  gav: { enabled: boolean; protocols: Record<string, { inbound: boolean; outbound: boolean }> };
  ips: {
    enabled: boolean;
    high: { prevent: boolean; detect: boolean };
    medium: { prevent: boolean; detect: boolean };
    low: { prevent: boolean; detect: boolean };
    exclusions: number[];
  };
  appControl: { enabled: boolean; logAll: boolean; categories: Record<AppCategory, AppAction> };
  cfs: { enabled: boolean; blockIfUnavailable: boolean; excludeAdmin: boolean; profiles: CfsProfile[]; rules: CfsRule[] };
  dpiSsl: {
    clientEnabled: boolean;
    inspect: { ips: boolean; gav: boolean; spyware: boolean; appControl: boolean; cfs: boolean };
    alwaysAuthServer: boolean;
    excludedCategories: string[];
    excludedNames: string[];
  };
  botnet: { enabled: boolean };
}

/* ============================== Users / VPN ============================== */

export interface LocalUser { id: string; name: string; passwordHash: string; groups: string[]; otp: boolean; vpnAccess: string[]; comment: string }
export interface UserGroup { name: string; builtIn: boolean; comment: string }
export interface UsersConfig { local: LocalUser[]; groups: UserGroup[]; inactivityMin: number; redirectToLogin: boolean }

export interface SslVpnConfig {
  zones: Record<string, boolean>;
  port: number;
  domain: string;
  pool: string;               // address object name
  dns: [string, string];
  clientRoutes: string[];
  tunnelAll: boolean;
}

export type Exchange = 'ikev2' | 'main' | 'aggressive';
export interface IpsecPolicy {
  id: string;
  name: string;
  kind: 'site' | 'group';
  gateway: string;
  secret: string;             // training-only
  localNet: string;           // address object/group name
  remoteNet: string;
  exchange: Exchange;
  p1: { dh: string; enc: string; auth: string; life: number };
  p2: { proto: 'ESP' | 'AH'; enc: string; auth: string; pfs: boolean; pfsGroup: string; life: number };
  keepAlive: boolean;
  suppressAutoRules: boolean;
  boundTo: string;
  enabled: boolean;
}

/** The Branch firewall (lab peer) — only what task 3.4/4.3 need. */
export interface BranchConfig {
  hostname: string;
  wanIp: string;
  wanMask: string;
  wanGw: string;
  lanIp: string;
  lanMask: string;
  addresses: AddressObject[];
  ipsec: IpsecPolicy[];
}

export interface SdwanGroup { id: string; name: string; members: string[] }
export interface SlaProbe { id: string; name: string; target: string; ifaces: string[]; intervalSec: number; enabled: boolean }
export interface PathProfile { id: string; name: string; group: string; probe: string; maxLatencyMs: number; maxLossPct: number; backup: string; enabled: boolean }
export interface SdwanConfig { groups: SdwanGroup[]; probes: SlaProbe[]; profiles: PathProfile[] }

export interface HaConfig {
  mode: 'none' | 'active-standby';
  secondarySerial: string;
  statefulSync: boolean;
  preempt: boolean;
  monitorIfaces: string[];
  monitorIps: Record<string, { primary: string; secondary: string }>;
  synced: boolean;
}

/* ============================== Device ============================== */

export interface SystemSettings {
  hostname: string;
  domain: string;
  description: string;
  model: string;
  serial: string;
  authCode: string;
  firmware: string;
  romVersion: string;
  adminUser: string;
  adminPasswordHash: string;
  defaultPassword: boolean;
  adminTimeoutMin: number;
  timezone: string;
  setupComplete: boolean;
  ipv6: boolean;
  otpMethod: 'disabled' | 'totp';
  bootedAt: number;
  httpsPort: number;
  certificate: string;        // management certificate name
  lockout: { enabled: boolean; attempts: number; minutes: number };
  syslog: { enabled: boolean; server: string; port: number };
  backupSchedule: 'none' | 'weekly';
  firmwareReviewed: boolean;
  limitedAdmins: { name: string; role: 'read-only' | 'limited' }[];
}

export type LicenseStatus = 'licensed' | 'not-licensed' | 'expired';
export interface LicensedService { id: string; name: string; status: LicenseStatus; expires: string | null }
export interface Licensing { registered: boolean; account: string | null; registeredAt: number | null; services: LicensedService[] }

export interface Certificate { name: string; type: 'Local' | 'CA'; subject: string; issuer: string; expires: string; builtIn: boolean }

export interface ConfigBackup { id: string; createdAt: number; firmware: string; user: string; comment: string; kind: 'local'; snapshot: string }

export interface FirewallConfig {
  system: SystemSettings;
  interfaces: NetInterface[];
  zones: Zone[];
  dhcp: DhcpConfig;
  staticArp: StaticArp[];
  antiSpoof: AntiSpoofConfig;
  dns: DnsSettings;
  addresses: AddressObject[];
  addressGroups: AddressGroup[];
  services: ServiceObject[];
  serviceGroups: ServiceGroup[];
  schedules: Schedule[];
  accessRules: AccessRule[];
  natRules: NatRule[];
  natDefaultsDisabled: string[];   // WAN interfaces whose built-in outbound NAT is disabled
  routes: RoutePolicy[];
  security: SecurityConfig;
  users: UsersConfig;
  sslvpn: SslVpnConfig;
  ipsec: IpsecPolicy[];
  sdwan: SdwanConfig;
  ha: HaConfig;
  certificates: Certificate[];
  licensing: Licensing;
  backups: ConfigBackup[];
  branch: BranchConfig;
}

/* ============================== Runtime / lab ============================== */

export type AuditCategory = 'System' | 'Network' | 'Object' | 'Policy' | 'VPN' | 'Security' | 'Users' | 'Lab' | 'Session';
export interface AuditEntry { id: string; ts: number; user: string; category: AuditCategory; action: string; detail: string }

export type LogCategory = 'Network' | 'Firewall Rule' | 'Security Services' | 'VPN' | 'User' | 'System' | 'High Availability' | 'SD-WAN';
export type LogPriority = 'Alert' | 'Warning' | 'Notice' | 'Info';
export interface LogEntry {
  id: string;
  ts: number;
  category: LogCategory;
  priority: LogPriority;
  message: string;
  src: string;
  dst: string;
  proto: string;
  action: 'allow' | 'drop' | 'block' | 'info';
  rule: string;
  notes: string;
  host?: string;              // lab host id, for scoping
}

export interface Packet {
  id: string;
  ts: number;
  ingress: string;
  egress: string;
  src: string;
  dst: string;
  srcPort: number;
  dstPort: number;
  proto: string;
  status: 'forwarded' | 'dropped' | 'consumed' | 'generated';
  reason: string;
  rule: string;
  nat: string;
  flowLabel: string;
}

export interface PacketMonitorState {
  filter: { src: string; dst: string; dstPort: string; etherType: 'IP' | 'ARP' | 'Any'; dropped: boolean; forwarded: boolean; consumed: boolean };
  capturing: boolean;
  packets: Packet[];
}

/** Learner workstation (ADMIN-PC) and its browser session to the firewall. */
export interface PcState {
  name: string;
  mac: string;
  cabled: boolean;
  mode: 'dhcp' | 'static';
  ip: string;                 // '' = no address yet
  mask: string;
  gateway: string;
  dns: string;
}
export interface LabSession {
  certAccepted: boolean;
  loggedIn: boolean;
  user: string | null;
  connectedVia: string;
  connectedIp: string;
  connectedPort: number;
  browserUrl: string;         // what the simulated browser tab shows ('' = new tab)
  disconnected: null | { reason: string; previousIp: string; expectedIp: string };
  pc: PcState;
  lastActivity: number;
}

/** Lab-only controls (the "physical world" around the firewall). */
export interface LabControls {
  clockOverride: number | null;           // epoch ms; null = real time
  isp: Record<string, 'up' | 'down'>;      // upstream ISP health per WAN port
  trunk: boolean;                          // switch port on X0 is an 802.1Q trunk
  haPower: { primary: boolean; secondary: boolean };
  pcsTrustDpiCa: boolean;                  // DPI-SSL CA pushed to clients (task 3.2)
  remoteUserConnected: boolean;            // NetExtender session (task 3.3)
  authSessions: { user: string; host: string; since: number }[];
  scenarios: Record<string, number>;       // scenario id → injected at
  haFailoverAt: number | null;
}

export type StepState = 'pending' | 'done';
export type TaskStatus = 'locked' | 'available' | 'in-progress' | 'completed' | 'stale';
export interface TaskProgress {
  status: TaskStatus;
  step: number;
  stepDoneAt: Record<string, number>;
  startedAt: number | null;
  completedAt: number | null;
  failures: { stepId: string; reason: string; at: number }[];
  checks: { id: string; ok: boolean; detail: string }[];
}
export interface LabEvent { id: string; ts: number; type: string; data: Record<string, unknown> }
export interface Progress {
  mode: 'guided' | 'practice';
  beginner: boolean;
  panelOpen: boolean;
  current: string;                         // task id the panel shows
  tasks: Record<string, TaskProgress>;
  events: LabEvent[];
  notes: Record<string, string>;           // RCA notes, incident report fields
  badgesSeen: number[];                    // levels whose internal badge has been announced
  learner: string;                         // name shown on the training report
}

export interface RootState {
  version: number;
  config: FirewallConfig;
  session: LabSession;
  lab: LabControls;
  progress: Progress;
  audit: AuditEntry[];
  logs: LogEntry[];
  pm: PacketMonitorState;
}
